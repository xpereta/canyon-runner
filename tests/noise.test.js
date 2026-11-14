import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, hash2, valueNoise2, fbm2 } from '../src/core/noise.js';

test('mulberry32: deterministic sequence in [0,1)', () => {
  const a = mulberry32(1234), b = mulberry32(1234);
  for (let i = 0; i < 100; i++) {
    const va = a(), vb = b();
    assert.ok(va >= 0 && va < 1, `out of range: ${va}`);
    assert.equal(va, vb);
  }
  // different seeds diverge
  const c = mulberry32(9999);
  assert.notEqual(mulberry32(1)(), c());
});

test('hash2: deterministic, in range, varies with inputs', () => {
  const seen = new Set();
  for (let ix = -50; ix <= 50; ix++) {
    for (let iy = -50; iy <= 50; iy++) {
      const v = hash2(ix, iy, 7);
      assert.ok(v >= 0 && v < 1);
      assert.equal(v, hash2(ix, iy, 7));
      seen.add(v.toFixed(6));
    }
  }
  assert.ok(seen.size > 9000, `hash2 collision-heavy: ${seen.size}`);
  assert.notEqual(hash2(1, 2, 3), hash2(1, 2, 4));
  assert.notEqual(hash2(1, 2, 3), hash2(2, 1, 3));
});

test('valueNoise2: in [0,1), continuous, cell size 1', () => {
  for (let i = 0; i < 500; i++) {
    const r = mulberry32(i);
    const x = r() * 40 - 20, y = r() * 40 - 20;
    const v = valueNoise2(x, y, 42);
    assert.ok(v >= 0 && v < 1);
    // continuity: tiny step changes little
    const v2 = valueNoise2(x + 1e-6, y + 1e-6, 42);
    assert.ok(Math.abs(v - v2) < 1e-3);
  }
});

test('fbm2: default normalized ~[-1,1], deterministic, options respected', () => {
  let lo = 1, hi = -1;
  for (let i = 0; i < 2000; i++) {
    const x = (i % 100) * 0.13, y = (i / 100) * 0.13;
    const v = fbm2(x, y, 5);
    assert.ok(v >= -1.0001 && v <= 1.0001);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  // actually uses range, not degenerate
  assert.ok(hi - lo > 0.5, `fbm range too small: ${lo}..${hi}`);
  // determinism + option effect
  assert.equal(fbm2(3.3, 4.4, 9, { octaves: 3 }), fbm2(3.3, 4.4, 9, { octaves: 3 }));
  assert.notEqual(fbm2(3.3, 4.4, 9, { octaves: 3 }), fbm2(3.3, 4.4, 9, { octaves: 4 }));
  // freq shifts the field
  assert.notEqual(fbm2(3.3, 4.4, 9, { freq: 2 }), fbm2(3.3, 4.4, 9, { freq: 1 }));
});
