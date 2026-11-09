import { test } from "node:test"
import assert from "node:assert/strict"
import { applyAtRevision, applyOperations, findNode, flattenNodes, parentOf, PreviewConflictError, validateDocument } from "../src/preview/document.ts"
import { previewIdentityKey } from "../src/preview/types.ts"
import type { PreviewChange, PreviewDocument, PreviewNode, PreviewRevision, PreviewState } from "../src/preview/types.ts"
import { isRendererSelection, renderEditorHtml, renderPreview, renderPreviewHtml } from "../src/preview/renderer.ts"
import { approvedRevision, assertIdentity, currentRevision, PreviewRequestGate } from "../src/preview/state.ts"
import { previewArtifactHtml, previewEditorArtifactHtml } from "../src/preview/artifact.ts"

function node(id: string, children: PreviewNode[] = [], kind: PreviewNode["kind"] = "container"): PreviewNode {
  return { id, kind, children, layout: { display: "flex", direction: "column", gap: 12 } }
}
function document(): PreviewDocument {
  return {
    schemaVersion: 1, title: "Ejemplo QA previsualización",
    root: node("root", [node("left", [node("a", [], "text"), node("b", [], "button")]), node("right")]),
    theme: { tokens: { primary: "#123456", font: "sans-serif" }, sources: [{ path: "src/theme.css", description: "Tema de ejemplo QA" }], approximations: [] },
    resources: [],
  }
}

test("la identidad separa proyecto, conversación y tarea incluso con delimitadores en los IDs", () => {
  const base = { project: "D:/qa/preview-example", conversationId: "preview-qa-chat", taskId: "crear" }
  const identities = [base, { ...base, project: "D:/qa/other" }, { ...base, conversationId: "otro" }, { ...base, taskId: "omitir" }]
  assert.equal(new Set(identities.map(previewIdentityKey)).size, identities.length)
  assert.notEqual(previewIdentityKey({ project: "a/b", conversationId: "c", taskId: "d" }), previewIdentityKey({ project: "a", conversationId: "b/c", taskId: "d" }))
})

test("reordenar y mover entre contenedores preserva IDs, contenido y documento original", () => {
  const initial = document(), before = structuredClone(initial)
  const reordered = applyOperations(initial, [{ type: "move", nodeId: "b", parentId: "left", index: 0 }])
  assert.deepEqual(findNode(reordered.root, "left")!.children.map(n => n.id), ["b", "a"])
  const moved = applyOperations(reordered, [{ type: "move", nodeId: "b", parentId: "right", index: 0 }])
  assert.deepEqual(findNode(moved.root, "left")!.children.map(n => n.id), ["a"])
  assert.deepEqual(findNode(moved.root, "right")!.children.map(n => n.id), ["b"])
  assert.deepEqual(findNode(moved.root, "b"), findNode(initial.root, "b"))
  assert.deepEqual(initial, before)
})

test("un lote inválido no aplica parcialmente textos ni movimientos", () => {
  const initial = document(), before = structuredClone(initial)
  for (const invalid of [
    { type: "move", nodeId: "left", parentId: "left", index: 0 },
    { type: "move", nodeId: "root", parentId: "left", index: 0 },
    { type: "move", nodeId: "a", parentId: "b", index: 0 },
    { type: "move", nodeId: "missing", parentId: "right", index: 0 },
    { type: "layout", nodeId: "a", patch: { width: -1 } },
  ] as const) {
    assert.throws(() => applyOperations(initial, [{ type: "text", nodeId: "a", text: "No debe persistir" }, invalid]))
    assert.deepEqual(initial, before)
  }
})

test("ciclo de un contenedor hacia su descendiente se rechaza sin perder subárbol", () => {
  const initial = document()
  findNode(initial.root, "left")!.children.push(node("nested"))
  assert.throws(() => applyOperations(initial, [{ type: "move", nodeId: "left", parentId: "nested", index: 0 }]))
  assert.equal(findNode(initial.root, "left")!.children.at(-1)!.id, "nested")
})

