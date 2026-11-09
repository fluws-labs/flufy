import { expect, test, type Page } from "@playwright/test"
import { applyOperations } from "../../src/preview/document.ts"
import { renderPreview } from "../../src/preview/renderer.ts"
import { fromNativeDesign, toNativeDocument, toNativeIdentity } from "../../src/preview/client.ts"
import type { PreviewDocument, PreviewImplementation, PreviewReference, PreviewState } from "../../src/preview/types.ts"

// Integración web con respuestas IPC controladas: ejercita el PreviewPanel real,
// el hook usePreview real y el adaptador previewClient real, con las firmas de
// comando confirmadas en src/preview/CONTRACT.md (Design nativo de 4 campos).
// NO sustituye el recorrido nativo en WebView2 ni la persistencia SQLite; eso
// pertenece a la verificación nativa y visual posterior.

const identity = { project: "D:/qa/preview-e2e", conversationId: "chat-qa-e2e", taskId: "visual" }
const nativeIdentity = toNativeIdentity(identity)

function document(): PreviewDocument {
  return {
    schemaVersion: 1, title: "Diseño QA previsualización",
    root: {
      id: "root", kind: "container", layout: { display: "flex", direction: "column", gap: 12 },
      children: [
        { id: "title", kind: "text", text: "Título QA", layout: {}, children: [] },
        {
          id: "card", kind: "container", layout: { display: "flex", direction: "column", gap: 8 },
          children: [{ id: "action", kind: "button", text: "Acción QA", layout: {}, children: [] }],
        },
      ],
    },
    theme: {
      tokens: { primary: "#123456", fontFamily: "QA Sans, sans-serif" },
      sources: [{ path: "src/theme.css", description: "Tema de ejemplo QA" }],
      approximations: ["Fuente no incrustada: alternativa del sistema"],
    },
    resources: [],
  }
}

type NativeRevision = { id: string; parentId: string | null; createdAt: number; document: unknown; html: string; css: string; assets: unknown[]; notes: string }
type NativeDesign = {
  identity: typeof nativeIdentity; choice: string; status: string
  currentRevisionId: string | null; approvedRevisionId: string | null
  revisions: NativeRevision[]; approvals: { revisionId: string; createdAt: number; notes: string }[]
}

function nativeRevision(id: string, parentId: string | null, doc: PreviewDocument, notes: string): NativeRevision {
  const artifact = renderPreview(doc)
  return { id, parentId, createdAt: 1_700_000_000_000, document: toNativeDocument(doc), html: artifact.html, css: artifact.css, assets: [], notes }
}
function nativeDesign(revisions: NativeRevision[], currentRevisionId: string | null, choice: string, status: string, approvedRevisionId: string | null = null, approvals: { revisionId: string; createdAt: number; notes: string }[] = []): NativeDesign {
  return { identity: nativeIdentity, choice, status, currentRevisionId, approvedRevisionId, revisions: [...revisions], approvals }
}

const d1 = document()
const d2 = applyOperations(d1, [{ type: "text", nodeId: "title", text: "Título editado por QA" }])
const nr1 = nativeRevision("r1", null, d1, "Crear previsualización")
const nr2 = nativeRevision("r2", "r1", d2, "Editar texto")
const nr3 = nativeRevision("r3", "r2", d1, "Restaurar revisión r1")
const nr4 = nativeRevision("r4", "r3", d2, "Restaurar revisión r2")
const approvals = [{ revisionId: "r4", createdAt: 1_700_000_005_000, notes: "Aprobado QA" }]
const nr5 = nativeRevision("r5", "r4", applyOperations(d2, [{ type: "text", nodeId: "action", text: "Borrador posterior" }]), "Borrador posterior")
const hostile = document()
hostile.title = "</title><script>parent.attack()</script>"
hostile.root.children[0].text = '<img src=x onerror="parent.attack()">'

const pending = nativeDesign([], null, "pending", "pending")
const designs = {
  choose: nativeDesign([nr1], "r1", "create", "draft"),
  apply: nativeDesign([nr1, nr2], "r2", "create", "draft"),
  undo: nativeDesign([nr1, nr2, nr3], "r3", "create", "draft"),
  redo: nativeDesign([nr1, nr2, nr3, nr4], "r4", "create", "draft"),
  approve: nativeDesign([nr1, nr2, nr3, nr4], "r4", "create", "approved", "r4", approvals),
  draftAfterApproval: nativeDesign([nr1, nr2, nr3, nr4, nr5], "r5", "create", "draft", "r4", approvals),
  hostile: nativeDesign([nativeRevision("h1", null, hostile, "Contenido hostil")], "h1", "create", "draft"),
}

type Transition = { command: string; matchKey?: string; matchValue?: unknown; state?: NativeDesign; error?: string }

