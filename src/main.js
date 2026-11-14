// Canyon Runner — src/main.js (ui agent). Composition root: the ONLY file that
// imports THREE (relative ../vendor/three.module.js — no bare 'three', no import
// maps) and the only file wiring core + render + UI together.
//
// Wave-2 render modules are consumed strictly via their contract signatures:
//   render/aircraft.js: createAircraft(THREE) -> { group, update(state, ctl) }
//   render/sky.js:      createSky(THREE, scene) -> { dispose }

import * as THREE from '../vendor/three.module.js';
import { WORLD, PHYS, FLIGHT, CONTROLS, RENDER, HUD } from './config.js';
import { createTerrain } from './core/terrain.js';
import { createAircraft, resetTo, stepFlight } from './core/flight.js';
import { createControlStack, KEYMAP } from './core/controls.js';
import { createGyro } from './core/gyro.js';
import { eulerFromQ } from './core/quat.js';
import { createWorld } from './render/terrainMesh.js';
import { createAircraft as createAircraftVisual } from './render/aircraft.js';
import { createSky } from './render/sky.js';
import { createHud } from './ui/hud.js';

// CFG-REQ: RAF watchdog thresholds (ms) — config has no loop-health keys
const WATCHDOG_MS = 200;   // interval between watchdog probes
const RAF_STALL_MS = 250;  // no RAF for this long -> run a frame manually
// CFG-REQ: fallback keyboard notice display time (ms)
const KB_NOTICE_MS = 6000;
// CFG-REQ: chase-camera look-ahead (s) applied to velocity for camera lookAt
const CAM_LOOKAHEAD_S = 0.5;
// CFG-REQ: camera floor clearance above terrain (m)
const CAM_GROUND_CLEAR = 3;

// ---------------- global error sink + QA hooks (installed first) ----------------
window.__errs = [];
function noteErr(e) {
  window.__errs.push(e && e.stack ? e.stack : String(e));
}

// ---------------- world + subsystems ----------------
const terrain = createTerrain(WORLD.SEED);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 6000);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.getElementById('app').appendChild(renderer.domElement);

const world = createWorld(THREE, scene, terrain, RENDER);
const sky = createSky(THREE, scene);
const ac = createAircraftVisual(THREE);
scene.add(ac.group);

const stack = createControlStack();
const gyro = createGyro(window, CONTROLS);
const hud = createHud(document, terrain);
hud.bindStack(stack);
hud.bindGyro(gyro);

const state = createAircraft();
resetTo(state, terrain.spawn);

// ---------------- input ----------------
const keyState = {}; // { KeyboardEvent.code: bool }
window.addEventListener('keydown', e => {
  if (e.code === 'KeyR' && !e.repeat) { hud.banner('Returning to runway', 1200); respawn(); return; }
  if (KEYMAP[e.code]) {
    keyState[e.code] = true;
    e.preventDefault(); // arrows/space scroll the page otherwise
  }
});
window.addEventListener('keyup', e => {
  if (KEYMAP[e.code]) keyState[e.code] = false;
});
window.addEventListener('blur', () => { for (const k of Object.keys(keyState)) keyState[k] = false; });

// ---------------- crash / respawn ----------------
const RESPAWN_FREEZE = FLIGHT.RESPAWN_FREEZE ?? 1.5;
let freezeTimer = 0;       // s of sim frozen after a crash (rendering continues)
const stats = { crashes: 0, frames: 0, simSteps: 0 };

function respawn() {
  freezeTimer = 0;
  resetTo(state, terrain.spawn);
  stack.setChannel('throttle', 0);
  stack.setChannel('flaps', 0);
  stack.setChannel('trim', 0);
  snapCamera();
}
hud.bindRespawn(respawn);

// ---------------- fixed-timestep simulation ----------------
const DT = PHYS.DT;

function simStep() {
  stats.simSteps++;
  if (freezeTimer > 0) {
    freezeTimer -= DT;
    if (freezeTimer <= 0) respawn();
    hud.update(state, []);
    return;
  }
  // keyboard writes every frame, gyro overwrites the stick axes when active
  stack.applyKeyState(keyState);
  if (gyro.active) {
    const axes = gyro.read();
    if (axes) {
      stack.setChannel('elevator', axes.pitchAxis);
      stack.setChannel('aileron', axes.rollAxis);
    }
  }
  stack.step(DT);
  const ctl = stack.get();
  const events = stepFlight(state, ctl, terrain, DT);
  if (events.includes('crash')) {
    stats.crashes++;
    freezeTimer = RESPAWN_FREEZE;
    hud.banner('CRASHED — respawning', RESPAWN_FREEZE * 1000);
  }
  if (events.includes('overspeed')) hud.banner('OVERSPEED', 1000);
  hud.update(state, events);
}

