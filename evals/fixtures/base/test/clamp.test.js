import test from "node:test"
import assert from "node:assert/strict"
import { clamp } from "../src/math.js"

test("clamp deja pasar los valores del rango", () => {
  assert.equal(clamp(5, 0, 10), 5)
})

test("clamp limita por abajo", () => {
  assert.equal(clamp(-1, 0, 10), 0)
})

test("clamp limita por arriba", () => {
  assert.equal(clamp(20, 0, 10), 10)
})
