import { expect, test, type Page } from "@playwright/test"

// Component integration with controlled IPC data, not a native desktop run.
async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    let id = 0
    Object.assign(window, {
      __studioCalls: [],
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++id, unregisterCallback: () => undefined,
        invoke: async (command: string, args: unknown) => {
          const w = window as any
          w.__studioCalls.push({ command, args })
          if (command === "plugin:event|listen") return ++id
          if (command === "teams_state") return w.__studioTeams
          if (command === "memory_overview") return { scope: "D:/qa/studio", slug: "studio", preferences: "", overview: "", tasks: [], notes: [{ id: "costs", title: "Costos Argentina", kind: "decision", preview: "Comparar comisiones", updated: "", source: "user" }] }
          if (command === "preview_get") return w.__studioDesign
          if (command === "preview_identity") return { provenance: [], approximations: [], assets: [] }
           if (command === "browser_internal_pages") return []
           if (command === "terminal_shells") return [{ id: "pwsh", name: "PowerShell", path: "pwsh" }]
          if (command === "fs_read_dir") return [{ name: "reader.ts", path: "D:/qa/studio/reader.ts", is_dir: false, heavy: false, size: 26, repo: null }]
          if (command === "fs_read_file") return { content: "export const answer = 42;\n", bom: false, size: 26, mtime: 1 }
          return null
        },
      },
    })
  })
  await page.route("**/studio-harness", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script></head><body><div id="root"></div></body></html>` }))
  await page.goto("/studio-harness")
  await page.evaluate(async () => {
    const react = await import("/@id/react")
    const dom = await import("/@id/react-dom/client")
    const React = react.default ?? react
    const createRoot = dom.createRoot ?? dom.default?.createRoot
    const { useProject } = await import("/src/state/project.ts")
    const { useAgent } = await import("/src/state/agent.ts")
    const { useTeams } = await import("/src/state/teams.ts")
    const { useStudio } = await import("/src/state/studio.ts")
     const { StudioWorkspace } = await import("/src/workbench/StudioWorkspace.tsx")
     const { WorkspaceCenter } = await import("/src/workbench/WorkspaceCenter.tsx")
    const { TitleBar } = await import("/src/workbench/Chrome.tsx")
    const { ExplorerView } = await import("/src/views/ExplorerView.tsx")
    const { EditorArea } = await import("/src/editor/EditorArea.tsx")
    const { toNativeDocument } = await import("/src/preview/client.ts")
    const { renderPreview } = await import("/src/preview/renderer.ts")
    const { previewTaskKey } = await import("/src/preview/task-identity.ts")
    await Promise.all(["base", "workbench", "agent", "teams", "studio", "views", "editor"].map(name => import(`/src/styles/${name}.css`)))
     await import("/node_modules/@vscode/codicons/dist/codicon.css")
     await import("/node_modules/@xterm/xterm/css/xterm.css")
    const h = React.createElement
    const project = "D:/qa/studio", sessionId = "studio-session", taskId = "visual-task"
    useProject.setState({ root: project, ready: true })
    const model = { providerID: "openai", modelID: "qa" }
    const agent = { id: "frontend", name: "Frontend", role: "Pantallas y navegación", model, variant: null, skillRefs: [], instructions: "", tools: [], maxConcurrentTasks: 1 }
    const team = { id: "team", name: "Checkout", projectRoot: project, allowedRepositories: [project], leadAgentId: agent.id, members: [agent], maxParallelTasks: 2, maxRetriesPerTask: 1, updatedAt: 1 }
    const run = { id: "run", goal: "Mejorar checkout", team, skills: [], status: "running", startedAt: 1, finishedAt: null, planSessionId: null, tasks: [{ id: "T1", title: "Pantallas", objective: "Mejorar checkout", assignedAgentId: agent.id, repository: project, dependencies: [], expectedFiles: [], acceptanceCriteria: ["Checkout legible"], status: "pending", attempts: [], error: null }], summary: "", error: null, evidenceDir: "", artifacts: [], notified: false }
    const chat = { id: "team-chat", title: "Sprint · Checkout", team, skills: [], archived: false, createdAt: 1, runs: [run], messages: [] }
    const w = window as any
    w.__studioTeams = { schemaVersion: 1, teams: [team], skills: [], chats: [chat] }
    useTeams.setState({ teams: [team], chats: [chat], activeChatId: chat.id, loaded: true })
    useAgent.setState({ connected: true, modelsLoaded: true, model, models: [{ ...model, providerName: "OpenAI", name: "QA", reasoning: true, image: true, variants: [], contextLimit: 100000 }], activeSessionId: sessionId,
      allSessions: [{ id: sessionId, title: "Comparar proveedores", directory: project, version: "1", projectID: "qa", time: { created: 1, updated: 1 } }],
      previewTasks: { [previewTaskKey(project, sessionId)]: taskId },
      views: { [sessionId]: { messages: [{ info: { id: "answer", role: "assistant", sessionID: sessionId, modelID: "qa", providerID: "openai", time: { created: 1, completed: 2 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }, parts: [{ id: "text", messageID: "answer", sessionID: sessionId, type: "text", text: "Compará las comisiones en https://stripe.com/pricing y https://mercadopago.com.ar/costos." }] }], loading: false, hasMore: false, error: null } },
      todos: { [sessionId]: [{ content: "Comparar comisiones", status: "completed", priority: "high" }, { content: "Revisar checkout", status: "in_progress", priority: "medium" }] },
    })
    const doc = { schemaVersion: 1, title: "Checkout", root: { id: "checkout", kind: "container", layout: { width: 390, height: 560, padding: 24, gap: 18 }, style: { background: "#f7f8ff", radius: 18, color: "#181c28" }, children: [{ id: "title", kind: "heading", text: "Checkout", layout: {}, style: { fontSize: 28, fontWeight: 700 }, children: [] }, { id: "summary", kind: "text", text: "Resumen del pedido · $24.900", layout: {}, children: [] }, { id: "pay", kind: "button", text: "Pagar $24.900", layout: {}, style: { background: "#8887ff", color: "#ffffff", radius: 10 }, children: [] }] }, theme: { tokens: {}, sources: [], approximations: [] }, resources: [] }
    w.__studioDesign = { identity: { projectRoot: project, sessionId, taskId, designId: "design" }, choice: "create", status: "draft", currentRevisionId: "r1", approvedRevisionId: null, revisions: [{ id: "r1", parentId: null, createdAt: 1, document: toNativeDocument(doc), ...renderPreview(doc), assets: [], notes: "QA" }], approvals: [] }
    function Harness() {
      const mode = useStudio(s => s.mode)
      return h("div", { className: "workbench studio-workbench" }, h(TitleBar), h("div", { className: "workbench-main" }, mode === "code" && h("aside", { className: "sidebar", style: { width: 240 } }, h(ExplorerView)), h(WorkspaceCenter, { hasProject: true, showPanel: mode === "code" }, mode === "code" ? h(EditorArea) : h(StudioWorkspace, { mode }))))
    }
    createRoot(document.getElementById("root")).render(h(Harness))
  })
}

async function terminalCommands(page: Page) {
  await page.evaluate(async () => {
    const commands = await import("/src/commands/registry.ts")
    const { registerBuiltinCommands } = await import("/src/commands/builtin.ts")
    const terminals = await import("/src/state/terminals.ts")
    registerBuiltinCommands()
    commands.installKeybindings()
    await terminals.ensureShells()
    Object.assign(window, { terminalTest: terminals, commands })
  })
}

test("terminal commands reveal and focus the shared terminal in all four spaces without changing mode", async ({ page }, info) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await boot(page)
  await terminalCommands(page)
  for (const [label, mode] of [["Investigar", "research"], ["Diseñar", "design"], ["Equipo", "team"], ["Código", "code"]]) {
    await page.getByRole("button", { name: label, exact: true }).click()
    await page.evaluate(() => (window as any).commands.executeCommand("terminal.new"))
    await expect(page.locator(".xterm-screen:visible")).toHaveCount(1)
    await expect(page.locator(".panel-slot .xterm-helper-textarea")).toBeFocused()
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true")
    await page.screenshot({ path: info.outputPath(`terminal-${mode}.png`) })
    await page.keyboard.press("Control+j")
    await expect(page.locator(".panel-slot")).toHaveCount(0)
    await page.evaluate(() => (window as any).commands.executeCommand("terminal.toggle"))
    await expect(page.locator(".panel-slot .xterm-helper-textarea")).toBeFocused()
    await page.getByRole("button", { name: "Panel inferior (Ctrl+J)", exact: true }).click()
    await expect(page.locator(".panel-slot")).toHaveCount(0)
    await page.keyboard.press("Control+Backquote")
    await expect(page.locator(".panel-slot .xterm-helper-textarea")).toBeFocused()
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true")
  }
  const calls = await page.evaluate(() => (window as any).__studioCalls)
  expect(calls.filter((c: any) => c.command === "terminal_spawn")).toHaveLength(4)
  expect(calls.filter((c: any) => c.command === "terminal_kill")).toHaveLength(0)
  expect(calls.filter((c: any) => c.command === "terminal_write")).toHaveLength(0)
})

test("changing spaces preserves terminal instances and output; the shared panel resizes, maximizes and shows git output", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await boot(page)
  await terminalCommands(page)
  // Showing the terminal before one exists must create a single default shell.
  await page.evaluate(() => (window as any).commands.executeCommand("terminal.toggle"))
  await expect(page.locator(".panel-slot .xterm-helper-textarea")).toBeFocused()
  await page.evaluate(async () => {
    const w = window as any
    w.firstId = w.terminalTest.useTerminals.getState().activeId
    w.firstInstance = w.terminalTest.getInstance(w.firstId)
    await new Promise<void>(done => w.firstInstance.term.write("still running\r\n", done))
  })
  for (const label of ["Código", "Equipo", "Diseñar", "Investigar", "Código"]) {
    await page.getByRole("button", { name: label, exact: true }).click()
    // Cada espacio recuerda si su panel inferior está abierto; abrirlo acá no
    // crea otra terminal, solo muestra la instancia compartida en este modo.
    await page.evaluate(async () => {
      const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
      if (!useLayout.getState().panelVisible) useLayout.getState().showPanel("terminal")
    })
    await expect(page.locator(".xterm-screen:visible")).toHaveCount(1)
    expect(await page.evaluate(() => {
      const w = window as any, current = w.terminalTest.getInstance(w.firstId)
      return current === w.firstInstance && current.host.isConnected && current.term.buffer.active.getLine(0).translateToString(true) === "still running"
    })).toBe(true)
    const before = (await page.locator(".panel-slot").boundingBox())!.height
    if (label === "Código") await expect(page.locator(".workspace-center > .panel-slot")).toHaveCount(1)
    else if (label === "Diseñar") await expect(page.locator(".studio-design-canvas > .panel-slot")).toHaveCount(1)
    else await expect(page.locator(".studio-team-hub > .panel-slot, .studio-content > .panel-slot")).toHaveCount(1)
    await expect(page.locator(".studio-sidebar .panel-slot, .studio-inspector .panel-slot")).toHaveCount(0)
    const sash = (await page.locator(".sash-horizontal").boundingBox())!
    await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2)
    await page.mouse.down()
    await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2 - 25, { steps: 3 })
    await page.mouse.up()
    await expect.poll(async () => (await page.locator(".panel-slot").boundingBox())!.height).toBeGreaterThan(before + 20)
    await page.getByRole("button", { name: "Maximizar panel", exact: true }).click()
    if (label === "Código") {
      await expect(page.locator(".workspace-content")).toBeHidden()
    } else {
      await expect(page.locator(".studio-center-main:visible")).toHaveCount(0)
    }
    await expect(page.locator(".xterm-screen")).toBeVisible()
    await page.getByRole("button", { name: "Restaurar tamaño", exact: true }).click()
    if (label === "Código") await expect(page.locator(".workspace-content")).toBeVisible()
    else await expect(page.locator(".studio-center-main:visible")).toHaveCount(1)
    await page.evaluate(() => (window as any).commands.executeCommand("output.show"))
    await expect(page.locator(".panel .output")).toBeVisible()
    await page.locator(".panel-tabs").getByRole("button", { name: "Terminal", exact: true }).click()
    await expect(page.locator(".xterm-screen")).toBeVisible()
  }
  await page.getByRole("button", { name: "Ocultar panel (Ctrl+J)", exact: true }).click()
  await expect(page.locator(".panel-slot")).toHaveCount(0)
  const calls = await page.evaluate(() => (window as any).__studioCalls)
  expect(calls.filter((c: any) => c.command === "terminal_spawn")).toHaveLength(1)
  expect(calls.filter((c: any) => c.command === "terminal_kill")).toHaveLength(0)
})

test("new-terminal shortcut reveals the panel in every space without forwarding the shortcut to the shell", async ({ page }) => {
  await boot(page)
  await terminalCommands(page)
  for (const label of ["Diseñar", "Equipo", "Investigar", "Código"]) {
    await page.getByRole("button", { name: label, exact: true }).click()
    await page.keyboard.press("Control+Shift+Backquote")
    await expect(page.locator(".panel-slot .xterm-helper-textarea")).toBeFocused()
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true")
    await page.getByRole("button", { name: "Ocultar panel (Ctrl+J)", exact: true }).click()
  }
  const calls = await page.evaluate(() => (window as any).__studioCalls)
  expect(calls.filter((c: any) => c.command === "terminal_spawn")).toHaveLength(4)
  expect(calls.filter((c: any) => c.command === "terminal_write")).toHaveLength(0)
})

test("los tres modos usan datos reales del estado y conservan la tarea del diseño", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
  await expect(page.getByRole("heading", { name: "Investigación profunda" })).toBeVisible()
  expect((await page.locator(".research-heading").boundingBox())!.height).toBeLessThanOrEqual(60)
  const previewToggle = page.getByRole("checkbox", { name: "Previsualización", exact: true })
  await expect(previewToggle).not.toBeChecked()
  await expect(page.getByText("¿Querés previsualizar cómo quedaría antes de implementarlo?", { exact: true })).toHaveCount(0)
  await previewToggle.check()
  const inspector = page.getByRole("complementary", { name: "Contexto de investigación" })
  await expect(inspector.getByRole("link")).toHaveCount(2)
  await expect(inspector.getByRole("link").first()).toHaveAttribute("href", "https://stripe.com/pricing")
  await expect(inspector.getByRole("progressbar")).toHaveAttribute("value", "1")
  await page.locator(".composer textarea").fill("Borrador sin enviar")
  const messageColumn = (await page.locator(".chat-messages").boundingBox())!
  const composerColumn = (await page.locator(".composer").boundingBox())!
  const gutter = await page.locator(".chat-messages").evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))
  expect(Math.abs(composerColumn.x - (messageColumn.x + gutter))).toBeLessThan(3)
  expect(Math.abs(composerColumn.width - (messageColumn.width - 2 * gutter))).toBeLessThan(3)
  await page.screenshot({ path: testInfo.outputPath("investigar.png") })
  expect((await page.locator(".studio-research .session-dock").boundingBox())!.height).toBeLessThan(260)
  await page.getByRole("button", { name: "Equipo", exact: true }).click()
  await expect(page.getByRole("main", { name: "Mis equipos" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Tablero de tareas" })).toHaveCount(0)
  await page.getByRole("button", { name: "Abrir equipo Sprint · Checkout" }).click()
  await expect(page.getByRole("heading", { name: "Tablero del equipo" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Tablero de tareas" })).toBeVisible()
  await expect(page.locator(".team-board-columns > .team-board-column")).toHaveCount(4)
  await expect(page.getByRole("main", { name: "Mis equipos" })).toHaveCount(0)
  const teamNavigation = page.getByRole("navigation", { name: "Navegación del equipo" })
  await page.getByRole("textbox", { name: "Mensaje para el equipo" }).fill("Borrador del equipo")
  await teamNavigation.getByRole("button", { name: "Alertas", exact: true }).click()
  await expect(page.getByRole("region", { name: "Alertas del equipo" })).toContainText("No hay alertas abiertas")
  await teamNavigation.getByRole("button", { name: "Plan detallado", exact: true }).click()
  await expect(page.getByRole("region", { name: "Plan detallado del equipo" })).toContainText("Checkout legible")
  await expect(page.getByRole("region", { name: "Plan detallado del equipo" }).getByRole("heading", { name: "1 paso preparado por el Lead" })).toBeVisible()
  await teamNavigation.getByRole("button", { name: "Agentes", exact: true }).click()
  await expect(page.getByRole("region", { name: "Agentes del equipo" })).toContainText("Frontend")
  await teamNavigation.getByRole("button", { name: "Tablero", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Mensaje para el equipo" })).toHaveValue("Borrador del equipo")
  await page.getByRole("button", { name: "Abrir tarea T1: Pantallas" }).click()
  await expect(page.getByRole("complementary", { name: "Detalle de T1" })).toContainText("Checkout legible")
  await page.getByRole("button", { name: "Cerrar detalle" }).click()
  await page.screenshot({ path: testInfo.outputPath("equipo.png") })
  await page.getByRole("button", { name: "Todos los equipos", exact: true }).click()
  await expect(page.getByRole("main", { name: "Mis equipos" })).toBeVisible()
  await page.getByRole("button", { name: "Diseñar", exact: true }).click()
  await expect(page.getByRole("region", { name: "Previsualización editable" })).toBeVisible()
  await expect(page.locator(".preview-editor iframe")).toBeVisible()
  await page.getByRole("button", { name: "Móvil · 390", exact: true }).click()
  await page.getByRole("button", { name: "Propiedades", exact: true }).click()
  await expect(page.getByRole("button", { name: "Aprobar revisión r1" })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath("disenar.png") })
  const calls = await page.evaluate(() => (window as any).__studioCalls)
  const reads = calls.filter((call: any) => call.command === "preview_get")
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.every((call: any) => call.args.identity.sessionId === "studio-session" && call.args.identity.taskId === "visual-task" && call.args.identity.designId === "design")).toBe(true)
  expect(calls.some((call: any) => ["preview_choose", "preview_approve", "preview_apply"].includes(call.command))).toBe(false)
  await page.getByRole("button", { name: "Investigar", exact: true }).click()
  await expect(page.getByRole("checkbox", { name: "Previsualización", exact: true })).toBeChecked()
  await page.getByRole("checkbox", { name: "Previsualización", exact: true }).uncheck()
  await expect(page.getByRole("heading", { name: "Investigación profunda" })).toBeVisible()
  await expect(page.locator(".composer textarea:visible")).toHaveValue("Borrador sin enviar")
  await page.getByRole("button", { name: "Costos Argentina decision", exact: true }).click()
  await expect(page.locator(".memory-editor")).toBeVisible()
})

test("Equipo sin equipos y equipo sin ejecución muestran estados vacíos propios", async ({ page }) => {
  await boot(page)
  await page.evaluate(async () => {
    const { useTeams } = await import("/src/state/teams.ts")
    ;(window as any).__savedTeamChat = useTeams.getState().chats[0]
    ;(window as any).__studioTeams = { schemaVersion: 1, teams: [], chats: [], skills: [] }
    useTeams.setState({ chats: [], teams: [], activeChatId: null })
  })
  await page.getByRole("button", { name: "Equipo", exact: true }).click()
  await expect(page.getByRole("button", { name: "Crear mi primer equipo" })).toBeVisible()
  await page.evaluate(async () => {
    const { useTeams } = await import("/src/state/teams.ts")
    const chat = { ...(window as any).__savedTeamChat, runs: [], title: "Equipo nuevo" }
    ;(window as any).__studioTeams = { schemaVersion: 1, teams: [chat.team], chats: [chat], skills: [] }
    useTeams.setState({ teams: [chat.team], chats: [chat] })
  })
  await page.getByRole("button", { name: "Abrir equipo Equipo nuevo" }).click()
  await expect(page.getByRole("heading", { name: "Todo listo para empezar" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Mensaje para el equipo" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Aprobar e iniciar plan" })).toHaveCount(0)
})

test("desde Agentes se abre la conversación individual del especialista", async ({ page }) => {
  await boot(page)
  await page.evaluate(async () => {
    const { useTeams } = await import("/src/state/teams.ts")
    const { useAgent } = await import("/src/state/agent.ts")
    const chat = useTeams.getState().chats[0]
    const run = chat.runs.at(-1)
    const task = run.tasks[0]
    const attempt = { id: "attempt-1", agent: run.team.members[0], sessionId: "agent-session", reviewSessionId: null, startedAt: 1, finishedAt: null, status: "running", summary: "", error: null, review: null, commands: [] }
    const updated = { ...chat, runs: [{ ...run, tasks: [{ ...task, attempts: [attempt] }] }] }
    ;(window as any).__studioTeams = { schemaVersion: 1, teams: [run.team], chats: [updated], skills: [] }
    useTeams.setState({ chats: [updated] })
    useAgent.setState((state) => ({
      allSessions: [...state.allSessions.filter((s) => s.id !== "agent-session"), { id: "agent-session", title: "Conversación con Frontend", directory: "D:/qa/studio", version: "1", projectID: "qa", time: { created: 1, updated: 1 } }],
      views: { ...state.views, "agent-session": { messages: [{ info: { id: "agent-answer", role: "assistant", sessionID: "agent-session", modelID: "qa", providerID: "openai", time: { created: 1, completed: 2 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }, parts: [{ id: "agent-text", messageID: "agent-answer", sessionID: "agent-session", type: "text", text: "```json\n{\"status\":\"blocked\",\"summary\":\"El archivo no compila y necesito una decisión.\",\"checks\":[\"build\"],\"limitations\":[\"Falta revisar el error de compilación\"]}\n```" }] }], loading: false, hasMore: false, error: null } },
    }))
  })
  await page.getByRole("button", { name: "Equipo", exact: true }).click()
  await page.getByRole("button", { name: "Abrir equipo Sprint · Checkout" }).click()
  await page.getByRole("navigation", { name: "Navegación del equipo" }).getByRole("button", { name: "Agentes", exact: true }).click()
  await page.getByRole("button", { name: "Abrir conversación de Frontend" }).click()
  const conversation = page.getByRole("region", { name: "Conversación de Frontend" })
  await expect(conversation).toBeVisible()
  await expect(conversation.locator(".composer")).toBeVisible()
  await expect(conversation.getByText("El agente necesita ayuda para continuar")).toBeVisible()
  await expect(conversation).not.toContainText('"status": "blocked"')
  await expect(page.getByText("Editor de código", { exact: true })).toHaveCount(0)
  await conversation.getByRole("button", { name: "Agentes", exact: true }).click()
  await expect(page.getByRole("region", { name: "Agentes del equipo" })).toBeVisible()
})

