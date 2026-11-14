# CONTRACT (frozen before code — every agent follows this exactly)

Game: **Canyon Runner** — iOS/iPad gyro-tilt low-altitude flight sim over a procedural
canyon landscape. Tilt device = control stick. Realistic-but-accessible light-plane
flight model (stalls, trim, ground effect optional), canyon flying, crash/respawn.

Static ES-module project. No bundler, no npm deps. Node 26 for tests (`node --test`).
THREE is imported ONLY in `src/main.js` (from `./vendor/three.module.js`) and passed into
render factories as their first argument. Core modules must NEVER import THREE or touch DOM.

## Module layout and ownership (one owner per file — do not touch others' files)

```
src/config.js            [ORCHESTRATOR — FROZEN, do not edit]  all tunables
src/core/noise.js        [terrain agent]
src/core/terrain.js      [terrain agent]
src/render/terrainMesh.js[terrain agent]
tests/terrain.test.js    [terrain agent]
tests/noise.test.js      [terrain agent]

src/core/quat.js         [flight agent]
src/core/flight.js       [flight agent]
src/core/controls.js     [flight agent]
src/core/gyro.js         [flight agent]
tests/quat.test.js       [flight agent]
tests/flight.test.js     [flight agent]
tests/controls.test.js   [flight agent]

src/render/aircraft.js   [ui agent, wave 2]
src/render/sky.js        [ui agent, wave 2]
src/ui/hud.js            [ui agent, wave 2]
src/main.js              [ui agent, wave 2]  composition root (only file importing everything)
index.html               [ui agent, wave 2]
src/ui/style.css         [ui agent, wave 2]
tests/hud.test.js        [ui agent, wave 2]
README.md                [ui agent, wave 2]
```

If you need a tunable that `src/config.js` lacks: use a local `const` tagged
`// CFG-REQ: <description>` and list it in your final report. Never edit config.js.

## World axes and conventions (LOCKED)

- Meters, seconds, SI. Three.js scene uses the same axes directly.
- **X = east, Y = up, Z = south** (so north = −Z). Right-handed, Y up — standard three.js.
- World is a square `WORLD.SIZE` m per side, **centered at origin** (x,z ∈ [−SIZE/2, SIZE/2]).
- Terrain elevation returned by `groundHeight(x,z)` is meters above datum ("MSL"); the
  flight sim's `pos.y` is the aircraft **gear-bottom reference point**, also MSL meters.
- Heading in degrees, compass convention: 0 = north (−Z), 90 = east, increases clockwise.
  Euler order for attitude: yaw(heading about Y) → pitch (about local Z′... see quat.js) → roll
  (about local X″). In three.js terms: intrinsic Y-X-Z? No — we lock it as: **ZYX extrinsic =
  yaw about world Y, then pitch about body lateral axis, then roll about body longitudinal**,
  i.e. `qFromEuler(headingRad, pitchRad, rollRad)` composes as `qYaw * qPitch * qRoll`
  (applied right-to-left to vectors). Pitch positive = nose UP. Roll positive = right wing down.
- Body axes in local frame (unrotated, attitude identity): **+X = nose forward, +Y = up
  (left wing is +Z... wait, locked below)**.
  LOCKED: local nose = **−Z** (three.js convention, so `group.quaternion = attitude quat`
  directly renders a model whose nose points −Z), local up = +Y, local right wing = +X.
  `qFromEuler(0,0,0)` rotates nose-vector (0,0,−1) to world (0,0,−1) = north. This is
  consistent with heading 0 = north. Aircraft models MUST be built nose-along-−Z.
- Velocity: world vector `{x,y,z}` m/s. Airspeed = |v − wind|; wind always zero for now
  (config WORLD.WIND reserved 0). AGL = pos.y − groundHeight(x,z).

## FIXED timestep and loop

- `PHYS.DT = 1/60` s fixed. `main.js` accumulates real time and calls `stepFlight` N times.
- `time` field = accumulated sim seconds.

## API signatures (LOCKED)

