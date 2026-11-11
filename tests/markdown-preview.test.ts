import assert from "node:assert/strict"
import { test } from "node:test"
import { isMarkdown, markdownView, setMarkdownView, useMarkdownViews } from "../src/editor/markdownViews.ts"

const storage = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
}, configurable: true })

test("Markdown extensions are case insensitive and other formats stay in code", () => {
  for (const path of ["readme.md", "guide.MARKDOWN", "C:\\docs\\README.MD"]) assert.equal(isMarkdown(path), true)
  for (const path of ["file.txt", "file.mdx", "file.md.ts", "folder.md/file"]) {
    assert.equal(isMarkdown(path), false)
    assert.equal(markdownView("C:/project", path), "code")
  }
  assert.equal(markdownView("C:/project", "readme.md"), "code")
})

test("view choices survive reopening and are isolated by file and project", () => {
  setMarkdownView("C:\\Project", "C:\\Project\\README.MD", "code")
  assert.equal(markdownView("c:/project", "c:/project/readme.md"), "code")
  assert.equal(markdownView("C:/project", "C:/project/other.md"), "code")
  assert.equal(markdownView("C:/other-project", "C:/project/readme.md"), "code")
  useMarkdownViews.setState({ projects: {} })
  assert.equal(markdownView("C:/project", "C:/project/readme.md"), "code")
  setMarkdownView("C:/project", "C:/project/readme.md", "preview")
  assert.equal(markdownView("C:/project", "C:/project/readme.md"), "preview")
  useMarkdownViews.setState({ projects: {} })
  assert.equal(markdownView("C:/project", "C:/project/readme.md"), "preview")
})
