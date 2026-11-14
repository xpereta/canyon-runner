// Canyon Runner — core/terrain.js
// Procedural canyon world: high plateau dissected by one long winding main canyon,
// 5-8 side canyons, >=15 mesas, a river, and a flat mesa-top runway at spawn.
// Pure deterministic math, no DOM, no THREE. All tables built once per seed.
//
// Axes: X east, Z south (north = -Z), Y up = meters MSL. World square WORLD.SIZE
// centered at origin.

import { WORLD } from '../config.js';
import { mulberry32, valueNoise2, fbm2 } from './noise.js';

const SIZE = WORLD.SIZE;
const PLATEAU = WORLD.PLATEAU_H;
const PLAIN = WORLD.PLAIN_H;
const C = WORLD.CANYON;
const FLOOR = PLATEAU - C.DEPTH;          // nominal canyon floor MSL (850)

// CFG-REQ: runway length/width (m) — contract fixes 900x30 but config.js has no keys
const RUNWAY_L = 900, RUNWAY_W = 30, RUNWAY_FEATHER = 130;
// CFG-REQ: canyon wall profile band half-widths (m) — smoothstep wall shape tuning
const WALL_HALF = 85;                     // transition spans [w-WALL_HALF, w+WALL_HALF]
const RIM_BAND = 55;                      // rimrock band beyond wall influence
const RIVER_HALF = C.RIVER_W / 2;         // 11 m water strip
const SPLINE_STEP = 55;                   // arc-length table spacing (m)
const BUCKET = 512;                       // spatial-hash cell size (m)
const BUCKET_REG = 230;                   // segment registration margin >= max canyon influence

function smoothstep(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// Catmull-Rom segment interpolation (uniform), phantom endpoints by reflection.
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

// Resample a dense polyline to uniform arc-length spacing; returns {pts, len}.
function resampleByArc(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0], az = pts[i - 1][1];
    const bx = pts[i][0], bz = pts[i][1];
    const seg = Math.hypot(bx - ax, bz - az);
    let d = carry;
    while (d + step <= seg) {
      d += step;
      const f = d / seg;
      out.push([ax + (bx - ax) * f, az + (bz - az) * f]);
    }
    carry = d - seg;
  }
  let len = 0;
  for (let i = 1; i < out.length; i++) len += Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
  return { pts: out, len };
}

function pointSegDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

const MESA_NAMES = ['Ghost Mesa', 'Sunspire Mesa', 'Lone Butte', 'The Castle', 'High Top Mesa',
  'Red Anvil', 'Kiva Mesa', 'Saddle Butte', 'Fang Mesa', 'Copper Mesa', 'Vulture Butte',
  'Jumpoff Mesa', 'Twin Horn Mesa', 'Painted Rock Mesa', 'Cueva Mesa', 'Curtain Butte',
  'Huerfano Mesa', 'Puerco Butte', 'Mesa de Oro', 'Sentinel Mesa', 'Broken Top Mesa', 'Apache Mesa'];
const SIDE_NAMES = ['Slot Creek', 'Dry Wash', 'Twin Notch', 'Red Wall Canyon', 'Coyote Draw',
  'Juniper Gulch', 'Serpent Wash', 'Rattlesnake Draw'];

