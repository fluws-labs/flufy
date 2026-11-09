import { test } from "node:test"
import assert from "node:assert/strict"
import {
  PREVIEW_TASK_MARKER, previewTaskContext, previewTaskKey, resolvePreviewTaskId,
  type TaskIdentity, type TaskMessage,
} from "../src/preview/task-identity.ts"

// Contrato real publicado por T1 en src/preview/task-identity.ts. Estas pruebas
// ejercitan ese módulo de producción; no reimplementan la resolución en un
// servidor simulado ni acreditan persistencia nativa/reanudación de Flufy.
const project = "D:/qa/preview-example"
const session = "preview-qa-chat"

function user(id: string, text: string, synthetic = false): TaskMessage {
  return { info: { id, role: "user" }, parts: [{ type: "text", text, synthetic }] }
}
function marker(identity: TaskIdentity): TaskMessage {
  return user(`marker-${identity.taskId}`, previewTaskContext(identity), true)
}
function assistant(id: string): TaskMessage {
  return { info: { id, role: "assistant" }, parts: [{ type: "text", text: "Respuesta QA" }] }
}

test("un chat sin marcador se ancla al primer turno humano y las correcciones no abren otra tarea", () => {
  const messages = [
    user("t1", "Diseñá una tarjeta de perfil"),
    assistant("a1"),
    user("correction", "Aumentá la separación y mantené el pedido"),
    assistant("a2"),
    user("correction-2", "Cambiá el texto del botón"),
  ]
  assert.equal(resolvePreviewTaskId(messages, project, session, null, true), "t1")
  // Mismo resultado con historial paginado completo: nunca se infiere del final.
  assert.equal(resolvePreviewTaskId(messages, project, session, null, true), "t1")
})

test("un historial incompleto no inventa una tarea desde el último mensaje", () => {
  const tail = [assistant("a9"), user("late", "Otra corrección")]
  assert.equal(resolvePreviewTaskId(tail, project, session, null, false), null)
  assert.equal(resolvePreviewTaskId([], project, session, null, true), null)
})

test("el marcador sintético es la frontera fija y una elección persistida prevalece", () => {
  const identity: TaskIdentity = { projectRoot: project, sessionId: session, taskId: "task-a", designId: "design" }
  const messages = [user("t1", "Pedido inicial"), marker(identity), assistant("a1"), user("t2", "Corrección")]
  const resolved = resolvePreviewTaskId(messages, project, session, null, false)
  assert.equal(resolved, "task-a")
  // La elección persistida es la acción explícita del usuario; gana al marcador.
  assert.equal(resolvePreviewTaskId(messages, project, session, "task-b", true), "task-b")
})

test("marcadores ajenos, malformados o con tarea inválida se ignoran sin romper el anclaje legado", () => {
  const foreign: TaskIdentity = { projectRoot: "D:/qa/otro-proyecto", sessionId: session, taskId: "foreign", designId: "design" }
  const otherDesign: TaskIdentity = { projectRoot: project, sessionId: session, taskId: "other-design", designId: "otra" }
  const badTask: TaskIdentity = { projectRoot: project, sessionId: session, taskId: "no vale!", designId: "design" }
  const hostile = user("marker-hostile", `${PREVIEW_TASK_MARKER}{roto`, true)
  const messages = [
    user("t1", "Pedido inicial"),
    marker(foreign), marker(otherDesign), marker(badTask), hostile,
    assistant("a1"), user("t2", "Corrección del mismo pedido"),
  ]
  assert.equal(resolvePreviewTaskId(messages, project, session, null, true), "t1")
  assert.equal(resolvePreviewTaskId([marker(foreign), assistant("a1")], project, session, null, true), null)
})

test("la clave normaliza la ruta del proyecto sin mezclar conversaciones ni tareas", () => {
  const windows = "D:\\qa\\preview-example\\"
  assert.equal(previewTaskKey(windows, session), previewTaskKey(project, session))
  assert.notEqual(previewTaskKey(project, session), previewTaskKey(project, "otro-chat"))
  // Los IDs no pueden colisionar por delimitadores: la clave las mantiene separadas.
  assert.notEqual(previewTaskKey("a/b", "c"), previewTaskKey("a", "b/c"))
})

test("el contexto de tarea conserva la identidad completa y separa pedido de ajustes", () => {
  const identity: TaskIdentity = { projectRoot: project, sessionId: session, taskId: "task-a", designId: "design" }
  const text = previewTaskContext(identity)
  assert.ok(text.startsWith(PREVIEW_TASK_MARKER))
  const firstLine = text.slice(PREVIEW_TASK_MARKER.length).split("\n")[0]
  assert.deepEqual(JSON.parse(firstLine), identity)
  assert.match(text, /Una respuesta o revisión nueva no inicia otra tarea/)
  assert.equal(previewTaskContext(identity), previewTaskContext({ ...identity }))
})
