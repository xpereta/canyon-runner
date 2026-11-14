// Canyon Runner — ui/hud.js (ui agent). DOM overlay + touch widgets + vector minimap.
// ALL formatting/minimap math lives in pure exported helpers so node tests can run
// them without a DOM; createHud is the thin DOM layer on top.
//
// Minimap note (verified against src/core/terrain.js): the exposed extra tables are
// mainSpline [{x,z,st,w}], mesas [{x,z,r,rf,topElev,name}], waterLevel (constant
// river surface elevation, meters MSL) and runway {x,z,headingDeg,length,width}.
// terrain.canyon.sides is only a numeric summary ({len,width,depth} per side) — no
// side-canyon polylines are exposed, so the minimap draws the main spline (canyon
// band + river centerline), mesas, runway tick, landmarks and the aircraft only.
// The 512^2 raster of the contract was replaced by this vector map per the approved
// optimization: no per-frame groundHeight sampling at all.

import { HUD, FLIGHT } from '../config.js';
import { eulerFromQ } from '../core/quat.js';

// CFG-REQ: landmark label pick range (m) — config lacks HUD.LANDMARK_RANGE
const LANDMARK_RANGE = 6000;
// CFG-REQ: AGL (m) below which the proximity vignette turns on
const PROX_AGL = 30;
// CFG-REQ: stall banner latch duration (s) after a 'stall-warning' event
const STALL_BANNER_S = 2.5;
// CFG-REQ: flaps detent step for the +/- buttons (matches KEYMAP detents 0,1/3,2/3,1)
const FLAP_STEP = 1 / 3;
// CFG-REQ: full needle deflection (rad/s) of the turn coordinator
const TURN_FULL_RATE = 0.5;
// CFG-REQ: minimap velocity arrow lookahead (s)
const VEL_ARROW_S = 3;

const KT = 1.943844492; // m/s -> knots
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// ---------------- pure formatting helpers (testable, no DOM) ----------------

export function speedMs(state) {
  const v = state.vel;
  return Math.hypot(v.x, v.y, v.z);
}
export function fmtSpeedKmh(state) { return String(Math.round(speedMs(state) * 3.6)); }
export function fmtSpeedKts(state) { return String(Math.round(speedMs(state) * KT)); }
export function fmtAlt(state) { return String(Math.round(state.pos.y)); }
export function fmtAgl(aglMeters) { return String(Math.round(aglMeters)); }
export function fmtVsi(vel) {
  const vy = typeof vel === 'number' ? vel : vel.y;
  const r = Math.round(vy);
  return (r > 0 ? '+' : '') + r;
}

// Compass heading (deg, 0..359) from the attitude quaternion (yaw = heading).
export function headingOf(state) {
  const yawDeg = eulerFromQ(state.q).yaw * 180 / Math.PI;
  return ((Math.round(yawDeg) % 360) + 360) % 360;
}
export function fmtHeading(deg) {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return String(d).padStart(3, '0');
}
export function cardinalOf(deg) {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return CARDINALS[Math.round(d / 45) % 8];
}

// Nearest landmark within maxDist of (x,z), or null.
export function chooseLandmarkLabel(landmarks, x, z, maxDist = LANDMARK_RANGE) {
  let best = null, bd = maxDist;
  for (const lm of landmarks || []) {
    const d = Math.hypot(lm.x - x, lm.z - z);
    if (d <= bd) { bd = d; best = lm; }
  }
  return best ? best.name : null;
}

// Flap detent index 0..3 for display.
export function fmtFlaps(flaps) {
  const v = Math.max(0, Math.min(1, flaps || 0));
  return String(Math.round(v * 3));
}

// Turn-coordinator needle angle (deg, right-turn positive) from body yaw rate.
export function turnNeedleDeg(omega) {
  const r = Math.max(-1, Math.min(1, (omega?.r ?? 0) / TURN_FULL_RATE));
  return Math.round(r * 45);
}

// ---------------- vector minimap (pure ctx; any 2D canvas-like surface) ----------------

