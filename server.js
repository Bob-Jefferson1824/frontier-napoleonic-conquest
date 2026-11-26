const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 6000
});

const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- PERSISTENT STATS DATABASE (JSON FILE STORE) ---
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let careerStats = {};
try {
  if (fs.existsSync(STATS_FILE)) {
    careerStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  }
} catch (err) {
  console.error('Failed to read stats.json, starting fresh:', err.message);
  careerStats = {};
}

let statsDirty = false;
function saveStatsIfDirty() {
  if (!statsDirty) return;
  statsDirty = false;
  fs.writeFile(STATS_FILE, JSON.stringify(careerStats, null, 2), (err) => {
    if (err) console.error('Error saving stats.json:', err.message);
  });
}
setInterval(saveStatsIfDirty, 10000);

function getOrCreateProfile(profileId, name) {
  const safeId = String(profileId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || crypto.randomUUID();
  if (!careerStats[safeId]) {
    careerStats[safeId] = {
      id: safeId,
      name: name || 'Soldier',
      kills: 0,
      deaths: 0,
      captures: 0,
      wins: 0,
      updatedAt: Date.now()
    };
    statsDirty = true;
  } else if (name) {
    careerStats[safeId].name = name;
    careerStats[safeId].updatedAt = Date.now();
    statsDirty = true;
  }
  return careerStats[safeId];
}

// --- WORLD & COMBAT CONSTANTS ---
const MAP_RADIUS = 520;
const RIVER_HALF_WIDTH = 34;
const TICK_RATE = 20;
const WIN_POINTS = 1000;
const NUM_FORTS = 12;

const CLASSES = {
  musketeer: {
    name: 'Musketeer',
    maxHp: 100,
    speed: 14,
    reloadMult: 1.0,
    weapons: ['musket', 'pistol', 'bayonet']
  },
  cavalry: {
    name: 'Cavalryman',
    maxHp: 110,
    speed: 15.5,
    reloadMult: 1.15,
    weapons: ['pistol', 'saber', 'spyglass']
  },
  cannoneer: {
    name: 'Cannoneer',
    maxHp: 105,
    speed: 13.5,
    reloadMult: 0.65,
    weapons: ['pistol', 'hammer', 'spyglass']
  },
  sailor: {
    name: 'Sailor',
    maxHp: 100,
    speed: 15,
    reloadMult: 0.9,
    weapons: ['blunderbuss', 'cutlass', 'spyglass']
  }
};

const WEAPON_STATS = {
  musket: { damage: 85, range: 260, speed: 240, reload: 4.2, spread: 0.018, pellets: 1, type: 'ranged' },
  blunderbuss: { damage: 24, range: 65, speed: 170, reload: 4.5, spread: 0.14, pellets: 7, type: 'ranged' },
  pistol: { damage: 55, range: 95, speed: 185, reload: 3.0, spread: 0.045, pellets: 1, type: 'ranged' },
  bayonet: { damage: 55, range: 4.2, cooldown: 0.85, type: 'melee' },
  saber: { damage: 68, range: 4.5, cooldown: 0.75, type: 'melee' },
  cutlass: { damage: 62, range: 4.0, cooldown: 0.65, type: 'melee' },
  hammer: { damage: 50, range: 3.8, cooldown: 0.9, type: 'melee' },
  spyglass: { damage: 0, range: 0, cooldown: 0.5, type: 'utility' }
};

const VALID_HATS = ['shako', 'bicorne', 'bearskin', 'tricorne'];
const VALID_TRIMS = ['gold', 'white', 'silver', 'crimson'];

const BANNED_WORDS = ['badword1', 'badword2', 'slur1', 'slur2'];
function sanitizeText(raw, maxLen) {
  let str = String(raw || '')
    .replace(/[<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  for (const word of BANNED_WORDS) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    str = str.replace(regex, '***');
  }
  return str;
}

let nextEntityId = 1;
const uid = (prefix) => `${prefix}_${nextEntityId++}`;

function getTerrainHeight(x, z) {
  const distFromCenter = Math.hypot(x, z);
  const riverCenterX = Math.sin(z * 0.008) * 45;
  const distToRiver = Math.abs(x - riverCenterX);

  if (distFromCenter > MAP_RADIUS - 35) {
    const edgeFactor = Math.max(0, (distFromCenter - (MAP_RADIUS - 35)) / 55);
    return Math.max(-8, 2.5 - edgeFactor * 10.5);
  }
  if (distToRiver < RIVER_HALF_WIDTH) {
    const riverNorm = distToRiver / RIVER_HALF_WIDTH;
    return -4.5 + riverNorm * riverNorm * 5.5;
  }

  const hills =
    Math.sin(x * 0.012) * Math.cos(z * 0.012) * 7.5 +
    Math.sin(x * 0.028 + 1.2) * Math.sin(z * 0.024) * 3.2;
  return Math.max(0.8, 2.5 + hills);
}

function isWater(x, z) {
  return getTerrainHeight(x, z) < 0.15;
}

// --- MULTI-ROOM ARCHITECTURE ---
const rooms = new Map();

function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createRoom({ id, name, isPrivate = false, maxPlayers = 32, enableBots = true }) {
  const room = {
    id,
    name: sanitizeText(name, 28) || 'Imperial Battlefield',
    isPrivate: !!isPrivate,
    inviteCode: isPrivate ? generateInviteCode() : null,
    maxPlayers,
    enableBots,
    round: 1,
    redPoints: 0,
    bluePoints: 0,
    roundOver: false,
    winner: null,
    roundEndTimer: 0,
    forts: [],
    horses: [],
    cannons: [],
    ships: [],
    players: {},
    projectiles: [],
    disconnectedSessions: new Map(),
    createdAt: Date.now()
  };
  initRoomWorld(room);
  rooms.set(id, room);
  return room;
}

function initRoomWorld(room) {
  room.redPoints = 0;
  room.bluePoints = 0;
  room.roundOver = false;
  room.winner = null;
  room.forts = [];
  room.horses = [];
  room.cannons = [];
  room.ships = [];
  room.projectiles = [];

  const fortNames = [
    'Fort Crown', 'Bastion Ridge', 'Fort Royal', 'Redoubt Hill',
    'Chatham Keep', 'Battery Point', 'Fort Albion', 'Riverwatch',
    'Fort Waterloo', 'Vanguard Post', 'Sovereign Keep', 'Harbor Citadel'
  ];

  for (let i = 0; i < NUM_FORTS; i++) {
    const team = i % 2 === 0 ? 'red' : 'blue';
    let fx = 0;
    let fz = 0;
    let tries = 0;
    do {
      const angle = (Math.random() * 0.8 + 0.1) * Math.PI + (team === 'red' ? Math.PI / 2 : -Math.PI / 2);
      const r = 110 + Math.random() * (MAP_RADIUS - 180);
      fx = Math.cos(angle) * r;
      fz = Math.sin(angle) * r;
      tries++;
    } while (
      tries < 60 &&
      (isWater(fx, fz) ||
        room.forts.some((f) => Math.hypot(f.x - fx, f.z - fz) < 95))
    );

    const fy = getTerrainHeight(fx, fz);
    room.forts.push({
      id: uid('fort'),
      name: fortNames[i] || `Fort ${i + 1}`,
      x: fx,
      y: fy,
      z: fz,
      owner: team,
      captureProgress: team === 'red' ? -100 : 100,
      radius: 26
    });
  }

  for (let i = 0; i < 18; i++) {
    const fort = room.forts[i % room.forts.length];
    const hx = fort.x + (Math.random() - 0.5) * 34;
    const hz = fort.z + (Math.random() - 0.5) * 34;
    if (!isWater(hx, hz)) {
      room.horses.push({
        id: uid('horse'),
        x: hx,
        y: getTerrainHeight(hx, hz),
        z: hz,
        yaw: Math.random() * Math.PI * 2,
        speed: 0,
        hp: 160,
        maxHp: 160,
        riderId: null,
        spawnX: hx,
        spawnZ: hz
      });
    }
  }

  for (let i = 0; i < 14; i++) {
    const fort = room.forts[i % room.forts.length];
    const cx = fort.x + (fort.owner === 'red' ? 22 : -22) + (Math.random() - 0.5) * 18;
    const cz = fort.z + (Math.random() - 0.5) * 24;
    if (!isWater(cx, cz)) {
      room.cannons.push({
        id: uid('cannon'),
        x: cx,
        y: getTerrainHeight(cx, cz),
        z: cz,
        yaw: fort.owner === 'red' ? Math.PI / 2 : -Math.PI / 2,
        pitch: 0.08,
        operatorId: null,
        reloadTimer: 0,
        reloadTime: 5.0
      });
    }
  }

  const shipConfigs = [
    { x: 0, z: -260, yaw: 0, team: 'red', name: 'HMS Victory' },
    { x: 5, z: -90, yaw: 0, team: 'blue', name: 'Le Redoutable' },
    { x: -5, z: 110, yaw: Math.PI, team: 'red', name: 'HMS Sovereign' },
    { x: 0, z: 270, yaw: Math.PI, team: 'blue', name: "L'Orient" },
    { x: -MAP_RADIUS - 35, z: 0, yaw: 0, team: 'red', name: 'HMS Endeavour' },
    { x: MAP_RADIUS + 35, z: 0, yaw: Math.PI, team: 'blue', name: 'La Royale' },
    { x: 0, z: -MAP_RADIUS - 40, yaw: Math.PI / 2, team: 'red', name: 'HMS Vanguard' },
    { x: 0, z: MAP_RADIUS + 40, yaw: -Math.PI / 2, team: 'blue', name: 'Le Triomphant' }
  ];

  shipConfigs.forEach((sc) => {
    room.ships.push({
      id: uid('ship'),
      name: sc.name,
      team: sc.team,
      x: sc.x,
      y: 0,
      z: sc.z,
      yaw: sc.yaw,
      speed: 0,
      hp: 600,
      maxHp: 600,
      captainId: null,
      portReload: 0,
      starboardReload: 0,
      spawnX: sc.x,
      spawnZ: sc.z,
      spawnYaw: sc.yaw
    });
  });

  Object.values(room.players).forEach((p) => {
    p.kills = 0;
    p.deaths = 0;
    p.captures = 0;
    respawnPlayer(room, p);
  });
}

function getSpawnPoint(room, team) {
  const friendlyForts = room.forts.filter((f) => f.owner === team);
  if (friendlyForts.length > 0) {
    const fort = friendlyForts[Math.floor(Math.random() * friendlyForts.length)];
    for (let attempt = 0; attempt < 25; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 10 + Math.random() * 18;
      const sx = fort.x + Math.cos(angle) * dist;
      const sz = fort.z + Math.sin(angle) * dist;
      if (!isWater(sx, sz)) {
        return { x: sx, y: getTerrainHeight(sx, sz), z: sz };
      }
    }
  }
  const baseX = team === 'red' ? -240 : 240;
  return { x: baseX, y: getTerrainHeight(baseX, 0), z: (Math.random() - 0.5) * 120 };
}

function respawnPlayer(room, player) {
  const cls = CLASSES[player.playerClass] || CLASSES.musketeer;
  const spawn = getSpawnPoint(room, player.team);
  player.hp = cls.maxHp;
  player.maxHp = cls.maxHp;
  player.x = spawn.x;
  player.y = spawn.y;
  player.z = spawn.z;
  player.vy = 0;
  player.onGround = true;
  player.crouching = false;
  player.dead = false;
  player.respawnTimer = 0;
  player.weaponIdx = 0;
  player.reloadTimer = 0;
  player.attackCooldown = 0;
  player.mountedType = null;
  player.mountedId = null;
}

function detachPlayerFromEntity(room, player) {
  if (!player.mountedType || !player.mountedId) return;
  if (player.mountedType === 'horse') {
    const h = room.horses.find((item) => item.id === player.mountedId);
    if (h && h.riderId === player.id) h.riderId = null;
  } else if (player.mountedType === 'cannon') {
    const c = room.cannons.find((item) => item.id === player.mountedId);
    if (c && c.operatorId === player.id) c.operatorId = null;
  } else if (player.mountedType === 'ship') {
    const s = room.ships.find((item) => item.id === player.mountedId);
    if (s && s.captainId === player.id) s.captainId = null;
  }
  player.mountedType = null;
  player.mountedId = null;
}

function damagePlayer(room, target, amount, attackerId, weaponName) {
  if (target.dead || room.roundOver) return;
  target.hp -= amount;
  if (target.hp <= 0) {
    target.hp = 0;
    target.dead = true;
    target.respawnTimer = 4.5;
    target.deaths = (target.deaths || 0) + 1;
    detachPlayerFromEntity(room, target);

    if (!target.isBot && target.profileId) {
      const prof = getOrCreateProfile(target.profileId, target.name);
      prof.deaths += 1;
      statsDirty = true;
    }

    const attacker = room.players[attackerId];
    if (attacker && attacker.id !== target.id) {
      attacker.kills = (attacker.kills || 0) + 1;
      if (!attacker.isBot && attacker.profileId) {
        const prof = getOrCreateProfile(attacker.profileId, attacker.name);
        prof.kills += 1;
        statsDirty = true;
      }
    }

    if (!target.isBot) {
      io.to(target.id).emit('playerDied', {
        killer: attacker ? attacker.name : 'Battlefield',
        killerTeam: attacker ? attacker.team : 'neutral',
        weapon: weaponName,
        respawnIn: 4.5
      });
    }

    io.to(room.id).emit('killFeed', {
      killer: attacker ? attacker.name : 'Battlefield',
      killerTeam: attacker ? attacker.team : 'neutral',
      victim: target.name,
      victimTeam: target.team,
      weapon: weaponName
    });
  }
}

// --- AI SOLDIERS ---
const BOT_NAMES = [
  'Pvt. Wellington', 'Sgt. Sharpe', 'Cpl. Harper', 'Lt. Wellesley',
  'Pvt. Bonaparte', 'Sgt. Ney', 'Cpl. Murat', 'Lt. Lannes',
  'Pvt. Nelson', 'Pvt. Collingwood', 'Sgt. Davout', 'Cpl. Soult',
  'Pvt. Cornwallis', 'Sgt. Picton', 'Pvt. Massena', 'Cpl. Marmont'
];

function syncRoomBots(room) {
  const allPlayers = Object.values(room.players);
  const humanCount = allPlayers.filter((p) => !p.isBot).length;
  const desiredTotal = !room.enableBots || humanCount === 0 ? 0 : Math.max(12, humanCount + 8);

  const bots = allPlayers.filter((p) => p.isBot);
  if (bots.length < desiredTotal) {
    const redCount = allPlayers.filter((p) => p.team === 'red').length;
    const blueCount = allPlayers.filter((p) => p.team === 'blue').length;
    const team = redCount <= blueCount ? 'red' : 'blue';
    const classKeys = Object.keys(CLASSES);
    const pClass = classKeys[Math.floor(Math.random() * classKeys.length)];
    const botId = uid('bot');
    const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + ' [AI]';
    const bot = {
      id: botId,
      name: botName,
      team,
      playerClass: pClass,
      hat: VALID_HATS[Math.floor(Math.random() * VALID_HATS.length)],
      trim: 'gold',
      isBot: true,
      yaw: 0,
      pitch: 0,
      kills: 0,
      deaths: 0,
      captures: 0,
      aiTargetFortId: null,
      aiShootTimer: 1 + Math.random() * 2
    };
    respawnPlayer(room, bot);
    room.players[botId] = bot;
  } else if (bots.length > desiredTotal && bots.length > 0) {
    const toRemove = bots[bots.length - 1];
    detachPlayerFromEntity(room, toRemove);
    delete room.players[toRemove.id];
  }
}

function updateRoomBots(room, dt) {
  const players = Object.values(room.players);
  for (const bot of players) {
    if (!bot.isBot || bot.dead) continue;

    let nearestEnemy = null;
    let nearestEnemyDist = 140;
    for (const other of players) {
      if (other.dead || other.team === bot.team) continue;
      const d = Math.hypot(other.x - bot.x, other.z - bot.z);
      if (d < nearestEnemyDist) {
        nearestEnemyDist = d;
        nearestEnemy = other;
      }
    }

    let targetFort = room.forts.find((f) => f.id === bot.aiTargetFortId);
    if (!targetFort || (targetFort.owner === bot.team && Math.random() < 0.015)) {
      const enemyForts = room.forts.filter((f) => f.owner !== bot.team);
      const pool = enemyForts.length > 0 ? enemyForts : room.forts;
      targetFort = pool[Math.floor(Math.random() * pool.length)];
      bot.aiTargetFortId = targetFort ? targetFort.id : null;
    }

    let moveTargetX = targetFort ? targetFort.x : 0;
    let moveTargetZ = targetFort ? targetFort.z : 0;

    if (nearestEnemy && nearestEnemyDist < 85) {
      const dx = nearestEnemy.x - bot.x;
      const dz = nearestEnemy.z - bot.z;
      bot.yaw = Math.atan2(-dx, -dz);

      if (nearestEnemyDist > 26) {
        moveTargetX = nearestEnemy.x;
        moveTargetZ = nearestEnemy.z;
      } else {
        moveTargetX = bot.x + Math.cos(bot.yaw) * 8;
        moveTargetZ = bot.z - Math.sin(bot.yaw) * 8;
      }

      bot.aiShootTimer -= dt;
      if (bot.aiShootTimer <= 0 && bot.reloadTimer <= 0 && bot.attackCooldown <= 0) {
        if (nearestEnemyDist < 4.5) {
          bot.weaponIdx = CLASSES[bot.playerClass].weapons.findIndex((w) => WEAPON_STATS[w].type === 'melee');
          if (bot.weaponIdx < 0) bot.weaponIdx = 0;
        } else {
          bot.weaponIdx = 0;
        }
        performPlayerAttack(room, bot);
        bot.aiShootTimer = 1.3 + Math.random() * 1.9;
      }
    } else if (targetFort) {
      const dx = moveTargetX - bot.x;
      const dz = moveTargetZ - bot.z;
      bot.yaw = Math.atan2(-dx, -dz);
    }

    const dx = moveTargetX - bot.x;
    const dz = moveTargetZ - bot.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 4) {
      const cls = CLASSES[bot.playerClass] || CLASSES.musketeer;
      const speed = isWater(bot.x, bot.z) ? cls.speed * 0.55 : cls.speed * 0.85;
      bot.x += (dx / dist) * speed * dt;
      bot.z += (dz / dist) * speed * dt;
      bot.y = getTerrainHeight(bot.x, bot.z);
    }
  }
}

function performPlayerAttack(room, player) {
  if (player.dead || room.roundOver) return;
  const cls = CLASSES[player.playerClass] || CLASSES.musketeer;

  if (player.mountedType === 'cannon') {
    const cannon = room.cannons.find((c) => c.id === player.mountedId);
    if (cannon && cannon.reloadTimer <= 0) {
      cannon.reloadTimer = cannon.reloadTime * cls.reloadMult;
      const dirX = -Math.sin(cannon.yaw) * Math.cos(cannon.pitch);
      const dirY = Math.sin(cannon.pitch) + 0.08;
      const dirZ = -Math.cos(cannon.yaw) * Math.cos(cannon.pitch);

      room.projectiles.push({
        id: uid('proj'),
        kind: 'cannonball',
        ownerId: player.id,
        team: player.team,
        x: cannon.x + dirX * 3.2,
        y: cannon.y + 1.5,
        z: cannon.z + dirZ * 3.2,
        vx: dirX * 135,
        vy: dirY * 135,
        vz: dirZ * 135,
        damage: 140,
        splashRadius: 11,
        life: 4.5,
        weaponName: 'Field Cannon'
      });
      io.to(room.id).emit('fxEvent', { type: 'cannonFire', x: cannon.x, y: cannon.y + 1.4, z: cannon.z });
    }
    return;
  }

  if (player.mountedType === 'ship') {
    const ship = room.ships.find((s) => s.id === player.mountedId);
    if (ship && ship.portReload <= 0) {
      ship.portReload = 4.5;
      const sides = [-1, 1];
      sides.forEach((side) => {
        const broadsideYaw = ship.yaw + (side * Math.PI) / 2;
        for (let b = -1; b <= 1; b++) {
          const offsetForward = b * 6;
          const sx = ship.x - Math.sin(ship.yaw) * offsetForward - Math.sin(broadsideYaw) * 5;
          const sz = ship.z - Math.cos(ship.yaw) * offsetForward - Math.cos(broadsideYaw) * 5;
          room.projectiles.push({
            id: uid('proj'),
            kind: 'cannonball',
            ownerId: player.id,
            team: player.team,
            x: sx,
            y: 2.8,
            z: sz,
            vx: -Math.sin(broadsideYaw) * 125,
            vy: 8 + Math.random() * 3,
            vz: -Math.cos(broadsideYaw) * 125,
            damage: 150,
            splashRadius: 12,
            life: 4.5,
            weaponName: `${ship.name} Broadside`
          });
        }
      });
      io.to(room.id).emit('fxEvent', { type: 'shipBroadside', x: ship.x, y: 2.5, z: ship.z });
    }
    return;
  }

  const weaponKey = cls.weapons[player.weaponIdx] || cls.weapons[0];
  const weapon = WEAPON_STATS[weaponKey];
  if (!weapon || weapon.type === 'utility') return;

  if (weapon.type === 'ranged') {
    if (player.reloadTimer > 0 || player.attackCooldown > 0) return;
    player.reloadTimer = weapon.reload * cls.reloadMult;
    player.attackCooldown = 0.4;

    const eyeY = player.y + (player.mountedType === 'horse' ? 2.7 : player.crouching ? 1.1 : 1.65);
    const forwardX = -Math.sin(player.yaw) * Math.cos(player.pitch);
    const forwardY = Math.sin(player.pitch);
    const forwardZ = -Math.cos(player.yaw) * Math.cos(player.pitch);

    for (let p = 0; p < weapon.pellets; p++) {
      const sx = forwardX + (Math.random() - 0.5) * weapon.spread;
      const sy = forwardY + (Math.random() - 0.5) * weapon.spread;
      const sz = forwardZ + (Math.random() - 0.5) * weapon.spread;
      const len = Math.hypot(sx, sy, sz) || 1;

      room.projectiles.push({
        id: uid('proj'),
        kind: 'musketball',
        ownerId: player.id,
        team: player.team,
        x: player.x + (sx / len) * 1.2,
        y: eyeY,
        z: player.z + (sz / len) * 1.2,
        vx: (sx / len) * weapon.speed,
        vy: (sy / len) * weapon.speed,
        vz: (sz / len) * weapon.speed,
        damage: weapon.damage,
        splashRadius: 0,
        life: weapon.range / weapon.speed,
        weaponName: weaponKey.charAt(0).toUpperCase() + weaponKey.slice(1)
      });
    }

    io.to(room.id).emit('fxEvent', {
      type: 'musketFire',
      x: player.x + forwardX * 1.1,
      y: eyeY - 0.1,
      z: player.z + forwardZ * 1.1
    });
  } else if (weapon.type === 'melee') {
    if (player.attackCooldown > 0) return;
    player.attackCooldown = weapon.cooldown;

    const forwardX = -Math.sin(player.yaw);
    const forwardZ = -Math.cos(player.yaw);
    const mountedBonus = player.mountedType === 'horse' ? 1.35 : 1.0;

    Object.values(room.players).forEach((other) => {
      if (other.id === player.id || other.dead || other.team === player.team) return;
      const dx = other.x - player.x;
      const dz = other.z - player.z;
      const dy = Math.abs(other.y - player.y);
      const dist = Math.hypot(dx, dz);
      if (dist <= weapon.range && dy < 3.5) {
        const dot = (dx * forwardX + dz * forwardZ) / (dist || 1);
        if (dot > 0.35) {
          damagePlayer(
            room,
            other,
            Math.round(weapon.damage * mountedBonus),
            player.id,
            weaponKey.charAt(0).toUpperCase() + weaponKey.slice(1)
          );
        }
      }
    });
  }
}

function tickRoom(room, dt) {
  syncRoomBots(room);

  // Clean expired reconnection tokens (> 60s)
  const nowMs = Date.now();
  for (const [token, saved] of room.disconnectedSessions.entries()) {
    if (nowMs - saved.disconnectedAt > 60000) {
      room.disconnectedSessions.delete(token);
    }
  }

  if (room.roundOver) {
    room.roundEndTimer -= dt;
    if (room.roundEndTimer <= 0) {
      room.round += 1;
      initRoomWorld(room);
      io.to(room.id).emit('roundReset', { round: room.round });
    }
    broadcastRoomSnapshot(room);
    return;
  }

  updateRoomBots(room, dt);

  Object.values(room.players).forEach((p) => {
    if (p.dead) {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) {
        respawnPlayer(room, p);
        if (!p.isBot) io.to(p.id).emit('playerRespawned');
      }
      return;
    }
    if (p.reloadTimer > 0) p.reloadTimer = Math.max(0, p.reloadTimer - dt);
    if (p.attackCooldown > 0) p.attackCooldown = Math.max(0, p.attackCooldown - dt);

    if (p.mountedType === 'horse') {
      const h = room.horses.find((item) => item.id === p.mountedId);
      if (h && h.hp > 0) {
        p.x = h.x;
        p.y = h.y;
        p.z = h.z;
      } else {
        detachPlayerFromEntity(room, p);
      }
    } else if (p.mountedType === 'cannon') {
      const c = room.cannons.find((item) => item.id === p.mountedId);
      if (c) {
        c.yaw = p.yaw;
        c.pitch = Math.max(-0.15, Math.min(0.45, p.pitch));
        p.x = c.x + Math.sin(c.yaw) * 1.4;
        p.z = c.z + Math.cos(c.yaw) * 1.4;
        p.y = c.y;
      } else {
        detachPlayerFromEntity(room, p);
      }
    } else if (p.mountedType === 'ship') {
      const s = room.ships.find((item) => item.id === p.mountedId);
      if (s && s.hp > 0) {
        p.x = s.x;
        p.y = s.y + 3.2;
        p.z = s.z;
      } else {
        detachPlayerFromEntity(room, p);
      }
    }
  });

  room.cannons.forEach((c) => {
    if (c.reloadTimer > 0) c.reloadTimer = Math.max(0, c.reloadTimer - dt);
  });

  room.ships.forEach((s) => {
    if (s.portReload > 0) s.portReload = Math.max(0, s.portReload - dt);
    if (s.starboardReload > 0) s.starboardReload = Math.max(0, s.starboardReload - dt);

    s.speed *= Math.pow(0.65, dt);
    const nextX = s.x - Math.sin(s.yaw) * s.speed * dt;
    const nextZ = s.z - Math.cos(s.yaw) * s.speed * dt;
    if (isWater(nextX, nextZ) && Math.hypot(nextX, nextZ) < MAP_RADIUS + 180) {
      s.x = nextX;
      s.z = nextZ;
    } else {
      s.speed = -s.speed * 0.3;
    }
  });

  for (let i = room.projectiles.length - 1; i >= 0; i--) {
    const proj = room.projectiles[i];
    proj.life -= dt;
    proj.vy -= (proj.kind === 'cannonball' ? 18 : 4.5) * dt;

    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
    proj.z += proj.vz * dt;

    let hit = false;

    for (const p of Object.values(room.players)) {
      if (p.dead || p.team === proj.team || p.id === proj.ownerId) continue;
      const hitRadius = proj.kind === 'cannonball' ? 2.4 : 1.15;
      const pCenterY = p.y + (p.crouching ? 0.75 : 1.1);
      const dist = Math.hypot(proj.x - p.x, proj.y - pCenterY, proj.z - p.z);
      if (dist <= hitRadius) {
        damagePlayer(room, p, proj.damage, proj.ownerId, proj.weaponName);
        hit = true;
        break;
      }
    }

    if (!hit && proj.kind === 'cannonball') {
      for (const s of room.ships) {
        if (s.team === proj.team) continue;
        if (Math.hypot(proj.x - s.x, proj.z - s.z) < 11 && proj.y < 7) {
          s.hp -= proj.damage;
          hit = true;
          if (s.hp <= 0) {
            if (s.captainId && room.players[s.captainId]) {
              damagePlayer(room, room.players[s.captainId], 999, proj.ownerId, proj.weaponName);
            }
            s.hp = s.maxHp;
            s.x = s.spawnX;
            s.z = s.spawnZ;
            s.yaw = s.spawnYaw;
            s.speed = 0;
          }
          break;
        }
      }
    }

    const groundY = getTerrainHeight(proj.x, proj.z);
    if (!hit && proj.y <= groundY) {
      hit = true;
    }

    if (hit || proj.life <= 0) {
      if (proj.kind === 'cannonball') {
        Object.values(room.players).forEach((p) => {
          if (p.dead || p.team === proj.team) return;
          const d = Math.hypot(p.x - proj.x, p.y - proj.y, p.z - proj.z);
          if (d <= proj.splashRadius) {
            const falloff = 1 - d / proj.splashRadius;
            damagePlayer(room, p, Math.round(proj.damage * falloff), proj.ownerId, proj.weaponName);
          }
        });
        io.to(room.id).emit('fxEvent', { type: 'explosion', x: proj.x, y: Math.max(groundY, proj.y), z: proj.z });
      }
      room.projectiles.splice(i, 1);
    }
  }

  let redForts = 0;
  let blueForts = 0;

  room.forts.forEach((fort) => {
    let redNear = 0;
    let blueNear = 0;
    const capturers = [];

    Object.values(room.players).forEach((p) => {
      if (p.dead) return;
      const d = Math.hypot(p.x - fort.x, p.z - fort.z);
      if (d <= fort.radius) {
        if (p.team === 'red') redNear++;
        else if (p.team === 'blue') blueNear++;
        capturers.push(p);
      }
    });

    if (redNear > 0 && blueNear === 0) {
      fort.captureProgress = Math.max(-100, fort.captureProgress - (6 + redNear * 3) * dt);
      if (fort.captureProgress <= -50 && fort.owner !== 'red') {
        fort.owner = 'red';
        capturers.forEach((c) => {
          c.captures = (c.captures || 0) + 1;
          if (!c.isBot && c.profileId) {
            getOrCreateProfile(c.profileId, c.name).captures += 1;
            statsDirty = true;
          }
        });
        io.to(room.id).emit('fortCaptured', { fortName: fort.name, team: 'red' });
      }
    } else if (blueNear > 0 && redNear === 0) {
      fort.captureProgress = Math.min(100, fort.captureProgress + (6 + blueNear * 3) * dt);
      if (fort.captureProgress >= 50 && fort.owner !== 'blue') {
        fort.owner = 'blue';
        capturers.forEach((c) => {
          c.captures = (c.captures || 0) + 1;
          if (!c.isBot && c.profileId) {
            getOrCreateProfile(c.profileId, c.name).captures += 1;
            statsDirty = true;
          }
        });
        io.to(room.id).emit('fortCaptured', { fortName: fort.name, team: 'blue' });
      }
    }

    if (fort.owner === 'red') redForts++;
    else if (fort.owner === 'blue') blueForts++;
  });

  const halfForts = room.forts.length / 2;
  if (redForts > halfForts) {
    const advantage = redForts - halfForts;
    room.redPoints = Math.min(WIN_POINTS, room.redPoints + advantage * 2.8 * dt);
  } else if (blueForts > halfForts) {
    const advantage = blueForts - halfForts;
    room.bluePoints = Math.min(WIN_POINTS, room.bluePoints + advantage * 2.8 * dt);
  }

  if (room.redPoints >= WIN_POINTS || room.bluePoints >= WIN_POINTS) {
    room.roundOver = true;
    room.winner = room.redPoints >= WIN_POINTS ? 'red' : 'blue';
    room.roundEndTimer = 10.0;

    Object.values(room.players).forEach((p) => {
      if (!p.isBot && p.team === room.winner && p.profileId) {
        getOrCreateProfile(p.profileId, p.name).wins += 1;
        statsDirty = true;
      }
    });

    const scoreboard = Object.values(room.players)
      .map((p) => ({
        name: p.name,
        team: p.team,
        playerClass: p.playerClass,
        kills: p.kills || 0,
        deaths: p.deaths || 0,
        captures: p.captures || 0
      }))
      .sort((a, b) => b.kills - a.kills)
      .slice(0, 12);

    io.to(room.id).emit('roundEnded', {
      winner: room.winner,
      redPoints: Math.round(room.redPoints),
      bluePoints: Math.round(room.bluePoints),
      scoreboard
    });
  }

  broadcastRoomSnapshot(room);
}

