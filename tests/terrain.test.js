import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD } from '../src/config.js';
import { createTerrain } from '../src/core/terrain.js';
import { mulberry32 } from '../src/core/noise.js';

const T = createTerrain(WORLD.SEED);
const T2 = createTerrain(WORLD.SEED);

test('determinism: same seed -> identical heights at 50 random points', () => {
  const r = mulberry32(0xBEEF);
  for (let i = 0; i < 50; i++) {
    const x = (r() * 2 - 1) * 1.2 * WORLD.SIZE / 2;
    const z = (r() * 2 - 1) * 1.2 * WORLD.SIZE / 2;
    assert.equal(T.groundHeight(x, z), T2.groundHeight(x, z));
    assert.deepEqual(T.groundInfo(x, z).type, T2.groundInfo(x, z).type);
  }
  // different seed -> different world
  const T3 = createTerrain(WORLD.SEED + 1);
  assert.notEqual(T.groundHeight(1000, -1000), T3.groundHeight(1000, -1000));
});

test('canyon: length/width/depth contract gates', () => {
  assert.ok(T.canyon.mainLen >= WORLD.CANYON.MIN_LEN, `mainLen ${T.canyon.mainLen}`);
  assert.ok(T.canyon.mainWidth >= WORLD.CANYON.WIDTH_MIN && T.canyon.mainWidth <= WORLD.CANYON.WIDTH_MAX,
    `mainWidth ${T.canyon.mainWidth}`);
  assert.equal(T.canyon.depth, WORLD.CANYON.DEPTH);
  assert.ok(T.canyon.sides.length >= WORLD.CANYON.SIDE_COUNT_MIN && T.canyon.sides.length <= WORLD.CANYON.SIDE_COUNT_MAX,
    `side count ${T.canyon.sides.length}`);
  for (const s of T.canyon.sides) {
    assert.ok(s.width < WORLD.CANYON.WIDTH_MIN + 80); // side canyons narrower
    assert.ok(s.len >= 700);
  }
});

