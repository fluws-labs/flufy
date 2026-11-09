import test from "node:test"
import assert from "node:assert/strict"
import { add } from "../src/math.js"

test("add suma enteros", () => {
  assert.equal(add(2, 3), 5)
})

test("add respeta negativos", () => {
  assert.equal(add(-1, 1), 0)
  assert.equal(add(-4, -6), -10)
})