export function createTerrain(seed) {
  const rng = mulberry32(seed >>> 0);
  const sA = (seed ^ 0x51ab) | 0, sB = (seed ^ 0x2f7c) | 0, sC = (seed ^ 0x77d3) | 0;
  const sD = (seed ^ 0x1e09) | 0, sP1 = rng() * Math.PI * 2, sP2 = rng() * Math.PI * 2;

  // ---- main canyon spline: 4 waypoints serpentine, 3 full sweeps ~42 km >= MIN_LEN
  const wp = [
    [-0.42 * SIZE, -0.375 * SIZE], [0.42 * SIZE, -0.125 * SIZE],
    [-0.42 * SIZE, 0.125 * SIZE], [0.42 * SIZE, 0.375 * SIZE],
  ];
  const dense = [];
  for (let i = 0; i < wp.length - 1; i++) {
    const p0 = i ? wp[i - 1] : [2 * wp[0][0] - wp[1][0], 2 * wp[0][1] - wp[1][1]];
    const p3 = i + 2 < wp.length ? wp[i + 2] : [2 * wp[3][0] - wp[2][0], 2 * wp[3][1] - wp[2][1]];
    const n = 240;
    for (let k = 0; k <= n; k++) dense.push(catmullRom(p0, wp[i], wp[i + 1], p3, k / n));
  }
  const rs = resampleByArc(dense, SPLINE_STEP);
  const N = rs.pts.length, L = rs.len;
  // half-width varies smoothly; full width stays in [WIDTH_MIN, WIDTH_MAX] = [120,260]
  const wHalf = new Float64Array(N), stn = new Float64Array(N);
  let sumFull = 0;
  for (let i = 0; i < N; i++) {
    const st = Math.min(i * SPLINE_STEP, L);
    stn[i] = st;
    const w = 95 + 22 * Math.sin(2 * Math.PI * 2.3 * st / L + sP1) + 13 * Math.sin(2 * Math.PI * 6.1 * st / L + sP2);
    wHalf[i] = w;
    sumFull += 2 * w;
  }
  const mainPts = rs.pts;
  const mainLen = L;
  const mainWidth = sumFull / N;

  // ---- side canyons: 5-8 branches, each winding, narrower, shallower
  const nSide = C.SIDE_COUNT_MIN + Math.floor(rng() * (C.SIDE_COUNT_MAX - C.SIDE_COUNT_MIN + 1));
  const sides = [];
  const junctions = [];
  for (let tries = 0; tries < 40 && junctions.length < nSide; tries++) {
    const s = Math.floor(0.06 * N + rng() * 0.88 * N);
    let ok = true;
    for (const j of junctions) if (Math.abs(j - s) * SPLINE_STEP < 1500) ok = false;
    if (ok) junctions.push(s);
  }
  const mainStation = (x, z) => { // coarse nearest main-station index (brute, build-time only)
    let best = -1, bd = Infinity;
    for (let i = 0; i < N; i += 4) {
      const d = (mainPts[i][0] - x) ** 2 + (mainPts[i][1] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  for (let j = 0; j < junctions.length; j++) {
    const s = junctions[j];
    const px = mainPts[s][0], pz = mainPts[s][1];
    const i2 = Math.min(N - 1, s + 2);
    let tx = mainPts[i2][0] - mainPts[Math.max(0, s - 2)][0];
    let tz = mainPts[i2][1] - mainPts[Math.max(0, s - 2)][1];
    const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
    const target = 1200 + rng() * 1400;
    const half = 55 + rng() * 40;          // full 110-190 m, narrower than main
    const depth = C.DEPTH * (0.6 + rng() * 0.18);
    // up to 3 heading attempts; keep the longest branch so SIDE_COUNT_MIN holds
    let best = null;
    for (let att = 0; att < 3; att++) {
      const sign = rng() < 0.5 ? 1 : -1;
      // branch must leave at >=30 deg off the main-normal so a 400 m perpendicular
      // rim probe never falls in the side canyon's influence (depth test safety)
      const baseAng = Math.atan2(tz, tx); // branch angles are RELATIVE to main tangent
      const phi0 = baseAng + sign * ((rng() < 0.5 ? 45 + rng() * 15 : 120 + rng() * 15)) * Math.PI / 180;
      let pts = [[px, pz]], dir = phi0, acc = 0;
      let cx = px, cz = pz;
      for (let k = 1; k < 40 && acc < target; k++) {
        dir += (rng() * 2 - 1) * 0.45;
        const nx = cx + Math.cos(dir) * 300, nz = cz + Math.sin(dir) * 300;
        if (Math.abs(nx) > 0.46 * SIZE || Math.abs(nz) > 0.46 * SIZE) break;
        if (k >= 5) { // beyond the junction fan-out: must not re-approach the main canyon
          const mi = mainStation(nx, nz);
          if (Math.hypot(mainPts[mi][0] - nx, mainPts[mi][1] - nz) < 650) break;
        }
        pts.push([nx, nz]); cx = nx; cz = nz; acc += 300;
      }
      if (!best || acc > best.acc) best = { pts, acc };
      if (acc >= 700) break;
    }
    if (best.acc < 700 && sides.length >= C.SIDE_COUNT_MIN) continue; // too pinched
    const r = resampleByArc(best.pts, SPLINE_STEP);
    const jIdx = mainStation(px, pz);
    sides.push({
      pts: r.pts, len: r.len, half, depth,
      floor: floorMain(stn[jIdx]) + (C.DEPTH - depth), // meets main floor level at junction
      name: SIDE_NAMES[j % SIDE_NAMES.length],
    });
  }

  // ---- mesas: flat-top masses with steep sides; kept clear of all canyons
  const mesaTarget = WORLD.MESA_MIN + 6;
  const mesas = [];
  const clearOfCanyons = (x, z, r) => {
    const lim = (r + 880) ** 2;
    for (let i = 0; i < N; i += 4) {
      if ((mainPts[i][0] - x) ** 2 + (mainPts[i][1] - z) ** 2 < lim) return false;
    }
    for (const sd of sides) {
      for (let i = 0; i < sd.pts.length; i += 4) {
        if ((sd.pts[i][0] - x) ** 2 + (sd.pts[i][1] - z) ** 2 < lim) return false;
      }
    }
    return true;
  };
  for (let tries = 0; tries < 900 && mesas.length < mesaTarget; tries++) {
    const big = mesas.length === 0; // first mesa is the runway host: big flat cap
    const r = big ? 950 : 320 + rng() * 520;
    const x = (rng() * 2 - 1) * 0.40 * SIZE, z = (rng() * 2 - 1) * 0.40 * SIZE;
    if (!clearOfCanyons(x, z, r)) continue;
    let ok = true;
    for (const m of mesas) if ((m.x - x) ** 2 + (m.z - z) ** 2 < (m.r + r + 500) ** 2) ok = false;
    if (!ok) continue;
    // capRise = height ADDED above local base; topElev is the absolute flat-top
    // elevation (base plateau + local rough at center) -> dead-flat caps
    const capRise = big ? 300 : 120 + rng() * 240;
    const topElev = PLATEAU + roughAt(x, z) + capRise;
    mesas.push({ x, z, r, capRise, topElev, rf: 0.78 * r, name: MESA_NAMES[mesas.length % MESA_NAMES.length] });
  }

  // ---- spawn: runway on the big mesa cap, east-west
  const spawnMesa = mesas[0];
  const spawn = { x: spawnMesa.x, z: spawnMesa.z, headingDeg: 90, elevation: 0 };

  // ---- spatial hash of all canyon segments for distance queries
  const segs = [];
  const buckets = new Map();
  const key = (cx, cz) => (cx + 4000) * 8001 + (cz + 4000);
  const addSeg = (ax, az, bx, bz, w0, w1, kind, id, st0, st1) => {
    const si = segs.length;
    segs.push([ax, az, bx, bz, w0, w1, kind, id, st0, st1]);
    const x0 = Math.floor((Math.min(ax, bx) - BUCKET_REG) / BUCKET);
    const x1 = Math.floor((Math.max(ax, bx) + BUCKET_REG) / BUCKET);
    const z0 = Math.floor((Math.min(az, bz) - BUCKET_REG) / BUCKET);
    const z1 = Math.floor((Math.max(az, bz) + BUCKET_REG) / BUCKET);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        let b = buckets.get(k);
        if (!b) buckets.set(k, b = []);
        b.push(si);
      }
    }
  };
  for (let i = 0; i < N - 1; i++) addSeg(mainPts[i][0], mainPts[i][1], mainPts[i + 1][0], mainPts[i + 1][1], wHalf[i], wHalf[i + 1], 0, -1, stn[i], stn[i + 1]);
  sides.forEach((sd, id) => {
    for (let i = 0; i < sd.pts.length - 1; i++) {
      addSeg(sd.pts[i][0], sd.pts[i][1], sd.pts[i + 1][0], sd.pts[i + 1][1], sd.half, sd.half, 1, id, 0, 0);
    }
  });

  // nearest canyon structures: main {d,st,w} + sides Map(id -> d)
  function nearestCanyon(x, z) {
    const cx = Math.floor(x / BUCKET), cz = Math.floor(z / BUCKET);
    const b = buckets.get(key(cx, cz));
    const res = { main: null, sides: null };
    if (!b) return res;
    for (const si of b) {
      const s = segs[si];
      const ax = s[0], az = s[1], bx = s[2], bz = s[3];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
      let t = l2 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (s[6] === 0) {
        if (!res.main || d < res.main.d) {
          res.main = { d, w: s[4] + (s[5] - s[4]) * t, st: s[8] + (s[9] - s[8]) * t };
        }
      } else {
        if (!res.sides) res.sides = new Map();
        const prev = res.sides.get(s[7]);
        if (prev === undefined || d < prev) res.sides.set(s[7], d);
      }
    }
    return res;
  }

  function floorMain(st) {
    return FLOOR + 2 * Math.sin(st / 900) + 3 * fbm2(st / 400, 7.3, sD, { octaves: 2 });
  }
  const WATER_Y = FLOOR + 5.6; // constant river surface (floor stays below it)

  function edgeBlend(x, z) { // 0 inside, 1 beyond SIZE/2+2000 -> low plain
    const e = Math.max(Math.abs(x), Math.abs(z));
    return smoothstep((e - (SIZE / 2 - 2000)) / 4000);
  }
  function canyonProfile(d, w) { // 1 at floor, 0 outside influence; C2-smooth walls
    const fr = Math.max(0, w - WALL_HALF), we = w + WALL_HALF;
    if (d <= fr) return 1;
    if (d >= we) return 0;
    return 1 - smoothstep((d - fr) / (we - fr));
  }
  function runwayBlend(x, z) {
    const d = spawn.headingDeg * Math.PI / 180;
    const ux = Math.sin(d), uz = -Math.cos(d); // heading 90 (east) -> (1,0)
    const ex = x - spawn.x, ez = z - spawn.z;
    const u = Math.abs(ex * ux + ez * uz), v = Math.abs(ex * uz - ez * ux);
    const s = Math.max(u - RUNWAY_L / 2, v - RUNWAY_W / 2);
    if (s <= 0) return 1;
    if (s >= RUNWAY_FEATHER) return 0;
    return 1 - smoothstep(s / RUNWAY_FEATHER);
  }

  function roughAt(x, z) { // gentle rolling plateau relief
    return 46 * fbm2(x / 2600, z / 2600, sA, { octaves: 4 }) + 10 * fbm2(x / 650, z / 650, sB, { octaves: 2 });
  }

  function rawHeight(x, z) {
    let h = PLATEAU + roughAt(x, z);
    const e = edgeBlend(x, z);
    if (e > 0) h = PLAIN + (h - PLAIN) * (1 - e);
    const nc = nearestCanyon(x, z);
    if (nc.main) {
      const wC = canyonProfile(nc.main.d, nc.main.w);
      if (wC > 0) { const fl = floorMain(nc.main.st); h = h + (fl - h) * wC; }
    }
    if (nc.sides) {
      for (const [id, d] of nc.sides) {
        const sd = sides[id];
        const wC = canyonProfile(d, sd.half);
        if (wC > 0) h = h + (sd.floor - h) * wC;
      }
    }
    for (const m of mesas) {
      const dm = Math.hypot(m.x - x, m.z - z);
      if (dm < m.r) {
        const t = dm <= m.rf ? 1 : 1 - smoothstep((dm - m.rf) / (m.r - m.rf));
        h = h + (m.topElev - h) * t; // blend toward the absolute flat cap elevation
      }
    }
    return h;
  }

  const spawnElev = Math.round(rawHeight(spawn.x, spawn.z) * 100) / 100;
  spawn.elevation = spawnElev;

  function groundHeight(x, z) {
    let h = rawHeight(x, z);
    const rb = runwayBlend(x, z);
    if (rb > 0) h = h + (spawnElev - h) * rb;
    return h;
  }

  function groundInfo(x, z) {
    const h = groundHeight(x, z);
    const rb = runwayBlend(x, z);
    if (rb > 0.5) return { h, type: 'grass' };
    const e = edgeBlend(x, z);
    const nc = nearestCanyon(x, z);
    let mainD = Infinity, mainW = 0, side = null;
    if (nc.main) { mainD = nc.main.d; mainW = nc.main.w; }
    if (nc.sides) {
      let bestD = Infinity, bestId = -1;
      for (const [id, d] of nc.sides) if (d < bestD) { bestD = d; bestId = id; }
      if (bestId >= 0 && bestD <= sides[bestId].half + WALL_HALF + RIM_BAND) side = { d: bestD, sd: sides[bestId] };
    }
    if (mainD < (side ? side.d : Infinity) && mainD <= mainW + WALL_HALF + RIM_BAND) {
      const fl = floorMain(nc.main.st);
      if (mainD <= RIVER_HALF) return { h, type: 'water' };
      if (h <= fl + 12) return { h, type: 'sand' };
      if (mainD <= mainW + WALL_HALF) return { h, type: slopeAt(x, z) >= 0.9 ? 'rock' : 'scree' };
      return { h, type: 'rimrock' };
    }
    if (side) {
      if (h <= side.sd.floor + 12) return { h, type: 'sand' };
      if (side.d <= side.sd.half + WALL_HALF) return { h, type: slopeAt(x, z) >= 0.9 ? 'rock' : 'scree' };
      return { h, type: 'rimrock' };
    }
    for (const m of mesas) {
      if ((m.x - x) ** 2 + (m.z - z) ** 2 <= m.rf * m.rf) return { h, type: 'mesatop' };
    }
    if (e > 0.55) return { h, type: 'grass' };
    if (slopeAt(x, z) >= 0.3) return { h, type: 'scree' };
    return { h, type: valueNoise2(x / 110, z / 110, sC) < 0.42 ? 'shrub' : 'grass' };
  }

  function slopeAt(x, z) { // forward-difference gradient magnitude (cheap, 2 extra calls)
    const eps = 15, h0 = groundHeight(x, z);
    return Math.hypot(groundHeight(x + eps, z) - h0, groundHeight(x, z + eps) - h0) / eps;
  }

  const landmarks = [
    { x: mainPts[Math.floor(N * 0.5)][0], z: mainPts[Math.floor(N * 0.5)][1], name: 'Redbone Canyon' },
    ...mesas.slice(0, 6).map(m => ({ x: m.x, z: m.z, name: m.name })),
    ...sides.map(s => ({ x: s.pts[Math.floor(s.pts.length * 0.5)][0], z: s.pts[Math.floor(s.pts.length * 0.5)][1], name: s.name })),
  ];

  return {
    seed,
    size: SIZE,
    groundHeight,
    groundInfo,
    landmarks,
    spawn,
    canyon: {
      mainLen, mainWidth, depth: C.DEPTH,
      sides: sides.map(s => ({ len: s.len, width: 2 * s.half, depth: s.depth })),
    },
    // internal tables (used by tests and the minimap; shape stable this session)
    mainSpline: mainPts.map((p, i) => ({ x: p[0], z: p[1], st: stn[i], w: wHalf[i] })),
    mesas,
    waterLevel: WATER_Y,
    runway: { x: spawn.x, z: spawn.z, headingDeg: spawn.headingDeg, length: RUNWAY_L, width: RUNWAY_W },
  };
}