### core/noise.js (terrain agent)
```js
export function mulberry32(seed)            // -> function(): float [0,1)
export function hash2(ix, iy, seed)         // -> float [0,1), deterministic lattice hash
export function valueNoise2(x, y, seed)     // smooth value noise, cell size 1, -> [0,1)
export function fbm2(x, y, seed, opts)      // opts {octaves=4, freq=1, lacunarity=2, gain=0.5} -> [-1,1]
```

### core/terrain.js (terrain agent)
```js
export function createTerrain(seed) -> terrain
terrain = {
  seed,
  size,                      // WORLD.SIZE
  groundHeight(x, z),        // -> meters MSL, deterministic, defined for ANY x,z
  groundInfo(x, z),          // -> { h, type } type ∈ 'water'|'sand'|'rock'|'scree'|
                             //    'shrub'|'grass'|'rimrock'|'mesatop'  (mesh coloring)
  landmarks,                 // [{x, z, name}] >= 6, for HUD labels
  spawn,                     // { x, z, headingDeg, elevation }  runway threshold center,
                             // elevation = groundHeight there (mesa-top runway, flat >=300 m)
  canyon,                    // { mainLen, mainWidth, depth }  (numbers, for HUD/tests)
}
```
Design requirements (terrain agent):
- High plateau ~`WORLD.PLATEAU_H` (1200 m) dissected by a **main canyon** >= `WORLD.CANYON.MIN_LEN`
  long, winding (spline through seeded waypoints, smooth), floor `depth` (~350 m) below rim,
  width 120–260 m varying smoothly, with 5–8 winding side canyons (shorter, narrower).
- River along main canyon floor: `type 'water'` strip <= 25 m wide at constant-ish low elevation;
  `type 'sand'` banks beside it.
- Mesas/buttes: isolated flat-topped masses on the plateau (cap + steep sides), >= 15 of them.
- Plateau surface gently rolling (fbm, <= 60 m amplitude), `groundInfo.type` 'grass'/'shrub';
  canyon walls 'rock'/'scree' by slope; rim band 'rimrock'.
- `groundHeight` MUST be pure and cheap: target < 40 noise evaluations per call.
  No caching required but you may add a small memo. Mesh builder samples ~16k+ points/chunk/frame-batch.
- Outside WORLD.SIZE±2000 m the height must fall to a low plain (~300 m) and `groundInfo`
  returns 'grass' so the edge looks like the world dropping to a sealess lowland (fog hides edge).
- Runway: `spawn` on a mesa top or plateau spot; a 900×30 m rectangle around it (along
  headingDeg) must be FLAT (height variation < 0.5 m) and type 'grass'; test asserts this.

### render/terrainMesh.js (terrain agent)
```js
export function createWorld(THREE, scene, terrain, cfg) -> world
world = {
  update(playerPos)   // idempotent; loads/unloads chunks around playerPos, safe to call every frame
  dispose()
  chunkCount()        // for tests/QA
}
```
- Chunked grid: `RENDER.CHUNK` m square tiles aligned to multiples of CHUNK; ring
  `RENDER.DRAW_RINGS` around player. LOD: ring 0 = `RENDER.RES_HI` verts/side,
  ring 1 = `RENDER.RES_MID`, ring ≥2 = `RENDER.RES_LO`.
- One THREE.Mesh per chunk (BufferGeometry, indexed, `MeshLambertMaterial({vertexColors:true, flatShading:false})`),
  vertex colors from `groundInfo` type + slope shading. Fog handled by scene (main.js sets scene.fog).
- Water: where type 'water', render a thin translucent plane patch at floor level
  (one merged mesh per chunk) — cheap, no reflections.
- Keep total chunk count <= (2*DRAW_RINGS+1)^2; dispose old geometries on unload (no leaks).

### core/quat.js (flight agent)
```js
export function qFromEuler(yawRad, pitchRad, rollRad) // -> [x,y,z,w], composes qYaw*qPitch*qRoll (YXZ intrinsic as stated above)
export function qMul(a, b)
export function qNormalize(q)
export function qRotate(q, v)        // v={x,y,z} -> {x,y,z}
export function qConjugate(q)
export function eulerFromQ(q)        // -> {yaw, pitch, roll} matching qFromEuler inverse (pitch clamp ±85 deg)
```
Tests must prove round-trip and the LOCKED identity: qFromEuler(0,0,0) rotates nose (0,0,-1) to (0,0,-1); qFromEuler(π/2,0,0) rotates nose to +X (east).

