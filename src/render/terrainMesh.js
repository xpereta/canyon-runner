// Canyon Runner — render/terrainMesh.js
// Chunked LOD terrain meshes over the core terrain field. THREE is passed IN as the
// first argument (never imported here). One indexed BufferGeometry + vertex colors
// per chunk, translucent merged water patch per chunk where type 'water'.

// CFG-REQ: progressive chunk-build budget (chunks per update()); currently build-all
// so first update() is synchronous and complete.
import { RENDER as RENDER_DEF } from '../config.js';

const TYPE_COLOR = {
  grass: [0.50, 0.58, 0.36],
  shrub: [0.44, 0.50, 0.31],
  sand: [0.76, 0.66, 0.48],
  water: [0.42, 0.40, 0.36], // riverbed under the translucent patch
  rock: [0.52, 0.34, 0.27],
  scree: [0.58, 0.46, 0.35],
  rimrock: [0.64, 0.42, 0.31],
  mesatop: [0.58, 0.56, 0.42],
};

export function createWorld(THREE, scene, terrain, cfg) {
  const R = { ...RENDER_DEF, ...(cfg || {}) };
  const CHUNK = R.CHUNK ?? 256;
  const RINGS = R.DRAW_RINGS ?? 4;
  const resFor = ring => (ring === 0 ? (R.RES_HI ?? 96) : ring === 1 ? (R.RES_MID ?? 48) : (R.RES_LO ?? 24));

  const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: false });
  const waterMat = new THREE.MeshLambertMaterial({
    color: R.WATER_COLOR ?? 0x2e5f8a, transparent: true, opacity: R.WATER_ALPHA ?? 0.75, depthWrite: false,
  });

  const chunks = new Map(); // 'cx,cz' -> { mesh, water }
  const key = (cx, cz) => cx + ',' + cz;

  function buildChunk(cx, cz, ring) {
    const res = resFor(ring);
    const n = res + 1, cs = CHUNK / res;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const nor = new Float32Array(n * n * 3);
    const hg = new Float64Array(n * n);
    const types = new Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const vi = j * n + i;
        const x = x0 + i * cs, z = z0 + j * cs;
        const info = terrain.groundInfo(x, z);
        hg[vi] = info.h;
        types[vi] = info.type;
        pos[vi * 3] = x; pos[vi * 3 + 1] = info.h; pos[vi * 3 + 2] = z;
      }
    }
    // normals + vertex colors (type base, slope shading, slight altitude tint)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const vi = j * n + i;
        const hl = hg[j * n + Math.max(0, i - 1)], hr = hg[j * n + Math.min(n - 1, i + 1)];
        const hd = hg[Math.max(0, j - 1) * n + i], hu = hg[Math.min(n - 1, j + 1) * n + i];
        const dhdx = (hr - hl) / ((i === 0 ? 1 : i === n - 1 ? 1 : 2) * cs);
        const dhdz = (hu - hd) / ((j === 0 ? 1 : j === n - 1 ? 1 : 2) * cs);
        const slope = Math.hypot(dhdx, dhdz);
        const inv = 1 / Math.hypot(dhdx, 1, dhdz);
        nor[vi * 3] = -dhdx * inv; nor[vi * 3 + 1] = inv; nor[vi * 3 + 2] = -dhdz * inv;
        const base = TYPE_COLOR[types[vi]] ?? TYPE_COLOR.grass;
        const shade = Math.min(1.12, Math.max(0.45, 1.10 / (1 + 0.35 * slope))) +
          (hg[vi] > 1300 ? 0.04 : hg[vi] < 900 ? -0.05 : 0);
        col[vi * 3] = base[0] * shade;
        col[vi * 3 + 1] = base[1] * shade;
        col[vi * 3 + 2] = base[2] * shade;
      }
    }
    const idx = new Uint32Array(res * res * 6);
    let t = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = a + n + 1;
        idx[t++] = a; idx[t++] = c; idx[t++] = b; // CCW seen from above
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mesh = new THREE.Mesh(geo, terrainMat);
    mesh.name = 'chunk ' + key(cx, cz);
    scene.add(mesh);

    // merged water patch: one quad per fully-water cell at the river surface
    const waterY = terrain.waterLevel ?? Math.min(...hg) + 2;
    let wc = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = j * n + i;
        if (types[a] === 'water' && types[a + 1] === 'water' && types[a + n] === 'water' && types[a + n + 1] === 'water') wc++;
      }
    }
    let water = null;
    if (wc > 0) {
      const wp = new Float32Array(wc * 4 * 3), wn = new Float32Array(wc * 4 * 3), wi = new Uint32Array(wc * 6);
      let q = 0, ii = 0;
      for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) {
          const a = j * n + i;
          if (!(types[a] === 'water' && types[a + 1] === 'water' && types[a + n] === 'water' && types[a + n + 1] === 'water')) continue;
          const xa = x0 + i * cs, za = z0 + j * cs, xb = xa + cs, zb = za + cs;
          const b = q * 4;
          wp.set([xa, waterY, za, xb, waterY, za, xb, waterY, zb, xa, waterY, zb], q * 12);
          wn.set([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], q * 12);
          wi[ii++] = b; wi[ii++] = b + 1; wi[ii++] = b + 2;
          wi[ii++] = b; wi[ii++] = b + 2; wi[ii++] = b + 3;
          q++;
        }
      }
      const wgeo = new THREE.BufferGeometry();
      wgeo.setAttribute('position', new THREE.BufferAttribute(wp, 3));
      wgeo.setAttribute('normal', new THREE.BufferAttribute(wn, 3));
      wgeo.setIndex(new THREE.BufferAttribute(wi, 1));
      water = new THREE.Mesh(wgeo, waterMat);
      water.name = 'water ' + key(cx, cz);
      scene.add(water);
    }
    chunks.set(key(cx, cz), { mesh, water });
  }

  function unload(k) {
    const c = chunks.get(k);
    if (!c) return;
    scene.remove(c.mesh);
    c.mesh.geometry.dispose();
    if (c.water) { scene.remove(c.water); c.water.geometry.dispose(); }
    chunks.delete(k);
  }

  function update(playerPos) {
    if (!Number.isFinite(playerPos?.x) || !Number.isFinite(playerPos?.z)) return;
    const cx0 = Math.floor(playerPos.x / CHUNK), cz0 = Math.floor(playerPos.z / CHUNK);
    const wanted = new Set();
    for (let dx = -RINGS; dx <= RINGS; dx++) {
      for (let dz = -RINGS; dz <= RINGS; dz++) wanted.add(key(cx0 + dx, cz0 + dz));
    }
    for (const k of chunks.keys()) if (!wanted.has(k)) unload(k);
    if (chunks.size === wanted.size) {
      // fast idempotent path: same set already loaded (verify cheaply by size + first-missing scan)
      for (const k of wanted) if (!chunks.has(k)) { loadNeeded(cx0, cz0, wanted); return; }
      return;
    }
    loadNeeded(cx0, cz0, wanted);
  }

  function loadNeeded(cx0, cz0, wanted) {
    for (let r = 0; r <= RINGS; r++) {          // nearest rings first
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const k = key(cx0 + dx, cz0 + dz);
          if (wanted.has(k) && !chunks.has(k)) buildChunk(cx0 + dx, cz0 + dz, r);
        }
      }
    }
  }

  function dispose() {
    for (const k of [...chunks.keys()]) unload(k);
    terrainMat.dispose();
    waterMat.dispose();
  }

  return {
    update,
    dispose,
    chunkCount: () => chunks.size,
    // QA/testing introspection
    chunkKeys: () => [...chunks.keys()],
  };
}