test("el Lead conversacional remoto abre dentro del equipo sin duplicar el compositor", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await boot(page)
  await page.evaluate(async () => {
    const { useTeams, selectTeamChat } = await import(/* @vite-ignore */ "/src/state/teams.ts")
    const { useAgent } = await import(/* @vite-ignore */ "/src/state/agent.ts")
    const chat = useTeams.getState().chats[0]
    const next = { ...chat, origin: { sessionId: "studio-session" }, runs: chat.runs.map(run => ({ ...run, planV2: { conversationLead: true } })) }
    ;(window as any).__studioTeams.chats = [next]
    useTeams.setState({ chats: [next] })
    useAgent.setState(s => ({ views: { ...s.views, "studio-session": { ...s.views["studio-session"], messages: [
      ...s.views["studio-session"].messages,
      { info: { id: "internal", role: "user" }, parts: [{ id: "internal-text", type: "text", text: "[FLUFY_EQUIPO_INTERNO] coordinación oculta" }] },
      { info: { ...s.views["studio-session"].messages[0].info, id: "internal-answer", role: "assistant", parentID: "internal" }, parts: [{ id: "internal-answer-text", type: "text", text: "Respuesta interna que no debe verse" }] },
    ] } } }))
    selectTeamChat(chat.id)
  })
  await expect.poll(async () => errors.length ? errors.join("\n") : page.getByRole("navigation", { name: "Navegación del equipo" }).count()).toBe(1)
  await page.getByRole("button", { name: "Ver chat", exact: true }).click()
  const conversation = page.locator(".studio-team .team-workspace-agent-chat")
  await expect(conversation).toBeVisible()
  await expect(conversation.locator(".composer")).toHaveCount(1)
  await expect(conversation).not.toContainText("Respuesta interna que no debe verse")
  await expect(page.locator(".studio-team .team-composer")).toHaveCount(0)
})