### core/flight.js (flight agent)
```js
export function createAircraft(cfg) -> state
state = {
  pos: {x,y,z},          // gear-bottom point, MSL
  vel: {x,y,z},          // world m/s
  q: [x,y,z,w],          // attitude
  omega: {p,q,r},        // body rates rad/s (p roll about local X? see below)
  alpha, beta,           // rad, cached each step
  throttle, flaps, trimElevator,  // mirror of last applied ctl values
  onGround,             // bool
  time,
  damage,               // 0..1, crash threshold >= 1
}
export function resetTo(state, spawn)  // reposition+zero velocity onto runway (headingDeg aligned)
export function stepFlight(state, ctl, terrain, dt) -> events[]
```
- `ctl = {throttle 0..1, elevator -1..1, aileron -1..1, rudder -1..1, flaps 0..1, trim -1..1}` (signed axes; elevator +1 = nose up command).
- Body rates LOCKED: p = roll rate about local X(+right wing; positive p rolls right wing down),
  q = pitch rate about local −? NO — locked: q positive = nose up (about local X̂cross: the lateral axis
  such that positive q matches positive pitch from eulerFromQ), r = yaw rate, positive r = nose right.
  The flight agent resolves the exact body-frame axis signs internally; observable contract is:
  elevator +1 eventually produces eulerFromQ pitch increasing; aileron +1 produces roll increasing
  (right wing down); rudder +1 produces heading increasing. Tests assert these OBSERVABLE signs.
- Physics: lift/drag along airspeed direction with CL(alpha) polar (linear to CLmax then stall
  break-off and recovery hysteresis-lite), side force from beta, thrust along nose from prop
  power curve vs airspeed, gravity. Control + damping + static stability moments with
  dynamic-pressure scaling; omega integrated, attitude quaternion integrated, velocity integrated, pos integrated (semi-implicit Euler).
- Ground: `pos.y <= groundHeight(x,z)`: if gentle (AGL climb rate > −2.5 m/s, |roll|<25°,
  |pitch−approach|<8°, speed < 55 m/s) → `onGround=true` taxi mode (level attitude follow,
  friction, can still steer with rudder/nosewheel, accelerate on throttle) with event 'touchdown';
  else inelastic ground hit → damage += f(impact) with event 'crash' (one event per contact episode).
  When onGround and speed > `FLIGHT.ROTATE_V` + elevator nose-up past `FLIGHT.ROTATE_V` → liftoff clears onGround.
- Events (strings, zero-or-more per step, no duplicates within a step): 'stall-warning',
  'stall-recovered', 'touchdown', 'liftoff', 'crash', 'overspeed'. `events` is a fresh array each step (may be empty — returning [] is fine).
- ACCESSIBILITY (config FLIGHT.ASSIST): auto rudder coordinated turns, mild roll-spiral
  stabilizer, control rate limiter, alpha limiter nudge (soft stall prevention when assist on).
  These are FLIGHT.ASSIST booleans read from config; default on.
- Trim: `ctl.trim` slews `state.trimElevator`; releases on elevator input (standard elevator-trim feel).

### core/controls.js (flight agent)
```js
export function createControlStack(cfg) -> stack
stack = {
  setChannel(name, value01signed)  // names: 'elevator','aileron','rudder','throttle','flaps','trim'
                                   // throttle/flaps are 0..1; others -1..1. Last writer wins per frame.
  applyKeyState(keyState)          // {up:bool,...} keyboard edge states -> setChannel convenience
  step(dt)                         // slew limits applied here; per-frame channels decay to prior
                                   // held value if not re-written? NO — locked: channels hold until
                                   // overwritten; keyboard writes every frame from main; gyro writes
                                   // every frame when active; buttons (flaps/throttle) write on demand.
  get() -> ctl                     // {throttle, elevator, aileron, rudder, flaps, trim} all clamped, slew-limited
}
export const KEYMAP // {code: channel} frozen mapping (document in code; include W/S throttle, arrows pitch/roll, A/D rudder, F/A flaps, T/G trim, Z/X elevator too)
```

