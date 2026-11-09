import test from "node:test"
import assert from "node:assert/strict"
import { sum, average } from "../src/math.js"

test("sum suma una lista", () => {
  assert.equal(sum([1, 2, 3]), 6)
})

test("sum de una lista vacía es cero", () => {
  assert.equal(sum([]), 0)
})

test("average calcula el promedio", () => {
  assert.equal(average([2, 4]), 3)
})

test("average de una lista vacía es cero", () => {
  assert.equal(average([]), 0)
})
