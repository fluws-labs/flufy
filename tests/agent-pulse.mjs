import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function listFiles(root) {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(root)
  return files.sort()
}

function hashTree(root) {
  const hash = createHash("sha256")
  for (const path of listFiles(root)) {
    const rel = relative(root, path).split(sep).join("/")
    hash.update(rel)
    hash.update("\0")
    hash.update(readFileSync(path))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function defaultPulseEnabled() {
  const source = readFileSync(join(repoRoot, "src-tauri", "src", "memory.rs"), "utf8")
  const match = source.match(/const AGENT_STATE_DEFAULT: &str = "((?:[^"\\]|\\.)*)";/)
  assert.ok(match, "AGENT_STATE_DEFAULT no está en memory.rs")
  const literal = match[1]
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
  return JSON.parse(literal).pulse.enabled
}

test("el tick del Vigía es de solo lectura y arranca apagado por defecto", () => {
  const project = mkdtempSync(join(tmpdir(), "flufy-agent-pulse-"))
  try {
    mkdirSync(join(project, "src"), { recursive: true })
    mkdirSync(join(project, "notes"), { recursive: true })
    writeFileSync(join(project, "README.md"), "# Proyecto temporal\n", "utf8")
    writeFileSync(join(project, "src", "main.ts"), "export const answer = 42\n", "utf8")
    writeFileSync(join(project, "notes", "idea.txt"), "una idea pendiente\n", "utf8")

    const before = hashTree(project)

    let output = ""
    let exitCode = 0
    try {
      output = execFileSync(
        "cargo",
        ["test", "--manifest-path", "src-tauri/Cargo.toml", "pulse_tick_is_read_only", "--", "--nocapture"],
        {
          cwd: repoRoot,
          env: { ...process.env, FLUFY_PULSE_TEST_PROJECT: project },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
    } catch (error) {
      exitCode = typeof error?.status === "number" ? error.status : 1
      output = `${error?.stdout || ""}\n${error?.stderr || ""}`
    }

    assert.equal(exitCode, 0, `cargo test terminó con código ${exitCode}:\n${output}`)
    assert.ok(output.includes("pulse_read_only_ok"), `la salida no incluye pulse_read_only_ok:\n${output}`)

    const after = hashTree(project)
    assert.equal(after, before, "el tick modificó archivos del proyecto temporal")

    const statePath = join(project, "agent", "state.json")
    const enabled = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8")).pulse?.enabled
      : defaultPulseEnabled()
    assert.equal(enabled, false, "el Vigía no arranca apagado por defecto")
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
