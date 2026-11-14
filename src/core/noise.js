// Canyon Runner — core/noise.js
// Pure deterministic noise utilities. No DOM, no THREE. All math is integer/float
// only so results are bit-identical across calls and createTerrain instances.

// Fast seeded PRNG (mulberry32). Returns a function producing floats in [0,1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic 2D lattice hash -> [0,1). Integer coordinates + seed mixed with
// the classic xxhash-style avalanche. Must stay branch-free and pure.
export function hash2(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed | 0, 2654435761)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smootherstep for C2-continuous value noise interpolation (no derivative
// discontinuities -> no visible grid seams in terrain derivatives/slopes).
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Smooth value noise, cell size 1, output [0,1). Bilinear-ish blend of hash2
// lattice values using fade() on both axes.
export function valueNoise2(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = fade(x - x0), fy = fade(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

// Fractal Brownian motion over valueNoise2. Output normalized to ~[-1,1].
// opts: {octaves=4, freq=1, lacunarity=2, gain=0.5}. Caller keeps octaves <= 5.
export function fbm2(x, y, seed, opts) {
  const octaves = opts?.octaves ?? 4;
  let f = opts?.freq ?? 1;
  const lac = opts?.lacunarity ?? 2;
  const gain = opts?.gain ?? 0.5;
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    // map value noise [0,1) -> [-1,1]
    sum += amp * (2 * valueNoise2(x * f, y * f, seed + o * 101) - 1);
    norm += amp;
    amp *= gain;
    f *= lac;
  }
  return sum / norm;
}
