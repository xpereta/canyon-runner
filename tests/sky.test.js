// tests/sky.test.js — headless node, real THREE.Scene + real vendor THREE.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { RENDER } from '../src/config.js';
import { createSky } from '../src/render/sky.js';

test('createSky adds hemisphere light, shadowless sun, dome; sets fog from config', () => {
  const scene = new THREE.Scene();
  const sky = createSky(THREE, scene);
  const hemis = scene.children.filter(o => o.isHemisphereLight);
  const dirs = scene.children.filter(o => o.isDirectionalLight);
  const domes = scene.children.filter(o => o.isMesh && o.material.side === THREE.BackSide);
  assert.equal(hemis.length, 1, 'exactly one hemisphere light');
  assert.equal(dirs.length, 1, 'exactly one directional light');
  assert.equal(dirs[0].castShadow, false, 'sun must be shadowless (iPad gate)');
  assert.equal(domes.length, 1, 'exactly one gradient dome mesh');
  assert.ok(domes[0].geometry.attributes.color, 'dome must use vertex colors');
  assert.equal(domes[0].material.fog, false, 'dome must be fog-exempt');

  assert.ok(scene.fog?.isFog, 'scene.fog must be a THREE.Fog');
  assert.equal(scene.fog.color.getHex(), new THREE.Color(RENDER.SKY_HORIZON).getHex());
  assert.equal(scene.fog.near, RENDER.FOG_NEAR);
  assert.equal(scene.fog.far, RENDER.FOG_FAR);
  sky.dispose();
});

test('dispose removes every added object and clears fog', () => {
  const scene = new THREE.Scene();
  const before = scene.children.length; // real THREE.Scene starts empty
  const sky = createSky(THREE, scene);
  assert.ok(scene.children.length > before);
  sky.dispose();
  assert.equal(scene.children.length, before, 'dispose must leave no leftovers');
  assert.equal(scene.fog, null, 'scene.fog must be null after dispose');
  // geometries/materials disposed (idempotent double-dispose must not throw)
  sky.dispose();
});

test('dome encloses the world and update() is optional slow-sun (no NaN)', () => {
  const scene = new THREE.Scene();
  const sky = createSky(THREE, scene);
  const dome = scene.children.find(o => o.isMesh && o.material.side === THREE.BackSide);
  const R = dome.geometry.boundingSphere ? dome.geometry.boundingSphere.radius
    : dome.geometry.parameters.radius;
  // world half-diagonal ~ sqrt(2)*(SIZE/2); camera can be at a corner
  const worldHalfDiag = Math.SQRT2 * (16000 / 2);
  assert.ok(R > worldHalfDiag, `dome radius ${R} must exceed world half-diagonal ${worldHalfDiag}`);
  sky.update(123.4); // optional drift must not throw / corrupt sun
  assert.ok(Number.isFinite(sky.sun.position.x));
  sky.dispose();
});
