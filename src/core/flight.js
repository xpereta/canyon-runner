// Canyon Runner — flight model (flight agent). Pure JS: no DOM, no THREE.
// Conventions per CONTRACT.md: X east, Y up, Z south; nose=-Z, right wing=+X, up=+Y.
// Body rates: omega = {p,q,r}: p roll rate (positive rolls right wing down),
// q pitch rate (positive nose up), r yaw rate (positive nose right / heading up).
// Semi-implicit Euler at fixed dt (caller guarantees dt = PHYS.DT).

import { FLIGHT, WORLD, PHYS } from '../config.js';
import {
  qFromEuler, qMul, qNormalize, qRotate, qConjugate, eulerFromQ,
} from './quat.js';

const D2R = Math.PI / 180;

// CFG-REQ: aspect ratio for Oswald induced drag (config has OSWALD but no AR)
const ASPECT_RATIO = 5.0;
// CFG-REQ: side-force slope per rad beta (config lacks CY slope)
const CY_BETA = 0.7;
// CFG-REQ: deep-stall nose-heavy pitch moment past ALPHA_STALL (stall must
// always break nose-down so it stays recoverable / accessible)
const STALL_NOSE_DROP = 6.0;
// CFG-REQ: gain of the ALPHA_LIMIT assist elevator adder (soft stall prevention)
const ALPHA_LIMIT_GAIN = 1.6;
// CFG-REQ: SPIRAL_STAB roll-rate back-term gain toward wings level (1/s)
const SPIRAL_K = 0.6;
// CFG-REQ: rolling-friction coefficient on the ground
const MU_ROLL = 0.05;
// CFG-REQ: max nosewheel steering rate on the ground (rad/s), scales down with speed
const GROUND_STEER = 0.7;
// CFG-REQ: pitch window (deg) for a gentle touchdown (contract: 'pitch near approach')
const GENTLE_PITCH_DEG = 12;
// CFG-REQ: crash damage coefficients (per m/s sink over gentle, per m/s speed over,
// per deg roll over, per unit slope, base)
const DMG_SINK = 0.10, DMG_SPEED = 0.02, DMG_ROLL = 0.012, DMG_SLOPE = 0.5, DMG_BASE = 0.08;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function createAircraft(cfg) {
  const F = cfg?.FLIGHT ?? FLIGHT ?? {};
  return {
    // --- state (contract surface) ---
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    q: [0, 0, 0, 1],
    omega: { p: 0, q: 0, r: 0 },
    alpha: 0, beta: 0,
    throttle: 0, flaps: 0, trimElevator: 0,
    onGround: false,
    time: 0,
    damage: 0,
    // --- internals (not part of the contract surface, but ride along) ---
    _cfg: F,
    _assist: cfg?.ASSIST ?? F.ASSIST ?? { AUTO_RUDDER: true, SPIRAL_STAB: true, ALPHA_LIMIT: true, RATE_LIMIT: true },
    _warnOn: false,          // stall warning latch
    _inContact: false,       // crash-event latch (one per contact episode)
    _groundHeading: 0,       // taxi heading (rad, compass)
    _dead: false,            // damage >= 1 -> skid, no controls, no events
  };
}

export function resetTo(state, spawn) {
  const yaw = (spawn.headingDeg ?? 0) * D2R;
  state.pos = { x: spawn.x, y: spawn.elevation, z: spawn.z };
  state.vel = { x: 0, y: 0, z: 0 };
  state.q = qFromEuler(yaw, 0, 0);
  state.omega = { p: 0, q: 0, r: 0 };
  state.alpha = 0; state.beta = 0;
  state.throttle = 0; state.flaps = 0; state.trimElevator = 0;
  state.onGround = true;
  state.time = 0;
  state.damage = 0;
  state._warnOn = false;
  state._inContact = true;   // we start on the ground: no crash event until a new contact
  state._groundHeading = yaw;
  state._dead = false;
  return state;
}