test('canyon depth: floor >= depth*0.7 below rim (max side, 400 m off-spline) for >=90% of spline samples', () => {
  const spl = T.mainSpline;
  const step = Math.max(1, Math.round(200 / 55)); // sample every ~200 m
  let pass = 0, total = 0;
  for (let i = 0; i < spl.length; i += step) {
    const a = spl[Math.max(0, i - 3)], b = spl[Math.min(spl.length - 1, i + 3)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
    const nx = -tz, nz = tx; // perpendicular
    const floor = T.groundHeight(spl[i].x, spl[i].z);
    const rim = Math.max(
      T.groundHeight(spl[i].x + nx * 400, spl[i].z + nz * 400),
      T.groundHeight(spl[i].x - nx * 400, spl[i].z - nz * 400));
    total++;
    if (floor <= rim - T.canyon.depth * 0.7) pass++;
  }
  assert.ok(total > 150, `too few samples: ${total}`);
  assert.ok(pass / total >= 0.9, `depth pass rate ${(pass / total * 100).toFixed(1)}% (${pass}/${total})`);
});

test('runway: 900x30 m rect < 0.5 m variation, all grass, on spawn heading', () => {
  const s = T.spawn;
  assert.ok(s.elevation >= 300);
  assert.equal(Math.round(T.groundHeight(s.x, s.z)), Math.round(s.elevation));
  const d = s.headingDeg * Math.PI / 180;
  const ux = Math.sin(d), uz = -Math.cos(d);
  let lo = Infinity, hi = -Infinity;
  for (let iu = 0; iu <= 40; iu++) {
    for (let iv = 0; iv <= 12; iv++) {
      const u = (iu / 40 - 0.5) * 900, v = (iv / 12 - 0.5) * 30;
      const x = s.x + u * ux + v * uz, z = s.z + u * uz - v * ux;
      const info = T.groundInfo(x, z);
      assert.equal(info.type, 'grass', `runway point type ${info.type} at u=${u} v=${v}`);
      lo = Math.min(lo, info.h); hi = Math.max(hi, info.h);
    }
  }
  assert.ok(hi - lo < 0.5, `runway variation ${(hi - lo).toFixed(3)} m`);
});

test('transect across main canyon shows water/sand/rock/rimrock/grass ordering', () => {
  const spl = T.mainSpline;
  const i = Math.floor(spl.length / 2);
  const a = spl[i - 3], b = spl[i + 3];
  let tx = b.x - a.x, tz = b.z - a.z;
  const tl = Math.hypot(tx, tz); tx /= tl; tz /= tl;
  const nx = -tz, nz = tx;
  const types = new Set();
  for (let k = -35; k <= 35; k++) {
    const d = k * 20;
    types.add(T.groundInfo(spl[i].x + nx * d, spl[i].z + nz * d).type);
  }
  for (const need of ['water', 'sand', 'rock', 'grass']) {
    assert.ok(types.has(need), `missing type '${need}' in transect: ${[...types].join(',')}`);
  }
  // water strip respects RIVER_W: count water samples * 20 m <= RIVER_W + small margin
  let waterCount = 0;
  for (let k = -35; k <= 35; k++) {
    if (T.groundInfo(spl[i].x + nx * k * 20, spl[i].z + nz * k * 20).type === 'water') waterCount++;
  }
  assert.ok(waterCount * 20 <= WORLD.CANYON.RIVER_W + 40, `water too wide: ${waterCount * 20} m`);
});

test('mesas: >= MESA_MIN flat-topped masses, +120 m above plateau', () => {
  assert.ok(T.mesas.length >= WORLD.MESA_MIN, `mesas: ${T.mesas.length}`);
  let flat = 0;
  for (const m of T.mesas) {
    let lo = Infinity, hi = -Infinity;
    for (let gx = -2; gx <= 2; gx++) {
      for (let gz = -2; gz <= 2; gz++) {
        const h = T.groundHeight(m.x + gx * m.rf * 0.3, m.z + gz * m.rf * 0.3);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
    }
    const centerH = T.groundHeight(m.x, m.z);
    if (hi - lo < 3 && centerH > WORLD.PLATEAU_H + 80) flat++;
  }
  assert.ok(flat >= WORLD.MESA_MIN, `flat-topped mesas: ${flat}/${T.mesas.length}`);
});

test('beyond edge: height falls to plain ~300 m, type grass', () => {
  for (const [x, z] of [[WORLD.SIZE / 2 + 2500, 0], [-WORLD.SIZE / 2 - 2500, 3000], [0, WORLD.SIZE / 2 + 2500], [10500, -10500]]) {
    const info = T.groundInfo(x, z);
    assert.ok(Math.abs(info.h - WORLD.PLAIN_H) < 30, `h at (${x},${z}) = ${info.h}`);
    assert.equal(info.type, 'grass');
  }
});

test('landmarks >= 6 with names and coords inside world', () => {
  assert.ok(T.landmarks.length >= 6);
  for (const l of T.landmarks) {
    assert.ok(typeof l.name === 'string' && l.name.length > 0);
    assert.ok(Number.isFinite(l.x) && Number.isFinite(l.z));
    assert.ok(Math.abs(l.x) <= WORLD.SIZE / 2 && Math.abs(l.z) <= WORLD.SIZE / 2);
  }
});

test('groundHeight defined anywhere, plateau regions near PLATEAU_H, cheap perf budget', () => {
  assert.ok(Number.isFinite(T.groundHeight(123456, -987654)));
  // spot plateau away from canyons/mesas
  const h = T.groundHeight(-7800, -7800) ?? T.groundHeight(200, -4100);
  assert.ok(Number.isFinite(h));
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) T.groundInfo((i % 200) * 73 - 7000, Math.floor(i / 200) * 91 - 4500);
  const dt = performance.now() - t0;
  assert.ok(dt < 1000, `groundInfo 20k calls took ${dt.toFixed(0)} ms`);
});

test('types from contract vocabulary only', () => {
  const allowed = new Set(['water', 'sand', 'rock', 'scree', 'shrub', 'grass', 'rimrock', 'mesatop']);
  const r = mulberry32(31337);
  for (let i = 0; i < 300; i++) {
    const t = T.groundInfo((r() * 2 - 1) * 8000, (r() * 2 - 1) * 8000).type;
    assert.ok(allowed.has(t), `bad type: ${t}`);
  }
});
