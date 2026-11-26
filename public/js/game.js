const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000
});

// --- CONSTANTS & SHARED TERRAIN MATH ---
const MAP_RADIUS = 520;
const RIVER_HALF_WIDTH = 34;

const CLASS_WEAPONS = {
  musketeer: ['Musket', 'Pistol', 'Bayonet'],
  cavalry: ['Pistol', 'Saber', 'Spyglass'],
  cannoneer: ['Pistol', 'Hammer', 'Spyglass'],
  sailor: ['Blunderbuss', 'Cutlass', 'Spyglass']
};

const TRIM_HEX = {
  gold: 0xf6e05e,
  white: 0xf7fafc,
  silver: 0xcbd5e0,
  crimson: 0x9b2c2c
};

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

// --- PROCEDURAL WEB AUDIO ENGINE ---
const SoundEngine = {
  ctx: null,
  masterVol: 0.7,
  sfxVol: 0.8,
  ensure() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  },
  playNoise(duration, filterFreq, gainVal) {
    this.ensure();
    if (!this.ctx || this.masterVol <= 0 || this.sfxVol <= 0) return;
    const sampleRate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, sampleRate * duration, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sampleRate * (duration * 0.35)));
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;

    const gain = this.ctx.createGain();
    gain.gain.value = gainVal * this.masterVol * this.sfxVol;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    src.start();
  },
  playTone(freqStart, freqEnd, duration, type = 'triangle', gainVal = 0.25) {
    this.ensure();
    if (!this.ctx || this.masterVol <= 0 || this.sfxVol <= 0) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), this.ctx.currentTime + duration);

    gain.gain.setValueAtTime(gainVal * this.masterVol * this.sfxVol, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  },
  musket() {
    this.playNoise(0.32, 1600, 0.45);
    this.playTone(220, 55, 0.16, 'sawtooth', 0.22);
  },
  cannon() {
    this.playNoise(0.85, 420, 0.7);
    this.playTone(110, 28, 0.55, 'sine', 0.45);
  },
  reload() {
    this.playTone(520, 740, 0.12, 'triangle', 0.15);
  },
  horn() {
    this.playTone(293.66, 293.66, 0.45, 'sawtooth', 0.18);
    setTimeout(() => this.playTone(440, 440, 0.65, 'sawtooth', 0.2), 220);
  }
};

// --- THREE.JS SCENE SETUP ---
const canvas = document.getElementById('gameCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5d6);
scene.fog = new THREE.FogExp2(0x87b5d6, 0.00145);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.2, 1600);

const hemiLight = new THREE.HemisphereLight(0xfff5e4, 0x3b5238, 0.78);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xfff1d6, 1.05);
sunLight.position.set(220, 360, 180);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
sunLight.shadow.camera.near = 10;
sunLight.shadow.camera.far = 900;
const shadowBound = 320;
sunLight.shadow.camera.left = -shadowBound;
sunLight.shadow.camera.right = shadowBound;
sunLight.shadow.camera.top = shadowBound;
sunLight.shadow.camera.bottom = -shadowBound;
scene.add(sunLight);

function applyGraphicsQuality(level) {
  if (level === 'low') {
    renderer.shadowMap.enabled = false;
    sunLight.castShadow = false;
    renderer.setPixelRatio(1);
    scene.fog.density = 0.0018;
  } else if (level === 'high') {
    renderer.shadowMap.enabled = true;
    sunLight.castShadow = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    scene.fog.density = 0.0012;
  } else {
    renderer.shadowMap.enabled = true;
    sunLight.castShadow = true;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    scene.fog.density = 0.00145;
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function buildTerrain() {
  const size = 1350;
  const segments = 160;
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = [];
  const color = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = getTerrainHeight(x, z);
    pos.setY(i, y);

    if (y < 0.2) {
      color.setHex(0xc2b280);
    } else if (y < 1.8) {
      color.setHex(0xd8c894);
    } else if (y > 8.5) {
      color.setHex(0x6b705c);
    } else {
      color.setHex(0x4a7c38);
    }
    colors.push(color.r, color.g, color.b);
  }

  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.05
  });

  const terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  const waterGeo = new THREE.PlaneGeometry(2600, 2600);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1d5b79,
    roughness: 0.25,
    metalness: 0.35,
    transparent: true,
    opacity: 0.88
  });
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.position.y = 0.0;
  scene.add(waterMesh);

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3d28 });
  const leavesMat = new THREE.MeshStandardMaterial({ color: 0x2d5a27 });
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3.2, 6);
  const leavesGeo = new THREE.ConeGeometry(2.4, 6.2, 7);

  for (let i = 0; i < 190; i++) {
    const angle = (i * 137.5 * Math.PI) / 180;
    const radius = 50 + ((i * 29) % (MAP_RADIUS - 85));
    const tx = Math.cos(angle) * radius;
    const tz = Math.sin(angle) * radius;
    const ty = getTerrainHeight(tx, tz);
    if (ty > 2.2) {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 1.6;
      const leaves = new THREE.Mesh(leavesGeo, leavesMat);
      leaves.position.y = 5.4;
      tree.add(trunk, leaves);
      tree.position.set(tx, ty, tz);
      scene.add(tree);
    }
  }
}
buildTerrain();