test("redimensión, separación, alineación y texto mantienen reglas móviles independientes", () => {
  const initial = document()
  const updated = applyOperations(initial, [
    { type: "layout", nodeId: "left", patch: { width: 560, height: 320, gap: 24, padding: 16, align: "center", justify: "space-between" } },
    { type: "layout", nodeId: "left", viewport: "mobile", patch: { width: 320, gap: 8, direction: "column" } },
    { type: "text", nodeId: "a", text: "Ejemplo QA editado" },
  ])
  const left = findNode(updated.root, "left")!
  assert.equal(left.layout.width, 560)
  assert.equal(left.layout.height, 320)
  assert.equal(left.layout.padding, 16)
  assert.equal(left.layout.align, "center")
  assert.equal(left.layout.justify, "space-between")
  assert.deepEqual(left.mobile, { width: 320, gap: 8, direction: "column" })
  assert.equal(findNode(updated.root, "a")!.text, "Ejemplo QA editado")
  assert.deepEqual(left.children.map(n => n.id), ["a", "b"])
  assert.deepEqual(initial, document())
})

test("una respuesta tardía del agente no reemplaza el movimiento manual vigente", () => {
  const current = applyAtRevision(document(), "r1", "r1", [{ type: "move", nodeId: "a", parentId: "right", index: 0 }])
  const before = structuredClone(current)
  assert.throws(() => applyAtRevision(current, "r2", "r1", [{ type: "text", nodeId: "a", text: "Respuesta atrasada" }]), PreviewConflictError)
  assert.deepEqual(current, before)
  const accepted = applyAtRevision(current, "r2", "r2", [{ type: "text", nodeId: "a", text: "Cambio sobre base actual" }])
  assert.equal(findNode(accepted.root, "right")!.children[0].text, "Cambio sobre base actual")
  assert.deepEqual(current, before)
})

