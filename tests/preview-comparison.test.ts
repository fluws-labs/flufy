import { test } from "node:test"
import assert from "node:assert/strict"
import { equivalentDimensions, implementationRejection, isPreviewReference, safeCaptureImage } from "../src/preview/comparison.ts"
import type { PreviewImplementation, PreviewReference } from "../src/preview/types.ts"

const reference: PreviewReference = {
  identity: { projectRoot: "D:/qa/preview-example", sessionId: "qa-chat", taskId: "qa-task", designId: "design" },
  revision: { id: "r-approved", parentId: null, createdAt: 1_700_000_000_000,
    document: { version: 1, root: { id: "root", type: "container", children: [] } },
    html: "<!doctype html><html><body>Referencia QA transferida</body></html>", css: "", assets: [], notes: "QA" },
}
const capture: PreviewImplementation = {
  identity: { ...reference.identity }, revisionId: "r-approved", viewport: "desktop", width: 1280, height: 800,
  status: "captured", source: "Fixture de contrato QA; no es captura de implementación", capturedAt: 1_700_000_005_000,
  imageUrl: "data:image/png;base64,AAAA",
}

test("la atribución exige proyecto, conversación, tarea, diseño, revisión y viewport coincidentes", () => {
  assert.equal(implementationRejection(reference, capture, "desktop"), null)
  assert.match(implementationRejection(reference, { ...capture, identity: undefined }, "desktop")!, /tarea/)
  for (const field of ["projectRoot", "sessionId", "taskId", "designId"] as const) {
    const foreign = { ...capture, identity: { ...reference.identity, [field]: `otro-${field}` } }
    assert.match(implementationRejection(reference, foreign, "desktop")!, /tarea/)
  }
  assert.match(implementationRejection(reference, { ...capture, revisionId: "r-later" }, "desktop")!, /revisión/)
  assert.match(implementationRejection(reference, { ...capture, viewport: "mobile" }, "desktop")!, /viewport/)
  for (const width of [0, -1, NaN, 1.5]) {
    assert.match(implementationRejection(reference, { ...capture, width }, "desktop")!, /dimensiones/)
  }
})

test("las dimensiones distintas se informan sin confundir escritorio con móvil", () => {
  assert.equal(equivalentDimensions(capture, "desktop"), true)
  assert.equal(equivalentDimensions(capture, "mobile"), false)
  assert.equal(equivalentDimensions({ ...capture, width: 390, height: 844 }, "mobile"), true)
  assert.equal(equivalentDimensions({ ...capture, width: 1280, height: 799 }, "desktop"), false)
})

test("la referencia transferida conserva el artefacto sin consultar el borrador mutable", () => {
  const transferred = JSON.parse(JSON.stringify(reference)) as PreviewReference
  const before = structuredClone(transferred)
  const laterDraft = structuredClone(reference)
  laterDraft.revision.id = "r-later"
  laterDraft.revision.html = "<p>Borrador posterior QA</p>"
  assert.equal(isPreviewReference(transferred), true)
  assert.equal(implementationRejection(transferred, capture, "desktop"), null)
  assert.match(implementationRejection(laterDraft, capture, "desktop")!, /revisión/)
  assert.deepEqual(transferred, before)
  for (const invalid of [null, {}, { ...reference, identity: undefined }, { ...reference, revision: { ...reference.revision, html: "" } }]) {
    assert.equal(isPreviewReference(invalid), false)
  }
  // Round-trip en memoria, no prueba de persistencia ni de reanudación nativa.
})

test("solo imágenes embebidas permitidas pasan la frontera de la comparación", () => {
  assert.equal(safeCaptureImage(capture.imageUrl), true)
  for (const invalid of [undefined, "https://invalid.example/qa.png", "blob:qa", "file:///qa.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,<script>"]) {
    assert.equal(safeCaptureImage(invalid), false)
  }
})
