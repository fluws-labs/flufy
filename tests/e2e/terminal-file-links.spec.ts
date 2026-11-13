import { expect, test, type Page } from "@playwright/test"

// Real xterm, link provider, document store and CodeMirror; native IPC is mocked.
// Filesystem containment and no-follow reads are tested separately in Rust.
async function boot(page: Page, output: string) {
  await page.addInitScript(() => {
    localStorage.clear()
    Object.assign(window, { __calls: [], __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1, unregisterCallback: () => undefined,
      invoke: async (command: string, args: any) => {
        ;(window as any).__calls.push({ command, args })
        if (command === "terminal_shells") return [{ id: "pwsh", name: "PowerShell", path: "pwsh" }]
        if (command === "terminal_file_reference") {
          if (args.file.startsWith("..")) throw new Error("fuera del espacio de trabajo")
          const path = args.file.startsWith("C:") ? args.file : `C:/project/${args.file}`
          return { path, ...(args.read ? { file: { content: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"), bom: false, size: 230, mtime: 1 } } : {}) }
        }
        if (command === "fs_read_file") throw new Error("unchecked read must not be used")
        return null
      },
    } })
  })
  await page.route("**/terminal-file-harness", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><script type="module">
import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script></head><body><div id="root" style="height:700px;display:flex;flex-direction:column"></div></body></html>` }))
  await page.goto("/terminal-file-harness")
  await page.evaluate(async () => {
    const React = (await import("/@id/react")).default
    const dom = await import("/@id/react-dom/client")
    const createRoot = dom.createRoot ?? dom.default.createRoot
    const { Panel } = await import("/src/workbench/Panel.tsx")
    const { FileEditor } = await import("/src/editor/FileEditor.tsx")
    const terminals = await import("/src/state/terminals.ts")
    const editors = await import("/src/state/editors.ts")
    const docs = await import("/src/editor/documents.ts")
    const { useProject } = await import("/src/state/project.ts")
    const { useLayout } = await import("/src/state/layout.ts")
    await Promise.all(["base", "workbench", "editor"].map(name => import(`/src/styles/${name}.css`)))
    await import("/node_modules/@xterm/xterm/css/xterm.css")
    await import("/node_modules/@vscode/codicons/dist/codicon.css")
    useProject.setState({ root: "C:/project", project: "C:/project" })
    useLayout.setState({ panelTab: "terminal" })
    await terminals.ensureShells()
    terminals.createTerminal({ id: "links", show: false })
    Object.assign(window, { terminalTest: terminals, editors, docs })
    function Editor() {
      const group = editors.useEditors(s => s.groups[0])
      const tab = group.tabs.find(t => t.id === group.activeId)
      const path = tab?.input.kind === "file" ? tab.input.path : null
      return React.createElement("div", { className: "editor-body", style: { height: "300px", flex: "none" } }, React.createElement(FileEditor, { groupId: group.id, path, visible: !!path }))
    }
    createRoot(document.getElementById("root")).render(React.createElement(React.Fragment, null, React.createElement(Editor), React.createElement(Panel)))
  })
  await expect(page.locator(".xterm-screen")).toBeVisible()
  await page.evaluate(async text => new Promise<void>(done => (window as any).terminalTest.getInstance("links").term.write(text, done)), output)
}

async function pointAt(page: Page, fragment: string, tooltip = true) {
  const cell = await page.evaluate(fragment => {
    const term = (window as any).terminalTest.getInstance("links").term
    let text = ""
    const cells: { x: number; y: number }[] = []
    for (let y = 0; y < term.rows; y++) {
      const line = term.buffer.active.getLine(term.buffer.active.viewportY + y)
      for (let x = 0; x < term.cols; x++) {
        const cell = line?.getCell(x)
        if (!cell || !cell.getWidth()) continue
        const chars = cell.getChars() || " "
        for (let i = 0; i < chars.length; i++) cells.push({ x, y })
        text += chars
      }
    }
    const index = text.indexOf(fragment)
    if (index < 0) throw new Error(`fragment not visible: ${fragment}`)
    return { ...cells[index], cols: term.cols, rows: term.rows }
  }, fragment)
  const box = (await page.locator(".xterm-screen").boundingBox())!
  await page.mouse.move(box.x + (cell.x + .5) * box.width / cell.cols, box.y + (cell.y + .5) * box.height / cell.rows)
  if (tooltip) await expect(page.getByRole("tooltip")).toBeVisible()
}

const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__calls.filter((c: any) => c.command === command), command)

test("shows the link cursor only while Ctrl hovers an allowed reference", async ({ page }) => {
  await boot(page, "src/main.ts:12:3\r\n../outside.ts:1\r\n")
  const screen = page.locator(".xterm-screen")
  await pointAt(page, "main.ts")
  await expect(screen).not.toHaveCSS("cursor", "pointer")
  await page.keyboard.down("Control")
  await expect(screen).toHaveCSS("cursor", "pointer")
  await page.keyboard.up("Control")
  await expect(screen).not.toHaveCSS("cursor", "pointer")

  await page.keyboard.down("Control")
  await expect(screen).toHaveCSS("cursor", "pointer")
  await page.mouse.move(5, 5)
  await expect(screen).not.toHaveCSS("cursor", "pointer")
  await pointAt(page, "src/main.ts") // Ctrl held before entering a different cell of the reference.
  await expect(screen).toHaveCSS("cursor", "pointer")
  await pointAt(page, "outside.ts")
  await expect(page.getByRole("tooltip")).toContainText("No se puede abrir")
  await expect(screen).not.toHaveCSS("cursor", "pointer")
  await pointAt(page, "main.ts")
  await expect(screen).toHaveCSS("cursor", "pointer")
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  await expect(screen).not.toHaveCSS("cursor", "pointer")
  await page.keyboard.up("Control")
  expect((await calls(page, "terminal_file_reference")).some((c: any) => c.args.read)).toBe(false)
})

test("Ctrl+click opens validated source at its location without an unchecked reread or external opener", async ({ page }, info) => {
  await boot(page, "🚨 src/main.ts:12:3\r\n")
  await pointAt(page, "main.ts")
  await page.mouse.down(); await page.mouse.up()
  expect(await calls(page, "terminal_file_reference")).toHaveLength(0)
  await page.keyboard.down("Control")
  await expect(page.getByRole("tooltip")).toContainText("C:/project/src/main.ts:12:3")
  await page.screenshot({ path: info.outputPath("terminal-reference-tooltip.png") })
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up("Control")
  await expect(page.locator(".cm-content")).toContainText("line 12")
  await expect.poll(() => page.evaluate(() => (window as any).docs.useDocs.getState().cursor)).toMatchObject({ line: 12, column: 3 })
  expect((await calls(page, "terminal_file_reference")).filter((c: any) => c.args.read)).toHaveLength(1)
  expect(await calls(page, "fs_read_file")).toHaveLength(0)
  expect(await calls(page, "plugin:opener|open_url")).toHaveLength(0)
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => /opener|shell|terminal_write/.test(c.command) && c.command !== "terminal_shells"))).toEqual([])
  await page.screenshot({ path: info.outputPath("terminal-reference-editor.png") })
  await page.evaluate(() => (window as any).docs.dispatchToDoc("C:/project/src/main.ts", { changes: { from: 0, to: 4, insert: "unsaved" } }))
  await page.keyboard.down("Control")
  await pointAt(page, "main.ts")
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up("Control")
  await expect.poll(async () => (await calls(page, "terminal_file_reference")).filter((c: any) => c.args.read).length).toBe(2)
  await expect(page.locator(".cm-content")).toContainText("unsaved")
})

test("uses visible text instead of hidden OSC 8 destinations and refuses denied references", async ({ page }) => {
  await boot(page, "\x1b]8;;https://evil.example/open\x07src/main.ts:12:3\x1b]8;;\x07\r\n../outside.ts:1\r\nhttps://example.com/main.ts:1\r\n")
  await page.keyboard.down("Control")
  await pointAt(page, "main.ts")
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up("Control")
  await expect(page.locator(".cm-content")).toContainText("line 12")
  expect((await calls(page, "terminal_file_reference")).every((c: any) => c.args.file === "src/main.ts")).toBe(true)
  await page.keyboard.down("Control")
  await pointAt(page, "outside.ts")
  await expect(page.getByRole("tooltip")).toContainText("No se puede abrir")
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up("Control")
  await expect.poll(async () => (await calls(page, "terminal_file_reference")).some((c: any) => c.args.file === "../outside.ts" && c.args.read)).toBe(true)
  expect(await page.evaluate(() => (window as any).editors.useEditors.getState().groups[0].tabs.map((t: any) => t.input.path))).toEqual(["C:/project/src/main.ts"])
  await page.keyboard.down("Control")
  await pointAt(page, "example.com", false)
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up("Control")
  expect(await page.evaluate(() => (window as any).__calls.filter((c: any) => /opener|shell|terminal_write/.test(c.command) && c.command !== "terminal_shells"))).toEqual([])
})

test("resolves wrapped quoted paths with spaces using the initial terminal base", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 800 })
  await boot(page, '  File "src/long directory name/my server.py", line 5\r\n')
  await page.keyboard.down("Control")
  await pointAt(page, "long directory")
  await expect(page.getByRole("tooltip")).toContainText("Base inicial: C:/project")
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up("Control")
  await expect.poll(() => page.evaluate(() => (window as any).docs.useDocs.getState().cursor?.line)).toBe(5)
  expect((await calls(page, "terminal_file_reference")).filter((c: any) => c.args.read).map((c: any) => c.args.file)).toEqual(["src/long directory name/my server.py"])
})

test("opens Markdown in code even with a saved preview choice and never auto-previews image-like text", async ({ page }) => {
  await boot(page, "README.md:3\r\nimage.png:2\r\n")
  await page.evaluate(async () => {
    const { setMarkdownView } = await import("/src/editor/markdownViews.ts")
    setMarkdownView("C:/project", "C:/project/README.md", "preview")
  })
  await page.keyboard.down("Control")
  await pointAt(page, "README.md")
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up("Control")
  await expect(page.locator(".cm-content")).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).docs.useDocs.getState().cursor?.line)).toBe(3)
  await expect(page.locator(".markdown-preview")).toHaveCount(0)
  await page.keyboard.down("Control")
  await pointAt(page, "image.png")
  await page.mouse.down(); await page.mouse.up()
  await page.keyboard.up("Control")
  await expect.poll(() => page.evaluate(() => (window as any).docs.useDocs.getState().cursor?.line)).toBe(2)
  await expect(page.locator(".image-preview")).toHaveCount(0)
  expect(await calls(page, "fs_read_base64")).toHaveLength(0)
})

test("closing and reopening a validated document uses the fresh content", async ({ page }) => {
  await boot(page, "")
  const content = await page.evaluate(async () => {
    const docs = (window as any).docs
    const path = "C:/project/fresh.ts"
    await docs.loadDocument(path, { content: "first", bom: false, size: 5, mtime: 1 })
    docs.closeDocument(path)
    await docs.loadDocument(path, { content: "second", bom: false, size: 6, mtime: 2 })
    return docs.docText(path)
  })
  expect(content).toBe("second")
  expect(await calls(page, "fs_read_file")).toHaveLength(0)
})
