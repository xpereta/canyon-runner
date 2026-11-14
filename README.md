# Canyon Runner

iOS/iPad gyro-tilt low-altitude flight sim over a procedural canyon landscape.
Static ES modules — no bundler, no npm dependencies. THREE is vendored in
`vendor/three.module.js` and imported only by `src/main.js`.

## How to play (iPhone / iPad)

1. Open the URL in Safari (or Add to Home Screen for fullscreen).
2. Open over HTTPS, tap **TAP TO BEGIN**, and allow motion & orientation access when prompted. If denied, use **Enable motion controls** to retry.
3. Hold your preferred neutral pose while the first sensor reading arrives, then tilt to steer — pitch fore/aft = elevator, roll left/right = aileron.
4. Tap **GYRO DEBUG** to see permission, HTTPS status, event counts, raw and neutral angles, screen angle and control axes. If events remain at zero, check Safari motion permissions and HTTPS.
5. Use the on-screen widgets: throttle slider (right edge), **FLAPS +/−**,
   **RECENTER GYRO** (re-captures your current hold pose as neutral), **RESET**
   (instant return to the runway).
6. Fly off the mesa-top runway, roll down (W to add throttle, rotate ~33 m/s
   with pitch-up), and thread the canyon. Crashing freezes briefly, then you
   respawn on the runway.

Landscape is the promoted orientation; the game also runs in portrait behind a
rotate hint. The mapping uses device beta/gamma without rotating axes for screen orientation; check the debug readout and recenter after rotating. Physical behavior in landscape has not been verified on an iPad.

### Keyboard fallback (desktop or motion denied)

| Keys | Action |
|---|---|
| W / S | throttle up / down |
| ↑ / ↓ | elevator (pitch up / down) |
| ← / → | aileron (roll) |
| A / D | rudder (yaw) |
| Z / X | elevator (alt) |
| F | cycle flaps detents 0 → ⅓ → ⅔ → full → 0 |
| T / G | trim nose-up / nose-down |
| R | instant respawn at runway |

## HUD

Airspeed (km/h big, knots small), altitude MSL + AGL, VSI m/s, 3-digit heading
with cardinal and nearest landmark, throttle bar, flap detents, elevator trim
dot, turn coordinator, STALL blinking banner, crash counter, proximity vignette
below 30 m AGL, and a **vector minimap** (main canyon + river, mesas, runway
tick, landmarks, aircraft + velocity vector; north-up, 3.2 km half-range).

## Development

```sh
node --check src/main.js src/ui/hud.js   # syntax gate
node --test tests/                       # all headless tests
```

Serve statically for the browser (any static server, e.g.
`python3 -m http.server` in the repo root) — the page is `index.html`.

### QA hooks (browser console / automation)

`window.__game` exposes:

- `terrain, world, ac, sky, state, stack, hud, gyro, camera, renderer, scene, stats`
- `step(n)` — run `n` deterministic sim steps with **no RAF** (hidden-tab proof)
- `draw()` — one render pass
- `respawn()`, `simTime` (getter), `freeze` (getter), `errs`

`window.__errs` collects every frame-body exception stack; a clean session keeps
it empty. A 200 ms watchdog pumps a frame manually if RAF stalls >250 ms.

## Layout

```
index.html              mobile game shell + start overlay
src/main.js             composition root (only THREE importer)
src/ui/hud.js           HUD widgets + pure format helpers + vector minimap
src/ui/style.css        dark aviation HUD styling
src/core/*              flight/terrain/controls/gyro core (pure JS, no DOM)
src/render/*            chunked terrain mesh, aircraft model, sky
tests/                  node:test suites (headless)
```
