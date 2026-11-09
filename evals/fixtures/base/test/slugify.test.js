import test from "node:test"
import assert from "node:assert/strict"
import { slugify } from "../src/text.js"

test("slugify convierte espacios en guiones", () => {
  assert.equal(slugify("Hola Mundo"), "hola-mundo")
})

test("slugify quita acentos", () => {
  assert.equal(slugify("Café Ñandú"), "cafe-nandu")
})

test("slugify colapsa espacios y separadores", () => {
  assert.equal(slugify("  Varios   espacios  "), "varios-espacios")
  assert.equal(slugify("Hola_Mundo 2026"), "hola-mundo-2026")
})
