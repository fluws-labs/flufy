import { test } from "node:test"
import assert from "node:assert/strict"
import { CONTINUITY_MARKER, prematureCompletion } from "../src/lib/continuity.ts"

const user = (id = "u", text = "Implementalo") => ({ info: { id, role: "user" }, parts: [{ type: "text", text }] })
const answer = (text: string, parentID = "u", extra = {}) => ({ info: { id: `a-${parentID}`, role: "assistant", parentID, time: { completed: 1 }, finish: "stop", ...extra }, parts: [{ type: "text", text }] })

test("detecta una admisión explícita de trabajo incompleto", () => {
  assert.equal(prematureCompletion([user(), answer("No la implementé. No encontré un bloqueo que justificara detenerme.")])?.answer, "a-u")
  assert.ok(prematureCompletion([user(), answer("El encargo queda incompleto; no tengo una implementación integral.")]))
})

test("no reanuda preguntas, bloqueos ni errores", () => {
  for (const text of ["No la implementé. ¿Querés que siga?", "No la implementé: falta acceso al servidor.", "No la implementé: hay un bloqueo.", "No la implementé, estoy sin credenciales.", "Ya está implementado y verificado."])
    assert.equal(prematureCompletion([user(), answer(text)]), null)
  assert.equal(prematureCompletion([user(), answer("No la implementé.", "u", { error: { name: "APIError" } })]), null)
  assert.equal(prematureCompletion([user(), { ...answer("No la implementé."), parts: [{ type: "tool", tool: "question" }, { type: "text", text: "No la implementé." }] }]), null)
})

test("limita continuaciones consecutivas y reinicia el límite al recibir un pedido nuevo", () => {
  const once = [user(), answer("No la implementé."), user("u2", CONTINUITY_MARKER), answer("No la implementé.", "u2")]
  assert.ok(prematureCompletion(once))
  const twice = [...once, user("u3", CONTINUITY_MARKER), answer("No la implementé.", "u3")]
  assert.equal(prematureCompletion(twice), null)
  assert.ok(prematureCompletion([...twice, user("u4"), answer("No la implementé.", "u4")]))
})

test("solo considera pendientes del plan si fue actualizado en el turno actual", () => {
  const pending = [{ status: "in_progress" }]
  const normal = answer("Avancé con el análisis.")
  assert.equal(prematureCompletion([user(), normal], pending), null)
  const planned = { ...normal, parts: [{ type: "tool", tool: "todowrite" }, ...normal.parts] }
  assert.ok(prematureCompletion([user(), planned], pending))
  assert.equal(prematureCompletion([user(), planned], [{ status: "completed" }]), null)
})
