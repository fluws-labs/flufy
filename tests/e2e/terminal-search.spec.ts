import { expect, test, type Page } from "@playwright/test"

// Real xterm and panel; only native shell IPC is simulated.
async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear()
    Object.assign(window, { __terminalWrites: [], __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => undefined,
      invoke: async (command: string, args: unknown) => {
        if (command === "terminal_shells") return [{ id: "pwsh", name: "PowerShell", path: "pwsh" }]
        if (command === "terminal_write") (window as any).__terminalWrites.push(args)
        return null
      },
    } })
  })
  await page.route("**/terminal-harness", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script></head><body><div id="root" style="height:450px;display:flex"></div></body></html>` }))
  await page.goto("/terminal-harness")
  await page.evaluate(async () => {
    const react = await import("/@id/react")
    const dom = await import("/@id/react-dom/client")
    const { Panel } = await import("/src/workbench/Panel.tsx")
    const terminals = await import("/src/state/terminals.ts")
    const { useProject } = await import("/src/state/project.ts")
    const { useLayout } = await import("/src/state/layout.ts")
    await Promise.all(["base", "workbench"].map(name => import(`/src/styles/${name}.css`)))
    await import("/node_modules/@xterm/xterm/css/xterm.css")
    await import("/node_modules/@vscode/codicons/dist/codicon.css")
    useProject.setState({ root: "C:/test" })
    useLayout.setState({ panelTab: "terminal" })
    await terminals.ensureShells()
    terminals.createTerminal({ id: "one", title: "One", show: false })
    terminals.createTerminal({ id: "two", title: "Two", show: false })
    terminals.setActiveTerminal("one")
    Object.assign(window, { terminalTest: terminals })
    const React = react.default ?? react
    ;(dom.createRoot ?? dom.default.createRoot)(document.getElementById("root")).render(React.createElement(Panel))
  })
  await expect(page.locator(".xterm-screen")).toBeVisible()
  await page.evaluate(async () => {
    const { getInstance } = (window as any).terminalTest
    await Promise.all(["one", "two"].map(id => new Promise<void>(done => getInstance(id).term.write(id === "one" ? "alpha error\r\nbeta error\r\ngamma\r\n" + "output line\r\n".repeat(200) : "other output\r\n", done))))
  })
}

test("search is isolated by terminal and does not send search keys to the shell", async ({ page }) => {
  await boot(page)
  await page.getByRole("button", { name: "Buscar en esta terminal", exact: true }).click()
  const input = page.getByRole("textbox", { name: "Buscar en esta terminal" })
  await expect(input).toBeFocused()
  await input.fill("error")
  await expect(page.getByRole("status")).toHaveText("1 de 2")
  await input.press("Enter")
  await expect(page.getByRole("status")).toHaveText("2 de 2")
  await input.press("Shift+Enter")
  await expect(page.getByRole("status")).toHaveText("1 de 2")
  await page.locator(".terminal-item").filter({ hasText: "Two" }).click()
  await expect(input).toHaveCount(0)
  await page.getByRole("button", { name: "Buscar en esta terminal", exact: true }).click()
  await input.fill("error")
  await expect(page.getByRole("status")).toHaveText("Sin resultados")
  await page.locator(".terminal-item").filter({ hasText: "One" }).click()
  await expect(input).toHaveValue("error")
  await expect(page.getByRole("status")).toHaveText("1 de 2")
  await input.press("Escape")
  await expect(input).toHaveCount(0)
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused()
  expect(await page.evaluate(() => (window as any).__terminalWrites)).toEqual([])
  await page.locator(".xterm-helper-textarea").press("Control+f")
  await expect.poll(() => page.evaluate(() => (window as any).__terminalWrites.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__terminalWrites[0].data)).toBe("\u0006")
})

test("search refreshes on output, clears highlights and releases closed terminal state", async ({ page }, testInfo) => {
  await boot(page)
  await page.getByRole("button", { name: "Buscar en esta terminal", exact: true }).click()
  const input = page.getByRole("textbox", { name: "Buscar en esta terminal" })
  await input.fill("error")
  await expect(page.getByRole("status")).toHaveText("1 de 2")
  await page.evaluate(async () => new Promise<void>(done => (window as any).terminalTest.getInstance("one").term.write("new error\r\n", done)))
  await expect(page.getByRole("status")).toContainText("de 3")
  await input.fill("")
  await expect(page.locator(".xterm-decoration")).toHaveCount(0)
  await input.fill("gamma")
  await expect(page.getByRole("status")).toHaveText("1 de 1")
  await page.screenshot({ path: testInfo.outputPath("terminal-search.png") })
  await page.getByRole("button", { name: "Cerrar búsqueda" }).click()
  await expect(page.locator(".xterm-decoration")).toHaveCount(0)
  await page.locator(".terminal-item").filter({ hasText: "One" }).getByRole("button", { name: "Cerrar terminal" }).click()
  expect(await page.evaluate(() => (window as any).terminalTest.getInstance("one"))).toBeUndefined()
  await page.getByRole("button", { name: "Buscar en esta terminal", exact: true }).click()
  await expect(input).toHaveValue("")
})
