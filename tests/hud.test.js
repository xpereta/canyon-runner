// tests/hud.test.js — pure HUD helpers + fake-document smoke test (no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtSpeedKmh, fmtSpeedKts, fmtAlt, fmtAgl, fmtVsi,
  headingOf, fmtHeading, cardinalOf, chooseLandmarkLabel,
  fmtFlaps, turnNeedleDeg, drawMinimap, createHud,
} from '../src/ui/hud.js';
import { qFromEuler } from '../src/core/quat.js';
import { createTerrain } from '../src/core/terrain.js';
import { createAircraft, resetTo, stepFlight } from '../src/core/flight.js';
import { createControlStack } from '../src/core/controls.js';
import { PHYS } from '../src/config.js';

// ---------------- pure helpers ----------------

test('speed formats', () => {
  const st = { vel: { x: 45, y: 0, z: 0 } };
  assert.equal(fmtSpeedKmh(st), '162');
  assert.equal(fmtSpeedKts(st), '87');
});

test('altitude and VSI formats', () => {
  const st = { pos: { x: 0, y: 1234.6, z: 0 } };
  assert.equal(fmtAlt(st), '1235');
  assert.equal(fmtAgl(12.4), '12');
  assert.equal(fmtVsi({ x: 0, y: -3.2, z: 0 }), '-3');
  assert.equal(fmtVsi({ x: 0, y: 2.7, z: 0 }), '+3');
});

test('heading: quaternion -> 3-digit + cardinal', () => {
  const north = { q: qFromEuler(0, 0, 0) };
  const east = { q: qFromEuler(Math.PI / 2, 0, 0) };
  const south = { q: qFromEuler(Math.PI, 0, 0) };
  assert.equal(headingOf(north), 0);
  assert.equal(fmtHeading(headingOf(north)), '000');
  assert.equal(cardinalOf(headingOf(north)), 'N');
  assert.equal(headingOf(east), 90);
  assert.equal(fmtHeading(headingOf(east)), '090');
  assert.equal(cardinalOf(headingOf(east)), 'E');
  assert.equal(headingOf(south), 180);
  assert.equal(cardinalOf(headingOf(south)), 'S');
  assert.equal(cardinalOf(315), 'NW');
});

test('chooseLandmarkLabel picks nearest, respects range', () => {
  const lms = [
    { x: 100, z: 0, name: 'Near Butte' },
    { x: 9000, z: 0, name: 'Far Mesa' },
  ];
  assert.equal(chooseLandmarkLabel(lms, 0, 0, 5000), 'Near Butte');
  assert.equal(chooseLandmarkLabel(lms, 8900, 0, 5000), 'Far Mesa');
  assert.equal(chooseLandmarkLabel(lms, 5000, 0, 500), null);
});

test('flaps detents + turn needle', () => {
  assert.equal(fmtFlaps(0), '0');
  assert.equal(fmtFlaps(1 / 3), '1');
  assert.equal(fmtFlaps(1), '3');
  assert.equal(turnNeedleDeg({ r: 0 }), 0);
  assert.equal(turnNeedleDeg({ r: 0.5 }), 45);
  assert.equal(turnNeedleDeg({ r: -2 }), -45); // clamped
});

// ---------------- fake document (small, honest ctx surface) ----------------

function makeFakeDoc() {
  const ctxCalls = { total: 0, lineTo: 0, arc: 0, fillText: 0 };
  const ctxMethod = name => (...args) => {
    ctxCalls.total++;
    if (name in ctxCalls) ctxCalls[name]++;
  };
  const CTX_METHODS = ['beginPath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'save',
    'restore', 'translate', 'rotate', 'clip', 'clearRect', 'fillRect', 'drawImage',
    'fillText', 'closePath'];

  function makeEl(tag) {
    const el = {
      tag,
      style: {},
      classList: (() => {
        const set = new Set();
        return {
          add: c => set.add(c),
          remove: c => set.delete(c),
          contains: c => set.has(c),
          toggle: (c, force) => {
            const want = force === undefined ? !set.has(c) : !!force;
            if (want) set.add(c); else set.delete(c);
            return want;
          },
          _set: set,
        };
      })(),
      children: [],
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); },
      setAttribute(k, v) { this['attr_' + k] = v; },
      addEventListener() {},
      removeEventListener() {},
      set textContent(v) { this._text = v; },
      get textContent() { return this._text ?? ''; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html ?? ''; },
    };
    if (tag === 'canvas') {
      el.width = 0; el.height = 0;
      el.getContext = kind => {
        if (kind !== '2d') return null;
        const ctx = {};
        for (const m of CTX_METHODS) ctx[m] = ctxMethod(m);
        return ctx;
      };
    }
    return el;
  }

  const doc = {
    createElement: makeEl,
    body: makeEl('body'),
    addEventListener() {},
    removeEventListener() {},
  };
  return { doc, ctxCalls };
}

function walkFind(el, pred) {
  if (pred(el)) return el;
  for (const c of el.children || []) {
    const hit = walkFind(c, pred);
    if (hit) return hit;
  }
  return null;
}

// ---------------- smoke test on real terrain + real flight state ----------------

test('createHud + update + minimap run against real terrain/flight with zero throws', () => {
  const { doc, ctxCalls } = makeFakeDoc();
  const terrain = createTerrain(20261114);
  const hud = createHud(doc, terrain);
  hud.bindStack(createControlStack());
  hud.banner('test banner', 100);

  const state = createAircraft();
  resetTo(state, terrain.spawn);
  assert.doesNotThrow(() => hud.update(state, ['stall-warning', 'crash']));
  assert.equal(hud.crashes, 1);
  hud.update(state, []);
  assert.equal(hud.crashes, 1); // only 'crash' events count

  // a few real sim steps (takeoff roll) then HUD update again
  const stack = createControlStack();
  stack.setChannel('throttle', 1);
  for (let i = 0; i < 120; i++) {
    stack.step(PHYS.DT);
    const ev = stepFlight(state, stack.get(), terrain, PHYS.DT);
    hud.update(state, ev);
  }
  assert.ok(terrain.groundHeight(state.pos.x, state.pos.z) >= 0);

  // minimap actually drew with the real terrain tables
  assert.ok(ctxCalls.lineTo > 10, 'main spline polyline drawn');
  assert.ok(ctxCalls.arc > 10, 'mesas + clip arc drawn');
  assert.ok(ctxCalls.fillText > 0, 'landmark labels drawn');

  hud.dispose();
  assert.equal(doc.body.children.length, 0, 'dispose removed the HUD root');
});

test('drawMinimap is pure over a plain ctx surface', () => {
  const terrain = createTerrain(20261114);
  const state = createAircraft();
  resetTo(state, terrain.spawn);
  const calls = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (typeof k === 'string' && !['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'globalAlpha'].includes(k))
        return (...a) => calls.push(k);
      return undefined;
    },
    set() { return true; },
  });
  assert.doesNotThrow(() => drawMinimap(ctx, terrain, state, { size: 256, range: 3200 }));
  assert.ok(calls.includes('clip') && calls.includes('stroke') && calls.includes('fillText'));
});