// ---------------- chase camera ----------------
const camPos = { x: 0, y: 0, z: 0 };
let camReady = false;

function cameraTarget() {
  const hs = Math.hypot(state.vel.x, state.vel.z);
  let dx, dz;
  if (hs > 1.5) { dx = state.vel.x / hs; dz = state.vel.z / hs; }
  else {
    const yaw = eulerFromQ(state.q).yaw;
    dx = Math.sin(yaw); dz = -Math.cos(yaw);
  }
  return {
    x: state.pos.x - dx * (RENDER.CAM_BACK ?? 14),
    y: state.pos.y + (RENDER.CAM_UP ?? 4),
    z: state.pos.z - dz * (RENDER.CAM_BACK ?? 14),
  };
}
function snapCamera() {
  const t = cameraTarget();
  camPos.x = t.x; camPos.y = t.y; camPos.z = t.z;
  camReady = true;
}
function updateCamera() {
  const t = cameraTarget();
  const k = RENDER.CAM_SMOOTH ?? 0.12;
  if (!camReady) snapCamera();
  else {
    camPos.x += (t.x - camPos.x) * k;
    camPos.y += (t.y - camPos.y) * k;
    camPos.z += (t.z - camPos.z) * k;
  }
  const floor = terrain.groundHeight(camPos.x, camPos.z) + CAM_GROUND_CLEAR;
  if (camPos.y < floor) camPos.y = floor;
  camera.position.set(camPos.x, camPos.y, camPos.z);
  camera.lookAt(
    state.pos.x + state.vel.x * CAM_LOOKAHEAD_S,
    state.pos.y + state.vel.y * CAM_LOOKAHEAD_S,
    state.pos.z + state.vel.z * CAM_LOOKAHEAD_S,
  );
}

// ---------------- rendering ----------------
function draw() {
  const ctl = stack.get();
  ac.group.position.set(state.pos.x, state.pos.y, state.pos.z);
  ac.group.quaternion.fromArray(state.q);
  ac.update(state, ctl);
  updateCamera();
  world.update(state.pos);
  renderer.render(scene, camera);
  stats.frames++;
}

// ---------------- frame loop + RAF watchdog ----------------
const MAX_STEPS = 5;
let lastReal = performance.now();
let rafId = 0;
let running = false;

function frame(now) {
  try {
    const dtReal = Math.min(1, (now - lastReal) / 1000);
    lastReal = now;
    let steps = Math.round(dtReal / DT);
    steps = Math.min(steps, MAX_STEPS);
    for (let i = 0; i < steps; i++) simStep();
    draw();
  } catch (e) {
    noteErr(e);
  }
  if (running) rafId = requestAnimationFrame(frame);
}

// hidden tabs freeze RAF: pump frames manually so the HUD/camera stay alive and
// QA can observe step()/draw() behavior headlessly.
setInterval(() => {
  if (!running) return;
  const now = performance.now();
  if (now - lastReal > RAF_STALL_MS) {
    cancelAnimationFrame(rafId);
    frame(now);
  }
}, WATCHDOG_MS);

function resize() {
  camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);

// ---------------- start flow (mobile UX; first tap = the user gesture) ----------------
const overlay = document.getElementById('start-overlay');
const beginBtn = document.getElementById('begin-btn');
const motionBtn = document.getElementById('motion-btn');
const kbNotice = document.getElementById('kb-notice');

function startLoop() {
  if (running) return;
  running = true;
  lastReal = performance.now();
  rafId = requestAnimationFrame(frame);
}

beginBtn.addEventListener('click', () => {
  overlay.classList.add('hidden');
  kbNotice.hidden = false;
  setTimeout(() => { kbNotice.hidden = true; }, KB_NOTICE_MS);
  if (gyro.needsPermission()) {
    motionBtn.hidden = false; // iOS: permission must ride this separate gesture
  } else if (window.DeviceOrientationEvent) {
    gyro.start();
    if (gyro.active) hud.banner('Gyro active — hold level, tilt to steer', 2500);
  }
  startLoop();
});

motionBtn.addEventListener('click', async () => {
  motionBtn.hidden = true;
  const ok = await gyro.requestPermission();
  if (ok) {
    gyro.start();
    hud.banner('Gyro active — hold level, tilt to steer', 2500);
  } else {
    hud.banner('Motion denied — keyboard controls active', 3000);
  }
});

// ---------------- QA hooks ----------------
function step(n) {
  for (let i = 0; i < n; i++) simStep();
  return state.time;
}

window.__game = {
  terrain, world, ac, sky, state, stack, hud, gyro, camera, renderer,
  scene, stats, step, draw,
  errs: window.__errs,
  respawn,
};
Object.defineProperty(window.__game, 'simTime', { get: () => state.time });
Object.defineProperty(window.__game, 'freeze', { get: () => freezeTimer });
