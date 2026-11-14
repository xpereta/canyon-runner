// Canyon Runner — controls stack + gyro tests (flight agent). node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHYS, CONTROLS } from '../src/config.js';
import { createControlStack, KEYMAP, KEY_SIGN } from '../src/core/controls.js';
import { mapTilt, createGyro } from '../src/core/gyro.js';

const DT = PHYS.DT;
const closeTo = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---------------- control stack ----------------

test('stack: channels clamp and hold until overwritten', () => {
  const s = createControlStack();
  s.setChannel('throttle', 2);
  s.setChannel('elevator', -3);
  for (let i = 0; i < 120; i++) s.step(DT);
  const c = s.get();
  assert.equal(c.throttle, 1, 'throttle clamps to 1');
  assert.equal(c.elevator, -1, 'elevator clamps to -1');
  // holds without being rewritten
  for (let i = 0; i < 120; i++) s.step(DT);
  const c2 = s.get();
  assert.equal(c2.throttle, 1);
  assert.equal(c2.elevator, -1);
});

test('stack: slew limits applied in step(dt)', () => {
  const s = createControlStack();
  s.setChannel('elevator', 1);
  s.step(DT);
  const rate = CONTROLS.SLEW.elevator; // 4/s
  assert.ok(closeTo(s.get().elevator, rate * DT, 1e-9), `one step = ${rate * DT}`);
  // throttle slew slower
  s.setChannel('throttle', 1);
  s.step(DT);
  assert.ok(closeTo(s.get().throttle, CONTROLS.SLEW.throttle * DT, 1e-9));
  const full = Math.ceil(1 / (rate * DT));
  for (let i = 0; i < full; i++) s.step(DT);
  assert.equal(s.get().elevator, 1);
});

test('stack: unknown channels ignored, non-finite treated as 0', () => {
  const s = createControlStack();
  s.setChannel('elevator', 1);
  s.step(DT);
  s.setChannel('bogus', 5);
  s.setChannel('rudder', NaN);
  for (let i = 0; i < 10; i++) s.step(DT);
  const c = s.get();
  assert.equal(c.rudder, 0);
  assert.deepEqual(Object.keys(c).sort(),
    ['aileron', 'elevator', 'flaps', 'throttle', 'trim', 'rudder'].sort());
});

test('stack: keyboard sticks press/release; throttle nudges', () => {
  const s = createControlStack();
  s.applyKeyState({ ArrowRight: true });
  for (let i = 0; i < 20; i++) s.step(DT);
  assert.ok(closeTo(s.get().aileron, 1, 1e-6), 'ArrowRight = aileron +1');
  s.applyKeyState({}); // key up releases the stick channel
  for (let i = 0; i < 30; i++) s.step(DT);
  assert.ok(closeTo(s.get().aileron, 0, 1e-6), 'key-up returns stick to 0');

  s.applyKeyState({ KeyW: true });
  for (let f = 0; f < 10; f++) { s.applyKeyState({ KeyW: true }); s.step(DT); }
  assert.ok(s.get().throttle > 0.1 && s.get().throttle < 0.5, `throttle nudged: ${s.get().throttle}`);
  const tBefore = s.get().throttle;
  for (let f = 0; f < 5; f++) { s.applyKeyState({ KeyS: true }); s.step(DT); }
  for (let i = 0; i < 40; i++) s.step(DT);
  assert.ok(s.get().throttle < tBefore - 1e-6, `S should back throttle off: ${tBefore} -> ${s.get().throttle}`);
});

test('stack: flaps KeyF cycles detents 0->1/3->2/3->1->0', () => {
  const s = createControlStack();
  const seen = [];
  for (let k = 0; k < 5; k++) {
    s.applyKeyState({ KeyF: true });
    for (let i = 0; i < 150; i++) s.step(DT); // settle past the slow flaps slew
    seen.push(s.get().flaps);
  }
  assert.ok(closeTo(seen[0], 1 / 3, 1e-6), `seen ${seen}`);
  assert.ok(closeTo(seen[1], 2 / 3, 1e-6), `seen ${seen}`);
  assert.ok(closeTo(seen[2], 1, 1e-6), `seen ${seen}`);
  assert.equal(seen[3], 0, 'wraps back to 0');
  assert.ok(closeTo(seen[4], 1 / 3, 1e-6), 'cycle restarts');
});

