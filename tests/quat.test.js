import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  qFromEuler, qMul, qNormalize, qRotate, qConjugate, eulerFromQ,
} from '../src/core/quat.js';

const D2R = Math.PI / 180;
const TAU_EPS = 1e-9;

function close(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);
}

test('identity maps nose (0,0,-1) to north (0,0,-1)', () => {
  const v = qRotate(qFromEuler(0, 0, 0), { x: 0, y: 0, z: -1 });
  close(v.x, 0); close(v.y, 0); close(v.z, -1);
});

test('yaw pi/2 maps nose to +X (east)', () => {
  const v = qRotate(qFromEuler(Math.PI / 2, 0, 0), { x: 0, y: 0, z: -1 });
  close(v.x, 1, 1e-9); close(v.y, 0); close(v.z, 0, 1e-9);
});

test('pitch positive = nose up', () => {
  const v = qRotate(qFromEuler(0, 0.5, 0), { x: 0, y: 0, z: -1 });
  assert.ok(v.y > 0.4, `nose y = ${v.y} should be up`);
});

test('roll positive = right wing (+X) down', () => {
  const v = qRotate(qFromEuler(0, 0, 0.5), { x: 1, y: 0, z: 0 });
  assert.ok(v.y < -0.4, `right wing y = ${v.y} should be down`);
});

test('round-trip qFromEuler -> eulerFromQ over a grid', () => {
  for (const yaw of [-3.0, -1.2, 0, 0.7, 2.5]) {
    for (const pitch of [-1.2, -0.4, 0, 0.3, 1.2]) {
      for (const roll of [-2.0, -0.9, 0, 1.1, 2.0]) {
        const e = eulerFromQ(qFromEuler(yaw, pitch, roll));
        close(e.yaw, yaw, 1e-9);
        close(e.pitch, pitch, 1e-9);
        close(e.roll, roll, 1e-9);
      }
    }
  }
});

test('eulerFromQ clamps pitch to +/-85 deg', () => {
  const e = eulerFromQ(qFromEuler(0.3, 90 * D2R, 0.1));
  close(e.pitch, 85 * D2R, 1e-6);
  assert.ok(Number.isFinite(e.yaw) && Number.isFinite(e.roll));
});

test('qMul identity and conjugate-inverse', () => {
  const id = [0, 0, 0, 1];
  const q = qNormalize(qFromEuler(0.4, 0.2, -0.7));
  const r = qMul(q, qConjugate(q));
  close(r[0], 0, TAU_EPS); close(r[1], 0, TAU_EPS); close(r[2], 0, TAU_EPS); close(r[3], 1, TAU_EPS);
  const m = qMul(q, id);
  assert.deepEqual(m.map((v) => +v.toFixed(12)), q.map((v) => +v.toFixed(12)));
});

test('qRotate preserves length and composes', () => {
  const q = qFromEuler(1.0, 0.5, -0.3);
  const v = { x: 3, y: 4, z: -2 };
  const rv = qRotate(q, v);
  close(Math.hypot(rv.x, rv.y, rv.z), Math.hypot(v.x, v.y, v.z), 1e-9);
  const qa = qFromEuler(0.8, 0.1, 0.2), qb = qFromEuler(-0.4, 0.6, 0.9);
  const one = qRotate(qMul(qa, qb), v);
  const two = qRotate(qa, qRotate(qb, v));
  close(one.x, two.x, 1e-9); close(one.y, two.y, 1e-9); close(one.z, two.z, 1e-9);
});

test('qFromEuler composes as qYaw*qPitch*qRoll', () => {
  const [y, p, r] = [0.9, -0.4, 1.3];
  const qYaw = [0, -Math.sin(y / 2), 0, Math.cos(y / 2)];
  const qPitch = [Math.sin(p / 2), 0, 0, Math.cos(p / 2)];
  const qRoll = [0, 0, -Math.sin(r / 2), Math.cos(r / 2)];
  const manual = qMul(qMul(qYaw, qPitch), qRoll);
  const q = qFromEuler(y, p, r);
  for (let i = 0; i < 4; i++) close(manual[i], q[i], 1e-12);
});