function broadcastRoomSnapshot(room) {
  const compactPlayers = {};
  for (const [id, p] of Object.entries(room.players)) {
    compactPlayers[id] = {
      id: p.id,
      name: p.name,
      team: p.team,
      c: p.playerClass,
      hat: p.hat || 'shako',
      trim: p.trim || 'gold',
      x: +p.x.toFixed(2),
      y: +p.y.toFixed(2),
      z: +p.z.toFixed(2),
      yaw: +p.yaw.toFixed(3),
      pitch: +p.pitch.toFixed(3),
      hp: Math.round(p.hp),
      maxHp: p.maxHp,
      dead: p.dead,
      respawn: +Math.max(0, p.respawnTimer || 0).toFixed(1),
      crouch: !!p.crouching,
      wIdx: p.weaponIdx,
      reload: +p.reloadTimer.toFixed(2),
      mType: p.mountedType,
      mId: p.mountedId,
      kills: p.kills || 0,
      deaths: p.deaths || 0,
      captures: p.captures || 0
    };
  }

  io.to(room.id).emit('state', {
    roomId: room.id,
    roomName: room.name,
    inviteCode: room.inviteCode,
    round: room.round,
    redPoints: Math.round(room.redPoints),
    bluePoints: Math.round(room.bluePoints),
    roundOver: room.roundOver,
    winner: room.winner,
    forts: room.forts.map((f) => ({
      id: f.id,
      name: f.name,
      x: +f.x.toFixed(1),
      y: +f.y.toFixed(1),
      z: +f.z.toFixed(1),
      owner: f.owner,
      prog: Math.round(f.captureProgress)
    })),
    horses: room.horses.map((h) => ({
      id: h.id,
      x: +h.x.toFixed(2),
      y: +h.y.toFixed(2),
      z: +h.z.toFixed(2),
      yaw: +h.yaw.toFixed(3),
      riderId: h.riderId
    })),
    cannons: room.cannons.map((c) => ({
      id: c.id,
      x: +c.x.toFixed(2),
      y: +c.y.toFixed(2),
      z: +c.z.toFixed(2),
      yaw: +c.yaw.toFixed(3),
      pitch: +c.pitch.toFixed(3),
      opId: c.operatorId,
      reload: +c.reloadTimer.toFixed(1)
    })),
    ships: room.ships.map((s) => ({
      id: s.id,
      name: s.name,
      team: s.team,
      x: +s.x.toFixed(2),
      y: +s.y.toFixed(2),
      z: +s.z.toFixed(2),
      yaw: +s.yaw.toFixed(3),
      hp: Math.round(s.hp),
      capId: s.captainId,
      reload: +s.portReload.toFixed(1)
    })),
    projectiles: room.projectiles.map((pr) => ({
      id: pr.id,
      k: pr.kind,
      x: +pr.x.toFixed(2),
      y: +pr.y.toFixed(2),
      z: +pr.z.toFixed(2)
    })),
    players: compactPlayers
  });
}