test("Código permite editar por defecto y alternar solo lectura globalmente", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
  await page.locator(".composer textarea").fill("Borrador para continuar")
  await page.getByRole("button", { name: "Equipo", exact: true }).click()
  await page.getByRole("button", { name: "Abrir equipo Sprint · Checkout" }).click()
  await page.getByLabel("Mensaje para el equipo").fill("Borrador del equipo para continuar")
  await page.evaluate(async () => {
    const { initExplorer } = await import(/* @vite-ignore */ "/src/state/explorer.ts")
    await initExplorer("D:/qa/studio")
  })
  await page.getByRole("button", { name: "Código", exact: true }).click()
  await expect(page.getByRole("button", { name: "Código", exact: true })).toHaveAttribute("aria-pressed", "true")
  await page.locator(".explorer-view").getByText("reader.ts", { exact: true }).click()
  const editor = page.locator(".file-editor .cm-content")
  const toggle = page.locator(".file-reading-banner button")
  await expect(toggle).toHaveText("Editable")
  await expect(editor).toHaveAttribute("aria-readonly", "false")
  await expect(editor).toContainText("export const answer = 42;")
  await editor.click()
  await page.keyboard.press("Control+End")
  await page.keyboard.type("// MANUAL")
  await expect(editor).toContainText("// MANUAL")
  await toggle.click()
  await expect(toggle).toHaveText("Solo lectura")
  await expect(editor).toHaveAttribute("aria-readonly", "true")
  await editor.click()
  await page.keyboard.type("NO MODIFICAR")
  await expect(editor).not.toContainText("NO MODIFICAR")
  expect(await page.evaluate(() => localStorage.getItem("guillecode:studio.readOnly"))).toBe("true")
  await page.evaluate(async () => {
    const { openEditor } = await import("/src/state/editors.ts")
    openEditor({ kind: "file", path: "D:/qa/studio/other.ts" })
  })
  await expect(editor).toHaveAttribute("aria-readonly", "true")
  await expect(editor).not.toContainText("// MANUAL")
  await editor.click()
  await page.keyboard.type("BLOCKED")
  await expect(editor).not.toContainText("BLOCKED")
  await toggle.click()
  await expect(editor).toHaveAttribute("aria-readonly", "false")
  await editor.click()
  await page.keyboard.type("// OTHER ")
  await expect(editor).toContainText("// OTHER")
  await page.evaluate(async () => {
    const { openEditor } = await import("/src/state/editors.ts")
    openEditor({ kind: "file", path: "D:/qa/studio/reader.ts" })
  })
  await expect(editor).toHaveAttribute("aria-readonly", "false")
  await expect(editor).toContainText("// MANUAL")
  await editor.click()
  await page.keyboard.press("Control+End")
  await page.keyboard.type(" AGAIN")
  await expect(editor).toContainText("// MANUAL AGAIN")
  await page.keyboard.press("Control+z")
  await expect(editor).not.toContainText("AGAIN")
  await expect(editor).toContainText("// MANUAL")
  expect(await page.evaluate(() => localStorage.getItem("guillecode:studio.readOnly"))).toBe("false")
  expect(await page.evaluate(() => (window as any).__studioCalls.filter((c: any) => c.command === "fs_write_file"))).toEqual([])
  await page.evaluate(async () => {
    const { saveDocument } = await import("/src/editor/documents.ts")
    await saveDocument("D:/qa/studio/reader.ts")
  })
  const writes = await page.evaluate(() => (window as any).__studioCalls.filter((c: any) => c.command === "fs_write_file"))
  expect(writes).toHaveLength(1)
  expect(writes[0].args.content).toContain("// MANUAL")
  await page.screenshot({ path: testInfo.outputPath("codigo-edicion.png") })
  await page.getByRole("button", { name: "Equipo", exact: true }).click()
  await expect(page.getByLabel("Mensaje para el equipo")).toHaveValue("Borrador del equipo para continuar")
  await page.getByRole("button", { name: "Investigar", exact: true }).click()
  await expect(page.locator(".studio-research .composer textarea")).toHaveValue("Borrador para continuar")
})

test("investigación se adapta a una ventana angosta sin desborde horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 800 })
  await boot(page)
  await expect(page.getByRole("heading", { name: "Investigación profunda" })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(620)
  const composer = page.locator(".composer")
  await expect(composer).toBeVisible()
  const bounds = (await composer.boundingBox())!
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(620)
})
