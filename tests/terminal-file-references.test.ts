import assert from "node:assert/strict"
import { test } from "node:test"
import { terminalFileReferences } from "../src/lib/terminalFileReferences.ts"

test("recognizes compiler locations, stack frames and quoted Python paths", () => {
  for (const [text, path, line, column] of [
    ["src/main.ts:42:17: error TS123", "src/main.ts", 42, 17],
    ["    at run (C:\\my project\\src\\main.ts:28:5)", "C:\\my project\\src\\main.ts", 28, 5],
    ["src/main.ts(12,7): error", "src/main.ts", 12, 7],
    ['  File "src/my server.py", line 64, in run', "src/my server.py", 64, undefined],
    ['"src/my file.ts":8:2', "src/my file.ts", 8, 2],
    ["  --> src/main.rs:10:3", "src/main.rs", 10, 3],
  ] as const) {
    const refs = terminalFileReferences(text)
    assert.equal(refs.length, 1, text)
    assert.deepEqual({ path: refs[0].path, line: refs[0].line, column: refs[0].column }, { path, line, column })
    assert.ok(text.slice(refs[0].start, refs[0].end).includes(path))
  }
})

test("does not reinterpret protocols, network paths, devices or malformed positions as local files", () => {
  for (const text of [
    "https://example.com/src/main.ts:10:2", "file:///C:/project/main.ts:1",
    "vscode://file/C:/project/main.ts:1", "javascript:main.ts:1", "C:main.ts:1",
    "\\\\server\\share\\main.ts:1", "//server/share/main.ts:1", "\\\\?\\C:\\project\\main.ts:1",
    "src/file.ts:0:2", "src/file.ts:1:0", "src/file.ts:9999999999999999", "12:30",
    "src/evil\u202E.ts:1", "C:/project/file.ts:stream:1",
  ]) assert.deepEqual(terminalFileReferences(text), [], text)
})

test("retains multiple independent visible references and Unicode offsets", () => {
  const text = "🚨 src/árbol.ts:3:4 and ./other.py:8"
  const refs = terminalFileReferences(text)
  assert.deepEqual(refs.map(r => r.path), ["src/árbol.ts", "./other.py"])
  assert.deepEqual(refs.map(r => text.slice(r.start, r.end)), ["src/árbol.ts:3:4", "./other.py:8"])
})