// --- ENTITY MESH POOLS ---
let fortMeshes = {};
let playerMeshes = {};
let horseMeshes = {};
let cannonMeshes = {};
let shipMeshes = {};
let projectileMeshes = {};
const smokeParticles = [];

function clearEntityPools() {
  Object.values(fortMeshes).forEach((m) => scene.remove(m.group));
  Object.values(playerMeshes).forEach((m) => scene.remove(m.group));
  Object.values(horseMeshes).forEach((m) => scene.remove(m));
  Object.values(cannonMeshes).forEach((m) => scene.remove(m.group));
  Object.values(shipMeshes).forEach((m) => scene.remove(m));
  Object.values(projectileMeshes).forEach((m) => scene.remove(m));
  fortMeshes = {};
  playerMeshes = {};
  horseMeshes = {};
  cannonMeshes = {};
  shipMeshes = {};
  projectileMeshes = {};
}

function createFortMesh(fort) {
  const group = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x8d8980, roughness: 0.9 });
  for (let s = 0; s < 4; s++) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(16, 4.2, 1.8), wallMat);
    const angle = (s * Math.PI) / 2;
    wall.position.set(Math.sin(angle) * 14, 2.1, Math.cos(angle) * 14);
    wall.rotation.y = angle;
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);
  }

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.22, 18, 8),
    new THREE.MeshStandardMaterial({ color: 0x4a3525 })
  );
  pole.position.y = 9;
  group.add(pole);

  const flagMat = new THREE.MeshStandardMaterial({
    color: fort.owner === 'red' ? 0xdc2626 : 0x2563eb,
    side: THREE.DoubleSide
  });
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 3.4), flagMat);
  flag.position.set(2.8, 16, 0);
  group.add(flag);

  const ringMat = new THREE.MeshBasicMaterial({
    color: fort.owner === 'red' ? 0xef4444 : 0x3b82f6,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(24.8, 26, 36), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.25;
  group.add(ring);

  group.position.set(fort.x, fort.y, fort.z);
  scene.add(group);
  return { group, flag, flagMat, ringMat };
}

function createSoldierMesh(team, hatStyle, trimStyle) {
  const group = new THREE.Group();
  const coatColor = team === 'red' ? 0xc53030 : 0x2b6cb0;
  const trimColor = TRIM_HEX[trimStyle] || 0xf6e05e;
  const coatMat = new THREE.MeshStandardMaterial({ color: coatColor });
  const trimMat = new THREE.MeshStandardMaterial({ color: trimColor });
  const trousersMat = new THREE.MeshStandardMaterial({ color: 0xf7fafc });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xfbd38d });
  const hatMat = new THREE.MeshStandardMaterial({ color: 0x1a202c });

  const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.9, 0.32), trousersMat);
  leftLeg.position.set(-0.2, 0.45, 0);
  const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.9, 0.32), trousersMat);
  rightLeg.position.set(0.2, 0.45, 0);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.76, 1.0, 0.44), coatMat);
  torso.position.y = 1.38;
  torso.castShadow = true;

  // Epaulette shoulder trims
  const leftEp = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.46), trimMat);
  leftEp.position.set(-0.42, 1.84, 0);
  const rightEp = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.46), trimMat);
  rightEp.position.set(0.42, 1.84, 0);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.44), skinMat);
  head.position.y = 2.12;

  let hat;
  if (hatStyle === 'bearskin') {
    hat = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.27, 0.68, 10), hatMat);
    hat.position.y = 2.65;
  } else if (hatStyle === 'bicorne' || hatStyle === 'tricorne') {
    hat = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.32, 0.34), hatMat);
    hat.position.y = 2.48;
  } else {
    hat = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.42, 10), hatMat);
    hat.position.y = 2.52;
  }

  const gunGroup = new THREE.Group();
  const stock = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.14, 1.45),
    new THREE.MeshStandardMaterial({ color: 0x5c3d28 })
  );
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 1.55, 6),
    new THREE.MeshStandardMaterial({ color: 0x718096, metalness: 0.7 })
  );
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.06, -0.25);
  gunGroup.add(stock, barrel);
  gunGroup.position.set(0.35, 1.48, -0.55);

  group.add(leftLeg, rightLeg, torso, leftEp, rightEp, head, hat, gunGroup);
  scene.add(group);
  return { group, leftLeg, rightLeg, gunGroup, key: `${team}_${hatStyle}_${trimStyle}` };
}

function createHorseMesh() {
  const group = new THREE.Group();
  const brownMat = new THREE.MeshStandardMaterial({ color: 0x6b4226 });
  const maneMat = new THREE.MeshStandardMaterial({ color: 0x1a1412 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.05, 2.35), brownMat);
  body.position.y = 1.35;
  body.castShadow = true;

  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.52, 1.05, 0.65), brownMat);
  neck.position.set(0, 2.05, -0.95);
  neck.rotation.x = -0.35;

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.48, 0.85), brownMat);
  head.position.set(0, 2.48, -1.32);

  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.95, 0.22), maneMat);
  tail.position.set(0, 1.25, 1.25);

  group.add(body, neck, head, tail);
  for (const lx of [-0.36, 0.36]) {
    for (const lz of [-0.82, 0.82]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 1.1, 0.24), brownMat);
      leg.position.set(lx, 0.55, lz);
      group.add(leg);
    }
  }

  scene.add(group);
  return group;
}

