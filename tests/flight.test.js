// Canyon Runner — flight model tests (flight agent). Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHYS, FLIGHT } from '../src/config.js';
import { createAircraft, resetTo, stepFlight } from '../src/core/flight.js';
import { qFromEuler, eulerFromQ, qRotate } from '../src/core/quat.js';

const DT = PHYS.DT;

// Flat terrain fixture, same shape production passes (main.js uses the real
// terrain: {groundHeight, groundInfo} — contract shape).
const flat = {
  groundHeight: () => 1000,
  groundInfo: () => ({ h: 1000, type: 'grass' }),
};
const spawn = { x: 0, z: -9000, headingDeg: 0, elevation: 1000 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const speed = st => Math.hypot(st.vel.x, st.vel.y, st.vel.z);
const head = st => Math.atan2(st.vel.x, -st.vel.z);
const D2R = Math.PI / 180;

function air({ alt = 1150, v = 50, pitch = 0, roll = 0, yaw = 0, vsi = 0, cfg } = {}) {
  const st = createAircraft(cfg);
  resetTo(st, spawn);
  st.q = qFromEuler(yaw, pitch, roll);
  const n = qRotate(st.q, { x: 0, y: 0, z: -1 });
  st.vel = { x: n.x * v, y: vsi, z: n.z * v };
  st.pos.y = alt;
  st.onGround = false;
  st._inContact = false;
  return st;
}
function ctlAll(o = {}) {
  return { throttle: 0.65, elevator: 0, aileron: 0, rudder: 0, flaps: 0, trim: 0, ...o };
}
function run(st, ctl, seconds, cb) {
  const evs = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const e = stepFlight(st, ctl, flat, DT);
    evs.push(...e);
    if (cb) cb(st, e, i); // e = fresh event array for THIS step
  }
  return evs;
}

test('resetTo puts aircraft on runway heading, grounded, speed 0', () => {
  const st = createAircraft();
  resetTo(st, spawn);
  assert.equal(st.onGround, true);
  assert.equal(speed(st), 0);
  assert.equal(eulerFromQ(st.q).yaw, 0);
  assert.equal(st.pos.y, 1000);
  assert.equal(st.damage, 0);
});

// ACCEPTANCE (a): level flight — trim-baseline 30s, trim holds altitude, 120s hold.
test('level flight: trim holds altitude within 20m and speed within 15% over 120s', () => {
  const st = air({ alt: 1150, v: 50 });
  const ctl = ctlAll({ throttle: 0.65 });
  run(st, ctl, 30); // trim-baseline, assist ON (default)

  // Trim search: slow integral on vertical speed (trim authority is large;
  // aggressive gains would fly the phugoid ourselves).
  let calmSince = -1, locked = false;
  run(st, ctl, 160, () => {
    if (locked) return;
    if (Math.abs(st.vel.y) < 0.05) {
      if (calmSince < 0) calmSince = st.time;
      if (st.time - calmSince > 10) { locked = true; return; }
    } else calmSince = -1;
    ctl.trim = clamp(ctl.trim - DT * 0.0015 * st.vel.y, -0.6, 0.6);
  });
  assert.ok(locked, 'trim search should settle to level flight');

  const alt0 = st.pos.y, v0 = speed(st);
  let dmax = 0, vmin = Infinity, vmax = 0;
  run(st, ctl, 120, () => {
    dmax = Math.max(dmax, Math.abs(st.pos.y - alt0));
    const v = speed(st);
    vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
  });
  assert.ok(dmax < 20, `altitude drift ${dmax.toFixed(1)}m must stay < 20m`);
  assert.ok(vmin > v0 * 0.85 && vmax < v0 * 1.15,
    `speed ${vmin.toFixed(1)}..${vmax.toFixed(1)} must stay within 15% of ${v0.toFixed(1)}`);
});

// ACCEPTANCE (b): LOCKED control signs from trimmed cruise.
test('signs: elevator +1 raises pitch, aileron +1 raises roll, rudder +1 raises heading', () => {
  const cruise = () => {
    const st = air({ alt: 1300, v: 55 });
    const ctl = ctlAll();
    ctl.trim = -0.02; // near-elevator trim for ~straight flight
    run(st, ctl, 10);
    return [st, ctl];
  };
  let [st, c] = cruise();
  const p0 = eulerFromQ(st.q).pitch;
  run(st, { ...c, elevator: 1 }, 3);
  assert.ok(eulerFromQ(st.q).pitch > p0 + 0.3, 'elevator +1 (LOCKED: nose-up) must increase pitch');

  [st, c] = cruise();
  const r0 = eulerFromQ(st.q).roll;
  run(st, { ...c, aileron: 1 }, 2);
  assert.ok(eulerFromQ(st.q).roll > r0 + 0.3, 'aileron +1 (right wing down) must increase roll');

  [st, c] = cruise();
  const h0 = head(st);
  run(st, { ...c, rudder: 1 }, 3);
  assert.ok(head(st) > h0 + 0.02, 'rudder +1 must increase heading');
});