// Create default public servers
createRoom({ id: 'eu-waterloo', name: 'Waterloo Campaign [Public #1]', isPrivate: false, maxPlayers: 32, enableBots: true });
createRoom({ id: 'na-trafalgar', name: 'Trafalgar Straits [Public #2]', isPrivate: false, maxPlayers: 32, enableBots: true });

// Simulation Loop across all active rooms
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  for (const [roomId, room] of rooms.entries()) {
    const humanPlayers = Object.values(room.players).filter((p) => !p.isBot);
    // Prune empty private rooms after 5 minutes
    if (room.isPrivate && humanPlayers.length === 0 && now - room.createdAt > 300000) {
      rooms.delete(roomId);
      continue;
    }
    tickRoom(room, dt);
  }
}, 1000 / TICK_RATE);

// --- HTTP API & HEALTH CHECK ENDPOINTS ---
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/rooms', (req, res) => {
  const list = [];
  for (const room of rooms.values()) {
    if (room.isPrivate) continue;
    const humans = Object.values(room.players).filter((p) => !p.isBot).length;
    const bots = Object.values(room.players).filter((p) => p.isBot).length;
    list.push({
      id: room.id,
      name: room.name,
      humans,
      bots,
      maxPlayers: room.maxPlayers,
      round: room.round,
      redPoints: Math.round(room.redPoints),
      bluePoints: Math.round(room.bluePoints)
    });
  }
  res.json(list);
});