function createCannonMesh() {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b4423 });
  const ironMat = new THREE.MeshStandardMaterial({ color: 0x2d3748, metalness: 0.75, roughness: 0.35 });

  const carriage = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.65, 2.2), woodMat);
  carriage.position.y = 0.75;

  const wheelGeo = new THREE.CylinderGeometry(0.68, 0.68, 0.22, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const wLeft = new THREE.Mesh(wheelGeo, woodMat);
  wLeft.position.set(-0.82, 0.68, -0.35);
  const wRight = new THREE.Mesh(wheelGeo, woodMat);
  wRight.position.set(0.82, 0.68, -0.35);

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, 2.8, 12), ironMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 1.22, -0.45);

  group.add(carriage, wLeft, wRight, barrel);
  scene.add(group);
  return { group, barrel };
}

function createShipMesh(team) {
  const group = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x5c3a21 });
  const trimMat = new THREE.MeshStandardMaterial({ color: team === 'red' ? 0xb91c1c : 0x1d4ed8 });
  const sailMat = new THREE.MeshStandardMaterial({ color: 0xf7fafc, side: THREE.DoubleSide });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(7.2, 3.4, 24), hullMat);
  hull.position.y = 1.4;
  hull.castShadow = true;

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.65, 24.2), trimMat);
  stripe.position.y = 2.6;

  const bow = new THREE.Mesh(new THREE.ConeGeometry(3.6, 6.5, 4), hullMat);
  bow.rotation.x = -Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.position.set(0, 1.5, -14.8);

  group.add(hull, stripe, bow);

  [-6, 0, 6].forEach((mz, idx) => {
    const h = idx === 1 ? 18 : 15;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, h, 8), hullMat);
    mast.position.set(0, h / 2 + 2.5, mz);
    const sail = new THREE.Mesh(new THREE.PlaneGeometry(8.5, h * 0.55), sailMat);
    sail.position.set(0, h * 0.62 + 2.5, mz - 0.35);
    group.add(mast, sail);
  });

  scene.add(group);
  return group;
}

function spawnSmokeBurst(x, y, z, count = 12, scale = 1.2) {
  const geo = new THREE.SphereGeometry(0.6 * scale, 6, 6);
  const mat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.75 });
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(geo, mat.clone());
    m.position.set(x, y, z);
    scene.add(m);
    smokeParticles.push({
      mesh: m,
      vx: (Math.random() - 0.5) * 7 * scale,
      vy: (1.5 + Math.random() * 4) * scale,
      vz: (Math.random() - 0.5) * 7 * scale,
      life: 1.1 + Math.random() * 0.7
    });
  }
}

// --- PERSISTENT CLIENT PROFILE & STATE ---
let profileId = localStorage.getItem('frontier_profile_id');
if (!profileId) {
  profileId = 'prof_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem('frontier_profile_id', profileId);
}
let sessionToken = sessionStorage.getItem('frontier_session_token') || '';

let myId = null;
let myTeam = 'red';
let myClass = 'musketeer';
let myHat = 'shako';
let myTrim = 'gold';
let selectedRoomId = 'eu-waterloo';
let pendingInviteCode = null;
let latestState = null;
let firstPerson = false;
let zooming = false;
let fullMapOpen = false;
let deployed = false;
let mouseSensMult = 1.0;

const keys = { w: false, a: false, s: false, d: false, jump: false, crouch: false };
let camYaw = 0;
let camPitch = 0.05;

// DOM Elements
const connectionOverlay = document.getElementById('connectionOverlay');
const connectionStatusText = document.getElementById('connectionStatusText');
const retryConnectBtn = document.getElementById('retryConnectBtn');
const deployOverlay = document.getElementById('deployOverlay');
const deployBtn = document.getElementById('deployBtn');
const playerNameInput = document.getElementById('playerNameInput');
const menuErrorBanner = document.getElementById('menuErrorBanner');
const topHud = document.getElementById('topHud');
const bottomHud = document.getElementById('bottomHud');
const crosshair = document.getElementById('crosshair');
const chatBox = document.getElementById('chatBox');
const chatInput = document.getElementById('chatInput');
const chatMessages = document.getElementById('chatMessages');
const interactPrompt = document.getElementById('interactPrompt');
const fullMapOverlay = document.getElementById('fullMapOverlay');
const roundOverOverlay = document.getElementById('roundOverOverlay');
const deathOverlay = document.getElementById('deathOverlay');

const savedName = localStorage.getItem('frontier_player_name');
if (savedName) playerNameInput.value = savedName;

function showMenuError(msg) {
  menuErrorBanner.textContent = msg;
  menuErrorBanner.classList.remove('hidden');
  setTimeout(() => menuErrorBanner.classList.add('hidden'), 5000);
}

// Load persistent stats from backend
fetch(`/api/profile/${encodeURIComponent(profileId)}`)
  .then((r) => r.json())
  .then((prof) => {
    document.getElementById('statCareerKills').textContent = prof.kills || 0;
    document.getElementById('statCareerDeaths').textContent = prof.deaths || 0;
    document.getElementById('statCareerCaptures').textContent = prof.captures || 0;
    document.getElementById('statCareerWins').textContent = prof.wins || 0;
  })
  .catch(() => {});