// ACCEPTANCE (c): stall warning + nose-drop recovery with input unchanged.
test('stall: pull-up at 18 m/s warns within 5s and recovers without input change', () => {
  const st = air({ alt: 1450, v: 18 });
  const ctl = ctlAll({ elevator: 1 });
  let warnT = -1, recT = -1;
  run(st, ctl, 20, (s, e) => {
    if (e.includes('stall-warning') && warnT < 0) warnT = st.time;
    if (e.includes('stall-recovered') && recT < 0) recT = st.time;
  });
  assert.ok(warnT >= 0 && warnT < 5, `stall-warning expected < 5s, got ${warnT}`);
  assert.ok(recT >= 0 && recT < 12, `stall-recovered expected (nose drops), got ${recT}`);
  assert.ok(!st.onGround, 'should recover before ground');
});

// ACCEPTANCE (d): hard impact -> crash event + damage; dead plane ignores inputs.
test('crash: 70 m/s dive at flat terrain fires crash, damage>0, dead plane skids quietly', () => {
  const st = air({ alt: 1004, v: 70, pitch: -40 * D2R });
  const ctl = ctlAll();
  const evs = run(st, ctl, 8);
  assert.ok(evs.includes('crash'), 'crash event expected');
  assert.ok(st.damage > 0, 'damage expected > 0');
  const evs2 = run(st, ctlAll({ throttle: 0.9, elevator: 0.5, aileron: 1, rudder: 1, flaps: 1, trim: 1 }), 5);
  assert.deepEqual(evs2.filter(e => !['touchdown', 'crash'].includes(e)).length, 0, 'dead: no new events');
});

// ACCEPTANCE (e): gentle landing -> touchdown/taxi/accelerate -> liftoff.
test('landing: -2 m/s at 40 m/s touches down gently, taxis, lifts off', () => {
  const st = air({ alt: 1001, v: 40, vsi: -2 });
  const ctl = ctlAll();
  let tdT = -1;
  run(st, ctl, 2, (s, e) => { if (e.includes('touchdown')) tdT = st.time; });
  assert.ok(tdT >= 0 && tdT < 1, 'touchdown expected within 1s');
  assert.equal(st.onGround, true);
  assert.equal(st.damage, 0, 'gentle touchdown must do no damage');

  const s0 = speed(st);
  run(st, ctlAll({ throttle: 0.9 }), 4);
  assert.ok(speed(st) > s0 + 3, `taxi accel expected: ${s0.toFixed(1)} -> ${speed(st).toFixed(1)}`);
  run(st, ctlAll({ throttle: 0.9 }), 3); // keep rolling to build carry-off speed

  const evs = run(st, ctlAll({ throttle: 0.9, elevator: 0.6 }), 0.5); // brief rotation
  assert.ok(evs.includes('liftoff'), 'liftoff expected with elevator hold above rotate speed');
  assert.equal(st.onGround, false);
  // gentle climb-out after liftoff
  run(st, ctlAll({ throttle: 0.9, elevator: 0.05 }), 10);
  assert.ok(st.damage === 0, 'no crash after liftoff');
  assert.ok(st.pos.y > 1005, `should be climbing away, got alt ${st.pos.y.toFixed(1)}`);
  assert.equal(st.onGround, false);
});

test('overspeed event fires once on VNE crossing', () => {
  const st = air({ alt: 1200, v: (FLIGHT.VNE ?? 92) + 4 });
  const evs = run(st, ctlAll({ throttle: 0.3 }), 3);
  assert.ok(evs.includes('overspeed'));
  assert.equal(evs.filter(e => e === 'overspeed').length, 1);
});

test('trim slews at TRIM_RATE and bleeds 2x under elevator pressure', () => {
  const st = air();
  const ctl = ctlAll({ trim: 0.5 });
  run(st, ctl, 1);
  const after1s = st.trimElevator;
  assert.ok(Math.abs(after1s - FLIGHT.TRIM_RATE) < 0.01, `trim slew ~${FLIGHT.TRIM_RATE}/s, got ${after1s}`);
  run(st, ctlAll({ trim: 0.5, elevator: 0.2 }), 1);
  assert.ok(st.trimElevator < after1s, 'elevator pressure bleeds trim (2x release)');
  assert.ok(st.trimElevator >= 0, 'trim does not overshoot past release to negative');
  run(st, ctlAll({ trim: 1.0 }), 8);
  assert.ok(Math.abs(st.trimElevator - FLIGHT.TRIM_RANGE) < 1e-9, 'trim clamps at TRIM_RANGE');
});

