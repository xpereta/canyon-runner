// Canyon Runner — sky: lights + gradient dome + scene fog (ui agent, wave 2).
// createSky(THREE, scene) -> { dispose, update? }
// Adds: hemisphere light, shadowless directional sun (no shadow maps on iPad),
// large inverted sphere dome with vertex-color gradient, and sets scene.fog =
// Fog(SKY_HORIZON, RENDER.FOG_NEAR, RENDER.FOG_FAR) so distant terrain dissolves
// into the horizon band. dispose() removes every object it added and clears fog.
// No mandatory per-frame work; update(elapsedSec) is optional slow sun drift.

import { WORLD, RENDER } from '../config.js';

// CFG-REQ: RENDER.SKY_RADIUS — dome radius m; must exceed world half-diagonal
// (~11.3 km) even from a corner so the camera is never outside the dome.
const SKY_RADIUS = RENDER?.SKY_RADIUS ?? (WORLD?.SIZE ? WORLD.SIZE * 1.2 : 19200);
// CFG-REQ: RENDER.SUN_AZ_DEG / SUN_EL_DEG — sun compass azimuth / elevation (deg)
const SUN_AZ_DEG = RENDER?.SUN_AZ_DEG ?? 130, SUN_EL_DEG = RENDER?.SUN_EL_DEG ?? 42;
// CFG-REQ: RENDER.HEMI_INTENSITY / SUN_INTENSITY — light intensities
const HEMI_I = RENDER?.HEMI_INTENSITY ?? 0.85, SUN_I = RENDER?.SUN_INTENSITY ?? 1.15;
// CFG-REQ: RENDER.SUN_DRIFT — rad/s of sun azimuth drift for slow time-of-day feel
const SUN_DRIFT = RENDER?.SUN_DRIFT ?? 0.0002;
const GROUND_BOUNCE = 0x9c8a6e; // canyon-ish bounce color for hemisphere ground

export function createSky(THREE, scene) {
  const top = new THREE.Color(RENDER?.SKY_TOP ?? 0x3a6db8);
  const horizon = new THREE.Color(RENDER?.SKY_HORIZON ?? 0xbfd3e6);
  const sunColor = new THREE.Color(RENDER?.SUN ?? 0xfff2df);

  const added = [];

  // ---- lights (shadowless by design — no shadow maps on iPad) ----
  const hemi = new THREE.HemisphereLight(top.getHex(), GROUND_BOUNCE, HEMI_I);
  hemi.name = 'skyHemi';
  scene.add(hemi); added.push(hemi);

  const sun = new THREE.DirectionalLight(sunColor.getHex(), SUN_I);
  sun.name = 'skySun';
  sun.castShadow = false;
  const az = (SUN_AZ_DEG * Math.PI) / 180, el = (SUN_EL_DEG * Math.PI) / 180;
  const sunDir = (azimuth) => new THREE.Vector3(
    -Math.sin(azimuth) * Math.cos(el),
    Math.sin(el),
    -Math.cos(azimuth) * Math.cos(el), // az=0 -> light from north
  );
  sun.position.copy(sunDir(az)).multiplyScalar(400);
  scene.add(sun); added.push(sun);

  // ---- gradient dome: inverted sphere, vertex colors, fog-exempt ----
  const domeGeo = new THREE.SphereGeometry(SKY_RADIUS, 24, 12);
  const pattr = domeGeo.attributes.position;
  const colors = new Float32Array(pattr.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pattr.count; i++) {
    const y = pattr.getY(i) / SKY_RADIUS; // -1..1
    if (y >= 0) {
      // horizon -> zenith with eased ramp (keeps a fat bright band at the rim)
      const t = Math.pow(y, 0.62);
      c.copy(horizon).lerp(top, t);
    } else {
      // below-hemisphere: subtle darkened haze (mostly hidden by terrain/fog)
      c.copy(horizon).multiplyScalar(1 - 0.35 * Math.min(1, -y));
    }
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  domeGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const domeMat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.name = 'skyDome';
  dome.frustumCulled = false; // camera lives inside
  dome.renderOrder = -1000;   // always behind
  scene.add(dome); added.push(dome);

  // ---- fog from config (dome is fog:false so it survives) ----
  const prevFog = scene.fog ?? null;
  scene.fog = new THREE.Fog(horizon.getHex(), RENDER?.FOG_NEAR ?? 900, RENDER?.FOG_FAR ?? 3400);

  function dispose() {
    for (const o of added) {
      scene.remove(o);
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    }
    added.length = 0;
    scene.fog = prevFog; // null on a fresh scene; restores prior fog otherwise
  }

  // Optional slow sun drift — main.js may skip calling this entirely.
  function update(elapsedSec) {
    if (!(elapsedSec >= 0)) return;
    sun.position.copy(sunDir(az + elapsedSec * SUN_DRIFT)).multiplyScalar(400);
  }

  return { dispose, update, dome, hemi, sun };
}
