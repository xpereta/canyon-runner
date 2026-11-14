// Canyon Runner — gyro tilt mapping (flight agent).
// mapTilt is PURE (tested headless); createGyro is the thin browser wrapper
// (deviceorientation listener; touches window/DeviceOrientationEvent only
// when instantiated — import in Node stays side-effect-free).
import { CONTROLS } from '../config.js';

// DeviceOrientation degrees: beta = pitch fore/aft (90 = held upright,
// increasing = top edge tilts away from the viewer), gamma = left/right roll
// (increasing = right side of device tips down/right).
//
// Holding pose is typically ~{beta: 45, gamma: 0}. Locked sign convention:
//   pitchAxis = (neutral.beta - cur.beta) / range
//     -> pushing the stick forward (device top tilts away/down-screen, beta
//        INCREASES past the deadband) gives NEGATIVE pitchAxis (elevator -1).
//   rollAxis  = (cur.gamma - neutral.gamma) / range
//     -> tilting the device right (gamma grows) gives POSITIVE rollAxis
//        (right wing down).
// Deadband then a smoothstep ramp reaching full ±1 at ±TILT_MAX.
export function mapTilt(neutral, cur, cfg) {
  const range = cfg?.TILT_MAX ?? CONTROLS?.TILT_MAX ?? 22;
  const dead = Math.max(0, cfg?.TILT_DEADBAND ?? CONTROLS?.TILT_DEADBAND ?? 3.5);
  const bias = cfg?.TILT_PITCH_BIAS ?? CONTROLS?.TILT_PITCH_BIAS ?? 0;
  const nBeta = (neutral?.beta ?? 45) + bias;
  const nGamma = neutral?.gamma ?? 0;
  const dPitch = nBeta - (cur?.beta ?? nBeta);
  const dRoll = (cur?.gamma ?? nGamma) - nGamma;
  return { pitchAxis: tiltAxis(dPitch, range, dead), rollAxis: tiltAxis(dRoll, range, dead) };
}

function tiltAxis(delta, range, dead) {
  const s = Math.sign(delta);
  const span = Math.max(range - dead, 1e-9);
  let t = (Math.abs(delta) - dead) / span;
  t = Math.max(0, Math.min(1, t));
  return s * t * t * (3 - 2 * t) + 0; // smoothstep: gentle onset at deadband edge (+0 kills -0)
}

export function createGyro(win, cfg) {
  const smooth = cfg?.GYRO_SMOOTH ?? CONTROLS?.GYRO_SMOOTH ?? 0.25;
  const doe = win?.DeviceOrientationEvent;

  let neutral = null;   // captured pose at start()/recalibrate()
  let latest = null;    // most recent raw {beta,gamma}
  let filt = { pitchAxis: 0, rollAxis: 0 };
  let onOrient = null;
  let isActive = false;
  let events = 0, invalidEvents = 0, permission = doe ? (typeof doe.requestPermission === 'function' ? 'prompt' : 'not required') : 'unavailable';

  function needsPermission() {
    return typeof doe?.requestPermission === 'function'; // iOS 13+ heuristic
  }

  async function requestPermission() {
    if (typeof doe?.requestPermission !== 'function') return true;
    try {
      const res = await doe.requestPermission();
      permission = res;
      return res === 'granted';
    } catch { permission = 'error'; return false; }
  }

  function recalibrate() {
    neutral = latest
      ? { beta: latest.beta, gamma: latest.gamma }
      : null;
    filt = { pitchAxis: 0, rollAxis: 0 };
  }

  function start() {
    if (isActive || !win?.addEventListener) return;
    latest = null;
    neutral = null;
    onOrient = (e) => {
      events++;
      if (Number.isFinite(e?.beta) && Number.isFinite(e?.gamma)) {
        latest = { beta: e.beta, gamma: e.gamma };
        if (!neutral) recalibrate();
      } else invalidEvents++;
    };
    win.addEventListener('deviceorientation', onOrient);
    recalibrate();
    isActive = true;
  }

  function stop() {
    if (onOrient && win?.removeEventListener) {
      win.removeEventListener('deviceorientation', onOrient);
    }
    onOrient = null;
    isActive = false;
  }

  function read() {
    if (!isActive || !latest || !neutral) return null;
    const raw = mapTilt(neutral, latest, cfg);
    const k = Math.max(0, Math.min(0.95, smooth)); // GYRO_SMOOTH: 0=off, high=heavy
    filt.pitchAxis += (1 - k) * (raw.pitchAxis - filt.pitchAxis);
    filt.rollAxis += (1 - k) * (raw.rollAxis - filt.rollAxis);
    return { pitchAxis: filt.pitchAxis, rollAxis: filt.rollAxis };
  }

  function diagnostics() {
    return { permission, secure: !!win?.isSecureContext, active: isActive, events, invalidEvents,
      raw: latest && { ...latest }, neutral: neutral && { ...neutral }, axes: { ...filt },
      screenAngle: win?.screen?.orientation?.angle ?? win?.orientation ?? 0 };
  }

  const g = { needsPermission, requestPermission, start, stop, read, recalibrate, diagnostics };
  Object.defineProperty(g, 'active', { get: () => isActive });
  return g;
}