// Draws north-up: world +X east -> screen +x, world +Z south -> screen +y (north up).
export function drawMinimap(ctx, terrain, state, opts = {}) {
  const S = opts.size ?? HUD.MINIMAP_SIZE ?? 256;
  const range = opts.range ?? HUD.MINIMAP_RANGE ?? 3200;
  const half = S / 2;
  const scale = half / range;
  const ax = state.pos.x, az = state.pos.z;
  const px = wx => half + (wx - ax) * scale;
  const pz = wz => half + (wz - az) * scale;
  const inBox = (x, z, m) => Math.abs(x - ax) <= range + m && Math.abs(z - az) <= range + m;

  ctx.clearRect(0, 0, S, S);
  ctx.save();
  ctx.beginPath();
  ctx.arc(half, half, half, 0, 2 * Math.PI);
  ctx.clip();
  ctx.fillStyle = 'rgba(8,14,22,0.35)';
  ctx.fillRect(0, 0, S, S);

  // main canyon band (width from spline w field), clipped to the view box
  const spline = terrain.mainSpline || [];
  let avgW = 100;
  if (spline.length) {
    let sw = 0;
    for (const p of spline) sw += p.w;
    avgW = sw / spline.length;
  }
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < spline.length; i++) {
    const p = spline[i];
    if (!inBox(p.x, p.z, 500)) { started = false; continue; }
    if (!started) { ctx.moveTo(px(p.x), pz(p.z)); started = true; }
    else ctx.lineTo(px(p.x), pz(p.z));
  }
  ctx.strokeStyle = 'rgba(150,80,55,0.55)';
  ctx.lineWidth = Math.max(2, 2 * avgW * scale);
  ctx.stroke();
  // river (waterLevel is a constant surface elevation; the strip follows the spline)
  ctx.beginPath();
  started = false;
  for (const p of spline) {
    if (!inBox(p.x, p.z, 500)) { started = false; continue; }
    if (!started) { ctx.moveTo(px(p.x), pz(p.z)); started = true; }
    else ctx.lineTo(px(p.x), pz(p.z));
  }
  ctx.strokeStyle = 'rgba(70,140,200,0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // mesas: rings around each flat-top circle in range
  ctx.strokeStyle = 'rgba(190,185,140,0.5)';
  ctx.fillStyle = 'rgba(190,185,140,0.10)';
  ctx.lineWidth = 1;
  for (const m of terrain.mesas || []) {
    if (!inBox(m.x, m.z, m.r)) continue;
    ctx.beginPath();
    ctx.arc(px(m.x), pz(m.z), Math.max(2, m.r * scale), 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }

  // runway tick
  const rw = terrain.runway;
  if (rw && inBox(rw.x, rw.z, rw.length)) {
    const d = rw.headingDeg * Math.PI / 180;
    const ux = Math.sin(d), uz = -Math.cos(d);
    const hl = rw.length / 2 * scale;
    ctx.beginPath();
    ctx.moveTo(px(rw.x - ux * rw.length / 2), pz(rw.z - uz * rw.length / 2));
    ctx.lineTo(px(rw.x + ux * rw.length / 2), pz(rw.z + uz * rw.length / 2));
    ctx.strokeStyle = '#e8f2ff';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // landmark dots + labels
  ctx.fillStyle = 'rgba(255,210,122,0.9)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  for (const lm of terrain.landmarks || []) {
    if (!inBox(lm.x, lm.z, 0)) continue;
    ctx.beginPath();
    ctx.arc(px(lm.x), pz(lm.z), 2.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillText(lm.name, px(lm.x) + 4, pz(lm.z) - 3);
  }

  // aircraft triangle (nose along heading, north-up map) + velocity vector
  const hdg = headingOf(state) * Math.PI / 180;
  ctx.save();
  ctx.translate(half, half);
  ctx.rotate(hdg);
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(6, 7);
  ctx.lineTo(-6, 7);
  ctx.closePath();
  ctx.fillStyle = '#8fd0ff';
  ctx.fill();
  ctx.restore();
  const vx = state.vel.x, vz = state.vel.z;
  if (Math.hypot(vx, vz) > 1) {
    ctx.beginPath();
    ctx.moveTo(half, half);
    ctx.lineTo(half + vx * VEL_ARROW_S * scale, half + vz * VEL_ARROW_S * scale);
    ctx.strokeStyle = 'rgba(143,208,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------- DOM layer ----------------

export function createHud(doc, terrain) {
  const SIZE = HUD.MINIMAP_SIZE ?? 256;
  const el = tag => doc.createElement(tag);
  const span = (cls, text) => { const s = el('span'); s.className = cls; s.textContent = text; return s; };
  const div = (id, cls) => { const d = el('div'); if (id) d.id = id; if (cls) d.className = cls; return d; };

  const root = div('cr-hud');
  root.style.setProperty?.('--cr-mm', SIZE + 'px');
  root.style['--cr-mm'] = SIZE + 'px'; // harmless plain-object fallback (fake docs)

  // airspeed
  const asi = div('cr-asi', 'panel');
  const asiBig = span('big', '0');
  asi.appendChild(asiBig);
  asi.appendChild(span('unit', ' km/h'));
  const asiKts = span('kts', '0 kt');
  asi.appendChild(asiKts);
  const asiVsi = span('vsi', '+0 m/s');
  asi.appendChild(asiVsi);

  // altitude
  const altP = div('cr-alt', 'panel');
  const altMsl = span('msl', '0 m MSL');
  const altAgl = span('agl', '0 m AGL');
  altP.appendChild(altMsl);
  altP.appendChild(altAgl);

  // heading strip
  const hdgP = div('cr-heading', 'panel');
  const hdgVal = span('hdg', '000');
  const hdgCard = span('card4', 'N');
  const hdgLand = span('landmark', '');
  hdgP.appendChild(hdgVal);
  hdgP.appendChild(hdgCard);
  hdgP.appendChild(hdgLand);

  // minimap
  const mm = div('cr-minimap');
  const mmCanvas = el('canvas');
  mmCanvas.width = SIZE;
  mmCanvas.height = SIZE;
  mmCanvas.style.width = SIZE + 'px';
  mmCanvas.style.height = SIZE + 'px';
  const mmCtx = mmCanvas.getContext ? mmCanvas.getContext('2d') : null;
  mm.appendChild(mmCanvas);

  // throttle bar / flaps detents / trim dot
  const tbar = div('cr-throttlebar');
  const tfill = div(null, 'fill');
  tbar.appendChild(tfill);
  const flapsBox = div('cr-flaps');
  const detDots = [0, 1, 2, 3].map(() => { const d = div(null, 'det'); flapsBox.appendChild(d); return d; });
  const trimBar = div('cr-trim');
  const trimDot = div(null, 'dot');
  trimBar.appendChild(trimDot);

  // turn coordinator
  const turn = div('cr-turn', 'panel');
  const needle = div(null, 'needle');
  turn.appendChild(needle);

  // banners
  const bannerEl = div('cr-banner');
  const stallEl = div('cr-stall');
  stallEl.textContent = 'STALL';
  const crashEl = div('cr-crashes');
  const vignette = div('cr-vignette');

  // touch widgets (right thumb zone)
  const widgets = div('cr-widgets');
  const tiltHint = div('cr-tilt-hint', 'pill');
  tiltHint.textContent = 'Hold level, tilt to steer';
  const recen = div('cr-recen', 'pill');
  recen.textContent = 'RECENTER GYRO';
  const reset = div('cr-reset', 'pill');
  reset.textContent = 'RESET';
  const flapBtns = div('cr-flapbtns');
  const flapMinus = div(null, 'pill');
  flapMinus.textContent = 'FLAPS -';
  const flapPlus = div(null, 'pill');
  flapPlus.textContent = 'FLAPS +';
  flapBtns.appendChild(flapMinus);
  flapBtns.appendChild(flapPlus);
  widgets.appendChild(tiltHint);
  widgets.appendChild(recen);
  widgets.appendChild(reset);
  widgets.appendChild(flapBtns);

  // throttle slider (big invisible track over the throttle bar readout)
  const slider = div('cr-slider');
  const knob = div(null, 'knob');
  slider.appendChild(knob);

  root.appendChild(asi);
  root.appendChild(altP);
  root.appendChild(hdgP);
  root.appendChild(mm);
  root.appendChild(tbar);
  root.appendChild(flapsBox);
  root.appendChild(trimBar);
  root.appendChild(turn);
  root.appendChild(bannerEl);
  root.appendChild(stallEl);
  root.appendChild(crashEl);
  root.appendChild(vignette);
  root.appendChild(widgets);
  root.appendChild(slider);
  doc.body.appendChild(root);

  // ---- state owned by the HUD ----
  let stack = null, gyro = null, respawnFn = null;
  let crashCount = 0;
  let stallUntil = -1;
  let lastSeenTime = 0;
  let bannerTimer = null;
  let heldThrottle = null; // set while the slider finger is down
  const listeners = [];
  const on = (target, ev, fn, opts) => {
    target.addEventListener(ev, fn, opts);
    listeners.push([target, ev, fn, opts]);
  };

  function banner(text, ms = 2500) {
    bannerEl.textContent = text;
    bannerEl.classList.add('show');
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), ms);
  }

  // slider geometry from a pointer event (guarded for non-browser stubs)
  function sliderValue(ev) {
    const rect = slider.getBoundingClientRect
      ? slider.getBoundingClientRect()
      : { top: 0, height: 200 };
    const y = (ev.clientY ?? rect.top) - rect.top;
    const f = 1 - Math.max(0, Math.min(1, y / Math.max(1, rect.height)));
    return f;
  }
  function pressStart(ev) {
    heldThrottle = sliderValue(ev);
    if (stack) stack.setChannel('throttle', heldThrottle);
  }
  function pressMove(ev) {
    if (heldThrottle === null) return;
    heldThrottle = sliderValue(ev);
    if (stack) stack.setChannel('throttle', heldThrottle);
  }
  function pressEnd() { heldThrottle = null; } // channel holds its last written value
  on(slider, 'pointerdown', pressStart);
  on(slider, 'pointermove', pressMove);
  on(slider, 'pointerup', pressEnd);
  on(slider, 'pointercancel', pressEnd);

  on(flapPlus, 'click', () => {
    if (stack) stack.setChannel('flaps', Math.min(1, (stack.target?.flaps ?? 0) + FLAP_STEP));
  });
  on(flapMinus, 'click', () => {
    if (stack) stack.setChannel('flaps', Math.max(0, (stack.target?.flaps ?? 0) - FLAP_STEP));
  });
  on(recen, 'click', () => { gyro?.recalibrate(); banner('Gyro re-centered', 1500); });
  on(reset, 'click', () => { respawnFn?.(); });

  function update(state, events) {
    asiBig.textContent = fmtSpeedKmh(state);
    asiKts.textContent = fmtSpeedKts(state) + ' kt';
    asiVsi.textContent = fmtVsi(state.vel) + ' m/s';

    const ground = terrain.groundHeight(state.pos.x, state.pos.z);
    const agl = state.pos.y - ground;
    altMsl.textContent = fmtAlt(state) + ' m MSL';
    altAgl.textContent = fmtAgl(agl) + ' m AGL';

    const hdg = headingOf(state);
    hdgVal.textContent = fmtHeading(hdg);
    hdgCard.textContent = cardinalOf(hdg);
    hdgLand.textContent = chooseLandmarkLabel(terrain.landmarks, state.pos.x, state.pos.z) ?? '';

    tfill.style.height = Math.round((state.throttle ?? 0) * 100) + '%';
    knob.style.bottom = Math.round((stack?.target?.throttle ?? state.throttle ?? 0) * (200 - 22)) + 'px';

    const fdet = Math.round((state.flaps ?? 0) * 3);
    for (let i = 0; i < 4; i++) detDots[i].classList.toggle('on', i <= fdet);

    const trimRange = FLIGHT.TRIM_RANGE ?? 0.6;
    const trimPct = 50 + Math.round((state.trimElevator ?? 0) / trimRange * 50);
    trimDot.style.bottom = Math.max(0, Math.min(100, trimPct)) + '%';

    needle.style.transform = `translateX(-50%) rotate(${turnNeedleDeg(state.omega)}deg)`;

    // stall banner: live alpha + latched from warning events
    if (state.time < lastSeenTime) stallUntil = -1; // respawn/restart rewound the clock
    lastSeenTime = state.time;
    if (events && events.includes('stall-warning')) stallUntil = state.time + STALL_BANNER_S;
    if (events && events.includes('stall-recovered') && stallUntil > state.time + 0.5) {
      stallUntil = state.time + 0.5; // quick wink on recovery
    }
    const alpha = Math.abs(state.alpha ?? 0);
    const stallOn = alpha > (HUD.STALL_ALPHA ?? 0.24) || state.time < stallUntil;
    stallEl.classList.toggle('show', stallOn);

    if (events && events.includes('crash')) crashCount += 1;
    crashEl.textContent = 'Crashes: ' + crashCount;

    vignette.classList.toggle('on', agl < PROX_AGL && agl >= 0 && !state.onGround);

    if (gyro) {
      recen.classList.toggle('show', !!gyro.active);
      tiltHint.classList.toggle('show', !!gyro.active);
    }

    // throttle held on the slider keeps re-writing its channel every frame
    if (heldThrottle !== null && stack) stack.setChannel('throttle', heldThrottle);

    if (mmCtx) drawMinimap(mmCtx, terrain, state, { size: SIZE });
  }

  function bindStack(s) { stack = s; }
  function bindGyro(g) { gyro = g; }
  function bindRespawn(fn) { respawnFn = fn; }

  function dispose() {
    if (bannerTimer) clearTimeout(bannerTimer);
    for (const [t, ev, fn, opts] of listeners) t.removeEventListener?.(ev, fn, opts);
    listeners.length = 0;
    root.remove?.();
  }

  const hud = { update, bindStack, bindGyro, bindRespawn, banner, dispose, drawMinimap };
  Object.defineProperty(hud, 'crashes', { get: () => crashCount });
  return hud;
}