### core/gyro.js (flight agent)
```js
export function mapTilt(neutral, cur, cfg) -> {pitchAxis, rollAxis} // pure math, testable
  // neutral & cur: {beta, gamma} DeviceOrientation degrees; axes -1..1 with sign convention:
  // tilting device nose-down (like pushing a stick forward) => pitchAxis negative (elevator -1 = nose down)
  // tilting device right => rollAxis positive (right wing down).
export function createGyro(win, cfg) -> gyro   // browser-side wrapper
gyro = {
  needsPermission(),                 // -> bool (iOS 13+ check via DeviceOrientationEvent.requestPermission presence)
  requestPermission(),               // -> Promise<bool>
  start(), stop(), active,
  read() -> {pitchAxis, rollAxis}|null, // calibrated with neutral captured on start()
  recalibrate(),                     // capture current device pose as neutral
}
```
Gyro wrapper may touch window events; mapTilt must be pure. Sensitivity: full ±1 control at
±(CONTROLS.TILT_MAX) deg of tilt from neutral, with CONTROLS.TILT_DEADBAND deadband, smooth curve.

### render/aircraft.js, render/sky.js, ui/hud.js, main.js, index.html — wave 2 (ui agent)
- `createAircraft(THREE) -> ac` ; `ac.group` (nose along −Z per LOCKED axes),
  `ac.update(state, ctl)` sets nothing about position (main sets group.position/quaternion from state),
  handles control surface visual angles + prop spin; `ac.setTrail?` optional smoke.
- `createSky(THREE, scene) -> {dispose}` — hemisphere light, directional sun, gradient dome,
  sets scene.fog from config.
- `createHud(doc, terrain) -> hud` — DOM overlay: ASI (km/h primary, kts small), altitude m + AGL,
  VSI m/s, heading tape, throttle bar, flaps/trim indicator, stall banner, touch widgets
  (throttle slider vertical right edge, flap +/-, recalibrate-gyro button, pause/reset),
  minimap canvas 2D: pre-rendered 512² elevation raster from terrain.groundHeight (progressive,
  <=4 ms/chunk slice), aircraft dot + velocity vector + landmarks.
  `hud.update(state, events)`; `hud.onWidget(cb)` where cb receives stack.setChannel calls:
  LOCKED: main passes the control stack to `hud.bindStack(stack)`.
- `main.js`: start overlay ("Tap to begin" then "Enable motion controls" if needsPermission),
  fallback keyboard notice; fixed-timestep loop w/ accumulator max 5 steps/frame; RAF watchdog
  (>250 ms without RAF -> setInterval fallback step); wrap frame body in try/catch into `window.__errs`;
  expose `window.__game = {terrain, world, ac, state, stack, step(n), draw(), errs: window.__errs}`;
  crash -> freeze 1.5 s, respawn at `terrain.spawn` via `resetTo`, damage counter in HUD;
  respawn also on 'Return to runway' HUD button and `R` key. Camera: chase cam, 14 m behind
  along velocity direction with smoothing; chases in cockpit? no — chase only v1.
- index.html: `<script type="module" src="./src/main.js">`, viewport meta with
  `viewport-fit=cover`, `user-scalable=no`, apple-mobile-web-app tags, touch-action none on body.

## QA gates (orchestrator runs after merge)
1. `node --check` every file; `node --test tests/`.
2. Terrain: canyon floor at least `canyon.depth*0.7` below rim along 90% of main spline samples;
   runway flat; determinism (two createTerrain(same seed) -> identical samples at 50 random points).
3. Flight: trims out and holds level at trim speed for 120 s of sim in headless test; stall event
   fires when elevator pulled hard at 18 m/s; observable control signs; crash on dive.
4. Live browser: page loads with zero `__errs`, `__game.step(600)` + `draw()` in one eval,
   readPixels proves ground pixels present, screenshot over canyon.

## Git rules
- Work ONLY in your assigned worktree/branch. Commit per module:
  `git -c user.name=<role> -c user.email=<role>@local commit -m "..."`
- First commit within ~15 tool calls (skeleton + tests scaffold counts).