test('KEYMAP: frozen and covers the locked contract codes', () => {
  assert.ok(Object.isFrozen(KEYMAP));
  for (const code of ['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyA', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyZ', 'KeyX']) {
    assert.ok(KEYMAP[code], `KEYMAP missing ${code}`);
  }
  assert.equal(KEYMAP.KeyW, 'throttle');
  assert.equal(KEYMAP.ArrowUp, 'elevator');
  assert.equal(KEYMAP.ArrowRight, 'aileron');
  assert.equal(KEYMAP.KeyD, 'rudder');
  assert.equal(KEY_SIGN.ArrowUp, 1, 'up = elevator +1 = nose up');
  assert.equal(KEY_SIGN.KeyS, -1, 'S = throttle down');
});

test('stack: RATE_LIMIT off => sticks jump straight to target', () => {
  const s = createControlStack({ RATE_LIMIT: false });
  s.setChannel('elevator', 1);
  s.step(DT);
  assert.equal(s.get().elevator, 1);
  // throttle/flaps/trim still slew
  const s2 = createControlStack();
  s2.setChannel('throttle', 1);
  s2.step(DT);
  assert.ok(s2.get().throttle < 1);
});

// ---------------- gyro: mapTilt (pure) ----------------

test('mapTilt: sign conventions (locked)', () => {
  const n = { beta: 45, gamma: 0 };
  const cfg = { TILT_MAX: 22, TILT_DEADBAND: 3.5, TILT_PITCH_BIAS: 0 };
  // device tilted so gamma grows by +TILT_MAX => rollAxis +1 (right wing down)
  assert.equal(mapTilt(n, { beta: 45, gamma: 22 }, cfg).rollAxis, 1);
  assert.equal(mapTilt(n, { beta: 45, gamma: -22 }, cfg).rollAxis, -1);
  // stick-forward: device top tilts away/down-screen => beta INCREASES => pitchAxis NEGATIVE
  assert.equal(mapTilt(n, { beta: 67, gamma: 0 }, cfg).pitchAxis, -1);
  // pull back (beta decreases past deadband) => pitchAxis positive
  assert.equal(mapTilt(n, { beta: 23, gamma: 0 }, cfg).pitchAxis, 1);
});

test('mapTilt: deadband, monotonic, config passthrough', () => {
  const n = { beta: 45, gamma: 0 };
  const cfg = { TILT_MAX: 22, TILT_DEADBAND: 3.5 };
  assert.equal(mapTilt(n, { beta: 45, gamma: 3 }, cfg).rollAxis, 0, 'inside deadband => 0');
  assert.equal(mapTilt(n, { beta: 48, gamma: 0 }, cfg).pitchAxis, 0, 'pitch deadband (beta +3)');
  let prev = 0;
  for (let g = 4; g <= 22; g++) {
    const v = mapTilt(n, { beta: 45, gamma: g }, cfg).rollAxis;
    assert.ok(v > prev, `monotonic at gamma=${g}`);
    prev = v;
  }
  assert.equal(prev, 1, 'full deflection at TILT_MAX');
  // custom cfg passthrough
  const c2 = { TILT_MAX: 10, TILT_DEADBAND: 2 };
  assert.equal(mapTilt(n, { beta: 45, gamma: 10 }, c2).rollAxis, 1, 'TILT_MAX=10 => full at 10deg');
  assert.equal(mapTilt(n, { beta: 45, gamma: 2 }, c2).rollAxis, 0, 'deadband=2 honored');
});

// ---------------- gyro: createGyro wrapper (fake window) ----------------

function fakeWin(withPermission = false) {
  const listeners = {};
  const w = {
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter(f => f !== fn); },
    emit: (t, e) => (listeners[t] || []).forEach(f => f(e)),
    listenerCount: (t) => (listeners[t] || []).length,
  };
  if (withPermission) {
    w.DeviceOrientationEvent = { requestPermission: async () => 'granted' };
  }
  return w;
}