// --- assist flags must be clearly separable ---
function assistCfg(over) {
  return { ASSIST: { AUTO_RUDDER: true, SPIRAL_STAB: true, ALPHA_LIMIT: true, RATE_LIMIT: true, ...over } };
}
test('SPIRAL_STAB off: wings stay tilted; on: roll back toward level', () => {
  const rollIn = ctlAll({ aileron: 1 });
  const level = ctlAll();
  const withA = air({ alt: 1300, v: 55, cfg: assistCfg({ SPIRAL_STAB: false }) });
  const withoutA = air({ alt: 1300, v: 55, cfg: assistCfg({ SPIRAL_STAB: true }) });
  run(withA, rollIn, 1); run(withoutA, rollIn, 1);
  const r0a = eulerFromQ(withA.q).roll, r0b = eulerFromQ(withoutA.q).roll;
  assert.ok(Math.abs(r0a - r0b) < 0.05, 'same roll input -> same initial roll');
  run(withA, level, 6);
  run(withoutA, level, 6);
  const dA = Math.abs(eulerFromQ(withA.q).roll) - r0a;
  const dB = Math.abs(eulerFromQ(withoutA.q).roll) - r0b;
  assert.ok(dA > -0.05, 'assist OFF: spiral divergence keeps roll (no rollback)');
  assert.ok(dB < -0.3, `assist ON: roll decays toward level (delta ${dB.toFixed(2)})`);
});

test('ALPHA_LIMIT on reduces peak alpha in aggressive pull-up', () => {
  const pull = ctlAll({ elevator: 1 });
  const on = air({ alt: 1400, v: 30, cfg: assistCfg({ ALPHA_LIMIT: true }) });
  const off = air({ alt: 1400, v: 30, cfg: assistCfg({ ALPHA_LIMIT: false }) });
  let aOn = 0, aOff = 0;
  run(on, pull, 6, () => { aOn = Math.max(aOn, Math.abs(on.alpha)); });
  run(off, pull, 6, () => { aOff = Math.max(aOff, Math.abs(off.alpha)); });
  assert.ok(aOn < aOff - 0.05, `ALPHA_LIMIT should cap alpha: on=${aOn.toFixed(2)} off=${aOff.toFixed(2)}`);
});

test('AUTO_RUDDER reduces sideslip during turns', () => {
  const bank = ctlAll({ aileron: 0.25 });
  const glide = ctlAll();
  const on = air({ alt: 1300, v: 55, cfg: assistCfg({ AUTO_RUDDER: true }) });
  const off = air({ alt: 1300, v: 55, cfg: assistCfg({ AUTO_RUDDER: false }) });
  let bOn = 0, bOff = 0;
  const meas = (st, acc) => () => { if (st.time > 2.2) acc.v = Math.max(acc.v, Math.abs(st.beta)); };
  const aOn = { v: 0 }, aOff = { v: 0 };
  run(on, bank, 2, meas(on, aOn)); run(off, bank, 2, meas(off, aOff));
  run(on, glide, 4, meas(on, aOn)); run(off, glide, 4, meas(off, aOff));
  bOn = aOn.v; bOff = aOff.v;
  assert.ok(bOff > 0.01, `expect sideslip without auto-rudder, got ${bOff.toFixed(3)}`);
  assert.ok(bOn < bOff - 0.01, `AUTO_RUDDER should cut beta: on=${bOn.toFixed(3)} off=${bOff.toFixed(3)}`);
});

test('damage accumulates and never exceeds 1; repeated bounces do not refire mid-episode', () => {
  const st = air({ alt: 1010, v: 70, pitch: -20 * D2R });
  run(st, ctlAll(), 30);
  assert.equal(st.damage, 1, 'hard repeated ground contact ends at damage=1 (dead)');
  assert.ok(st._dead);
});

// Regression (orchestrator live-QA): taxiing off a mesa edge must NOT pin the
// aircraft to the terrain face — it enters free flight and falls.
test('cliff guard: taxi off a sharp terrain drop releases to free fall', () => {
  const cliff = {
    groundHeight: (x) => (x < 0 ? 1000 : 500),
    groundInfo: (x) => ({ h: x < 0 ? 1000 : 500, type: 'grass' }),
  };
  const st = createAircraft();
  resetTo(st, { x: -40, z: 0, headingDeg: 90, elevation: 1000 });
  const ctl = ctlAll({ throttle: 1 });
  let released = false;
  for (let i = 0; i < Math.round(6 / DT); i++) {
    stepFlight(st, ctl, cliff, DT);
    if (!st.onGround) { released = true; break; }
  }
  assert.ok(released, 'aircraft must leave ground at cliff edge');
  run2(st, ctl, 4);
  assert.ok(st.pos.y < 990 && st.vel.y < 0, 'falls with gravity instead of tracking terrain face');
  assert.ok(st.pos.y > 500, 'has not yet reached the lower plain in 4 s of fall');
});
function run2(st, ctl, seconds) {
  for (let i = 0; i < Math.round(seconds / DT); i++) stepFlight(st, ctl, cliffFixture, DT);
}
const cliffFixture = { groundHeight: (x) => (x < 0 ? 1000 : 500), groundInfo: (x) => ({ h: x < 0 ? 1000 : 500, type: 'grass' }) };