async function boot(page: Page, options: { initial?: NativeDesign; transitions?: Transition[]; comparisonState?: PreviewState; implementations?: PreviewImplementation[]; reference?: PreviewReference }) {
  const config = { identity: nativeIdentity, initial: options.initial ?? pending, transitions: options.transitions ?? [] }
  await page.addInitScript(({ identity, initial, transitions }) => {
    let id = 0
    const key = JSON.stringify([identity.projectRoot, identity.sessionId, identity.taskId, identity.designId])
    const readStored = () => { try { const raw = sessionStorage.getItem("qa:preview-design"); return raw ? JSON.parse(raw) : null } catch { return null } }
    const qa = { calls: [] as { command: string; args: unknown }[], current: readStored() ?? initial, transitions: [...transitions], key }
    Object.assign(window, { __qa: qa })
    Object.assign(window, {
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++id,
        unregisterCallback: () => undefined,
        invoke: async (command: string, args?: Record<string, unknown>) => {
          if (command === "plugin:event|listen") return ++id
          if (command === "plugin:app|version") return "0.18.0"
          if (!command.startsWith("preview_")) return null
          qa.calls.push({ command, args: args ?? null })
          if (command === "preview_get") {
            const requested = args?.identity as Record<string, unknown> | undefined
            const requestedKey = JSON.stringify([requested?.projectRoot, requested?.sessionId, requested?.taskId, requested?.designId])
            return requestedKey === qa.key ? qa.current : null
          }
          if (command === "preview_identity") return { provenance: [], approximations: [], assets: [] }
          const index = qa.transitions.findIndex(t => t.command === command && (t.matchKey === undefined || (args && args[t.matchKey] === t.matchValue)))
          if (index < 0) throw new Error(`IPC de previsualización no guionado: ${command}`)
          const transition = qa.transitions.splice(index, 1)[0]
          if (transition.error) throw new Error(transition.error)
          qa.current = transition.state
          try { sessionStorage.setItem("qa:preview-design", JSON.stringify(qa.current)) } catch { /* contexto sin almacenamiento */ }
          return qa.current
        },
      },
    })
  }, config)
  // Vite transformIndexHtml inyecta este preamble en index.html; el harness propio
  // debe incluirlo para que los módulos JSX de @vitejs/plugin-react puedan evaluarse.
  await page.route("**/preview-harness", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><title>Flufy · QA previsualización</title>
<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script></head><body><div id="root"></div></body></html>`,
  }))
  await page.goto("/preview-harness")
  await mount(page, options.comparisonState, options.implementations, options.reference)
}

async function mount(page: Page, comparisonState?: PreviewState, implementations: PreviewImplementation[] = [], reference?: PreviewReference) {
  await page.evaluate(async ({ identity, comparisonState, implementations, reference }) => {
    const w = window as any
    w.$RefreshReg$ ??= () => {}
    w.$RefreshSig$ ??= () => (type: unknown) => type
    w.__vite_plugin_react_preamble_installed__ = true
    const react = await import("/@id/react")
    const dom = await import("/@id/react-dom/client")
    const { PreviewPanel, PreviewComparison } = await import("/src/preview/index.ts")
    const createElement = react.createElement ?? react.default?.createElement
    const createRoot = dom.createRoot ?? dom.default?.createRoot
    if (!createElement || !createRoot) throw new Error("No se pudieron resolver react/createRoot desde Vite")
    const children = [createElement(PreviewPanel, { key: "panel", identity, onClose: () => undefined })]
    if (comparisonState || reference) children.push(createElement(PreviewComparison, { key: "comparison", state: comparisonState, reference, implementations }))
    createRoot(document.getElementById("root")).render(createElement("div", null, children))
  }, { identity, comparisonState, implementations, reference })
}

const calls = (page: Page) => page.evaluate(() => (window as any).__qa.calls as { command: string; args: any }[])
const current = (page: Page) => page.evaluate(() => (window as any).__qa.current as NativeDesign)

// Playwright's cross-frame locator coordinates omit a CSS-scaled iframe's zoom.
// Convert real local geometry to host coordinates; all actions remain physical mouse input.
async function canvasPoint(page: Page, selector: string, x = .5, y = .5) {
  const frame = page.locator('.preview-editor iframe:visible')
  await expect(frame).toBeVisible()
  await frame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const element = frame.contentFrame().locator(selector)
  await expect(element).toBeVisible()
  const local = await element.evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), width: innerWidth }))
  const outer = (await frame.boundingBox())!
  const scale = outer.width / local.width
  return { x: outer.x + (local.rect.x + local.rect.width * x) * scale, y: outer.y + (local.rect.y + local.rect.height * y) * scale }
}

async function enablePersistedEdits(page: Page) {
  await page.evaluate(async () => {
    const { fromNativeDocument } = await import('/src/preview/client.ts')
    const { renderPreview } = await import('/src/preview/renderer.ts')
    const w = window as any
    const original = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command !== 'preview_apply') return original(command, args)
      w.__qa.calls.push({ command, args })
      const state = w.__qa.current
      if (state.currentRevisionId !== args.baseRevisionId) throw new Error('PREVIEW_CONFLICT')
      const artifact = renderPreview(fromNativeDocument(args.document))
      const revision = { id: `r${state.revisions.length + 1}`, parentId: state.currentRevisionId, createdAt: Date.now(), document: args.document, ...artifact, assets: [], notes: args.notes }
      w.__qa.current = { ...state, currentRevisionId: revision.id, revisions: [...state.revisions, revision] }
      sessionStorage.setItem('qa:preview-design', JSON.stringify(w.__qa.current))
      return w.__qa.current
    }
  })
}

// Vite dev sirve módulos invalidados por HMR con `?t=...`; importar el store desde
// otra URL crea una segunda instancia. Se usa la MISMA URL que consume el hook real.
async function sharedAgentModule(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const source = await (await fetch("/src/agent/preview-identity.ts")).text()
    return source.match(/from "([^"]*\/src\/state\/agent\.ts[^"]*)"/)?.[1] ?? "/src/state/agent.ts"
  })
}

test("P01/P05: una corrección humana conserva la tarea y solo una acción explícita inicia otra", async ({ page }) => {
  await boot(page, {})
  const agentModule = await sharedAgentModule(page)
  await page.evaluate(async ({ agentModule }) => {
    const React = await import("/@id/react")
    const dom = await import("/@id/react-dom/client")
    const createRoot = dom.createRoot ?? dom.default?.createRoot
    const createElement = React.createElement ?? React.default?.createElement
    const { useAgent } = await import(agentModule)
    const { useProject } = await import("/src/state/project.ts")
    const { usePreviewTaskId } = await import("/src/agent/preview-identity.ts")
    useProject.setState({ project: "D:/qa/preview-e2e", root: "D:/qa/preview-e2e", ready: true })
    const first = { info: { id: "qa-task-start", role: "user", sessionID: "qa-task-chat" }, parts: [{ type: "text", text: "Diseñá una tarjeta QA" }] }
    useAgent.setState({ views: { "qa-task-chat": { messages: [first], loading: false, hasMore: false, error: null } }, previewTasks: {} })
    const target = document.createElement("div")
    document.body.append(target)
    function Probe() {
      return createElement("output", { "aria-label": "Identidad activa QA" }, usePreviewTaskId("qa-task-chat") ?? "sin tarea")
    }
    createRoot(target).render(createElement(Probe))
  }, { agentModule })
  const active = page.getByLabel("Identidad activa QA")
  await expect(active).toHaveText("qa-task-start")
  await page.evaluate(async ({ agentModule }) => {
    const { useAgent } = await import(agentModule)
    useAgent.setState(s => ({ views: { ...s.views, "qa-task-chat": {
      ...s.views["qa-task-chat"], messages: [...s.views["qa-task-chat"].messages,
        { info: { id: "qa-task-correction", role: "user", sessionID: "qa-task-chat" }, parts: [{ type: "text", text: "Aumentá la separación de esa tarjeta QA" }] }],
    } } }))
  }, { agentModule })
  await expect(active).toHaveText("qa-task-start")
  const next = await page.evaluate(async ({ agentModule }) => {
    const { startPreviewTask } = await import(agentModule)
    return startPreviewTask("D:/qa/preview-e2e", "qa-task-chat")
  }, { agentModule })
  await expect(active).toHaveText(next)
  expect(next).not.toBe("qa-task-start")
  expect(await page.evaluate(async ({ agentModule }) => {
    const { useAgent } = await import(agentModule)
    const { previewTaskKey } = await import("/src/preview/task-identity.ts")
    return useAgent.getState().previewTasks[previewTaskKey("D:/qa/preview-e2e", "qa-task-chat")] ?? null
  }, { agentModule })).toBe(next)
})

test("el adaptador real reconstruye el estado desde el Design nativo sin perder el documento", async () => {
  const state = fromNativeDesign(designs.draftAfterApproval, identity)
  expect(state.currentRevisionId).toBe("r5")
  expect(state.approval?.revisionId).toBe("r4")
  expect(state.revisions.find(r => r.id === "r4")!.document.root.children[0].text).toBe("Título editado por QA")
})

test("P01: crear deja de ofrecerse al recargar el panel con la elección guardada por el fixture IPC", async ({ page }) => {
  await boot(page, { initial: pending, transitions: [{ command: "preview_choose", matchKey: "choice", matchValue: "create", state: designs.choose }] })
  await expect(page.getByRole("button", { name: "Crear previsualización" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Omitir previsualización" })).toBeVisible()

  await page.getByRole("button", { name: "Crear previsualización" }).click()
  await expect(page.getByText(/Revisión r1/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Crear previsualización" })).toHaveCount(0)
  const chooses = (await calls(page)).filter(c => c.command === "preview_choose")
  expect(chooses).toHaveLength(1)
  expect(chooses[0].args).toMatchObject({ identity: nativeIdentity, baseRevisionId: null, choice: "create" })

  await page.reload()
  await mount(page)
  await expect(page.getByRole("button", { name: "Crear previsualización" })).toHaveCount(0)
  await expect(page.getByText(/Revisión r1/)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__qa.current.choice)).toBe("create")
})

test("P02: omitir no genera documento ni aprobación y recargar conserva la elección del fixture", async ({ page }) => {
  await boot(page, { transitions: [{ command: "preview_choose", matchKey: "choice", matchValue: "skip", state: nativeDesign([], null, "skip", "skipped") }] })
  await page.getByRole("button", { name: "Omitir previsualización" }).click()
  await expect(page.getByText("Previsualización omitida para esta tarea.")).toBeVisible()
  await expect(page.locator(".preview-editor iframe")).toHaveCount(0)
  expect((await calls(page)).filter(c => c.command === "preview_choose").map(c => c.args)).toEqual([
    { identity: nativeIdentity, baseRevisionId: null, choice: "skip" },
  ])
  await page.reload()
  await mount(page)
  await expect(page.getByText("Previsualización omitida para esta tarea.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Crear previsualización" })).toHaveCount(0)
  expect((await calls(page)).some(c => c.command === "preview_apply" || c.command === "preview_approve")).toBe(false)
})

test("P04: no permite aprobar texto sin guardar y envía la revisión visible al aprobar", async ({ page }) => {
  await boot(page, { initial: designs.redo, transitions: [{ command: "preview_approve", matchKey: "baseRevisionId", matchValue: "r4", state: designs.approve }] })
  await page.getByLabel("Bloque seleccionado").selectOption("title")
  await page.locator(".preview-properties textarea").fill("Texto local todavía sin guardar")
  await expect(page.getByRole("button", { name: "Aprobar revisión r4" })).toBeDisabled()
  expect((await calls(page)).filter(c => c.command === "preview_approve")).toHaveLength(0)
  // Reabrir descarta únicamente este texto local no guardado en el contexto de prueba.
  await page.reload()
  await mount(page)
  await page.getByLabel("Observaciones para la aprobación").fill("Aprobado QA")
  await page.getByRole("button", { name: "Aprobar revisión r4" }).click()
  await expect(page.getByRole("button", { name: "Revisión aprobada" })).toBeDisabled()
  expect((await calls(page)).filter(c => c.command === "preview_approve").map(c => c.args)).toEqual([
    { identity: nativeIdentity, baseRevisionId: "r4", notes: "Aprobado QA" },
  ])
})

test("P06: conflicto IPC muestra error y conserva documento e historial visibles", async ({ page }) => {
  await boot(page, { initial: designs.apply, transitions: [{ command: "preview_apply", error: "PREVIEW_CONFLICT: otra edición cambió la revisión vigente" }] })
  await page.getByLabel("Bloque seleccionado").selectOption("title")
  await page.locator(".preview-properties textarea").fill("No debe sobrescribir")
  await page.getByRole("button", { name: "Guardar texto" }).click()
  await expect(page.getByRole("alert")).toContainText("PREVIEW_CONFLICT")
  await expect(page.getByText(/Revisión r2/)).toBeVisible()
  await expect(page.frameLocator(".preview-editor iframe").getByText("Título editado por QA")).toBeVisible()
  expect(await page.evaluate(() => (window as any).__qa.current.revisions.map((r: any) => r.id))).toEqual(["r1", "r2"])
  await page.getByRole("button", { name: "Recargar revisión" }).click()
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("P06: el cliente real rechaza cambio tardío del agente antes de enviar preview_apply", async ({ page }) => {
  await boot(page, { initial: designs.apply })
  const result = await page.evaluate(async ({ identity }) => {
    const { previewClient } = await import("/src/preview/index.ts")
    try {
      await previewClient.change(identity, { baseRevisionId: "r1", author: "agent", summary: "Respuesta tardía QA", operations: [{ type: "text", nodeId: "title", text: "Tardío" }] })
      return "aceptado"
    } catch (e) { return e instanceof Error ? e.message : String(e) }
  }, { identity })
  expect(result).toMatch(/vigente|conflicto/i)
  expect((await calls(page)).filter(c => c.command === "preview_apply")).toHaveLength(0)
  await expect(page.frameLocator(".preview-editor iframe").getByText("Título editado por QA")).toBeVisible()
})

test("P09: una revisión del agente es deshacible y editar tras deshacer invalida rehacer", async ({ page }) => {
  const agentRevision = { ...nr2, document: toNativeDocument(d2, "agent") }
  const branch = nativeRevision("branch", "r3", applyOperations(d1, [{ type: "text", nodeId: "title", text: "Rama manual QA" }]), "Editar texto")
  await boot(page, { initial: nativeDesign([nr1, agentRevision], "r2", "create", "draft"), transitions: [
    { command: "preview_apply", matchKey: "baseRevisionId", matchValue: "r2", state: designs.undo },
    { command: "preview_apply", matchKey: "baseRevisionId", matchValue: "r3", state: nativeDesign([nr1, agentRevision, nr3, branch], "branch", "create", "draft") },
  ] })
  await page.getByRole("button", { name: "Deshacer" }).click()
  await expect(page.frameLocator(".preview-editor iframe").getByText("Título QA")).toBeVisible()
  await expect(page.getByRole("button", { name: "Rehacer" })).toBeEnabled()
  await page.getByLabel("Bloque seleccionado").selectOption("title")
  await page.locator(".preview-properties textarea").fill("Rama manual QA")
  await page.getByRole("button", { name: "Guardar texto" }).click()
  await expect(page.frameLocator(".preview-editor iframe").getByText("Rama manual QA")).toBeVisible()
  await expect(page.getByRole("button", { name: "Rehacer" })).toBeDisabled()
  expect((await calls(page)).filter(c => c.command === "preview_apply").map(c => c.args.baseRevisionId)).toEqual(["r2", "r3"])
})

test("el lienzo mueve un bloque libremente y deshacer restaura la posición", async ({ page }) => {
  test.setTimeout(20000)
  const dragDocument = applyOperations(d1, [{ type: 'layout', nodeId: 'card', patch: { padding: 32 } }])
  await boot(page, { initial: nativeDesign([nativeRevision('r1', null, dragDocument, 'Diseño con tarjeta')], 'r1', 'create', 'draft') })
  await enablePersistedEdits(page)
  const frame = page.frameLocator('.preview-editor iframe')
  const title = frame.locator('[data-node="title"]')
  await expect(title).toHaveAttribute('draggable', 'true')
  const source = await canvasPoint(page, '[data-node="title"]')
  await page.mouse.move(source.x, source.y)
  await page.mouse.down()
  await page.mouse.move(source.x + 5, source.y + 5, { steps: 3 })
  await expect(frame.locator('[data-node="title"]')).toHaveAttribute('data-dragging', '')
  await page.mouse.move(source.x + 90, source.y + 60, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await current(page))?.currentRevisionId).toBe('r2')
  const doc = fromNativeDesign((await current(page))!, identity).revisions.at(-1)!.document
  expect(doc.root.children.map(n => n.id)).toEqual(['title', 'card'])
  expect(doc.root.children[1].children.map(n => n.id)).toEqual(['action'])
  const moved = doc.root.children.find(node => node.id === 'title')!
  expect(moved.offset).toBeDefined()
  expect(Math.abs(moved.offset!.x) + Math.abs(moved.offset!.y)).toBeGreaterThan(10)
  const first = moved.offset!
  const source2 = await canvasPoint(page, '[data-node="title"]')
  await page.mouse.move(source2.x, source2.y)
  await page.mouse.down()
  await page.mouse.move(source2.x + 5, source2.y - 5, { steps: 3 })
  await page.mouse.move(source2.x + 40, source2.y - 20, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await current(page))?.currentRevisionId).toBe('r3')
  const doc2 = fromNativeDesign((await current(page))!, identity).revisions.at(-1)!.document
  const movedAgain = doc2.root.children.find(node => node.id === 'title')!
  expect(movedAgain.offset).toBeDefined()
  expect(movedAgain.offset!.x).toBeGreaterThan(first.x + 10)
  expect(movedAgain.offset!.y).toBeGreaterThan(0)
  expect(movedAgain.offset!.y).toBeLessThan(first.y)
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click()
  await expect.poll(async () => (await current(page))?.currentRevisionId).toBe('r4')
  await page.getByRole('button', { name: 'Deshacer', exact: true }).click()
  await expect.poll(async () => (await current(page))?.currentRevisionId).toBe('r5')
  expect(fromNativeDesign((await current(page))!, identity).revisions.at(-1)!.document).toEqual(dragDocument)
})

test("seleccionar un bloque no recarga el iframe ni regenera el artefacto", async ({ page }) => {
  test.setTimeout(20000)
  await boot(page, { initial: designs.choose })
  const frame = page.locator('.preview-editor iframe')
  await frame.contentFrame().locator('body').evaluate(el => { el.dataset.qaMarker = 'estable' })
  const before = await frame.getAttribute('srcdoc')
  const source = await canvasPoint(page, '[data-node="title"]')
  await page.mouse.click(source.x, source.y)
  await expect(page.getByLabel('Bloque seleccionado')).toHaveValue('title')
  await expect(frame.contentFrame().locator('body')).toHaveAttribute('data-qa-marker', 'estable')
  expect(await frame.getAttribute('srcdoc')).toBe(before)
  await page.locator('.preview-properties fieldset textarea').first().fill('borrador sin guardar')
  await expect(frame.contentFrame().locator('[data-node="title"]')).toHaveAttribute('draggable', 'false')
  await expect(frame.contentFrame().locator('body')).toHaveAttribute('data-qa-marker', 'estable')
})

test("la paleta de colores valida el código, aplica hexadecimales y muestras rápidas", async ({ page }) => {
  test.setTimeout(20000)
  await boot(page, { initial: designs.choose })
  await enablePersistedEdits(page)
  const source = await canvasPoint(page, '[data-node="title"]')
  await page.mouse.click(source.x, source.y)
  await expect(page.getByLabel('Bloque seleccionado')).toHaveValue('title')
  await page.getByRole('button', { name: 'Paleta de colores' }).click()
  const hex = page.getByPlaceholder('#FAFAFA')
  await hex.fill('no-es-color')
  await expect(page.getByText('Usá un código como #FAFAFA.')).toBeVisible()
  expect((await current(page))?.currentRevisionId).toBe('r1')
  await hex.fill('#FAFAFA')
  await hex.press('Enter')
  await expect.poll(async () => (await current(page))?.currentRevisionId).toBe('r2')
  const applyCall = (await calls(page)).filter(c => c.command === 'preview_apply').at(-1)
  expect(applyCall?.args?.document?.root?.children?.[0]?.styles?.background).toBe('#FAFAFA')
  expect((await current(page))!.revisions.at(-1)!.css).toContain('background:#FAFAFA')
  expect(fromNativeDesign((await current(page))!, identity).revisions.at(-1)!.document.root.children[0].style?.background).toBe('#FAFAFA')
  await page.getByLabel('Aplicar a').selectOption('color')
  await page.getByRole('button', { name: 'Aplicar #7668F5' }).click()
  await expect.poll(async () => (await current(page))?.currentRevisionId).toBe('r3')
  expect(fromNativeDesign((await current(page))!, identity).revisions.at(-1)!.document.root.children[0].style?.color).toBe('#7668F5')
})

test('mover y separar un bloque mantiene fijos sus vecinos durante el gesto y después de guardar', async ({ page }) => {
  const doc = document()
  doc.root.layout = { display: 'flex', direction: 'column', gap: 20, width: 1280, height: 800 }
  doc.root.children[1].layout = { display: 'flex', direction: 'column', gap: 12, padding: 20, width: 240 }
  doc.root.children[1].children = [
    { id: 'moving', kind: 'text', text: 'Mover solo este texto', layout: { height: 40 }, children: [] },
    { id: 'inner-peer', kind: 'text', text: 'Este se queda fijo', layout: { height: 50 }, children: [] },
  ]
  doc.root.children.push({ id: 'outer-peer', kind: 'container', layout: { width: 240, height: 100 }, children: [] })
  await boot(page, { initial: nativeDesign([nativeRevision('r1', null, doc, 'Vecinos fijos')], 'r1', 'create', 'draft') })
  await enablePersistedEdits(page)
  const frame = page.frameLocator('.preview-editor iframe')
  const positions = () => frame.locator('[data-node="card"],[data-node="inner-peer"],[data-node="outer-peer"]').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect(); return { id: node.getAttribute('data-node'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }))
  const before = await positions()
  const source = await canvasPoint(page, '[data-node="moving"]')
  await page.mouse.move(source.x, source.y)
  await page.mouse.down()
  await page.mouse.move(source.x + 200, source.y + 80, { steps: 12 })
  expect(await positions()).toEqual(before)
  await page.mouse.up()
  await expect.poll(async () => (await current(page)).currentRevisionId).toBe('r2')
  await expect(frame.locator('[data-node="root"] > [data-node="moving"]')).toBeVisible()
  expect(await positions()).toEqual(before)
  await page.reload()
  await mount(page)
  await expect(frame.locator('[data-node="root"] > [data-node="moving"]')).toBeVisible()
  expect(await positions()).toEqual(before)
})

test('sacar un texto de una caja lo independiza y conserva su posición al mover la caja', async ({ page }) => {
  const doc = document()
  doc.root.layout = { width: 1280, height: 800 }
  doc.root.children[1].layout = { width: 240, height: 180, padding: 20 }
  doc.root.children[1].children[0].kind = 'text'
  await boot(page, { initial: nativeDesign([nativeRevision('r1', null, doc, 'Separación')], 'r1', 'create', 'draft') })
  await enablePersistedEdits(page)
  const source = await canvasPoint(page, '[data-node="action"]')
  await page.mouse.move(source.x, source.y)
  await page.mouse.down()
  await page.mouse.move(source.x + 190, source.y + 70, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await current(page)).currentRevisionId).toBe('r2')
  const frame = page.frameLocator('.preview-editor iframe')
  await expect(frame.locator('[data-node="root"] > [data-node="action"]')).toBeVisible()
  const before = await frame.locator('[data-node="action"]').evaluate(el => el.getBoundingClientRect().toJSON())
  const card = await canvasPoint(page, '[data-node="card"]', .85, .8)
  await page.mouse.move(card.x, card.y)
  await page.mouse.down()
  await page.mouse.move(card.x + 40, card.y + 40, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await current(page)).currentRevisionId).toBe('r3')
  const after = await frame.locator('[data-node="action"]').evaluate(el => el.getBoundingClientRect().toJSON())
  expect(after.x).toBeCloseTo(before.x, 0)
  expect(after.y).toBeCloseTo(before.y, 0)
})

test('Separar de la caja corrige un texto que ya estaba desplazado en un diseño guardado', async ({ page }) => {
  const doc = document()
  doc.root.layout = { width: 1280, height: 800 }
  doc.root.children[1].layout = { width: 240, height: 180, padding: 20 }
  doc.root.children[1].children[0].offset = { x: 400, y: 100 }
  await boot(page, { initial: nativeDesign([nativeRevision('r1', null, doc, 'Diseño anterior')], 'r1', 'create', 'draft') })
  await enablePersistedEdits(page)
  const point = await canvasPoint(page, '[data-node="action"]')
  await page.mouse.click(point.x, point.y)
  const frame = page.frameLocator('.preview-editor iframe')
  const before = await frame.locator('[data-node="action"]').evaluate(el => el.getBoundingClientRect().toJSON())
  await page.getByRole('button', { name: 'Separar de la caja', exact: true }).click()
  await expect.poll(async () => (await current(page)).currentRevisionId).toBe('r2')
  await expect(frame.locator('[data-node="root"] > [data-node="action"]')).toBeVisible()
  const after = await frame.locator('[data-node="action"]').evaluate(el => el.getBoundingClientRect().toJSON())
  expect(after.x).toBeCloseTo(before.x, 0)
  expect(after.y).toBeCloseTo(before.y, 0)
})

test('un botón conserva su destino y navega a la pantalla vinculada con doble clic', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1656, height: 1010 })
  const doc = applyOperations(document(), [{ type: 'screen-add', screenId: 'settings', nodeId: 'settings-root', boardId: 'board', name: 'Configuración' }])
  await boot(page, { initial: nativeDesign([nativeRevision('r1', null, doc, 'Pantallas')], 'r1', 'create', 'draft') })
  await page.evaluate(async () => { await import('/src/styles/base.css'); await import('/src/styles/agent.css') })
  await enablePersistedEdits(page)
  let point = await canvasPoint(page, '[data-node="action"]')
  await page.mouse.click(point.x, point.y)
  await page.getByLabel('Pantalla de destino').selectOption('settings')
  await expect.poll(async () => (await current(page)).currentRevisionId).toBe('r2')
  expect(fromNativeDesign((await current(page)), identity).revisions.at(-1)!.document.root.children[0].children[1].children[0].targetScreenId).toBe('settings')
  await expect(page.getByText('Enlaces de esta pantalla · 1')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('inspector-pantallas.png') })
  point = await canvasPoint(page, '[data-node="action"]')
  await page.mouse.dblclick(point.x, point.y)
  await expect(page.frameLocator('.preview-editor iframe').locator('[data-node="settings-root"]')).toBeVisible()
  await expect(page.frameLocator('.preview-editor iframe').locator('[data-node="action"]')).toBeHidden()
  expect((await current(page)).currentRevisionId).toBe('r2')
})

test("el tirador redimensiona visualmente solo el viewport activo", async ({ page }) => {
  test.setTimeout(20000)
  await boot(page, { initial: designs.choose })
  await enablePersistedEdits(page)
  await page.getByRole('button', { name: 'Móvil · 390', exact: true }).click()
  const frame = page.frameLocator('.preview-editor iframe')
  const button = await canvasPoint(page, '[data-node="action"]')
  await page.mouse.click(button.x, button.y)
  await expect(page.getByLabel('Bloque seleccionado')).toHaveValue('action')
  await expect(frame.locator('[data-node="action"]')).toHaveAttribute('data-selected', 'true')
  const handle = frame.getByRole('button', { name: 'Redimensionar bloque' })
  await expect(handle).toBeVisible()
  const corner = await canvasPoint(page, '#preview-resize-handle')
  await page.mouse.move(corner.x, corner.y)
  await page.mouse.down()
  await page.mouse.move(corner.x + 35, corner.y + 25, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await current(page))?.currentRevisionId).toBe('r2')
  const node = fromNativeDesign((await current(page))!, identity).revisions.at(-1)!.document.root.children[1].children[0]
  expect(node.layout).toEqual({})
  expect(node.mobile!.width).toBeGreaterThan(40)
  expect(node.mobile!.height).toBeGreaterThan(25)
})

test("el editor flotante ocupa casi la ventana y conserva la selección al minimizar", async ({ page }, testInfo) => {
  test.setTimeout(20000)
  await page.setViewportSize({ width: 1656, height: 1010 })
  await boot(page, { initial: designs.choose })
  await page.evaluate(async identity => {
    await import('/src/styles/base.css')
    await import('/src/styles/agent.css')
    document.getElementById('root')!.style.display = 'none'
    const React = await import('/@id/react')
    const dom = await import('/@id/react-dom/client')
    const { PreviewFloatingEditor } = await import('/src/agent/PreviewHost.tsx')
    const root = document.createElement('div')
    document.body.append(root)
    const createRoot = dom.createRoot ?? dom.default?.createRoot
    const createElement = React.createElement ?? React.default?.createElement
    createRoot(root).render(createElement(PreviewFloatingEditor, { identity, onClose: () => undefined }))
  }, identity)
  const dialog = page.getByRole('dialog', { name: 'Editor visual de previsualización' })
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds!.width).toBeGreaterThan(page.viewportSize()!.width * .9)
  expect(bounds!.height).toBeGreaterThan(page.viewportSize()!.height * .9)
  const titlePoint = await canvasPoint(page, '[data-node="title"]')
  await page.mouse.click(titlePoint.x, titlePoint.y)
  await expect(dialog.getByLabel('Bloque seleccionado')).toHaveValue('title')
  await dialog.getByRole('button', { name: 'Minimizar editor' }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole('button', { name: 'Volver al diseño' }).click()
  await expect(dialog.getByLabel('Bloque seleccionado')).toHaveValue('title')
  await canvasPoint(page, '[data-node="title"]')
  await expect.poll(() => dialog.locator('.preview-canvas-scroll').getAttribute('data-scale')).not.toBe('0.10')
  await page.screenshot({ path: testInfo.outputPath('editor-flotante-desktop.png') })
  await dialog.getByRole('button', { name: 'Chat del diseño', exact: true }).click()
  await expect(dialog.getByRole('complementary', { name: 'Agente de previsualización' })).not.toBeVisible()
  await dialog.getByRole('button', { name: 'Móvil · 390', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Móvil · 390', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.frameLocator('iframe').locator('[data-node="title"]')).toBeVisible()
  await canvasPoint(page, '[data-node="title"]')
  await page.screenshot({ path: testInfo.outputPath('editor-flotante-mobile.png') })
})

test('pantallas y capas permiten crear, renombrar, navegar, arrastrar y reabrir sin perder el diseño', async ({ page }) => {
  test.setTimeout(30000)
  await boot(page, { initial: designs.choose })
  await enablePersistedEdits(page)
  await page.getByRole('button', { name: '+ Pantalla', exact: true }).click()
  await expect.poll(async () => (await current(page)).currentRevisionId).toBe('r2')
  const screens = page.getByRole('navigation', { name: 'Pantallas del diseño' })
  await expect(screens.getByRole('button', { name: 'Pantalla 2' })).toHaveAttribute('aria-current', 'page')
  await expect(page.frameLocator('.preview-editor iframe').getByText('Título QA', { exact: true })).toBeHidden()
  await page.getByRole('textbox', { name: 'Nombre de pantalla', exact: true }).fill('Acceso')
  await page.getByRole('textbox', { name: 'Nombre de pantalla', exact: true }).press('Tab')
  await expect.poll(async () => (await current(page)).currentRevisionId).toBe('r3')
  await screens.getByRole('button', { name: 'Diseño QA previsualización' }).click()
  await expect(page.frameLocator('.preview-editor iframe').getByText('Título QA', { exact: true })).toBeVisible()
  const title = page.getByRole('button', { name: 'Seleccionar capa title', exact: true })
  const card = page.getByRole('button', { name: 'Seleccionar capa card', exact: true })
  await title.dragTo(card)
  await expect.poll(async () => (await current(page)).currentRevisionId).toBe('r4')
  expect(fromNativeDesign(await current(page), identity).revisions.at(-1)!.document.root.children[0].children[0].children.map(node => node.id)).toEqual(['action', 'title'])
  await page.reload()
  await mount(page)
  await expect(page.getByRole('navigation', { name: 'Pantallas del diseño' }).getByRole('button', { name: 'Acceso', exact: false })).toBeVisible()
  expect(fromNativeDesign(await current(page), identity).revisions.at(-1)!.document.screens).toHaveLength(2)
})

test('el chat dentro del editor envía al mismo agente la revisión, pantalla y capa sin crear una conversación nueva', async ({ page }) => {
  test.setTimeout(30000)
  await boot(page, { initial: designs.choose })
  const requests: { url: string; body: any }[] = []
  await page.route('**/qa-opencode/**', async route => {
    if (route.request().method() === 'POST') requests.push({ url: route.request().url(), body: route.request().postDataJSON() })
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  const agentModule = await sharedAgentModule(page)
  await page.evaluate(async ({ identity, agentModule }) => {
    const { useAgent } = await import(agentModule)
    const { previewTaskKey } = await import('/src/preview/task-identity.ts')
    const { useProject } = await import('/src/state/project.ts')
    useProject.setState({ root: identity.project, project: identity.project, ready: true })
    const session = { id: identity.conversationId, title: 'Diseño QA', projectID: 'qa', directory: identity.project, version: '0.18.0', time: { created: Date.now(), updated: Date.now() } }
    useAgent.setState({ connected: true, modelsLoaded: true, modelsError: null, models: [{ providerID: 'openai', modelID: 'qa', name: 'QA' }], model: { providerID: 'openai', modelID: 'qa' }, sessions: [session], allSessions: [session], activeSessionId: session.id, previewTasks: { [previewTaskKey(identity.project, session.id)]: identity.taskId }, memoryEnabled: { [session.id]: false }, context: [], views: { [session.id]: { messages: [], loading: false, hasMore: false, error: null } } })
    const w = window as any
    const original = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => command === 'server_config' ? { url: location.origin + '/qa-opencode', username: 'fixture', password: 'fixture', worktree: identity.project } : original(command, args)
    document.getElementById('root')!.style.display = 'none'
    const React = await import('/@id/react'), dom = await import('/@id/react-dom/client')
    const { PreviewFloatingEditor } = await import('/src/agent/PreviewHost.tsx')
    const root = document.createElement('div'); document.body.append(root)
    const createRoot = dom.createRoot ?? dom.default?.createRoot, createElement = React.createElement ?? React.default?.createElement
    createRoot(root).render(createElement(PreviewFloatingEditor, { identity, onClose: () => undefined }))
  }, { identity, agentModule })
  const dialog = page.getByRole('dialog', { name: 'Editor visual de previsualización' })
  await dialog.getByRole('button', { name: 'Seleccionar capa title', exact: true }).click()
  const chat = dialog.getByRole('complementary', { name: 'Agente de previsualización' })
  await chat.getByRole('textbox', { name: 'Pedile un cambio al agente' }).fill('Agregá una pantalla de acceso sin perder mis cambios')
  await chat.getByRole('button', { name: 'Pedir cambio', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0].url).toContain(`/session/${identity.conversationId}/prompt_async`)
  expect(requests[0].body.parts).toContainEqual({ type: 'text', text: 'Agregá una pantalla de acceso sin perder mis cambios' })
  const adjustment = requests[0].body.parts.find((part: any) => part.synthetic && part.text.startsWith('[FLUFY_PREVIEW_ADJUSTMENT]'))
  expect(adjustment.text).toContain('"revisionId":"r1"')
  expect(adjustment.text).toContain('"nodeId":"title"')
  expect(adjustment.text).toContain('"screenId":"default"')
  await expect(chat.getByRole('textbox', { name: 'Pedile un cambio al agente' })).toHaveValue('')
  expect(requests.some(request => /\/session$/.test(request.url))).toBe(false)
})

const savedDesigns = [
  { identity: { ...nativeIdentity, sessionId: 'chat-inicio', taskId: 'task-inicio' }, title: 'Inicio y resumen', status: 'approved', currentRevisionId: 'r4', approvedRevisionId: 'r4', revisionCount: 4, screenCount: 3, updatedAt: 1_700_000_010_000 },
  { identity: { ...nativeIdentity, sessionId: 'chat-acceso', taskId: 'task-acceso' }, title: 'Acceso', status: 'draft', currentRevisionId: 'r2', approvedRevisionId: null, revisionCount: 2, screenCount: 1, updatedAt: 1_700_000_005_000 },
]

async function mountLibrary(page: Page, designs: unknown[], unreadable = 0) {
  await page.evaluate(async ({ designs, unreadable, projectRoot }) => {
    await import('/src/styles/base.css')
    const w = window as any
    w.__qa.library = { designs, unreadable }
    w.__qa.libraryError = ''
    const original = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command !== 'preview_list') return original(command, args)
      w.__qa.calls.push({ command, args })
      if (w.__qa.libraryError) throw new Error(w.__qa.libraryError)
      return w.__qa.library
    }
    document.getElementById('root')!.style.display = 'none'
    const React = await import('/@id/react'), dom = await import('/@id/react-dom/client')
    const { PreviewLibrary } = await import('/src/agent/PreviewLibrary.tsx')
    const container = document.createElement('div'); document.body.append(container)
    const root = (dom.createRoot ?? dom.default?.createRoot)(container)
    const createElement = React.createElement ?? React.default?.createElement
    root.render(createElement(React.StrictMode ?? React.default?.StrictMode, null, createElement(PreviewLibrary, { projectRoot, onOpen: design => { w.__qa.openedDesign = design }, onClose: () => root.unmount() })))
  }, { designs, unreadable, projectRoot: identity.project })
}

test('la galería muestra los diseños guardados, busca y filtra sin perder la identidad al abrir', async ({ page }, testInfo) => {
  await boot(page, {})
  await mountLibrary(page, savedDesigns, 1)
  const gallery = page.getByRole('dialog', { name: 'Diseños guardados' })
  await expect(gallery.getByRole('button', { name: /^Abrir diseño/ })).toHaveCount(2)
  await expect(gallery.getByRole('status')).toContainText('Se conservaron sin modificar')
  await page.screenshot({ path: testInfo.outputPath('disenos-guardados.png') })
  await gallery.getByRole('searchbox', { name: 'Buscar diseños' }).fill('acceso')
  await expect(gallery.getByRole('button', { name: /^Abrir diseño/ })).toHaveCount(1)
  await gallery.getByRole('combobox', { name: 'Estado', exact: true }).selectOption('approved')
  await expect(gallery.getByText(/No hay diseños que coincidan/)).toBeVisible()
  await gallery.getByRole('searchbox', { name: 'Buscar diseños' }).fill('')
  await gallery.getByRole('button', { name: 'Abrir diseño Inicio y resumen', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__qa.openedDesign.identity)).toEqual(savedDesigns[0].identity)
  expect((await calls(page)).filter(call => call.command === 'preview_list').every(call => call.args.projectRoot === identity.project)).toBe(true)
  await gallery.getByRole('button', { name: 'Cerrar diseños' }).click()
  await expect(gallery).not.toBeVisible()
})

test('la galería distingue un proyecto sin diseños de un fallo y permite recargar', async ({ page }) => {
  await boot(page, {})
  await mountLibrary(page, [])
  const gallery = page.getByRole('dialog', { name: 'Diseños guardados' })
  await expect(gallery.getByText('Todavía no hay diseños guardados')).toBeVisible()
  await page.evaluate(() => { (window as any).__qa.libraryError = 'PREVIEW_SCOPE: proyecto incompatible' })
  await gallery.getByRole('button', { name: 'Recargar diseños' }).click()
  await expect(gallery.getByRole('alert')).toContainText('PREVIEW_SCOPE')
  await expect(gallery.getByText('Todavía no hay diseños guardados')).not.toBeVisible()
  await page.evaluate(designs => { const qa = (window as any).__qa; qa.libraryError = ''; qa.library = { designs, unreadable: 0 } }, savedDesigns)
  await gallery.getByRole('button', { name: 'Recargar diseños' }).click()
  await expect(gallery.getByRole('button', { name: /^Abrir diseño/ })).toHaveCount(2)
})

test('el botón Diseños del panel permite volver a la conversación y tarea del diseño guardado', async ({ page }) => {
  test.setTimeout(30000)
  page.on('pageerror', error => console.error('Galería:', error.message))
  await boot(page, {})
  const agentModule = await sharedAgentModule(page)
  await page.evaluate(async ({ identity, savedDesigns, agentModule, savedState }) => {
    const { useAgent } = await import(agentModule)
    const { useProject } = await import('/src/state/project.ts')
    const { useTeams } = await import('/src/state/teams.ts')
    useProject.setState({ root: identity.project, project: identity.project, ready: true })
    const session = { id: savedDesigns[0].identity.sessionId, title: 'Diseño guardado', projectID: 'qa', directory: identity.project, version: '0.18.0', time: { created: Date.now(), updated: Date.now() } }
    useAgent.setState({ activeSessionId: null, connected: true, sessions: [session], allSessions: [session], previewTasks: {}, views: { [session.id]: { messages: [], loading: false, hasMore: false, error: null } } })
    useTeams.setState({ activeChatId: null, chats: [], loaded: true })
    const w = window as any
    const original = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => command === 'preview_list' ? { designs: savedDesigns, unreadable: 0 } : command === 'preview_get' && args?.identity?.sessionId === 'chat-inicio' ? { ...savedState, identity: savedDesigns[0].identity } : original(command, args)
    document.getElementById('root')!.style.display = 'none'
    const React = await import('/@id/react'), dom = await import('/@id/react-dom/client')
    const { AgentPanel } = await import('/src/agent/AgentPanel.tsx')
    const container = document.createElement('div'); container.style.cssText = 'height:900px;width:700px'; document.body.append(container)
    const createElement = React.createElement ?? React.default?.createElement
    function Probe() {
      // Use the real store's React hook, not /@id/react's alternate dispatcher.
      const open = useAgent(state => state.__qaPreviewOpen === true)
      return createElement(AgentPanel, { previewOpen: open, onPreviewOpen: () => { w.__qa.editorOpened = true; useAgent.setState({ __qaPreviewOpen: true }) }, onPreviewClose: () => useAgent.setState({ __qaPreviewOpen: false }) })
    }
    ;(dom.createRoot ?? dom.default?.createRoot)(container).render(createElement(Probe))
  }, { identity, savedDesigns, agentModule, savedState: designs.approve })
  await expect(page.getByRole('button', { name: 'Diseños', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Diseños', exact: true }).click()
  await page.getByRole('dialog', { name: 'Diseños guardados' }).getByRole('button', { name: 'Abrir diseño Inicio y resumen', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__qa.editorOpened)).toBe(true)
  const selected = await page.evaluate(async ({ agentModule, project }) => {
    const { useAgent } = await import(agentModule)
    const { previewTaskKey } = await import('/src/preview/task-identity.ts')
    const state = useAgent.getState()
    return { session: state.activeSessionId, task: state.previewTasks[previewTaskKey(project, state.activeSessionId)] }
  }, { agentModule, project: identity.project })
  expect(selected).toEqual({ session: 'chat-inicio', task: 'task-inicio' })
  await expect(page.getByRole('dialog', { name: 'Diseños guardados' })).not.toBeVisible()
  const editor = page.getByRole('dialog', { name: 'Editor visual de previsualización' })
  await expect(editor).toBeVisible()
  await editor.getByRole('button', { name: 'Seleccionar capa title', exact: true }).click()
  await editor.getByRole('button', { name: 'Minimizar editor' }).click()
  await expect(editor).not.toBeVisible()
  await page.getByRole('button', { name: 'Diseños', exact: true }).click()
  await page.getByRole('dialog', { name: 'Diseños guardados' }).getByRole('button', { name: 'Abrir diseño Inicio y resumen', exact: true }).click()
  await expect(editor).toBeVisible()
  await expect(editor.getByLabel('Bloque seleccionado')).toHaveValue('title')
})

test("P10/P14: editor y comparación usan el HTML congelado recibido, no lo regeneran del modelo", async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
  // Artefacto controlado distinto del renderer de dominio: detecta un segundo render accidental.
  const frozen = { ...nr1, html: '<main data-preview-id="root"><p data-preview-id="title">Artefacto nativo congelado QA</p></main>', css: '[data-preview-id="title"]{color:rgb(18,52,86)}' }
  const initial = nativeDesign([frozen], "r1", "create", "approved", "r1", [{ revisionId: "r1", createdAt: 1_700_000_005_000, notes: "QA" }])
  await boot(page, { initial, comparisonState: fromNativeDesign(initial, identity) })
  const editor = page.frameLocator(".preview-editor iframe")
  await expect(editor.getByText("Artefacto nativo congelado QA")).toBeVisible()
  await expect(editor.getByText("Título QA", { exact: true })).toHaveCount(0)
  await expect(editor.getByText("Artefacto nativo congelado QA")).toHaveCSS("color", "rgb(18, 52, 86)")
  const comparison = page.locator("section[aria-label='Comparación de diseño'] iframe")
  await expect(comparison).toHaveAttribute("sandbox", "")
  expect(await comparison.getAttribute("srcdoc")).toContain(frozen.html)
  await page.evaluate(() => {
    const w = window as any
    w.__previewMessages = []
    window.addEventListener("message", e => {
      if (e.data?.type === "preview-select") w.__previewMessages.push({ origin: e.origin, data: e.data, fromEditor: e.source === document.querySelector<HTMLIFrameElement>(".preview-editor iframe")?.contentWindow })
    })
  })
  const frozenPoint = await canvasPoint(page, '[data-preview-id="title"]')
  await page.mouse.click(frozenPoint.x, frozenPoint.y)
  try { await expect(page.getByLabel("Bloque seleccionado")).toHaveValue("title") }
  finally {
    const observation = { errors, messages: await page.evaluate(() => (window as any).__previewMessages) }
    await testInfo.attach("bridge-observation", { contentType: "application/json", body: JSON.stringify(observation, null, 2) })
    if (testInfo.status !== testInfo.expectedStatus) console.error("Observación del bridge:", JSON.stringify(observation))
  }
})

test("P14: comparación rechaza capturas de otra revisión o viewport y URLs externas", async ({ page }) => {
  const capture = { revisionId: "r3", viewport: "desktop" as const, width: 1280, height: 800, status: "captured" as const, source: "Fixture QA: no es evidencia real", imageUrl: "https://invalid.example/not-a-capture.png" }
  await boot(page, { initial: designs.approve, comparisonState: fromNativeDesign(designs.approve, identity), implementations: [capture, { ...capture, revisionId: "r4", viewport: "mobile" }] })
  const comparison = page.locator("section[aria-label='Comparación de diseño']")
  await expect(comparison.getByText(/No hay una captura real verificada/)).toBeVisible()
  await expect(comparison.locator("img")).toHaveCount(0)
  await comparison.getByRole("button", { name: "Móvil · 390 × 844" }).click()
  await expect(comparison.locator("img")).toHaveCount(0)
  await expect(comparison.getByRole("status").filter({ hasText: "No hay una captura real verificada" })).toBeVisible()
})

test("P14: una imagen local sin procedencia de tarea no acredita una implementación", async ({ page }) => {
  // PNG de fixture, NO captura real ni evidencia visual: aísla la validación de
  // procedencia de la de URL segura. La revisión y el viewport sí coinciden.
  const unattributed = {
    revisionId: "r4", viewport: "desktop", width: 1280, height: 800, status: "captured",
    source: "Fixture QA sin atribución; no es evidencia real", capturedAt: 1_700_000_005_000,
    imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=",
  } as PreviewImplementation
  await boot(page, { initial: designs.approve, comparisonState: fromNativeDesign(designs.approve, identity), implementations: [unattributed] })
  const comparison = page.locator("section[aria-label='Comparación de diseño']")
  await expect(comparison.locator("img")).toHaveCount(0)
  await expect(comparison.getByRole("status").filter({ hasText: "No hay una captura real verificada" })).toBeVisible()
})

test("P11/P14: la comparación usa la referencia transferida aunque el estado apruebe otra revisión", async ({ page }) => {
  const transferred: PreviewReference = {
    identity: nativeIdentity,
    revision: { ...nr1, html: '<p data-preview-id="title">Referencia transferida inmutable QA</p>' },
  }
  await boot(page, { initial: designs.approve, comparisonState: fromNativeDesign(designs.approve, identity), reference: transferred })
  const comparison = page.locator("section[aria-label='Comparación de diseño']")
  await expect(comparison.getByText(/Revisión r1/)).toBeVisible()
  await expect(comparison.getByText(/Revisión r4/)).toHaveCount(0)
  await expect(comparison.locator("iframe")).toHaveAttribute("srcdoc", /Referencia transferida inmutable QA/)
  expect((await calls(page)).some(c => c.command === "preview_approve")).toBe(false)
})

test("P14: el chat muestra capturas del registro nativo sin depender de un equipo", async ({ page }) => {
  page.on("pageerror", error => console.error("PreviewPane:", error.message))
  await boot(page, { initial: designs.draftAfterApproval })
  await page.evaluate(async ({ identity, nativeIdentity, revision }) => {
    const w = window as any
    const original = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === "preview_transfer") return { identity: nativeIdentity, revision }
      if (command === "preview_capture_list") return ["desktop", "mobile"].map(viewport => ({
        binding: { identity: nativeIdentity, revisionId: revision.id, viewport, width: viewport === "desktop" ? 1280 : 390, height: viewport === "desktop" ? 800 : 844, origin: "http://127.0.0.1:5188" },
        status: "verified", source: "Fixture del registro nativo; no captura real", capturedAt: 1_700_000_005_000,
      }))
      if (command === "preview_capture_image") {
        w.__qa.calls.push({ command, args })
        return { mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=" }
      }
      return original(command, args)
    }
    const React = await import("/@id/react")
    const dom = await import("/@id/react-dom/client")
    const { PreviewPane } = await import("/src/agent/PreviewHost.tsx")
    const { useTeams } = await import("/src/state/teams.ts")
    useTeams.setState({ chats: [] })
    const createElement = React.createElement ?? React.default?.createElement
    const createRoot = dom.createRoot ?? dom.default?.createRoot
    const target = document.createElement("div")
    // Alojar el pane con altura definida como en Workbench, sin el panel del
    // harness anterior desplazándose al cargar su iframe fuera de esta raíz.
    document.getElementById("root")!.style.display = "none"
    target.style.cssText = "height:900px;display:flex"
    document.body.append(target)
    createRoot(target).render(createElement(React.StrictMode ?? React.default?.StrictMode, null,
      createElement(PreviewPane, { identity, onClose: () => undefined })))
  }, { identity, nativeIdentity, revision: nr4 })
  await expect(page.locator(".preview-pane").getByRole("button", { name: "Aprobar revisión r5" })).toBeVisible()
  const compareTab = page.getByRole("tab", { name: "Comparar con lo implementado" })
  await compareTab.click()
  await expect(compareTab).toHaveAttribute("aria-selected", "true")
  const comparison = page.getByRole("region", { name: "Comparación de diseño" })
  await expect(comparison.getByRole("img", { name: "Implementación real de r4, desktop, 1280 por 800" })).toBeVisible()
  await comparison.getByRole("button", { name: "Móvil · 390 × 844" }).click()
  await expect(comparison.getByRole("img", { name: "Implementación real de r4, mobile, 390 por 844" })).toBeVisible()
  expect((await calls(page)).filter(c => c.command === "preview_capture_image").map(c => c.args.revisionId)).toEqual(["r4", "r4"])
})

test("P10/P14: la referencia aprobada sigue congelada y la comparación no sustituye una captura ausente", async ({ page }) => {
  await boot(page, { initial: designs.draftAfterApproval, comparisonState: fromNativeDesign(designs.draftAfterApproval, identity) })
  await expect(page.getByText("La referencia aprobada sigue siendo r4. Este borrador todavía no la reemplaza.")).toBeVisible()
  await expect(page.getByRole("button", { name: /Aprobar revisión r5/ })).toBeVisible()

  const comparison = page.locator("section[aria-label='Comparación de diseño']")
  await expect(comparison.getByText(/Revisión r4/)).toBeVisible()
  await expect(comparison.getByText(/No hay una captura real verificada/)).toBeVisible()
  await expect(comparison.getByRole("button", { name: "Escritorio · 1280 × 800" })).toBeVisible()
  // Reintento con re-clic: una recarga HMR de Vite durante ediciones paralelas
  // puede descartar el estado local del componente sin que el click falle.
  const mobile = comparison.getByRole("button", { name: "Móvil · 390 × 844" })
  await expect.poll(async () => {
    try {
      if (await mobile.getAttribute("aria-pressed") !== "true") await mobile.click()
      return await mobile.getAttribute("aria-pressed")
    } catch { return null }
  }, { timeout: 15000, intervals: [200, 400, 800] }).toBe("true")
  await expect(comparison.locator("figure").first().locator("iframe")).toHaveAttribute("style", /width: 390px/)
})

test("P04: aprobar una revisión desactualizada se rechaza sin alterar la referencia aprobada", async ({ page }) => {
  await boot(page, { initial: designs.approve, transitions: [{ command: "preview_approve", error: "PREVIEW_CONFLICT: la revisión presentada ya no está vigente" }] })
  const result = await page.evaluate(async ({ identity }) => {
    const { previewClient } = await import("/src/preview/index.ts")
    try { await previewClient.approve(identity, "r3", "Aprobación tardía"); return { ok: true, message: "" } }
    catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) } }
  }, { identity })
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/vigente|CONFLICT/)
  const after = await page.evaluate(() => (window as any).__qa.current)
  expect(after.approvedRevisionId).toBe("r4")
  expect(after.currentRevisionId).toBe("r4")
  expect((await calls(page)).filter(c => c.command === "preview_approve").map(c => c.args)).toEqual([{ identity: nativeIdentity, baseRevisionId: "r3", notes: "Aprobación tardía" }])
})

test("P05: el cliente real no revela el diseño de otro proyecto, conversación o tarea", async ({ page }) => {
  await boot(page, { initial: designs.approve })
  const others = [
    { ...identity, project: "D:/qa/otro-proyecto" },
    { ...identity, conversationId: "otro-chat" },
    { ...identity, taskId: "otra-tarea" },
  ]
  const result = await page.evaluate(async ({ identity, others }) => {
    const { previewClient } = await import("/src/preview/index.ts")
    const own = await previewClient.load(identity)
    const foreign = await Promise.all(others.map(i => previewClient.load(i)))
    return { own: own?.currentRevisionId ?? null, foreign: foreign.map(f => f ?? null) }
  }, { identity, others })
  expect(result.own).toBe("r4")
  expect(result.foreign).toEqual([null, null, null])
})

test("P08/P09: editar, deshacer y rehacer pasan por los comandos reales y mantienen el iframe aislado", async ({ page }) => {
  await boot(page, {
    initial: pending,
    transitions: [
      { command: "preview_choose", matchKey: "choice", matchValue: "create", state: designs.choose },
      { command: "preview_apply", matchKey: "baseRevisionId", matchValue: "r1", state: designs.apply },
      { command: "preview_apply", matchKey: "baseRevisionId", matchValue: "r2", state: designs.undo },
      { command: "preview_apply", matchKey: "baseRevisionId", matchValue: "r3", state: designs.redo },
    ],
  })
  await page.getByRole("button", { name: "Crear previsualización" }).click()
  await expect(page.getByText(/Revisión r1/)).toBeVisible()

  await page.getByLabel("Bloque seleccionado").selectOption("title")
  await expect(page.locator(".preview-properties fieldset")).toBeVisible()
  await page.locator(".preview-properties fieldset textarea").first().fill("Título editado por QA")
  await page.getByRole("button", { name: "Guardar texto" }).click()
  await expect(page.getByText(/Revisión r2/)).toBeVisible()
  await expect(page.frameLocator(".preview-editor iframe").getByText("Título editado por QA")).toBeVisible()

  const frame = page.locator(".preview-editor iframe")
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts")
  const srcDoc = await frame.getAttribute("srcdoc")
  expect(srcDoc).toContain("default-src 'none'")
  expect(srcDoc).toContain("connect-src 'none'")
  expect(srcDoc).not.toContain("allow-same-origin")
  expect(await page.frameLocator(".preview-editor iframe").locator("body").evaluate(() => {
    try { void window.parent.document; return "accesible" } catch { return "bloqueado" }
  })).toBe("bloqueado")

  await page.getByRole("button", { name: "Deshacer" }).click()
  await expect(page.getByText(/Revisión r3/)).toBeVisible()
  await expect(page.frameLocator(".preview-editor iframe").getByText("Título QA")).toBeVisible()
  await page.getByRole("button", { name: "Rehacer" }).click()
  await expect(page.getByText(/Revisión r4/)).toBeVisible()
  await expect(page.frameLocator(".preview-editor iframe").getByText("Título editado por QA")).toBeVisible()

  const applied = (await calls(page)).filter(c => c.command === "preview_apply")
  expect(applied).toHaveLength(3)
  expect(applied[0].args).toMatchObject({ identity: nativeIdentity, baseRevisionId: "r1", notes: "Editar texto" })
  expect(applied[0].args.document.preview.root.children[0].text).toBe("Título editado por QA")
  expect(applied[1].args).toMatchObject({ identity: nativeIdentity, baseRevisionId: "r2", notes: "Restaurar revisión r1" })
  expect(applied[1].args.document.preview.root.children[0].text).toBe("Título QA")
  expect(applied[2].args).toMatchObject({ identity: nativeIdentity, baseRevisionId: "r3", notes: "Restaurar revisión r2" })
  expect(applied[2].args.document.preview.root.children[0].text).toBe("Título editado por QA")
})

test("P13: el prototipo escapa contenido hostil y no expone el puente nativo al iframe", async ({ page }) => {
  await boot(page, { initial: designs.hostile })
  await expect(page.locator(".preview-editor iframe")).toHaveAttribute("sandbox", "allow-scripts")
  const srcDoc = await page.locator(".preview-editor iframe").getAttribute("srcdoc")
  expect(srcDoc).toContain("&lt;img src=x")
  expect(srcDoc).not.toContain("<img src=x")
  expect(srcDoc).not.toContain("<script>parent")
  expect(srcDoc).toContain("frame-src 'none'")
  expect(srcDoc).toContain("form-action 'none'")
  expect((srcDoc!.match(/<script>/g) ?? []).length).toBe(1)
  expect(await page.frameLocator(".preview-editor iframe").locator("body").evaluate(() => {
    try { void window.parent.document; return "accesible" } catch { return "bloqueado" }
  })).toBe("bloqueado")

  // Un mensaje que no proviene del frame no puede cambiar la selección.
  await page.evaluate(() => window.postMessage({ type: "preview-select", identityKey: "ajeno", revisionId: "h1", channel: "ajeno", nodeId: "title" }, "*"))
  await expect(page.getByLabel("Bloque seleccionado")).toHaveValue("")
})
