// Canyon Runner — control stack (flight agent). Pure JS, no DOM.
// Contract: channels hold until overwritten; step(dt) applies slew limits;
// get() returns the clamped, slew-limited ctl consumed by stepFlight.
import { CONTROLS, FLIGHT } from '../config.js';

// Frozen keyboard map. Contract: W/S throttle, arrows pitch/roll, A/D rudder,
// F/A flaps, T/G trim, Z/X elevator. NOTE: 'KeyA' is already rudder-left per
// "A/D rudder", so flaps use a single detent-cycle key (KeyF) — see applyKeyState.
export const KEYMAP = Object.freeze({
  KeyW: 'throttle', KeyS: 'throttle',
  KeyZ: 'elevator', KeyX: 'elevator',
  ArrowUp: 'elevator', ArrowDown: 'elevator',
  ArrowLeft: 'aileron', ArrowRight: 'aileron',
  KeyA: 'rudder', KeyD: 'rudder',
  KeyF: 'flaps',
  KeyT: 'trim', KeyG: 'trim',
});

// Signed effect of each key on its channel (elevator +=1 = nose up,
// aileron +1 = right wing down, rudder +1 = nose right, throttle +1 = up...).
export const KEY_SIGN = Object.freeze({
  KeyW: +1, KeyS: -1,
  KeyX: +1, KeyZ: -1,
  ArrowUp: +1, ArrowDown: -1,
  ArrowRight: +1, ArrowLeft: -1,
  KeyD: +1, KeyA: -1,
  KeyT: +1, KeyG: -1,
});

const CHANNELS = ['elevator', 'aileron', 'rudder', 'throttle', 'flaps', 'trim'];
const STICKS = ['elevator', 'aileron', 'rudder'];
const RANGES = {
  elevator: [-1, 1], aileron: [-1, 1], rudder: [-1, 1],
  throttle: [0, 1], flaps: [0, 1], trim: [-1, 1],
};

// CFG-REQ: per-frame trim nudge for T/G keys (config KEY_STEP lacks 'trim')
const TRIM_KEY_STEP = 0.05;

export function createControlStack(cfg) {
  const slew = { ...(CONTROLS?.SLEW ?? {}), ...(cfg?.SLEW ?? {}) };
  const keyStep = { throttle: 0.02, flaps: 0.03, ...(CONTROLS?.KEY_STEP ?? {}), ...(cfg?.KEY_STEP ?? {}) };
  // RATE_LIMIT assist (FLIGHT.ASSIST) gates stick slew limiting; on = sticks
  // slew through CONTROLS.SLEW rates, off = sticks jump to target instantly.
  const rateLimit = cfg?.RATE_LIMIT ?? FLIGHT?.ASSIST?.RATE_LIMIT ?? true;

  const target = { elevator: 0, aileron: 0, rudder: 0, throttle: 0, flaps: 0, trim: 0 };
  const out = { ...target };
  let kbChannels = new Set(); // stick channels last driven by keyboard

  function clampCh(name, v) {
    const [lo, hi] = RANGES[name];
    return Math.max(lo, Math.min(hi, v));
  }

  function setChannel(name, value) {
    if (!CHANNELS.includes(name)) return;
    target[name] = clampCh(name, Number.isFinite(value) ? value : 0);
  }

  // keyState: { code: bool } (KeyboardEvent.code keys). Sticks are written to
  // their signed held value while held and released to 0 on key-up; throttle
  // and trim nudge by KEY_STEP per call; F cycles flaps detents (0,.34,.67,1,0).
  function applyKeyState(keyState) {
    const touched = new Set();
    for (const code of Object.keys(keyState || {})) {
      if (!keyState[code]) continue;
      const ch = KEYMAP[code];
      if (!ch) continue;
      if (STICKS.includes(ch)) {
        setChannel(ch, (KEY_SIGN[code] ?? 0));
        touched.add(ch);
      } else if (ch === 'throttle' || ch === 'trim') {
        const step = ch === 'throttle' ? keyStep.throttle : TRIM_KEY_STEP;
        setChannel(ch, target[ch] + (KEY_SIGN[code] ?? 0) * step);
      } else if (ch === 'flaps') {
        const detents = [0, 1 / 3, 2 / 3, 1];
        const next = detents.find(d => d > target.flaps + 1e-6);
        setChannel('flaps', next === undefined ? 0 : next);
      }
    }
    // release stick channels the keyboard drove last frame but not this frame
    for (const ch of kbChannels) if (!touched.has(ch)) setChannel(ch, 0);
    kbChannels = touched;
  }

  function step(dt) {
    for (const ch of CHANNELS) {
      const rate = rateLimit || !STICKS.includes(ch) ? (slew[ch] ?? 4) : Infinity;
      const d = target[ch] - out[ch];
      const max = rate * dt;
      out[ch] = Math.abs(d) <= max ? target[ch] : out[ch] + Math.sign(d) * max;
    }
  }

  function get() {
    return {
      throttle: clampCh('throttle', out.throttle),
      elevator: clampCh('elevator', out.elevator),
      aileron: clampCh('aileron', out.aileron),
      rudder: clampCh('rudder', out.rudder),
      flaps: clampCh('flaps', out.flaps),
      trim: clampCh('trim', out.trim),
    };
  }

  return { setChannel, applyKeyState, step, get, target };
}
