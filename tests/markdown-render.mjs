import assert from "node:assert/strict"
import { test } from "node:test"
import { build } from "vite"
import { chromium } from "@playwright/test"
import react from "@vitejs/plugin-react"

// Exercise the production sanitizer in a real DOM, without a dev server or writes.
test("Markdown renders GFM safely and resolves local resources from the document", async () => {
  const bundle = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry: "src/editor/markdownRender.ts", name: "MarkdownRenderer", formats: ["iife"] },
      minify: false,
    },
  })
  const script = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === "chunk").code
  const browser = await chromium.launch({ channel: "msedge", headless: true })
  try {
    const page = await browser.newPage()
    await page.addScriptTag({ content: script })
    const result = await page.evaluate(() => {
      const text = '# Heading\n\n- item\n- [x] done\n- [ ] pending\n\n| Key | Value |\n| --- | --- |\n| A | B |\n\n[Link](https://example.com)\n\n![Local](../images/screen%20shot.png)\n\n```js\nconst x = "<script>"\n```\n\n<script>window.compromised = true</script><img src="x" onerror="window.compromised=true"><a href="javascript:alert(1)">bad</a><iframe src="https://example.com"></iframe><input type="text" value="bad"><form><button>Submit</button></form><style>body{display:none}</style>'
      document.body.innerHTML = MarkdownRenderer.renderMarkdown(text, "C:/project/docs/README.MD")
      const local = document.querySelector('img[alt="Local"]')
      return {
        heading: document.querySelector("h1")?.textContent,
        table: document.querySelector("td")?.textContent,
        checkboxes: [...document.querySelectorAll("input")].map(el => ({ type: el.type, checked: el.checked, disabled: el.disabled })),
        code: document.querySelector("pre code")?.textContent,
        highlighted: !!document.querySelector("pre .hljs-keyword"),
        link: document.querySelector("a")?.getAttribute("href"),
        local: local?.getAttribute("data-markdown-image"),
        localSrc: local?.getAttribute("src"),
        unsafe: !!document.body.querySelector("script,iframe,form,button,style,[onerror],a[href^='javascript:']"),
        compromised: !!window.compromised,
        relativeLink: MarkdownRenderer.markdownTarget("C:/project/docs/readme.md", "../guide.md"),
        rejected: ["javascript:alert(1)", "command:run", "//example.com/path"].map(href => MarkdownRenderer.markdownTarget("C:/project/readme.md", href)),
      }
    })
    assert.equal(result.heading, "Heading")
    assert.equal(result.table, "A")
    assert.deepEqual(result.checkboxes, [
      { type: "checkbox", checked: true, disabled: true },
      { type: "checkbox", checked: false, disabled: true },
    ])
    assert.equal(result.code, 'const x = "<script>"')
    assert.equal(result.highlighted, true)
    assert.equal(result.link, "https://example.com")
    assert.equal(result.local, "C:/project/images/screen shot.png")
    assert.equal(result.localSrc, null)
    assert.equal(result.unsafe, false)
    assert.equal(result.compromised, false)
    assert.deepEqual(result.relativeLink, { kind: "file", value: "C:/project/guide.md" })
    assert.deepEqual(result.rejected, [null, null, null])
  } finally {
    await browser.close()
  }
})

test("switching the real file editor preserves unsaved content and undo without writing", async () => {
  const entry = "src/editor/__markdown-test-entry.ts"
  const bundle = await build({
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [react(), {
      name: "markdown-test-entry",
      resolveId: id => id.replace(/\\/g, "/").endsWith(entry) ? entry : undefined,
      load: id => id === entry ? `
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import { FileEditor } from '/src/editor/FileEditor.tsx';
        import { useProject } from '/src/state/project.ts';
        import { useEditors } from '/src/state/editors.ts';
        import { getDoc, dispatchToDoc, isDirty, useDocs, docKey } from '/src/editor/documents.ts';
        import { setMarkdownView } from '/src/editor/markdownViews.ts';
        import { undo } from '@codemirror/commands';
        export { getDoc, dispatchToDoc, isDirty, useDocs, docKey, undo };
        export function mount(path) {
          useProject.setState({root:'C:/project'});
          useEditors.setState({activeGroupId:'test'});
          const root = createRoot(document.getElementById('root'));
          root.render(createElement(FileEditor, {groupId:'test',path,visible:true}));
        }
        export function view(path, mode) { setMarkdownView('C:/project',path,mode); }
      ` : undefined,
    }],
    build: {
      write: false,
      lib: { entry, name: "EditorTest", formats: ["iife"] },
      minify: false,
    },
  })
  const script = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(item => item.type === "chunk").code
  const browser = await chromium.launch({ channel: "msedge", headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<div id="root" style="height:600px"></div>')
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.evaluate(() => {
      window.nativeCalls = []
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "test" } },
        invoke: async (command, args) => {
          window.nativeCalls.push(command)
          if (command === "fs_read_file") return { content: "# Original\n", bom: false, mtime: 1, size: 11 }
          if (command === "fs_read_base64") return ""
          if (command === "fs_write_file") throw new Error("Unexpected write")
          return null
        },
      }
    })
    await page.addScriptTag({ content: script })
    assert.deepEqual(errors, [])
    await page.evaluate(() => EditorTest.mount("C:/project/README.MD"))
    await page.locator(".cm-content").waitFor({ state: "visible" })
    assert.equal(await page.getByRole("region", { name: "Vista previa Markdown" }).count(), 0)
    await page.evaluate(() => EditorTest.view("C:/project/README.MD", "preview"))
    await page.getByRole("region", { name: "Vista previa Markdown" }).waitFor()
    assert.equal(await page.locator(".markdown-preview h1").textContent(), "Original")
    await page.evaluate(() => EditorTest.view("C:/project/README.MD", "code"))
    await page.locator(".cm-content").waitFor({ state: "visible" })
    await page.evaluate(() => {
      const doc = EditorTest.getDoc("C:/project/README.MD")
      doc.view.dispatch({ changes: { from: 0, to: doc.state.doc.length, insert: "# Unsaved\n" } })
      EditorTest.view("C:/project/README.MD", "preview")
    })
    await page.getByRole("heading", { name: "Unsaved" }).waitFor()
    // A second change while already dirty must also reach the visible preview.
    await page.evaluate(() => EditorTest.dispatchToDoc("C:/project/README.MD", { changes: { from: 2, to: 9, insert: "Current" } }))
    await page.getByRole("heading", { name: "Current" }).waitFor()
    await page.evaluate(() => EditorTest.view("C:/project/README.MD", "code"))
    await page.locator(".cm-content").waitFor({ state: "visible" })
    const result = await page.evaluate(() => {
      const path = "C:/project/README.MD"
      const doc = EditorTest.getDoc(path)
      const before = doc.state.doc.toString()
      const dirty = EditorTest.isDirty(path)
      const undoWorked = EditorTest.undo(doc.view)
      return { before, dirty, undoWorked, after: doc.state.doc.toString(), writes: window.nativeCalls.filter(c => c === "fs_write_file").length }
    })
    assert.equal(result.before, "# Current\n")
    assert.equal(result.dirty, true)
    assert.equal(result.undoWorked, true)
    assert.notEqual(result.after, result.before)
    assert.equal(result.writes, 0)
  } finally {
    await browser.close()
  }
})