// CL(alpha) polar: linear to CL_MAX by ALPHA_STALL, then break-off to 0.9*CL_MAX
// declining into deep stall (floored so the wing never goes fully dead -> the nose
// always drops and the stall stays recoverable).
function clOf(alpha, F) {
  const A = Math.abs(alpha);
  const s = alpha < 0 ? -1 : 1;
  if (A <= F.ALPHA_STALL) {
    return s * Math.min(F.CL0 + F.CL_A * A, F.CL_MAX);
  }
  const deep = F.CL_MAX * (0.9 - 1.5 * (A - F.ALPHA_STALL));
  return s * Math.max(deep, 0.28 * F.CL_MAX);
}

export function stepFlight(state, ctl, terrain, dt) {
  const F = state._cfg, A = state._assist;
  const events = [];
  state.time += dt;

  // --- trim slew (state.trimElevator tracks ctl.trim*TRIM_RANGE at TRIM_RATE;
  //     elevator input past 0.15 bleeds trim off at 2x rate -> release feel) ---
  const trimTarget = clamp(ctl.trim ?? 0, -1, 1) * F.TRIM_RANGE;
  const slew = F.TRIM_RATE * dt;
  if (Math.abs(state.trimElevator - trimTarget) <= slew) state.trimElevator = trimTarget;
  else state.trimElevator += Math.sign(trimTarget - state.trimElevator) * slew;
  if (Math.abs(ctl.elevator ?? 0) > 0.15 && !state._dead) {
    const rel = 2 * F.TRIM_RATE * dt;
    if (Math.abs(state.trimElevator) <= rel) state.trimElevator = 0;
    else state.trimElevator -= Math.sign(state.trimElevator) * rel;
  }

  const ground = terrain.groundHeight(state.pos.x, state.pos.z);

  // pilot dead: skid to a stop, emit nothing.
  if (state._dead) {
    groundSlide(state, F, ground, dt);
    return events;
  }

  const elevator = clamp(ctl.elevator ?? 0, -1, 1);
  state.throttle = clamp(ctl.throttle ?? 0, 0, 1);
  state.flaps = clamp(ctl.flaps ?? 0, 0, 1);

  // ---------------- ground / taxi mode ----------------
  if (state.onGround) {
    const speed = Math.hypot(state.vel.x, state.vel.z);
    // nosewheel steering, full authority below ~15 m/s, fading with speed
    const steerFade = speed <= 15 ? 1 : Math.max(0.2, 1 - (speed - 15) / 60);
    state._groundHeading += clamp(ctl.rudder ?? 0, -1, 1) * GROUND_STEER * steerFade * dt;
    const hd = state._groundHeading;
    const nose = { x: Math.sin(hd), y: 0, z: -Math.cos(hd) };  // heading h -> (sin h, 0, -cos h)
    // thrust vs rolling friction vs aero drag
    const thrust = Math.min(
      (F.POWER_MAX * state.throttle) / Math.max(speed, 5) * (F.PROP_T_COEF ?? 0.9),
      F.T_MAX,
    );
    const qbar = 0.5 * F.RHO * speed * speed;
    const drag = qbar * F.WING_S * (F.CD0 + F.FLAP_CD * state.flaps);
    let s = speed + ((thrust - drag) / F.MASS - (speed > 0.05 ? MU_ROLL * 9.81 : 0)) * dt;
    if (s < 0) s = 0;
    state.vel = { x: nose.x * s, y: 0, z: nose.z * s };
    state.pos.x += state.vel.x * dt;
    state.pos.z += state.vel.z * dt;
    // Cliff guard: taxiing off a significant terrain drop (mesa edge, canyon
    // rim) puts the aircraft into free flight instead of pinning it to the
    // terrain face. Drop > ~1 m/step at taxi speeds = steeper than any runway.
    const newGround = terrain.groundHeight(state.pos.x, state.pos.z);
    if (ground - newGround > 1.0 && s > 5) {
      state.onGround = false;
      state._inContact = false;
      state.vel.y = 0;
      state.q = qFromEuler(hd, 0, 0);
      return events;
    }
    state.pos.y = newGround;
    state.q = qFromEuler(hd, 0, 0);
    state.omega = { p: 0, q: 0, r: 0 };
    state.alpha = 0; state.beta = 0;
    state._inContact = true;

    // rotate: liftoff when wing lift at the effective alpha of the pull
    // (positive elevator raises tail / alpha) reaches ~0.95 of weight. This
    // makes rotate speed physical (hard pull ~37 m/s, zero pull ~53 m/s from
    // CL0 alone) so gentle gyro pulls fly instead of gluing the plane to the
    // runway at 50+ m/s.
    const alphaEff = Math.min(0.30, Math.max(0, elevator * 0.12));
    const clGround = F.CL0 + F.CL_A * alphaEff;
    if (s > 15 && state.damage < 0.5 && qbar * F.WING_S * clGround >= 0.95 * F.MASS * 9.81) {
      state.onGround = false;
      state.vel.y = 1.2;
      state.q = qFromEuler(hd, 0.08, 0);
      state._inContact = false;
      events.push('liftoff');
    }
    return events;
  }

  // ---------------- airborne ----------------
  // cached air angles (wind = 0): body-frame velocity, nose along -Z
  const vB = qRotate(qConjugate(state.q), state.vel);
  const u = -vB.z;                       // forward speed along nose
  const speed = Math.hypot(state.vel.x, state.vel.y, state.vel.z);
  state.alpha = Math.atan2(-vB.y, Math.max(u, 0.5));  // nose above flight path -> +
  state.beta = Math.atan2(vB.x, Math.max(u, 0.5));    // velocity right of nose -> +

  // ---------------- control effects + accessibility assist ----------------
  // post-stall the tail loses effectiveness in the wing wake: elevator
  // authority decays with deepening stall so the nose can always drop.
  const stallDeep = Math.max(0, Math.abs(state.alpha) - F.ALPHA_STALL);
  const stallEff = 1 / (1 + 4.0 * stallDeep);
  let elevCmd = (elevator + state.trimElevator) * stallEff;
  // ALPHA_LIMIT: soft nose-down elevator adder approaching the stall
  if (A.ALPHA_LIMIT) {
    const lim = F.ALPHA_STALL * 0.9;
    if (state.alpha > lim) elevCmd -= ALPHA_LIMIT_GAIN * (state.alpha - lim);
    else if (state.alpha < -lim) elevCmd += ALPHA_LIMIT_GAIN * (-state.alpha - lim);
  }
  let aileronCmd = clamp(ctl.aileron ?? 0, -1, 1);
  let rudderCmd = clamp(ctl.rudder ?? 0, -1, 1);
  // AUTO_RUDDER: coordinate the turn from aileron + kill sideslip
  if (A.AUTO_RUDDER) {
    rudderCmd = clamp(rudderCmd + 0.8 * aileronCmd + 2.2 * state.beta, -1, 1);
  }
  // RATE_LIMIT assist is delegated to the controls stack (channel slewing).

  // control authority grows at low speed (accessibility), shrinks at high speed
  const auth = clamp((F.TRIM_SPEED ?? 45) / Math.max(speed, 8), 0.4, 2.0);

  // ---------------- body rate dynamics ----------------
  const { p, q: qRate, r } = state.omega;
  const deep = Math.abs(state.alpha) - F.ALPHA_STALL;
  const qDot =
    elevCmd * (F.PITCH_RATE ?? 1.1) * auth
    - (F.STATIC_P ?? 0.8) * state.alpha * auth
    - (deep > 0 ? STALL_NOSE_DROP * deep * Math.sign(state.alpha) : 0)
    - (F.DAMP_P ?? 0.9) * qRate;
  let rollBack = 0;
  if (A.SPIRAL_STAB && Math.abs(aileronCmd) < 0.05) {
    const roll = eulerFromQ(state.q).roll;
    rollBack = -SPIRAL_K * roll;
  }
  const pDot =
    aileronCmd * (F.ROLL_RATE ?? 2.6) * auth
    + rollBack
    - (F.DAMP_R ?? 2.2) * p;
  const rDot =
    rudderCmd * (F.YAW_RATE ?? 0.5) * auth
    + (F.STATIC_Y ?? 1.2) * state.beta * auth   // weathervane toward beta=0
    - (F.DAMP_Y ?? 1.4) * r;
  state.omega = { p: p + pDot * dt, q: qRate + qDot * dt, r: r + rDot * dt };

  // integrate attitude: dq = 1/2 * omega_body_quat * q; body-frame omega vector
  // from (p,q,r) with our axes: pitch about +X, yaw-right about -Y, roll-right about -Z.
  const w = state.omega;
  const halfDt = 0.5 * dt;
  const dq = [w.q * halfDt, -w.r * halfDt, -w.p * halfDt, 1];
  state.q = qNormalize(qMul(dq, state.q));

  // ---------------- forces ----------------
  const qbar = 0.5 * F.RHO * speed * speed;
  const CL = clOf(state.alpha, F);
  const CD = F.CD0 + (CL * CL) / (Math.PI * (F.OSWALD ?? 0.86) * ASPECT_RATIO)
    + F.FLAP_CD * state.flaps;
  const CY = -CY_BETA * state.beta;   // side force opposes slip
  const L = qbar * F.WING_S * CL;
  const D = qbar * F.WING_S * CD;
  const Y = qbar * F.WING_S * CY;

  // wind axes in body frame: forward = velocity dir; lift = body up component
  // perpendicular to velocity; side = right-wing axis orthogonalized.
  const inv = speed > 0.1 ? 1 / speed : 0;
  const fB = { x: vB.x * inv, y: vB.y * inv, z: vB.z * inv };
  let lB = { x: -fB.y * fB.x, y: 1 - fB.y * fB.y, z: -fB.y * fB.z };  // up - (up.f)f
  const lN = Math.hypot(lB.x, lB.y, lB.z) || 1;
  lB = { x: lB.x / lN, y: lB.y / lN, z: lB.z / lN };
  let sB = { x: 1 - fB.x * fB.x - lB.x * (lB.x), y: -fB.x * fB.y - lB.x * lB.y, z: -fB.x * fB.z - lB.x * lB.z };
  const sN = Math.hypot(sB.x, sB.y, sB.z) || 1;
  sB = { x: sB.x / sN, y: sB.y / sN, z: sB.z / sN };

  const fBody = {
    x: L * lB.x - D * fB.x + Y * sB.x,
    y: L * lB.y - D * fB.y + Y * sB.y,
    z: L * lB.z - D * fB.z + Y * sB.z,
  };
  const fWorld = qRotate(state.q, fBody);
  const noseW = qRotate(state.q, { x: 0, y: 0, z: -1 });
  const thrust = Math.min(
    (F.POWER_MAX * state.throttle) / Math.max(speed, 5) * (F.PROP_T_COEF ?? 0.9),
    F.T_MAX,
  );
  const ax = (fWorld.x + thrust * noseW.x) / F.MASS;
  const ay = (fWorld.y + thrust * noseW.y) / F.MASS - 9.81;
  const az = (fWorld.z + thrust * noseW.z) / F.MASS;
  state.vel = {
    x: state.vel.x + ax * dt,
    y: state.vel.y + ay * dt,
    z: state.vel.z + az * dt,
  };
  state.pos.x += state.vel.x * dt;
  state.pos.y += state.vel.y * dt;
  state.pos.z += state.vel.z * dt;

  // ---------------- events ----------------
  const warnUp = F.ALPHA_STALL * 0.85, warnDn = F.ALPHA_STALL * 0.7;
  if (!state._warnOn && state.alpha > warnUp) { state._warnOn = true; events.push('stall-warning'); }
  else if (state._warnOn && state.alpha < warnDn) { state._warnOn = false; events.push('stall-recovered'); }
  if (speed > (F.VNE ?? 92)) {
    if (!state._overOn) { state._overOn = true; events.push('overspeed'); }
  } else if (speed < (F.VNE ?? 92) * 0.97) state._overOn = false;

  // ---------------- ground contact ----------------
  const gy = terrain.groundHeight(state.pos.x, state.pos.z);
  if (state.pos.y <= gy) {
    const euler = eulerFromQ(state.q);
    const rollDeg = Math.abs(euler.roll) / D2R;
    const pitchDeg = Math.abs(euler.pitch) / D2R;
    const gentle =
      state.vel.y > -(F.GENTLE_SINK ?? 2.5) &&
      rollDeg < (F.GENTLE_ROLL ?? 25) &&
      speed < (F.GENTLE_SPEED ?? 55) &&
      pitchDeg < GENTLE_PITCH_DEG;
    if (gentle) {
      state.pos.y = gy;
      state.vel.y = 0;
      state.onGround = true;
      state._groundHeading = euler.yaw;
      state.q = qFromEuler(euler.yaw, 0, 0);
      state.omega = { p: 0, q: 0, r: 0 };
      state._inContact = true;
      events.push('touchdown');
    } else if (!state._inContact) {
      // hard hit: one crash event per contact episode, impulse damage
      let slope = 0;
      if (typeof terrain.groundInfo === 'function') {
        const hE = terrain.groundHeight(state.pos.x + 30, state.pos.z);
        const hW = terrain.groundHeight(state.pos.x - 30, state.pos.z);
        const hN = terrain.groundHeight(state.pos.x, state.pos.z - 30);
        const hS = terrain.groundHeight(state.pos.x, state.pos.z + 30);
        slope = Math.max(Math.abs(hE - hW), Math.abs(hN - hS)) / 60;
      }
      const sinkOver = Math.max(0, -(state.vel.y) - (F.GENTLE_SINK ?? 2.5));
      const spdOver = Math.max(0, speed - (F.GENTLE_SPEED ?? 55));
      const rollOver = Math.max(0, rollDeg - (F.GENTLE_ROLL ?? 25));
      state.damage = Math.min(1, state.damage +
        DMG_BASE + DMG_SINK * sinkOver + DMG_SPEED * spdOver + DMG_ROLL * rollOver + DMG_SLOPE * slope);
      events.push('crash');
      // wreck slides on the ground from here
      state.pos.y = gy;
      state.vel.y = 0;
      state.onGround = true;
      state._inContact = true;
      if (state.damage >= 1) state._dead = true;
    }
  } else if (state.pos.y > gy + 0.5) {
    state._inContact = false;   // left the ground: a new contact episode can crash again
  }

  return events;
}

// dead / wreck physics: no controls, no events, friction skid to stop.
function groundSlide(state, F, ground, dt) {
  if (state.onGround) {
    const s = Math.hypot(state.vel.x, state.vel.z);
    const ns = Math.max(0, s - (MU_ROLL * 9.81 + 0.02) * dt);
    if (ns < 0.01) { state.vel = { x: 0, y: 0, z: 0 }; }
    else {
      state.vel.x = (state.vel.x / s) * ns;
      state.vel.z = (state.vel.z / s) * ns;
    }
    state.pos.x += state.vel.x * dt;
    state.pos.z += state.vel.z * dt;
    state.pos.y = ground;
  } else {
    state.vel.y -= 9.81 * dt;
    state.pos.x += state.vel.x * dt;
    state.pos.y += state.vel.y * dt;
    state.pos.z += state.vel.z * dt;
    if (state.pos.y <= ground) {
      state.pos.y = ground;
      state.vel.y = 0;
      state.onGround = true;
    }
  }
}