app.get('/api/profile/:id', (req, res) => {
  const prof = getOrCreateProfile(req.params.id);
  res.json(prof);
});

// --- SOCKET.IO CONNECTION & HANDLERS ---
io.on('connection', (socket) => {
  let currentRoomId = null;
  let lastChatAt = 0;

  function leaveCurrentRoom(preserveForReconnect = false) {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (room && room.players[socket.id]) {
      const p = room.players[socket.id];
      detachPlayerFromEntity(room, p);
      if (preserveForReconnect && p.sessionToken) {
        room.disconnectedSessions.set(p.sessionToken, {
          name: p.name,
          team: p.team,
          playerClass: p.playerClass,
          hat: p.hat,
          trim: p.trim,
          profileId: p.profileId,
          kills: p.kills,
          deaths: p.deaths,
          captures: p.captures,
          disconnectedAt: Date.now()
        });
      }
      delete room.players[socket.id];
    }
    socket.leave(currentRoomId);
    currentRoomId = null;
  }

  socket.on('listRooms', () => {
    const list = [];
    for (const room of rooms.values()) {
      if (room.isPrivate) continue;
      const humans = Object.values(room.players).filter((p) => !p.isBot).length;
      const bots = Object.values(room.players).filter((p) => !p.isBot).length;
      list.push({
        id: room.id,
        name: room.name,
        humans,
        bots,
        maxPlayers: room.maxPlayers,
        round: room.round,
        redPoints: Math.round(room.redPoints),
        bluePoints: Math.round(room.bluePoints)
      });
    }
    socket.emit('roomList', list);
  });

  socket.on('createPrivateRoom', (payload) => {
    const { roomName, enableBots } = (payload && typeof payload === 'object') ? payload : {};
    const id = uid('priv');
    const room = createRoom({
      id,
      name: roomName || 'Private Regiment Match',
      isPrivate: true,
      maxPlayers: 24,
      enableBots: enableBots !== false
    });
    socket.emit('privateRoomCreated', { roomId: room.id, inviteCode: room.inviteCode, name: room.name });
  });

  socket.on('joinBattle', (payload) => {
    const { roomId, inviteCode, name, team, playerClass, hat, trim, profileId, sessionToken } = (payload && typeof payload === 'object') ? payload : {};
    leaveCurrentRoom(false);

    let targetRoom = null;
    if (inviteCode) {
      const cleanCode = String(inviteCode).trim().toUpperCase();
      for (const r of rooms.values()) {
        if (r.inviteCode === cleanCode) {
          targetRoom = r;
          break;
        }
      }
      if (!targetRoom) {
        socket.emit('joinError', { message: 'Invalid or expired Private Match code.' });
        return;
      }
    } else if (roomId && rooms.has(roomId)) {
      targetRoom = rooms.get(roomId);
    } else {
      targetRoom = rooms.get('eu-waterloo') || Array.from(rooms.values())[0];
    }

    const humanCount = Object.values(targetRoom.players).filter((p) => !p.isBot).length;
    if (humanCount >= targetRoom.maxPlayers) {
      socket.emit('joinError', { message: 'That server is currently full.' });
      return;
    }

    // Check if reconnecting with an active session token
    const token = String(sessionToken || crypto.randomUUID()).slice(0, 64);
    const restored = targetRoom.disconnectedSessions.get(token);
    if (restored) {
      targetRoom.disconnectedSessions.delete(token);
    }

    const cleanName = sanitizeText(name || (restored && restored.name) || 'Soldier', 18) || 'Soldier';
    const validTeam =
      team === 'red' || team === 'blue'
        ? team
        : restored
        ? restored.team
        : Math.random() < 0.5
        ? 'red'
        : 'blue';
    const validClass = CLASSES[playerClass]
      ? playerClass
      : restored && CLASSES[restored.playerClass]
      ? restored.playerClass
      : 'musketeer';
    const validHat = VALID_HATS.includes(hat) ? hat : (restored && restored.hat) || 'shako';
    const validTrim = VALID_TRIMS.includes(trim) ? trim : (restored && restored.trim) || 'gold';

    const profile = getOrCreateProfile(profileId || (restored && restored.profileId), cleanName);

    const player = {
      id: socket.id,
      sessionToken: token,
      profileId: profile.id,
      name: cleanName,
      team: validTeam,
      playerClass: validClass,
      hat: validHat,
      trim: validTrim,
      isBot: false,
      yaw: 0,
      pitch: 0,
      kills: restored ? restored.kills : 0,
      deaths: restored ? restored.deaths : 0,
      captures: restored ? restored.captures : 0,
      lastInputAt: 0
    };

    respawnPlayer(targetRoom, player);
    targetRoom.players[socket.id] = player;
    currentRoomId = targetRoom.id;
    socket.join(targetRoom.id);

    socket.emit('joined', {
      id: socket.id,
      roomId: targetRoom.id,
      roomName: targetRoom.name,
      inviteCode: targetRoom.inviteCode,
      team: validTeam,
      playerClass: validClass,
      hat: validHat,
      trim: validTrim,
      sessionToken: token,
      profile
    });
  });

  socket.on('switchLoadout', (payload) => {
    const { team, playerClass, hat, trim } = (payload && typeof payload === 'object') ? payload : {};
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const p = room && room.players[socket.id];
    if (!p) return;
    if (team === 'red' || team === 'blue') p.team = team;
    if (CLASSES[playerClass]) p.playerClass = playerClass;
    if (VALID_HATS.includes(hat)) p.hat = hat;
    if (VALID_TRIMS.includes(trim)) p.trim = trim;
    detachPlayerFromEntity(room, p);
    respawnPlayer(room, p);
  });

  socket.on('input', (data) => {
    if (!currentRoomId || !data || typeof data !== 'object') return;
    const room = rooms.get(currentRoomId);
    const p = room && room.players[socket.id];
    if (!p || p.dead || room.roundOver) return;

    // Basic anti-speedhack rate clamp
    const now = Date.now();
    const dt = Math.min(0.06, Math.max(0.015, (now - (p.lastInputAt || now - 50)) / 1000));
    p.lastInputAt = now;

    if (Number.isFinite(Number(data.yaw))) p.yaw = Number(data.yaw);
    if (Number.isFinite(Number(data.pitch))) {
      p.pitch = Math.max(-1.45, Math.min(1.45, Number(data.pitch)));
    }
    if (typeof data.crouch === 'boolean') p.crouching = data.crouch;

    if (typeof data.weaponIdx === 'number' && Number.isInteger(data.weaponIdx) && data.weaponIdx >= 0 && data.weaponIdx <= 2) {
      p.weaponIdx = data.weaponIdx;
    }

    const forward = (data.w ? 1 : 0) - (data.s ? 1 : 0);
    const strafe = (data.d ? 1 : 0) - (data.a ? 1 : 0);

    if (p.mountedType === 'ship') {
      const ship = room.ships.find((s) => s.id === p.mountedId);
      if (ship) {
        if (forward !== 0) {
          ship.speed = Math.max(-12, Math.min(26, ship.speed + forward * 16 * dt));
        }
        if (strafe !== 0) {
          ship.yaw -= strafe * 0.65 * dt;
        }
      }
      return;
    }

    if (p.mountedType === 'horse') {
      const horse = room.horses.find((h) => h.id === p.mountedId);
      if (horse) {
        if (strafe !== 0) {
          horse.yaw -= strafe * 2.2 * dt;
        }
        if (forward !== 0) {
          const maxHorseSpeed = p.playerClass === 'cavalry' ? 32 : 27;
          horse.speed = Math.max(-10, Math.min(maxHorseSpeed, horse.speed + forward * 38 * dt));
        } else {
          horse.speed *= 0.88;
        }
        const nx = horse.x - Math.sin(horse.yaw) * horse.speed * dt;
        const nz = horse.z - Math.cos(horse.yaw) * horse.speed * dt;
        if (Math.hypot(nx, nz) < MAP_RADIUS + 10) {
          horse.x = nx;
          horse.z = nz;
          horse.y = getTerrainHeight(nx, nz);
        }
        p.x = horse.x;
        p.y = horse.y;
        p.z = horse.z;
      }
      return;
    }

    if (p.mountedType === 'cannon') {
      const cannon = room.cannons.find((c) => c.id === p.mountedId);
      if (cannon && strafe !== 0) {
        cannon.yaw -= strafe * 0.9 * dt;
        p.yaw = cannon.yaw;
      }
      return;
    }

    const cls = CLASSES[p.playerClass] || CLASSES.musketeer;
    let speed = cls.speed;
    if (p.crouching) speed *= 0.55;
    if (isWater(p.x, p.z)) speed *= 0.52;

    if (forward !== 0 || strafe !== 0) {
      const sin = Math.sin(p.yaw);
      const cos = Math.cos(p.yaw);
      let vx = -sin * forward + cos * strafe;
      let vz = -cos * forward - sin * strafe;
      const len = Math.hypot(vx, vz) || 1;
      vx = (vx / len) * speed * dt;
      vz = (vz / len) * speed * dt;

      const nx = p.x + vx;
      const nz = p.z + vz;
      if (Math.hypot(nx, nz) < MAP_RADIUS + 18) {
        p.x = nx;
        p.z = nz;
      }
    }

    const groundY = getTerrainHeight(p.x, p.z);
    if (data.jump && p.onGround) {
      p.vy = 11.5;
      p.onGround = false;
    }

    p.vy = (p.vy || 0) - 28 * dt;
    p.y += p.vy * dt;
    if (p.y <= groundY) {
      p.y = groundY;
      p.vy = 0;
      p.onGround = true;
    }
  });

  socket.on('action', (payload) => {
    const { type } = (payload && typeof payload === 'object') ? payload : {};
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const p = room && room.players[socket.id];
    if (!p || p.dead || room.roundOver) return;

    if (type === 'attack') {
      performPlayerAttack(room, p);
    } else if (type === 'reload') {
      const cls = CLASSES[p.playerClass] || CLASSES.musketeer;
      const weaponKey = cls.weapons[p.weaponIdx] || cls.weapons[0];
      const weapon = WEAPON_STATS[weaponKey];
      if (weapon && weapon.type === 'ranged' && p.reloadTimer <= 0) {
        p.reloadTimer = weapon.reload * cls.reloadMult;
      }
    } else if (type === 'interact') {
      if (p.mountedType) {
        detachPlayerFromEntity(room, p);
        p.y = getTerrainHeight(p.x, p.z);
        return;
      }

      for (const h of room.horses) {
        if (!h.riderId && Math.hypot(h.x - p.x, h.z - p.z) < 5.5) {
          h.riderId = p.id;
          p.mountedType = 'horse';
          p.mountedId = h.id;
          return;
        }
      }

      for (const c of room.cannons) {
        if (!c.operatorId && Math.hypot(c.x - p.x, c.z - p.z) < 5.5) {
          c.operatorId = p.id;
          p.mountedType = 'cannon';
          p.mountedId = c.id;
          p.yaw = c.yaw;
          return;
        }
      }

      for (const s of room.ships) {
        if (!s.captainId && Math.hypot(s.x - p.x, s.z - p.z) < 16) {
          s.captainId = p.id;
          p.mountedType = 'ship';
          p.mountedId = s.id;
          return;
        }
      }
    }
  });

  socket.on('chat', (payload) => {
    const { channel, text } = (payload && typeof payload === 'object') ? payload : {};
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const p = room && room.players[socket.id];
    if (!p) return;

    // Rate limit chat to 1 message per 650ms
    const now = Date.now();
    if (now - lastChatAt < 650) return;
    lastChatAt = now;

    const msg = sanitizeText(text, 140);
    if (!msg) return;

    if (channel === 'team') {
      Object.values(room.players).forEach((recipient) => {
        if (!recipient.isBot && recipient.team === p.team) {
          io.to(recipient.id).emit('chatMessage', {
            sender: p.name,
            team: p.team,
            channel: 'TEAM',
            text: msg
          });
        }
      });
    } else {
      io.to(room.id).emit('chatMessage', {
        sender: p.name,
        team: p.team,
        channel: 'ALL',
        text: msg
      });
    }
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(true);
  });
});

server.listen(PORT, () => {
  console.log(`Frontier: Napoleonic Conquest Server running on port ${PORT}`);
});
