import { expect, test, type Page } from "@playwright/test"

// Real xterm selection, context menu, Composer and session runtime; native shell
// IPC is mocked and no model request is sent by these actions.
async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    Object.assign(window, { __calls: [], __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => undefined,
      invoke: async (command: string, args: unknown) => {
        ;(window as any).__calls.push({ command, args })
        if (command === "terminal_shells") return [{ id: "pwsh", name: "PowerShell", path: "pwsh" }]
        return null
      },
    } })
  })
  await page.route("**/terminal-chat-harness", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script></head><body><div id="root" style="height:750px;display:flex;flex-direction:column"></div></body></html>` }))
  await page.goto("/terminal-chat-harness")
  await page.evaluate(async () => {
    const React = (await import("/@id/react")).default
    const dom = await import("/@id/react-dom/client")
    const { Panel } = await import("/src/workbench/Panel.tsx")
    const { Composer } = await import("/src/agent/Composer.tsx")
    const { ContextMenuHost } = await import("/src/components/ContextMenu.tsx")
    const terminals = await import("/src/state/terminals.ts")
    const agent = await import("/src/state/agent.ts")
    const runtime = await import("/src/state/session-runtime.ts")
    const { useProject } = await import("/src/state/project.ts")
    const { useLayout } = await import("/src/state/layout.ts")
    await Promise.all(["base", "workbench", "agent"].map(name => import(`/src/styles/${name}.css`)))
    await import("/node_modules/@xterm/xterm/css/xterm.css")
    await import("/node_modules/@vscode/codicons/dist/codicon.css")
    useProject.setState({ root: "C:/project", project: "C:/project" })
    agent.bindAgentProject("C:/project")
    useLayout.setState({ panelTab: "terminal", agentVisible: false })
    await terminals.ensureShells()
    terminals.createTerminal({ id: "chat-term", show: false, focus: false })
    Object.assign(window, { terminals, agent, runtime, useLayout })
    function Chat() {
      const sessionId = agent.useAgent(s => s.activeSessionId)
      return React.createElement(Composer, { sessionId, busy: false })
    }
    ;(dom.createRoot ?? dom.default.createRoot)(document.getElementById("root")).render(
      React.createElement(React.Fragment, null, React.createElement("div", { style: { height: "350px" } }, React.createElement(Chat)), React.createElement(Panel), React.createElement(ContextMenuHost)),
    )
  })
  await expect(page.locator(".xterm-screen")).toBeVisible()
  await page.evaluate(async () => new Promise<void>(done => (window as any).terminals.getInstance("chat-term").term.write("\x1b[31mError: connection refused\x1b[0m\r\n    at src/main.ts:12:3\r\n", done)))
}

async function select(page: Page) {
  // The public xterm selection API selects rendered text, not escape sequences.
  await page.evaluate(() => (window as any).terminals.getInstance("chat-term").term.select(0, 0, 25))
}

async function menu(page: Page) {
  await page.locator(".xterm-screen").click({ button: "right", position: { x: 8, y: 8 } })
}

const context = (page: Page) => page.evaluate(() => (window as any).agent.useAgent.getState().context)

test("disables actions without selection and preserves selection without pasting on right click", async ({ page }) => {
  await boot(page)
  await menu(page)
  await expect(page.getByRole("button", { name: "Agregar al chat", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Consultar este error", exact: true })).toBeDisabled()
  await page.keyboard.press("Escape")
  await select(page)
  const before = await page.evaluate(() => (window as any).terminals.getInstance("chat-term").term.getSelection())
  await menu(page)
  expect(await page.evaluate(() => (window as any).terminals.getInstance("chat-term").term.getSelection())).toBe(before)
  await expect(page.getByRole("button", { name: "Agregar al chat", exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "terminal_write"))).toEqual([])
})

test("captures a fixed selection, preserves the draft, appends a question without duplicate context and allows removal", async ({ page }, info) => {
  await boot(page)
  const chatRequests: string[] = []
  page.on("request", request => {
    if (/\/session(?:\/|$)/.test(new URL(request.url()).pathname)) chatRequests.push(request.url())
  })
  const composer = page.locator(".composer textarea")
  await composer.fill("Me falla solamente en desarrollo.")
  await select(page)
  await menu(page)
  // A live terminal change after opening the menu must not alter the snapshot.
  await page.evaluate(() => (window as any).terminals.getInstance("chat-term").term.clearSelection())
  await page.getByRole("button", { name: "Agregar al chat", exact: true }).click()
  await expect(composer).toHaveValue("Me falla solamente en desarrollo.")
  await expect(composer).toBeFocused()
  await expect(page.locator(".context-chip.terminal")).toContainText("Terminal")
  await expect.poll(() => context(page)).toMatchObject([{ kind: "terminal", text: "Error: connection refused", cwd: "C:/project" }])
  expect(await page.evaluate(() => (window as any).useLayout.getState().agentVisible)).toBe(true)
  await select(page)
  await menu(page)
  await page.getByRole("button", { name: "Consultar este error", exact: true }).click()
  await expect(composer).toHaveValue("Me falla solamente en desarrollo.\n\n¿Qué indica este error y qué debería revisar para resolverlo?")
  expect(await context(page)).toHaveLength(1)
  await select(page)
  await menu(page)
  await page.getByRole("button", { name: "Consultar este error", exact: true }).click()
  await expect(composer).toHaveValue("Me falla solamente en desarrollo.\n\n¿Qué indica este error y qué debería revisar para resolverlo?")
  expect(await context(page)).toHaveLength(1)
  await page.evaluate(() => (window as any).terminals.getInstance("chat-term").term.clear())
  expect((await context(page))[0].text).toBe("Error: connection refused")
  await page.screenshot({ path: info.outputPath("terminal-context-composer.png") })
  await page.locator(".context-chip.terminal").getByRole("button", { name: "Quitar" }).click()
  await expect(page.locator(".context-chip.terminal")).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => /terminal_write|open_url|fs_read_file/.test(c.command)))).toEqual([])
  expect(chatRequests).toEqual([])
})

test("keeps snapshots per session and serializes terminal output as text alongside code selections", async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    const w = window as any
    w.runtime.patchSessionRuntime("chat-a", { draft: "borrador A", context: [] })
    w.agent.useAgent.setState({ activeSessionId: "chat-a", context: [] })
    w.agent.addContext({ kind: "selection", path: "C:/project/src/main.ts", startLine: 10, endLine: 12, text: "const n = 1" })
  })
  await select(page)
  await menu(page)
  await page.getByRole("button", { name: "Consultar este error", exact: true }).click()
  expect(await context(page)).toHaveLength(2)
  const parts = await page.evaluate(() => (window as any).agent.contextToParts("C:/project", (window as any).agent.useAgent.getState().context, null))
  expect(parts).toHaveLength(2)
  expect(parts[0].text).toContain("líneas 10-12")
  expect(parts[1]).toMatchObject({ type: "text" })
  expect(parts[1].text).toContain("Directorio inicial: C:/project")
  expect(parts[1].text).toContain("Error: connection refused")
  await page.evaluate(() => {
    const w = window as any
    w.runtime.patchSessionRuntime("chat-b", { draft: "borrador B", context: [] })
    w.agent.useAgent.setState({ activeSessionId: "chat-b", context: [] })
  })
  await expect(page.locator(".context-chip.terminal")).toHaveCount(0)
  await expect(page.locator(".composer textarea")).toHaveValue("borrador B")
  await page.evaluate(() => {
    const w = window as any
    w.agent.useAgent.setState({ activeSessionId: "chat-a", context: w.runtime.sessionRuntime("chat-a").context })
  })
  await expect(page.locator(".context-chip.terminal")).toHaveCount(1)
  await expect(page.locator(".composer textarea")).toHaveValue("borrador A\n\n¿Qué indica este error y qué debería revisar para resolverlo?")
})

test("keeps mouse selection and copying native and handles menu keyboard actions without writing to the shell", async ({ page }) => {
  await boot(page)
  const metrics = await page.evaluate(() => {
    const term = (window as any).terminals.getInstance("chat-term").term
    return { cols: term.cols, rows: term.rows }
  })
  const box = (await page.locator(".xterm-screen").boundingBox())!
  const w = box.width / metrics.cols, y = box.y + box.height / metrics.rows / 2
  await page.mouse.move(box.x + w / 4, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 25.25 * w, y, { steps: 8 })
  await page.mouse.up()
  const copied = await page.evaluate(() => {
    const term = (window as any).terminals.getInstance("chat-term").term
    const data = new DataTransfer()
    term.element.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }))
    return { selected: term.getSelection(), copied: data.getData("text/plain") }
  })
  expect(copied).toEqual({ selected: "Error: connection refused", copied: "Error: connection refused" })
  await menu(page)
  await page.keyboard.press("Enter") // No focused action: must not submit to the shell.
  await expect(page.locator(".context-menu")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator(".context-menu")).toHaveCount(0)
  await menu(page)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(page.locator(".context-chip.terminal")).toHaveCount(1)
  await expect(page.locator(".composer textarea")).toHaveValue("¿Qué indica este error y qué debería revisar para resolverlo?")
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => c.command === "terminal_write"))).toEqual([])
})