test('createGyro: permission handling (iOS 13+ presence check)', async () => {
  const gPlain = createGyro(fakeWin());
  assert.equal(gPlain.needsPermission(), false);
  assert.equal(await gPlain.requestPermission(), true, 'no gate => granted');
  const gIOS = createGyro(fakeWin(true));
  assert.equal(gIOS.needsPermission(), true);
  assert.equal(await gIOS.requestPermission(), true);
});

test('createGyro: start/calibrate/read/recalibrate/stop', () => {
  const win = fakeWin();
  const g = createGyro(win, { GYRO_SMOOTH: 0 }); // smoothing off => instant
  assert.equal(g.read(), null, 'not started => null');
  g.start();
  assert.equal(g.active, true);
  assert.equal(win.listenerCount('deviceorientation'), 1);
  win.emit('deviceorientation', { beta: 50, gamma: 5 }); // pose captured pre-cal
  g.recalibrate(); // current pose is neutral
  let r = g.read();
  assert.equal(r.pitchAxis, 0);
  assert.equal(r.rollAxis, 0);
  win.emit('deviceorientation', { beta: 50 + 22, gamma: 5 }); // stick forward
  r = g.read();
  assert.ok(r.pitchAxis < -0.99, `forward tilt => negative pitchAxis, got ${r.pitchAxis}`);
  assert.equal(r.rollAxis, 0);
  win.emit('deviceorientation', { beta: 50, gamma: 5 + 22 }); // tilt right
  r = g.read();
  assert.ok(r.rollAxis > 0.99, `right tilt => positive rollAxis, got ${r.rollAxis}`);
  g.recalibrate();
  r = g.read();
  assert.equal(r.rollAxis, 0, 'recalibrate zeroes pose');
  g.stop();
  assert.equal(g.active, false);
  assert.equal(win.listenerCount('deviceorientation'), 0);
});

test('createGyro: GYRO_SMOOTH low-pass passthrough', () => {
  const win = fakeWin();
  const g = createGyro(win, { GYRO_SMOOTH: 0.9 }); // heavy smoothing
  g.start();
  win.emit('deviceorientation', { beta: 45, gamma: 0 });
  win.emit('deviceorientation', { beta: 45, gamma: 22 }); // full step
  const r = g.read();
  assert.ok(r.rollAxis > 0.05 && r.rollAxis < 0.15, `heavy smoothing first read ~0.1, got ${r.rollAxis}`);
  for (let i = 0; i < 60; i++) assert.ok(g.read().rollAxis <= 1);
  assert.ok(g.read().rollAxis > 0.9, 'converges eventually');
});


test('gyro automatically centers the first valid upright sample', () => {
  const win = fakeWin();
  const g = createGyro(win, { GYRO_SMOOTH: 0 });
  g.start();
  win.emit('deviceorientation', { beta: 90, gamma: 0 });
  assert.equal(g.read().pitchAxis, 0);
  win.emit('deviceorientation', { beta: 100, gamma: 0 });
  assert.ok(g.read().pitchAxis < 0);
});

test('gyro diagnostics distinguish waiting, invalid and valid events', () => {
  const win = fakeWin(true);
  const g = createGyro(win, { GYRO_SMOOTH: 0 });
  g.start();
  assert.equal(g.diagnostics().events, 0);
  win.emit('deviceorientation', { beta: null, gamma: null });
  assert.equal(g.diagnostics().invalidEvents, 1);
  win.emit('deviceorientation', { beta: 90, gamma: 2 });
  assert.equal(g.diagnostics().neutral.beta, 90);
  assert.equal(g.diagnostics().raw.gamma, 2);
  assert.equal(g.diagnostics().events, 2);
});

// ---------------- control-debug overlay feed (stack-side contract) ----------------

test('stack exposes slewed get() output + live target so the HUD overlay can show raw-vs-final', () => {
  const s = createControlStack();
  s.setChannel('elevator', 1);
  s.step(DT);
  const c = s.get();
  assert.equal(s.target.elevator, 1, 'target = commanded value');
  assert.ok(c.elevator > 0 && c.elevator < 1, `slewed output lags target (${c.elevator})`);
  for (const k of ['elevator', 'aileron', 'rudder', 'throttle', 'flaps', 'trim'])
    assert.ok(Number.isFinite(c[k]), `get().${k} must be finite for the debug rows`);
});