test("la revisión serializada reconstruye el mismo artefacto con tokens y reglas móviles", () => {
  const initial = document()
  initial.theme.tokens = { primary: "#123456", fontFamily: "QA Sans, sans-serif", background: "#f0f0f0", text: "#102030" }
  findNode(initial.root, "b")!.style = { background: "$primary", color: "#ffffff" }
  findNode(initial.root, "left")!.mobile = { direction: "column", gap: 8 }
  const artifact = renderPreview(initial)
  assert.deepEqual(renderPreview(JSON.parse(JSON.stringify(initial))), artifact)
  assert.match(artifact.css, /font-family:QA Sans, sans-serif/)
  assert.match(artifact.css, /background:#123456/)
  assert.match(artifact.css, /@media\(max-width:600px\)/)
  assert.match(artifact.css, /\[data-node="left"\]\{flex-direction:column;gap:8px\}/)
  assert.deepEqual(initial.theme.sources, [{ path: "src/theme.css", description: "Tema de ejemplo QA" }])
})

test("contenido hostil queda como texto y estilos/recursos no admiten URLs externas", () => {
  const initial = document()
  initial.title = "</title><script>parent.attack()</script>"
  findNode(initial.root, "a")!.text = '<img src=x onerror="parent.attack()">'
  findNode(initial.root, "a")!.style = { background: "url(https://invalid.example/attack)" }
  findNode(initial.root, "right")!.children.push({ ...node("image", [], "image"), resourceId: "remote", text: '" onerror="attack()' })
  initial.resources.push({ id: "remote", mime: "image/png", data: "https://invalid.example/image.png", source: "Ejemplo QA no cargable" })
  const html = renderPreviewHtml(initial)
  assert.ok(!html.includes("<script>"))
  assert.ok(!html.includes("<img src=x"))
  assert.ok(!html.includes("https://invalid.example"))
  assert.match(html, /&lt;img src=x onerror=&quot;parent.attack\(\)&quot;&gt;/)
  assert.match(html, /Recurso no disponible/)
  assert.match(html, /default-src 'none'/)
  const editor = renderEditorHtml(initial, { identityKey: "qa", revisionId: "r1", channel: "qa-channel", viewport: "desktop" })
  assert.equal((editor.match(/<script>/g) ?? []).length, 1)
  assert.ok(!editor.includes('<img src=x'))
})

test("el bridge rechaza otra tarea, revisión, canal, forma y nodo no válido", () => {
  const context = { identityKey: "qa-task", revisionId: "r2", channel: "qa-channel", viewport: "desktop" as const }
  const valid = { type: "preview-select", identityKey: context.identityKey, revisionId: context.revisionId, channel: context.channel, nodeId: "a" }
  assert.equal(isRendererSelection(valid, context), true)
  for (const invalid of [
    null, "preview-select", {}, { ...valid, identityKey: "other-task" },
    { ...valid, revisionId: "r1" }, { ...valid, channel: "other-channel" },
    { ...valid, type: "invoke" }, { ...valid, extra: "invoke" },
    { ...valid, nodeId: '<script>' }, { ...valid, nodeId: 7 },
  ]) assert.equal(isRendererSelection(invalid, context), false)
  // Source-window, opaque origin and node existence are checked by PreviewFrame;
  // this pure test deliberately does not claim to exercise that browser boundary.
})

// Estados persistidos de ejemplo: fixtures del contrato real, no una reimplementación
// de las transiciones del servidor. Se construyen con applyOperations/renderPreview reales.
const qaIdentity = { project: "D:/qa/preview-example", conversationId: "preview-qa-chat", taskId: "visual" }
const otherTask = { ...qaIdentity, taskId: "visual-2" }
const otherProject = { ...qaIdentity, project: "D:/qa/otro-proyecto" }
const otherConversation = { ...qaIdentity, conversationId: "otro-chat" }

function revision(id: string, parentId: string | null, doc: PreviewDocument, author: "user" | "agent", summary: string): PreviewRevision {
  const artifact = renderPreview(doc)
  return { id, parentId, createdAt: 1_700_000_000_000, document: structuredClone(doc), html: artifact.html, css: artifact.css, author, summary }
}
function state(identity: PreviewState["identity"], revisions: PreviewRevision[], currentRevisionId: string | null, status: PreviewState["status"], approval: PreviewState["approval"] = null): PreviewState {
  return { identity, designId: `design-${identity.taskId}`, status, revisions: [...revisions], currentRevisionId, approval }
}

test("los selectores sobre snapshots pending/draft/approved conservan referencia a la revisión congelada", () => {
  const first = document()
  const pending = state(qaIdentity, [], null, "pending")
  const r1 = revision("r1", null, first, "user", "Crear previsualización")
  const draft = state(qaIdentity, [r1], "r1", "draft")
  const approval = { revisionId: "r1", approvedAt: 1_700_000_005_000, notes: "Aprobado QA" }
  const approved = state(qaIdentity, [r1], "r1", "approved", approval)
  const second = applyOperations(first, [{ type: "text", nodeId: "a", text: "Borrador posterior del agente" }])
  const r2 = revision("r2", "r1", second, "agent", "Respuesta del agente")
  const lateDraft = state(qaIdentity, [r1, r2], "r2", "draft", approval)

  assert.equal(currentRevision(pending), undefined)
  assert.equal(approvedRevision(pending), undefined)
  assert.equal(currentRevision(draft)?.id, "r1")
  assert.equal(approvedRevision(approved)?.id, "r1")
  assert.equal(approved.approval?.revisionId, currentRevision(approved)?.id)
  assert.equal(currentRevision(lateDraft)?.id, "r2")
  assert.equal(approvedRevision(lateDraft)?.id, "r1")
  assert.deepEqual(approvedRevision(lateDraft), approvedRevision(approved))
  assert.deepEqual(lateDraft.revisions[0], r1)
  assert.equal(lateDraft.approval?.revisionId, "r1")

  // Round-trip JSON del fixture; no acredita reapertura del chat ni almacenamiento nativo.
  const reopened: PreviewState = JSON.parse(JSON.stringify(lateDraft))
  assert.doesNotThrow(() => assertIdentity(reopened, qaIdentity))
  assert.equal(currentRevision(reopened)?.id, "r2")
  assert.equal(approvedRevision(reopened)?.id, "r1")
  assert.deepEqual(approvedRevision(reopened)?.document, first)
  assert.deepEqual(currentRevision(reopened)?.document, second)
})

test("assertIdentity rechaza snapshots de otros ámbitos y un snapshot omitido no tiene aprobación", () => {
  const doc = document()
  const r1 = revision("r1", null, doc, "user", "Crear")
  const chosen = state(qaIdentity, [r1], "r1", "approved", { revisionId: "r1", approvedAt: 1_700_000_005_000, notes: "Aprobado" })
  const skipped = state(otherTask, [], null, "skipped")
  const foreignProject = state(otherProject, [r1], "r1", "approved", chosen.approval)
  const foreignChat = state(otherConversation, [r1], "r1", "approved", chosen.approval)

  assert.notEqual(previewIdentityKey(qaIdentity), previewIdentityKey(otherTask))
  assert.equal(assertIdentity(chosen, qaIdentity), chosen)
  for (const foreign of [otherTask, otherProject, otherConversation]) {
    assert.throws(() => assertIdentity(chosen, foreign), /otra conversación o tarea/)
  }
  assert.throws(() => assertIdentity(foreignProject, qaIdentity), /otra conversación o tarea/)
  assert.throws(() => assertIdentity(foreignChat, qaIdentity), /otra conversación o tarea/)
  assert.equal(approvedRevision(skipped), undefined)
  const before = structuredClone(chosen)
  assertIdentity(chosen, qaIdentity)
  assert.deepEqual(chosen, before)
})

test("el gate de peticiones descarta respuestas tardías y el cambio de conversación", () => {
  const gate = new PreviewRequestGate()
  const t1 = gate.begin(qaIdentity)
  const t2 = gate.begin(qaIdentity)
  assert.equal(gate.accepts(t1), false)
  assert.equal(gate.accepts(t2), true)
  const t3 = gate.begin(otherConversation)
  assert.equal(gate.accepts(t2), false)
  assert.equal(gate.accepts(t3), true)
  assert.notEqual(t1.key, t3.key)
  gate.invalidate()
  assert.equal(gate.accepts(t3), false)
})

test("una respuesta tardía del agente basada en otra revisión produce conflicto y preserva la edición manual", () => {
  const initial = document()
  const manual = applyOperations(initial, [{ type: "move", nodeId: "a", parentId: "right", index: 0 }])
  const before = structuredClone(manual)
  const stale: PreviewChange = {
    baseRevisionId: "r1", author: "agent", summary: "Agente sobre revisión anterior",
    operations: [{ type: "text", nodeId: "a", text: "Respuesta atrasada del agente" }],
  }
  assert.equal(stale.author, "agent")
  assert.throws(() => applyAtRevision(manual, "r2", stale.baseRevisionId, stale.operations), e => e instanceof PreviewConflictError && /vigente/.test(e.message))
  assert.deepEqual(manual, before)
  validateDocument(manual)
  const accepted = applyAtRevision(manual, "r2", "r2", stale.operations)
  assert.deepEqual(findNode(accepted.root, "right")!.children.map(n => n.id), ["a"])
  assert.equal(findNode(accepted.root, "a")!.text, "Respuesta atrasada del agente")
  assert.deepEqual(manual, before)
})

test("snapshots de historial conservan operaciones y parentesco sin mutar documentos anteriores", () => {
  const d1 = document()
  const d2 = applyOperations(d1, [{ type: "text", nodeId: "a", text: "Texto del agente" }])
  const d3 = applyOperations(d2, [{ type: "move", nodeId: "a", parentId: "right", index: 0 }])
  const r1 = revision("r1", null, d1, "user", "Diseño inicial")
  const r2 = revision("r2", "r1", d2, "agent", "Respuesta del agente")
  const r3 = revision("r3", "r2", d3, "user", "Mover bloque a la derecha")
  // Fixtures de revisiones restauradas; el comportamiento real de restore/redo se prueba en E2E/Rust.
  const r4 = revision("r4", "r3", d2, "user", "Deshacer")
  const r5 = revision("r5", "r4", d3, "user", "Rehacer")
  const d6 = applyOperations(r4.document, [{ type: "text", nodeId: "b", text: "Nueva edición tras deshacer" }])
  const r6 = revision("r6", "r4", d6, "agent", "Nueva edición que invalida redo")
  const chain = [r1, r2, r3, r4, r5, r6]

  assert.deepEqual(chain.map(r => r.parentId), [null, "r1", "r2", "r3", "r4", "r4"])
  assert.deepEqual(r4.document, r2.document)
  assert.deepEqual(r5.document, r3.document)
  assert.notDeepEqual(r6.document, r3.document)
  assert.notDeepEqual(r6.document, r4.document)
  assert.deepEqual(chain.map(r => r.author), ["user", "agent", "user", "user", "user", "agent"])
  for (const r of chain) assert.deepEqual(renderPreview(r.document), { html: r.html, css: r.css })
  assert.deepEqual(r1, revision("r1", null, d1, "user", "Diseño inicial"))
  assert.equal(findNode(r4.document.root, "a")!.text, "Texto del agente")
  assert.equal(findNode(r5.document.root, "right")!.children[0]!.id, "a")
  assert.equal(parentOf(r3.document.root, "a")!.id, "right")
  assert.equal(flattenNodes(r6.document.root).length, flattenNodes(d1.root).length)
  assert.equal(currentRevision(state(qaIdentity, chain, "r6", "draft"))?.id, "r6")
})

test("la referencia aprobada se reconstruye desde la revisión guardada y sobrevive a un borrador posterior", () => {
  const doc = document()
  doc.theme.tokens = { primary: "#123456", fontFamily: "QA Sans, sans-serif", background: "#f0f0f0", text: "#102030" }
  doc.theme.sources = [{ path: "src/theme.css", description: "Tema de ejemplo QA" }]
  doc.theme.approximations = ["Fuente no incrustada: alternativa del sistema"]
  const r1 = revision("r1", null, doc, "user", "Diseño aprobado")
  const approved = state(qaIdentity, [r1], "r1", "approved", { revisionId: "r1", approvedAt: 1_700_000_005_000, notes: "Congelado QA" })
  const reloaded: PreviewState = JSON.parse(JSON.stringify(approved))
  const frozen = approvedRevision(reloaded)!
  assert.deepEqual(frozen, approvedRevision(approved))
  assert.deepEqual(renderPreview(frozen.document), { html: frozen.html, css: frozen.css })
  assert.match(frozen.css, /font-family:QA Sans, sans-serif/)
  assert.deepEqual(frozen.document.theme.sources, [{ path: "src/theme.css", description: "Tema de ejemplo QA" }])
  assert.deepEqual(frozen.document.theme.approximations, ["Fuente no incrustada: alternativa del sistema"])

  const r2 = revision("r2", "r1", applyOperations(frozen.document, [{ type: "text", nodeId: "a", text: "Borrador nuevo" }]), "agent", "Borrador posterior")
  const after = state(qaIdentity, [frozen, r2], "r2", "draft", reloaded.approval)
  assert.equal(currentRevision(after)?.id, "r2")
  assert.equal(approvedRevision(after)?.id, "r1")
  assert.deepEqual(approvedRevision(after), frozen)
  assert.equal(findNode(approvedRevision(after)!.document.root, "a")!.text, undefined)
  assert.equal(findNode(r2.document.root, "a")!.text, "Borrador nuevo")
})

test("un artefacto nativo completo no se regenera desde un documento editable posterior", () => {
  const artifact = {
    html: '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>[data-preview-id="a"]{color:#123456}</style></head><body><p data-preview-id="a">Referencia transferida QA</p></body></html>',
    css: '[data-preview-id="a"]{color:#123456}',
  }
  const before = structuredClone(artifact)
  assert.equal(previewArtifactHtml(artifact), artifact.html)
  const context = { identityKey: previewIdentityKey(qaIdentity), revisionId: "r-approved", channel: "qa-frozen", viewport: "desktop" as const }
  const editor = previewEditorArtifactHtml(artifact, context)
  assert.ok(editor.includes('<p data-preview-id="a">Referencia transferida QA</p>'))
  assert.ok(editor.includes(`<style>${artifact.css}</style>`))
  assert.deepEqual(artifact, before)
  assert.equal(previewArtifactHtml(artifact), before.html)
  // Esto verifica funciones de producción; la transferencia/reanudación SQLite
  // se comprueba en Rust y no se deduce de este fixture en memoria.
})
