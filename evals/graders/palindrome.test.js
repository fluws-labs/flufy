import test from "node:test"
import assert from "node:assert/strict"
import { isPalindrome } from "../src/text.js"

test("detecta palíndromos ignorando mayúsculas, espacios y acentos", () => {
  assert.equal(isPalindrome("Anita lava la tina"), true)
  assert.equal(isPalindrome("A man, a plan, a canal: Panama"), true)
  assert.equal(isPalindrome("Café éfac"), true)
  assert.equal(isPalindrome("Flufy"), false)
})
