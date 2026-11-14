import { test } from 'node:test'
import assert from 'node:assert'
import { WORLD, PHYS, FLIGHT, CONTROLS, RENDER, HUD } from '../src/config.js'

test('config scaffold loads with required sections', () => {
  assert.ok(WORLD.SIZE > 0 && PHYS.DT > 0)
  assert.ok(FLIGHT.MASS > 0 && FLIGHT.ASSIST)
  assert.ok(CONTROLS.SLEW.elevator > 0)
  assert.ok(RENDER.CHUNK > 0 && RENDER.DRAW_RINGS >= 1)
  assert.ok(HUD.MINIMAP_SIZE > 0)
})
