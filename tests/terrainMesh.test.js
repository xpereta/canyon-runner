import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { WORLD, RENDER } from '../src/config.js';
import { createTerrain } from '../src/core/terrain.js';
import { createWorld } from '../src/render/terrainMesh.js';

// minimal scene stub with real add/remove bookkeeping
function makeScene() {
  return {
    children: [],
    add(o) { this.children.push(o); },
    remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); },
  };
}

const terrain = createTerrain(WORLD.SEED);
const RINGS = RENDER.DRAW_RINGS;
const TOTAL = (2 * RINGS + 1) ** 2;

test('loads full ring of chunk meshes around player', () => {
  const scene = makeScene();
  const world = createWorld(THREE, scene, terrain, RENDER);
  const spl = terrain.mainSpline[Math.floor(terrain.mainSpline.length * 0.3)];
  world.update({ x: spl.x, z: spl.z });
  assert.equal(world.chunkCount(), TOTAL, `chunkCount ${world.chunkCount()} != ${TOTAL}`);
  const meshes = scene.children.filter(o => o.name.startsWith('chunk'));
  assert.equal(meshes.length, TOTAL);
  // idempotent: second update same position changes nothing
  world.update({ x: spl.x, z: spl.z });
  assert.equal(world.chunkCount(), TOTAL);
  world.dispose();
  assert.equal(world.chunkCount(), 0);
  assert.equal(scene.children.length, 0);
});

test('LOD vertex counts differ per ring (RES_HI/RES_MID/RES_LO)', () => {
  const scene = makeScene();
  const world = createWorld(THREE, scene, terrain, RENDER);
  const spl = terrain.mainSpline[Math.floor(terrain.mainSpline.length * 0.3)];
  world.update({ x: spl.x, z: spl.z });
  const countBy = new Map();
  for (const o of scene.children.filter(o => o.name.startsWith('chunk'))) {
    const vc = o.geometry.attributes.position.count;
    countBy.set(vc, (countBy.get(vc) ?? 0) + 1);
  }
  const hi = (RENDER.RES_HI + 1) ** 2, mid = (RENDER.RES_MID + 1) ** 2, lo = (RENDER.RES_LO + 1) ** 2;
  assert.ok(countBy.has(hi) && countBy.has(mid) && countBy.has(lo), `LODs seen: ${[...countBy.keys()]}`);
  assert.equal(countBy.get(hi), 1);                     // ring 0: player chunk (Chebyshev)
  assert.equal(countBy.get(mid), 8);                    // ring 1: 8 chunks
  assert.equal(countBy.get(lo), TOTAL - 9);             // rings 2+
  assert.notEqual(hi, mid); assert.notEqual(mid, lo);
  for (const o of scene.children.filter(o => o.name.startsWith('chunk'))) {
    const res = Math.round(Math.sqrt(o.geometry.attributes.position.count)) - 1;
    assert.equal(o.geometry.index.count, res * res * 6); // indexed quad grid
    assert.equal(o.geometry.attributes.color.count, o.geometry.attributes.position.count);
    assert.ok(o.material.isMeshLambertMaterial && o.material.vertexColors === true);
  }
  world.dispose();
});

test('water patch present over the river, translucent', () => {
  const scene = makeScene();
  const world = createWorld(THREE, scene, terrain, RENDER);
  const spl = terrain.mainSpline[Math.floor(terrain.mainSpline.length * 0.3)];
  world.update({ x: spl.x, z: spl.z });
  const water = scene.children.filter(o => o.name.startsWith('water'));
  assert.ok(water.length > 0, 'no water patch meshes near river');
  for (const w of water) {
    assert.ok(w.material.transparent && w.material.opacity > 0 && w.material.opacity < 1);
    assert.ok(w.geometry.attributes.position.count % 4 === 0); // merged quads
  }
  world.dispose();
});

test('moving the player swaps chunks; old geometries disposed (no leaks)', () => {
  const scene = makeScene();
  const world = createWorld(THREE, scene, terrain, RENDER);
  const a = terrain.mainSpline[Math.floor(terrain.mainSpline.length * 0.2)];
  const b = terrain.mainSpline[Math.floor(terrain.mainSpline.length * 0.8)];
  world.update({ x: a.x, z: a.z });
  const geos = [];
  for (const o of scene.children) {
    o.geometry.__disposed = false;
    o.geometry.addEventListener('dispose', () => { o.geometry.__disposed = true; });
    geos.push(o.geometry);
  }
  const keysBefore = new Set(world.chunkKeys());
  world.update({ x: b.x, z: b.z });
  const keysAfter = new Set(world.chunkKeys());
  assert.equal(world.chunkCount(), TOTAL);
  let overlap = 0;
  for (const k of keysBefore) if (keysAfter.has(k)) overlap++;
  assert.ok(overlap < keysBefore.size, 'player moved far but no chunks swapped');
  for (const g of geos) {
    if (!scene.children.some(o => o.geometry === g)) {
      assert.ok(g.__disposed, 'geometry still in use after unload but not disposed');
    }
  }
  world.dispose();
  let allDisposed = 0;
  for (const g of geos) if (g.__disposed) allDisposed++;
  assert.ok(allDisposed >= geos.length - overlap * 2, `dispose leak: only ${allDisposed}/${geos.length} disposed`);
  assert.equal(scene.children.length, 0);
});
