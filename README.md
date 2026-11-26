# Frontier: Napoleonic Conquest

A 3D multiplayer Napoleonic land and naval warfare game built with **Three.js**, **Node.js**, **Express**, and **Socket.IO**, ready for deployment on **GitHub + Render**.

## Features
- **3D Island, River & Open Sea Battlefield**: Rolling hills, coastal beaches, trees, meandering central river, and surrounding ocean with configurable graphics quality (shadows, pixel ratio, fog).
- **Public Server Browser & Private Matches**: Join public conquest lobbies or create/join private rooms using a 6-character invite code.
- **12 Capturable Forts & Majority Conquest Rules**: Capture stone forts with animated team flags. Holding **7 or more forts (>50%)** generates Fort Points toward the **1,000-point** victory target, followed by an end-of-war scoreboard and automatic map reshuffle.
- **4 Playable Classes & Customisation**:
  - **Musketeer**: Flintlock Musket, Flintlock Pistol, Bayonet.
  - **Cavalryman**: Dragoon Saber, Flintlock Pistol, Spyglass, faster horse speed.
  - **Cannoneer**: Artillery Hammer, Flintlock Pistol, Spyglass, 35% faster cannon reload.
  - **Sailor**: Blunderbuss, Cutlass, Spyglass, enhanced ship handling.
  - Customise your soldier name, uniform trim, and headgear style (Shako, Bicorne, Bearskin, Tricorne).
- **Land, Artillery & Naval Combat (`F` Key)**:
  - Mountable Warhorses across the island.
  - Rotatable Field Cannons firing explosive cannonballs with splash damage.
  - 3-masted Sailing Warships on the river and sea with port/starboard cannon broadsides.
- **Career Stats & Session Reconnection**: Tracks career kills, deaths, fort captures, and wars won in `data/stats.json` (note: on Render's free tier, local disk storage is ephemeral and resets when the service restarts or redeploys; attach a persistent disk or external database if long-term persistence across deploys is needed) with automatic session token reconnection.
- **Web Audio Sound Effects & Settings**: Procedural Web Audio musket cracks, cannon booms, reloads, hit markers, and fort capture horns with Master/SFX volume controls.

## Controls
- `WASD` / `Arrow Keys` — Move infantry, ride warhorse, or steer warship
- `Mouse` — Aim / Look (Pointer Lock)
- `Left Click` — Fire firearm, swing melee, fire field cannon, or fire ship broadside
- `Right Click` or `Shift` — Iron-sight / Spyglass zoom
- `R` — Reload firearm
- `1` / `2` / `3` — Switch weapon slots
- `C` — Crouch (take cover while reloading)
- `V` — Toggle 1st-Person / 3rd-Person camera
- `F` — Interact (Mount Warhorse, Man Field Cannon, Take Ship Helm, Dismount)
- `M` — Toggle Full Tactical War Room Map
- `Enter` / `T` — All Chat / Team Chat
- `Esc` — Open Pause / Loadout / Settings Menu

## Deploying to GitHub & Render
1. Extract this ZIP archive so that `package.json`, `server.js`, `render.yaml`, and `public/` are at the root of your folder.
2. Create a new repository on **GitHub** and push all extracted files to it:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: Frontier Napoleonic Conquest"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
   git push -u origin main
   ```
3. Log into [Render](https://render.com), click **New +** -> **Web Service**, and connect your GitHub repository.
4. Render will automatically detect `render.yaml` (`npm install` build command, `npm start` start command, and `/health` health check).
5. Click **Create Web Service**. Once deployed, open your `.onrender.com` URL and share it or use Private Match codes to play with friends.
