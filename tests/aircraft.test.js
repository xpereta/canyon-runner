// tests/aircraft.test.js — headless node, real vendor THREE.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { createAircraft } from '../src/render/aircraft.js';

const state = {
  pos: { x: 0, y: 1200, z: 0 },
  vel: { x: 0, y: 0, z: -45 },
  q: [0, 0, 0, 1],
  throttle: 0.5, flaps: 0, trimElevator: 0, onGround: false,
};
const ctl0 = { throttle: 0.5, elevator: 0, aileron: 0, rudder: 0, flaps: 0, trim: 0 };

test('group exists and is a THREE.Group', () => {
  const ac = createAircraft(THREE);
  assert.ok(ac.group.isGroup);
  ac.update(state, ctl0); // smoke: runs without throwing
  ac.dispose();
});

test('mesh budget: <= 40 meshes (and a real model, >= 12)', () => {
  const ac = createAircraft(THREE);
  let n = 0;
  ac.group.traverse(o => { if (o.isMesh) n++; });
  assert.ok(n >= 12 && n <= 40, `mesh count ${n} out of [12, 40]`);
  ac.dispose();
});

test('nose convention: forward-most geometry is at local -Z (spinner, not tail)', () => {
  const ac = createAircraft(THREE);
  ac.group.updateMatrixWorld(true); // identity group -> world box == local box
  let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity, minY = Infinity;
  let frontMesh = null, backMesh = null;
  for (const o of ac.group.children.concat([])) void o;
  ac.group.traverse(o => {
    if (!o.isMesh) return;
    const b = new THREE.Box3().setFromObject(o);
    if (b.isEmpty()) return;
    if (b.min.z < minZ) { minZ = b.min.z; frontMesh = o; }
    if (b.max.z > maxZ) { maxZ = b.max.z; backMesh = o; }
    minX = Math.min(minX, b.min.x); maxX = Math.max(maxX, b.max.x);
    minY = Math.min(minY, b.min.y);
  });
  // nose sticks far out in -Z; tail cone/trailing edges are the +Z extreme
  assert.ok(minZ < -3.2, `nose should reach -Z, got minZ=${minZ}`);
  assert.match(frontMesh.name, /spinner|prop|cowl/, `forwardmost mesh should be nose gear, got '${frontMesh.name}'`);
  assert.ok(maxZ > 3.0, `tail should reach +Z, got maxZ=${maxZ}`);
  // overall size ~7 m long, ~8 m span, gear-bottom datum at y=0
  assert.ok(maxZ - minZ >= 6.5 && maxZ - minZ <= 8.2, `length ${maxZ - minZ} not ~7 m`);
  assert.ok(maxX - minX >= 7.6 && maxX - minX <= 8.4, `span ${maxX - minX} not ~8 m`);
  assert.ok(Math.abs(minY) < 0.06, `gear bottom should sit at y=0, got minY=${minY}`);
  ac.dispose();
});

test('update() deflects hinge pivots for nonzero ctl, zero at neutral', () => {
  const ac = createAircraft(THREE);
  const g = ac.group;
  const elev = g.getObjectByName('elevatorPivot');
  const rud = g.getObjectByName('rudderPivot');
  const ailR = g.getObjectByName('aileronR');
  const ailL = g.getObjectByName('aileronL');
  for (const p of [elev, rud, ailR, ailL]) assert.ok(p, 'hinge pivot missing');

  ac.update(state, ctl0);
  assert.equal(elev.rotation.x, 0);
  assert.equal(rud.rotation.y, 0);
  assert.equal(ailR.rotation.x, 0);
  assert.equal(ailL.rotation.x, 0);

  ac.update(state, { ...ctl0, elevator: 1 });
  assert.ok(elev.rotation.x < 0, 'elevator +1 (nose-up cmd) must raise TE (rot.x negative)');

  ac.update(state, { ...ctl0, rudder: 1 });
  assert.ok(rud.rotation.y < 0, 'rudder +1 (nose right cmd) must swing TE left (rot.y negative)');

  ac.update(state, { ...ctl0, aileron: 1 });
  assert.ok(ailR.rotation.x < 0 && ailL.rotation.x > 0, 'aileron +1: right TE up, left TE down');

  ac.update(state, { ...ctl0, elevator: -1, rudder: -1, aileron: -1 });
  assert.ok(elev.rotation.x > 0 && rud.rotation.y > 0 && ailR.rotation.x > 0 && ailL.rotation.x < 0, 'mirrored signs');

  ac.update(state, ctl0);
  assert.equal(elev.rotation.x, 0); // returns to neutral
  ac.dispose();
});

test('update() does not touch group position/quaternion (main.js owns those)', () => {
  const ac = createAircraft(THREE);
  ac.group.position.set(100, 1200, -50);
  ac.group.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
  const p0 = ac.group.position.clone(), q0 = ac.group.quaternion.clone();
  ac.update({ ...state, onGround: true }, { ...ctl0, elevator: 0.3, throttle: 1 });
  assert.ok(p0.equals(ac.group.position));
  assert.equal(ac.group.quaternion.angleTo(q0), 0);
  ac.dispose();
});

test('prop group and control-surface pivots are named; setTrail toggles cheap Points', () => {
  const ac = createAircraft(THREE);
  const scene = new THREE.Scene();
  scene.add(ac.group);
  assert.ok(ac.group.getObjectByName('propGroup'));
  ac.setTrail(true);
  ac.update(state, ctl0);
  const pts = [...ac.group.children, ...scene.children].filter(o => o.isPoints);
  assert.equal(pts.length, 1, 'one trail Points object when enabled');
  assert.ok(pts[0].geometry.attributes.position.count <= 200, 'trail must stay cheap');
  ac.setTrail(false);
  assert.equal([...scene.children, ...ac.group.children].filter(o => o.isPoints).length, 0);
  ac.dispose();
});

test('setDebugSurfaces: 2x visual gain on stick-driven surfaces, flap drop unscaled', () => {
  const ac = createAircraft(THREE);
  const g = ac.group;
  const elev = g.getObjectByName('elevatorPivot');
  const rud = g.getObjectByName('rudderPivot');
  const ailR = g.getObjectByName('aileronR');
  const ctl = { ...ctl0, elevator: 0.5, rudder: 0.5, aileron: 0.5 };

  ac.update(state, ctl);
  const e0 = elev.rotation.x, r0 = rud.rotation.y, a0 = ailR.rotation.x;
  assert.ok(e0 !== 0 && r0 !== 0 && a0 !== 0, 'baseline deflection nonzero');

  ac.setDebugSurfaces(true);
  ac.update(state, ctl);
  assert.ok(Math.abs(elev.rotation.x - 2 * e0) < 1e-9, 'debug: elevator doubled');
  assert.ok(Math.abs(rud.rotation.y - 2 * r0) < 1e-9, 'debug: rudder doubled');
  assert.ok(Math.abs(ailR.rotation.x - 2 * a0) < 1e-9, 'debug: aileron doubled');

  // flap drop contribution stays 1x even under debug gain
  const flapCtl = { ...ctl0, flaps: 1 };
  ac.update(state, flapCtl);
  const flapA = ailR.rotation.x;
  ac.setDebugSurfaces(false);
  ac.update(state, flapCtl);
  assert.ok(Math.abs(ailR.rotation.x - flapA) < 1e-9, 'flap drop identical with/without debug');

  ac.update(state, ctl0);
  assert.equal(elev.rotation.x, 0, 'neutral stays neutral under gain');
  ac.dispose();
});