// Menu Tabs
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'tabServers') socket.emit('listRooms');
  });
});

// Team, Class, Hat, Trim Selectors
document.querySelectorAll('.team-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.team-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    myTeam = btn.dataset.team;
  });
});

document.querySelectorAll('.class-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.class-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    myClass = btn.dataset.class;
  });
});

document.querySelectorAll('#hatSelector .pill-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#hatSelector .pill-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    myHat = btn.dataset.hat;
  });
});

document.querySelectorAll('#trimSelector .pill-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#trimSelector .pill-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    myTrim = btn.dataset.trim;
  });
});

// Server Browser & Private Rooms
document.getElementById('refreshServersBtn').addEventListener('click', () => socket.emit('listRooms'));

document.getElementById('createPrivateBtn').addEventListener('click', () => {
  const roomName = document.getElementById('privateRoomNameInput').value.trim();
  const enableBots = document.getElementById('privateBotsCheck').checked;
  socket.emit('createPrivateRoom', { roomName, enableBots });
});

document.getElementById('joinPrivateBtn').addEventListener('click', () => {
  const code = document.getElementById('privateCodeInput').value.trim().toUpperCase();
  if (code.length < 4) {
    showMenuError('Enter a valid 6-character Private Match invite code.');
    return;
  }
  pendingInviteCode = code;
  deployed = false;
  clearEntityPools();
  deployBtn.click();
});

// Settings Sliders
document.getElementById('masterVolSlider').addEventListener('input', (e) => {
  SoundEngine.masterVol = Number(e.target.value) / 100;
  document.getElementById('masterVolVal').textContent = `${e.target.value}%`;
});

document.getElementById('sfxVolSlider').addEventListener('input', (e) => {
  SoundEngine.sfxVol = Number(e.target.value) / 100;
  document.getElementById('sfxVolVal').textContent = `${e.target.value}%`;
});

document.getElementById('mouseSensSlider').addEventListener('input', (e) => {
  mouseSensMult = Number(e.target.value) / 100;
  document.getElementById('mouseSensVal').textContent = `${mouseSensMult.toFixed(1)}x`;
});

document.getElementById('gfxQualitySelect').addEventListener('change', (e) => {
  applyGraphicsQuality(e.target.value);
});

document.getElementById('openLoadoutFromDeathBtn').addEventListener('click', () => {
  deathOverlay.classList.add('hidden');
  deployOverlay.classList.remove('hidden');
  deployBtn.textContent = 'APPLY LOADOUT & RESPAWN';
});

