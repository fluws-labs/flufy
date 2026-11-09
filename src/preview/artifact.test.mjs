import { test } from "node:test"
import assert from "node:assert/strict"
import {
  toNativeIdentity, toNativeDocument, fromNativeDocument, fromNativeDesign,
  PREVIEW_DERIVE_APPROXIMATIONS,
} from "./client.ts"
import { previewArtifactHtml, previewEditorArtifactHtml } from "./artifact.ts"
import { findNode } from "./document.ts"

function doc() {
  return {
    schemaVersion: 1, title: "Diseño QA",
    root: {
      id: "root", kind: "container", children: [
        { id: "h", kind: "heading", text: "Titulo", children: [], layout: {} },
        { id: "p", kind: "text", text: "Cuerpo", children: [], layout: { display: "flex" } },
      ], layout: { display: "flex", direction: "column" },
    },
    theme: {
      tokens: { fontFamily: "QA Sans, sans-serif", background: "#f0f0f0", text: "#102030", primary: "#123456" },
      sources: [{ path: "src/theme.css", description: "Tema QA" }],
      approximations: [],
    },
    resources: [],
  }
}

const frozenHtml = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>[data-preview-id="root"]{display:flex}</style></head><body><div data-preview-id="root">Titulo</div></body></html>`
const frozenCss = '[data-preview-id="root"]{display:flex}'
const identity = { project: "D:/proj", conversationId: "chat-1", taskId: "t1" }

function design(documentValue) {
  return {
    identity: { projectRoot: "D:/proj", sessionId: "chat-1", taskId: "t1", designId: "design" },
    choice: "create", status: "approved", currentRevisionId: "r1", approvedRevisionId: "r1",
    revisions: [{ id: "r1", parentId: null, createdAt: 1, document: documentValue, html: frozenHtml, css: frozenCss, assets: [], notes: "Aprobado" }],
    approvals: [{ revisionId: "r1", createdAt: 2, notes: "Aprobado" }],
  }
}

test("identidad de cuatro campos", () => {
  assert.deepEqual(toNativeIdentity(identity), { projectRoot: "D:/proj", sessionId: "chat-1", taskId: "t1", designId: "design" })
})

test("toNativeDocument inyecta tema, conserva preview/previewKind y hace round-trip sin pérdida", () => {
  const native = toNativeDocument(doc(), "user")
  assert.equal(native.root.styles.fontFamily, "QA Sans, sans-serif")
  assert.equal(native.root.styles.background, "#f0f0f0")
  assert.equal(native.root.styles.color, "#102030")
  assert.equal(native.root.previewKind, "container")
  assert.equal(native.root.children[0].previewKind, "heading")
  assert.equal(native.root.children[0].type, "text")
  assert.equal(native.author, "user")
  assert.deepEqual(fromNativeDocument(native), doc())
})

test("deriveDocument recupera heading y declara cada aproximación", () => {
  const nativeOnly = {
    version: 1, title: "Agente",
    root: { id: "root", type: "container", previewKind: "container", layout: { display: "flex" }, children: [{ id: "h", type: "text", previewKind: "heading", text: "Titulo" }] },
    theme: { provenance: [], approximations: [], tokens: {} },
  }
  const derived = fromNativeDocument(nativeOnly)
  assert.equal(findNode(derived.root, "h").kind, "heading")
  assert.deepEqual(derived.resources, [])
  for (const a of PREVIEW_DERIVE_APPROXIMATIONS) assert.ok(derived.theme.approximations.includes(a))
})

test("fromNativeDesign congela html/css y reconstruye el autor por procedencia", () => {
  const state = fromNativeDesign(design(toNativeDocument(doc(), "user")), identity)
  const rev = state.revisions[0]
  assert.equal(rev.html, frozenHtml)
  assert.equal(rev.css, frozenCss)
  assert.equal(rev.author, "user")
  assert.equal(state.approval.revisionId, "r1")
  const toolState = fromNativeDesign(design({ version: 1, root: { id: "root", type: "container" }, theme: {} }), identity)
  assert.equal(toolState.revisions[0].author, "agent")
})

test("el HTML mostrado ES el HTML congelado y el editor conserva cuerpo y CSS", () => {
  const artifact = { html: frozenHtml, css: frozenCss }
  assert.equal(previewArtifactHtml(artifact), frozenHtml)
  const context = { identityKey: "k", revisionId: "r1", channel: "c1", viewport: "desktop", selectedId: "root" }
  const editor = previewEditorArtifactHtml(artifact, context)
  const body = /<body>([\s\S]*?)<\/body>/.exec(frozenHtml)[1]
  assert.ok(editor.includes(body), "cuerpo del artefacto conservado")
  assert.ok(editor.includes(`<style>${frozenCss}</style>`), "CSS del artefacto conservado")
  assert.equal((editor.match(/<script>/g) ?? []).length, 1)
  assert.ok(editor.includes("script-src 'unsafe-inline'"))
  assert.ok(editor.includes("default-src 'none'"))
  assert.ok(editor.includes("data-preview-id"))
  assert.ok(!editor.includes("allow-same-origin"))
  assert.ok(!editor.includes("invoke(") && !editor.includes("__TAURI"))
})

test("un fragmento se envuelve con CSP estricta sin alterar el marcado", () => {
  const wrapped = previewArtifactHtml({ html: '<section data-node="root">Hola</section>', css: '[data-node="root"]{display:flex}' })
  assert.ok(wrapped.includes("<!doctype html>"))
  assert.ok(wrapped.includes("default-src 'none'"))
  assert.ok(wrapped.includes('<section data-node="root">Hola</section>'))
})