deployBtn.addEventListener('click', () => {
  SoundEngine.ensure();
  const name = playerNameInput.value.trim() || `Soldier_${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem('frontier_player_name', name);

  if (!deployed) {
    socket.emit('joinBattle', {
      roomId: selectedRoomId,
      inviteCode: pendingInviteCode,
      name,
      team: myTeam,
      playerClass: myClass,
      hat: myHat,
      trim: myTrim,
      profileId,
      sessionToken
    });
    pendingInviteCode = null;
  } else {
    socket.emit('switchLoadout', {
      team: myTeam,
      playerClass: myClass,
      hat: myHat,
      trim: myTrim
    });
  }

  deployOverlay.classList.add('hidden');
  topHud.classList.remove('hidden');
  bottomHud.classList.remove('hidden');
  crosshair.classList.remove('hidden');
  chatBox.classList.remove('hidden');
  if (canvas.requestPointerLock) canvas.requestPointerLock();
});

// Input & Pointer Lock
let chatChannel = 'all';

canvas.addEventListener('click', () => {
  if (
    deployed &&
    deployOverlay.classList.contains('hidden') &&
    fullMapOverlay.classList.contains('hidden') &&
    deathOverlay.classList.contains('hidden')
  ) {
    if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
      canvas.requestPointerLock();
    } else {
      socket.emit('action', { type: 'attack' });
    }
  }
});

window.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement === canvas) {
    if (e.button === 0) socket.emit('action', { type: 'attack' });
    if (e.button === 2) zooming = true;
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 2) zooming = false;
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) {
    const sens = (zooming ? 0.0012 : 0.0023) * mouseSensMult;
    camYaw -= e.movementX * sens;
    camPitch = Math.max(-1.35, Math.min(1.35, camPitch - e.movementY * sens));
  }
});

window.addEventListener('keydown', (e) => {
  if (!chatInput.classList.contains('hidden')) {
    if (e.key === 'Enter') {
      const text = chatInput.value.trim();
      if (text) socket.emit('chat', { channel: chatChannel, text });
      chatInput.value = '';
      chatInput.classList.add('hidden');
      if (canvas.requestPointerLock) canvas.requestPointerLock();
    } else if (e.key === 'Escape') {
      chatInput.classList.add('hidden');
    }
    return;
  }

  if (!deployed) return;

  const code = e.code;
  if (code === 'KeyW' || code === 'ArrowUp') keys.w = true;
  if (code === 'KeyS' || code === 'ArrowDown') keys.s = true;
  if (code === 'KeyA' || code === 'ArrowLeft') keys.a = true;
  if (code === 'KeyD' || code === 'ArrowRight') keys.d = true;
  if (code === 'Space') keys.jump = true;
  if (code === 'KeyC') keys.crouch = true;
  if (code === 'ShiftLeft' || code === 'ShiftRight') zooming = true;

  if (code === 'Digit1') socket.emit('input', { yaw: camYaw, pitch: camPitch, weaponIdx: 0 });
  if (code === 'Digit2') socket.emit('input', { yaw: camYaw, pitch: camPitch, weaponIdx: 1 });
  if (code === 'Digit3') socket.emit('input', { yaw: camYaw, pitch: camPitch, weaponIdx: 2 });
  if (code === 'KeyR') {
    socket.emit('action', { type: 'reload' });
    SoundEngine.reload();
  }
  if (code === 'KeyF') socket.emit('action', { type: 'interact' });
  if (code === 'KeyV') firstPerson = !firstPerson;

  if (code === 'KeyM') {
    fullMapOpen = !fullMapOpen;
    fullMapOverlay.classList.toggle('hidden', !fullMapOpen);
    if (fullMapOpen && document.pointerLockElement === canvas) {
      document.exitPointerLock();
    }
  }

  if (code === 'Enter' || code === 'KeyT') {
    e.preventDefault();
    chatChannel = code === 'KeyT' ? 'team' : 'all';
    chatInput.placeholder = chatChannel === 'team' ? 'Team Chat...' : 'All Chat...';
    chatInput.classList.remove('hidden');
    chatInput.focus();
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  }
});

window.addEventListener('keyup', (e) => {
  const code = e.code;
  if (code === 'KeyW' || code === 'ArrowUp') keys.w = false;
  if (code === 'KeyS' || code === 'ArrowDown') keys.s = false;
  if (code === 'KeyA' || code === 'ArrowLeft') keys.a = false;
  if (code === 'KeyD' || code === 'ArrowRight') keys.d = false;
  if (code === 'Space') keys.jump = false;
  if (code === 'KeyC') keys.crouch = false;
  if (code === 'ShiftLeft' || code === 'ShiftRight') zooming = false;
});

document.addEventListener('pointerlockchange', () => {
  if (
    deployed &&
    document.pointerLockElement !== canvas &&
    fullMapOverlay.classList.contains('hidden') &&
    chatInput.classList.contains('hidden') &&
    roundOverOverlay.classList.contains('hidden') &&
    deathOverlay.classList.contains('hidden')
  ) {
    deployOverlay.classList.remove('hidden');
    deployBtn.textContent = 'RESUME / REDEPLOY';
  }
});

setInterval(() => {
  if (!deployed || !myId) return;
  socket.emit('input', {
    w: keys.w,
    a: keys.a,
    s: keys.s,
    d: keys.d,
    jump: keys.jump,
    crouch: keys.crouch,
    yaw: camYaw,
    pitch: camPitch
  });
}, 50);

// --- SOCKET.IO EVENTS ---
socket.on('connect', () => {
  connectionOverlay.classList.add('hidden');
  retryConnectBtn.classList.add('hidden');
  socket.emit('listRooms');

  if (deployed && sessionToken) {
    // Reclaim session seamlessly after brief disconnect
    socket.emit('joinBattle', {
      roomId: selectedRoomId,
      name: playerNameInput.value.trim(),
      team: myTeam,
      playerClass: myClass,
      hat: myHat,
      trim: myTrim,
      profileId,
      sessionToken
    });
  } else {
    deployOverlay.classList.remove('hidden');
  }
});

socket.on('disconnect', () => {
  connectionStatusText.textContent = 'Connection lost. Attempting to reconnect to server...';
  connectionOverlay.classList.remove('hidden');
  retryConnectBtn.classList.remove('hidden');
});

retryConnectBtn.addEventListener('click', () => {
  socket.connect();
});

socket.on('roomList', (list) => {
  const container = document.getElementById('serverListContainer');
  if (!list || list.length === 0) return;
  container.innerHTML = list
    .map(
      (r) => `<div class="server-item ${r.id === selectedRoomId ? 'selected' : ''}" data-room="${r.id}">
        <span><strong>${r.name}</strong> (War #${r.round})</span>
        <span>${r.humans}/${r.maxPlayers} Soldiers (+${r.bots} AI)</span>
      </div>`
    )
    .join('');

  container.querySelectorAll('.server-item').forEach((item) => {
    item.addEventListener('click', () => {
      container.querySelectorAll('.server-item').forEach((i) => i.classList.remove('selected'));
      item.classList.add('selected');
      selectedRoomId = item.dataset.room;
      deployed = false;
      clearEntityPools();
    });
  });
});

socket.on('privateRoomCreated', ({ roomId, inviteCode, name }) => {
  selectedRoomId = roomId;
  deployed = false;
  clearEntityPools();
  const display = document.getElementById('createdCodeDisplay');
  display.textContent = `Created "${name}"! Share Invite Code: ${inviteCode}`;
  display.classList.remove('hidden');
});

socket.on('joinError', ({ message }) => {
  deployed = false;
  deployOverlay.classList.remove('hidden');
  showMenuError(message);
});

socket.on('joined', (data) => {
  deployed = true;
  myId = data.id;
  myTeam = data.team;
  myClass = data.playerClass;
  myHat = data.hat;
  myTrim = data.trim;
  selectedRoomId = data.roomId;
  sessionToken = data.sessionToken;
  sessionStorage.setItem('frontier_session_token', sessionToken);

  const codeBadge = document.getElementById('roomCodeBadge');
  if (data.inviteCode) {
    codeBadge.textContent = `Private Room Code: ${data.inviteCode}`;
    codeBadge.classList.remove('hidden');
  } else {
    codeBadge.textContent = data.roomName;
    codeBadge.classList.remove('hidden');
  }

  if (data.profile) {
    document.getElementById('statCareerKills').textContent = data.profile.kills || 0;
    document.getElementById('statCareerDeaths').textContent = data.profile.deaths || 0;
    document.getElementById('statCareerCaptures').textContent = data.profile.captures || 0;
    document.getElementById('statCareerWins').textContent = data.profile.wins || 0;
  }
});

socket.on('state', (state) => {
  latestState = state;
  updateHud(state);
});

socket.on('fxEvent', (ev) => {
  if (ev.type === 'musketFire') {
    spawnSmokeBurst(ev.x, ev.y, ev.z, 6, 0.6);
    SoundEngine.musket();
  }
  if (ev.type === 'cannonFire') {
    spawnSmokeBurst(ev.x, ev.y, ev.z, 16, 1.5);
    SoundEngine.cannon();
  }
  if (ev.type === 'shipBroadside') {
    spawnSmokeBurst(ev.x, ev.y, ev.z, 24, 2.0);
    SoundEngine.cannon();
  }
  if (ev.type === 'explosion') {
    spawnSmokeBurst(ev.x, ev.y, ev.z, 20, 2.2);
    SoundEngine.cannon();
  }
});

socket.on('playerDied', ({ killer, weapon, respawnIn }) => {
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  document.getElementById('deathReasonText').textContent = `Defeated by ${killer} (${weapon})`;
  document.getElementById('respawnCountdown').textContent = respawnIn.toFixed(1);
  deathOverlay.classList.remove('hidden');
});

socket.on('playerRespawned', () => {
  deathOverlay.classList.add('hidden');
  if (deployOverlay.classList.contains('hidden') && canvas.requestPointerLock) {
    canvas.requestPointerLock();
  }
});

socket.on('killFeed', ({ killer, killerTeam, victim, victimTeam, weapon }) => {
  const feed = document.getElementById('killFeed');
  const div = document.createElement('div');
  div.className = 'kill-entry';
  div.innerHTML = `<span class="c-${killerTeam}">${killer}</span> [${weapon}] <span class="c-${victimTeam}">${victim}</span>`;
  feed.prepend(div);
  while (feed.children.length > 6) feed.removeChild(feed.lastChild);
  setTimeout(() => div.remove(), 7000);
});

socket.on('fortCaptured', ({ fortName, team }) => {
  SoundEngine.horn();
  const banner = document.getElementById('bannerAlert');
  banner.textContent = `${team.toUpperCase()}COATS CAPTURED ${fortName.toUpperCase()}!`;
  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), 4000);
});

socket.on('chatMessage', ({ sender, team, channel, text }) => {
  const line = document.createElement('div');
  line.className = 'chat-line';
  const span = document.createElement('span');
  span.className = `c-${team}`;
  span.textContent = `${sender}: `;
  line.appendChild(document.createTextNode(`[${channel}] `));
  line.appendChild(span);
  line.appendChild(document.createTextNode(text));
  chatMessages.appendChild(line);
  while (chatMessages.children.length > 6) chatMessages.removeChild(chatMessages.firstChild);
});

socket.on('roundEnded', ({ winner, redPoints, bluePoints, scoreboard }) => {
  SoundEngine.horn();
  const title = document.getElementById('victoryTitle');
  title.textContent = `${winner.toUpperCase()}COATS WIN THE WAR! (${redPoints} — ${bluePoints})`;
  const tbody = document.getElementById('scoreboardBody');
  tbody.innerHTML = scoreboard
    .map(
      (r) => `<tr>
        <td class="c-${r.team}">${r.name}</td>
        <td>${r.team.toUpperCase()}</td>
        <td>${r.playerClass}</td>
        <td>${r.kills}</td>
        <td>${r.deaths}</td>
        <td>${r.captures}</td>
      </tr>`
    )
    .join('');
  roundOverOverlay.classList.remove('hidden');
});

socket.on('roundReset', () => {
  roundOverOverlay.classList.add('hidden');
  deathOverlay.classList.add('hidden');
  clearEntityPools();
});

// --- HUD & TACTICAL MAP DRAWING ---
function updateHud(state) {
  let redForts = 0;
  let blueForts = 0;
  state.forts.forEach((f) => {
    if (f.owner === 'red') redForts++;
    else if (f.owner === 'blue') blueForts++;
  });

  document.getElementById('redFortCount').textContent = `${redForts} Forts`;
  document.getElementById('blueFortCount').textContent = `${blueForts} Forts`;
  document.getElementById('roundLabel').textContent = `WAR #${state.round}`;
  document.getElementById('pointsSummary').textContent = `${state.redPoints} — ${state.bluePoints}`;
  document.getElementById('redProgressBar').style.width = `${Math.min(50, (state.redPoints / 1000) * 50)}%`;
  document.getElementById('blueProgressBar').style.width = `${Math.min(50, (state.bluePoints / 1000) * 50)}%`;

  const me = state.players[myId];
  if (!me) return;

  if (me.dead) {
    document.getElementById('respawnCountdown').textContent = me.respawn.toFixed(1);
  }

  document.getElementById('classBadge').textContent = `${me.team.toUpperCase()} ${me.c.toUpperCase()}`;
  document.getElementById('kdaBadge').textContent = `${me.kills} K / ${me.deaths} D / ${me.captures} Cap`;
  document.getElementById('hpText').textContent = me.dead ? 'FALLEN' : `${me.hp} / ${me.maxHp} HP`;
  document.getElementById('hpFill').style.width = `${(me.hp / me.maxHp) * 100}%`;

  const wList = CLASS_WEAPONS[me.c] || CLASS_WEAPONS.musketeer;
  document.querySelectorAll('.w-slot').forEach((slot, idx) => {
    slot.textContent = `[${idx + 1}] ${wList[idx]}`;
    slot.classList.toggle('active', me.wIdx === idx);
  });

  const reloadWrap = document.getElementById('reloadBarWrap');
  const reloadFill = document.getElementById('reloadBarFill');
  if (me.reload > 0) {
    reloadWrap.classList.remove('hidden');
    const pct = Math.max(0, Math.min(100, (1 - me.reload / 4.2) * 100));
    reloadFill.style.width = `${pct}%`;
  } else {
    reloadWrap.classList.add('hidden');
  }

  if (me.mType) {
    interactPrompt.textContent = `Press [F] to Leave ${me.mType.toUpperCase()}`;
    interactPrompt.classList.remove('hidden');
  } else {
    let promptText = null;
    for (const h of state.horses) {
      if (!h.riderId && Math.hypot(h.x - me.x, h.z - me.z) < 5.5) promptText = 'Press [F] to Mount Warhorse';
    }
    if (!promptText) {
      for (const c of state.cannons) {
        if (!c.opId && Math.hypot(c.x - me.x, c.z - me.z) < 5.5) promptText = 'Press [F] to Man Field Cannon';
      }
    }
    if (!promptText) {
      for (const s of state.ships) {
        if (!s.capId && Math.hypot(s.x - me.x, s.z - me.z) < 16) promptText = `Press [F] to Captain ${s.name}`;
      }
    }
    if (promptText) {
      interactPrompt.textContent = promptText;
      interactPrompt.classList.remove('hidden');
    } else {
      interactPrompt.classList.add('hidden');
    }
  }

  drawMap(document.getElementById('minimapCanvas'), state, me, false);
  if (fullMapOpen) {
    drawMap(document.getElementById('fullMapCanvas'), state, me, true);
  }
}

function drawMap(cvs, state, me, showLabels) {
  const ctx = cvs.getContext('2d');
  const w = cvs.width;
  const h = cvs.height;
  const cx = w / 2;
  const cy = h / 2;
  const scale = (w * 0.43) / MAP_RADIUS;

  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = '#164e63';
  ctx.beginPath();
  ctx.arc(cx, cy, w / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#4d7c3f';
  ctx.beginPath();
  ctx.arc(cx, cy, MAP_RADIUS * scale, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#1d5b79';
  ctx.lineWidth = RIVER_HALF_WIDTH * 2 * scale;
  ctx.beginPath();
  for (let z = -MAP_RADIUS; z <= MAP_RADIUS; z += 20) {
    const rx = Math.sin(z * 0.008) * 45;
    const px = cx + rx * scale;
    const py = cy + z * scale;
    if (z === -MAP_RADIUS) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();

  state.ships.forEach((s) => {
    ctx.fillStyle = '#ecc94b';
    ctx.fillRect(cx + s.x * scale - 3, cy + s.z * scale - 3, 6, 6);
  });

  state.forts.forEach((f) => {
    const fx = cx + f.x * scale;
    const fy = cy + f.z * scale;
    ctx.fillStyle = f.owner === 'red' ? '#f56565' : '#4299e1';
    ctx.beginPath();
    ctx.arc(fx, fy, showLabels ? 6 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (showLabels) {
      ctx.fillStyle = '#fff';
      ctx.font = '10px sans-serif';
      ctx.fillText(f.name, fx + 8, fy + 3);
    }
  });

  Object.values(state.players).forEach((p) => {
    if (p.dead || p.team !== me.team) return;
    const px = cx + p.x * scale;
    const py = cy + p.z * scale;
    ctx.fillStyle = p.id === me.id ? '#ffffff' : '#a7f3d0';
    ctx.beginPath();
    ctx.arc(px, py, p.id === me.id ? 4.5 : 2.3, 0, Math.PI * 2);
    ctx.fill();

    if (p.id === me.id) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - Math.sin(camYaw) * 11, py - Math.cos(camYaw) * 11);
      ctx.stroke();
    }
  });
}

// --- 3D RENDER LOOP ---
let lastFrame = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  for (let i = smokeParticles.length - 1; i >= 0; i--) {
    const sp = smokeParticles[i];
    sp.life -= dt;
    sp.mesh.position.x += sp.vx * dt;
    sp.mesh.position.y += sp.vy * dt;
    sp.mesh.position.z += sp.vz * dt;
    sp.mesh.scale.addScalar(dt * 1.4);
    sp.mesh.material.opacity = Math.max(0, sp.life * 0.5);
    if (sp.life <= 0) {
      scene.remove(sp.mesh);
      smokeParticles.splice(i, 1);
    }
  }

  if (latestState) {
    latestState.forts.forEach((f) => {
      if (!fortMeshes[f.id]) fortMeshes[f.id] = createFortMesh(f);
      const fm = fortMeshes[f.id];
      const hex = f.owner === 'red' ? 0xdc2626 : 0x2563eb;
      fm.flagMat.color.setHex(hex);
      fm.ringMat.color.setHex(hex);
      fm.flag.position.y = 6 + (Math.abs(f.prog) / 100) * 10;
    });

    latestState.horses.forEach((h) => {
      if (!horseMeshes[h.id]) horseMeshes[h.id] = createHorseMesh();
      const hm = horseMeshes[h.id];
      hm.position.set(h.x, h.y, h.z);
      hm.rotation.y = h.yaw;
    });

    latestState.cannons.forEach((c) => {
      if (!cannonMeshes[c.id]) cannonMeshes[c.id] = createCannonMesh();
      const cm = cannonMeshes[c.id];
      cm.group.position.set(c.x, c.y, c.z);
      cm.group.rotation.y = c.yaw;
      cm.barrel.rotation.x = Math.PI / 2 - c.pitch;
    });

    latestState.ships.forEach((s) => {
      if (!shipMeshes[s.id]) shipMeshes[s.id] = createShipMesh(s.team);
      const sm = shipMeshes[s.id];
      sm.position.set(s.x, s.y, s.z);
      sm.rotation.y = s.yaw;
    });

    const activeIds = new Set(Object.keys(latestState.players));
    for (const [id, meshObj] of Object.entries(playerMeshes)) {
      if (!activeIds.has(id)) {
        scene.remove(meshObj.group);
        delete playerMeshes[id];
      }
    }

    for (const [id, p] of Object.entries(latestState.players)) {
      const desiredKey = `${p.team}_${p.hat}_${p.trim}`;
      if (!playerMeshes[id] || playerMeshes[id].key !== desiredKey) {
        if (playerMeshes[id]) scene.remove(playerMeshes[id].group);
        playerMeshes[id] = createSoldierMesh(p.team, p.hat, p.trim);
      }
      const pm = playerMeshes[id];
      pm.group.visible = !p.dead && !(id === myId && firstPerson);

      const yOffset = p.mType === 'horse' ? 1.55 : 0;
      pm.group.position.set(p.x, p.y + yOffset, p.z);
      pm.group.rotation.y = p.yaw;
      pm.group.scale.y = p.crouch ? 0.68 : 1.0;

      const walkSwing = Math.sin(now * 0.012) * 0.35;
      pm.leftLeg.rotation.x = walkSwing;
      pm.rightLeg.rotation.x = -walkSwing;
    }

    const activeProjIds = new Set(latestState.projectiles.map((pr) => pr.id));
    for (const [id, mesh] of Object.entries(projectileMeshes)) {
      if (!activeProjIds.has(id)) {
        scene.remove(mesh);
        delete projectileMeshes[id];
      }
    }
    latestState.projectiles.forEach((pr) => {
      if (!projectileMeshes[pr.id]) {
        const radius = pr.k === 'cannonball' ? 0.32 : 0.08;
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 6, 6),
          new THREE.MeshBasicMaterial({ color: pr.k === 'cannonball' ? 0x1a202c : 0xfefcbf })
        );
        scene.add(m);
        projectileMeshes[pr.id] = m;
      }
      projectileMeshes[pr.id].position.set(pr.x, pr.y, pr.z);
    });

    const me = latestState.players[myId];
    if (me) {
      const targetFov = zooming ? 38 : 72;
      if (Math.abs(camera.fov - targetFov) > 0.2) {
        camera.fov += (targetFov - camera.fov) * 0.2;
        camera.updateProjectionMatrix();
      }

      const eyeHeight = me.mType === 'ship' ? 5.5 : me.mType === 'horse' ? 3.2 : me.crouch ? 1.2 : 1.85;
      const anchor = new THREE.Vector3(me.x, me.y + eyeHeight, me.z);

      if (firstPerson && me.mType !== 'ship') {
        camera.position.copy(anchor);
      } else {
        const camDist = me.mType === 'ship' ? 24 : 5.2;
        const offset = new THREE.Vector3(
          Math.sin(camYaw) * Math.cos(camPitch) * camDist,
          -Math.sin(camPitch) * camDist + 1.2,
          Math.cos(camYaw) * Math.cos(camPitch) * camDist
        );
        camera.position.copy(anchor).add(offset);
        const minGround = getTerrainHeight(camera.position.x, camera.position.z) + 0.6;
        if (camera.position.y < minGround) camera.position.y = minGround;
      }

      const lookTarget = new THREE.Vector3(
        anchor.x - Math.sin(camYaw) * Math.cos(camPitch) * 30,
        anchor.y + Math.sin(camPitch) * 30,
        anchor.z - Math.cos(camYaw) * Math.cos(camPitch) * 30
      );
      camera.lookAt(lookTarget);
    }
  }

  renderer.render(scene, camera);
}
requestAnimationFrame(animate);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
