#!/usr/bin/env node
// Harness de evals de Flufy.
//
// Modo real: levanta el motor incluido con un perfil temporal, copia las
// credenciales del usuario, ejecuta cada tarea en una copia del fixture y
// corre su comando de calificación.
//
// Modo --mock: no usa inferencia. Valida cada eval con un control negativo
// (el fixture sin arreglar falla) y uno positivo (la solución incluida pasa).
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const project = resolve(here, "..")
const enginePath = resolve(project, "src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe")
const resultsDir = join(here, "results")
const runsDir = join(here, ".runs")

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback = undefined) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const repeat = Math.max(1, Number(value("--repeat", "1")) || 1)
const keep = flag("--keep")
const mock = flag("--mock")
const jsonOnly = flag("--json")
const timeoutSeconds = Math.max(30, Number(value("--timeout", "300")) || 300)
const only = new Set((value("--task", "") || "").split(",").map((s) => s.trim()).filter(Boolean))

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

function log(...parts) {
  if (!jsonOnly) console.log(...parts)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"))
}

async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}

async function copyFixture(destination) {
  await cp(join(here, "fixtures/base"), destination, { recursive: true })
}

async function applyCopies(task, destination) {
  for (const item of task.copy ?? []) {
    const from = join(here, item.from)
    const to = join(destination, item.to)
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to)
  }
}

function applyEdit(content, oldText, newText) {
  const count = content.split(oldText).length - 1
  if (count !== 1) throw new Error(`La solución esperaba una coincidencia y encontró ${count}`)
  return content.replace(oldText, newText)
}

async function applySolution(task, repo) {
  const solution = await readJson(join(here, "solutions", `${task.id}.json`))
  for (const file of solution.files) {
    const path = join(repo, file.path)
    let content = await readFile(path, "utf8").catch(() => "")
    if (file.create !== undefined) content = file.create
    for (const edit of file.edits ?? []) content = applyEdit(content, edit.oldText, edit.newText)
    await writeFile(path, content)
  }
}

async function runCommand(command, cwd, timeout = 120000) {
  const started = Date.now()
  return await new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let output = ""
    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-20000)
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    const timer = setTimeout(() => {
      output += "\n[timeout]"
      child.kill()
    }, timeout)
    child.on("error", (error) => {
      clearTimeout(timer)
      done({ pass: false, code: -1, output: String(error), durationMs: Date.now() - started })
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      done({ pass: code === 0, code: code ?? -1, output, durationMs: Date.now() - started })
    })
  })
}

async function hashTree(dir, base = dir, out = new Map()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".runs") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await hashTree(path, base, out)
    else if (entry.isFile()) {
      const content = await readFile(path)
      out.set(path.slice(base.length + 1).replaceAll("\\", "/"), createHash("sha256").update(content).digest("hex"))
    }
  }
  return out
}

function changedFiles(before, after) {
  const changed = []
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.push(path)
  for (const path of before.keys()) if (!after.has(path)) changed.push(path)
  return changed.sort()
}

function authPath() {
  if (value("--auth")) return resolve(value("--auth"))
  const home = process.env.USERPROFILE || process.env.HOME || ""
  return join(home, ".local", "share", "opencode", "auth.json")
}

async function startEngine(profile, cwd) {
  const port = await freePort()
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  Object.assign(env, {
    USERPROFILE: profile,
    HOME: profile,
    APPDATA: profile,
    LOCALAPPDATA: profile,
    XDG_DATA_HOME: join(profile, "data"),
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_CACHE_HOME: join(profile, "cache"),
    XDG_STATE_HOME: join(profile, "state"),
    OPENCODE_CONFIG_DIR: join(profile, "config", "opencode"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      agent: { title: { disable: true }, summary: { disable: true } },
      permission: { edit: "allow", bash: "allow", webfetch: "deny" },
    }),
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_SERVER_PASSWORD: "eval-password",
  })
  await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
  const auth = authPath()
  if (await stat(auth).then(() => true).catch(() => false)) {
    await mkdir(join(env.XDG_DATA_HOME, "opencode"), { recursive: true })
    await cp(auth, join(env.XDG_DATA_HOME, "opencode", "auth.json"))
  }
  const child = spawn(enginePath, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env,
    cwd,
    windowsHide: true,
    stdio: "pipe",
  })
  let logText = ""
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { logText = (logText + chunk.toString()).slice(-12000) })
  const headers = { Authorization: `Basic ${Buffer.from("opencode:eval-password").toString("base64")}`, "content-type": "application/json" }
  const api = async (method, path, body, timeout = 30000) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 500)}`)
    return text ? JSON.parse(text) : undefined
  }
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await api("GET", "/global/health")
      ready = true
      break
    } catch {
      await delay(500)
    }
  }
  if (!ready) throw new Error(`El motor no arrancó:\n${logText}`)
  return {
    api,
    log: () => logText,
    stop: async () => {
      child.kill()
      await new Promise((done) => (child.exitCode !== null ? done() : child.once("exit", done)))
    },
  }
}

async function pickModel(api, requested) {
  if (requested) {
    const [providerID, ...rest] = requested.split("/")
    return { providerID, modelID: rest.join("/") }
  }
  const catalog = await api("GET", "/config/providers")
  for (const provider of catalog.providers ?? []) {
    const key = provider.options?.apiKey
    const connected = key !== "public" && (provider.source === "api" || provider.source === "env" || (typeof key === "string" && key.length > 0))
    if (!connected) continue
    const model = Object.values(provider.models ?? {})[0]
    if (model?.id) return { providerID: provider.id, modelID: model.id }
  }
  throw new Error("No hay proveedores conectados. Conectá una cuenta en Flufy o pasá --model proveedor/modelo.")
}

async function runTask(task) {
  const runId = randomUUID()
  const work = join(runsDir, runId)
  const repo = join(work, "repo")
  const profile = join(work, "profile")
  await mkdir(repo, { recursive: true })
  await mkdir(profile, { recursive: true })
  await copyFixture(repo)
  const before = await hashTree(repo)
  let engine
  try {
    engine = await startEngine(profile, repo)
    const model = await pickModel(engine.api, value("--model"))
    const session = await engine.api("POST", "/session", {}, 120000)
    const started = Date.now()
    await engine.api("POST", `/session/${session.id}/prompt_async`, {
      model,
      agent: "build",
      parts: [{ type: "text", text: `${task.prompt}\n\nTrabajá directamente en este repositorio. Cuando termines, respondé con un resumen breve.` }],
    })
    let messages = []
    const deadline = Date.now() + timeoutSeconds * 1000
    while (Date.now() < deadline) {
      messages = await engine.api("GET", `/session/${session.id}/message`)
      const status = await engine.api("GET", "/session/status")
      const assistants = messages.filter((message) => message.info.role === "assistant")
      if (assistants.some((message) => message.info.time?.completed) && !status[session.id]) break
      await delay(400)
    }
    const durationMs = Date.now() - started
    const assistants = messages.filter((message) => message.info.role === "assistant")
    const parts = messages.flatMap((message) => message.parts ?? [])
    const toolParts = parts.filter((part) => part.type === "tool")
    const tokens = assistants.reduce((total, message) => {
      const value = message.info.tokens ?? {}
      total.input += value.input ?? 0
      total.output += value.output ?? 0
      total.reasoning += value.reasoning ?? 0
      total.cache += value.cache?.read ?? 0
      return total
    }, { input: 0, output: 0, reasoning: 0, cache: 0 })
    const cost = assistants.reduce((total, message) => total + (message.info.cost ?? 0), 0)
    const errors = assistants.filter((message) => message.info.error).map((message) => message.info.error?.data?.message ?? message.info.error?.name ?? "error")
    const completed = assistants.some((message) => message.info.time?.completed)
    await engine.stop()
    engine = null
    const after = await hashTree(repo)
    await applyCopies(task, repo)
    const grade = await runCommand(task.grade, repo, 120000)
    return {
      id: task.id,
      title: task.title,
      model: `${model.providerID}/${model.modelID}`,
      pass: grade.pass,
      completed,
      durationMs,
      tokens,
      cost,
      toolCalls: toolParts.length,
      toolErrors: toolParts.filter((part) => part.state?.status === "error").length,
      errors,
      changed: changedFiles(before, after),
      grade: { code: grade.code, output: grade.output.slice(-4000), durationMs: grade.durationMs },
    }
  } finally {
    if (engine) await engine.stop().catch(() => undefined)
    if (!keep) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined)
  }
}

async function selfTest(task) {
  const work = join(runsDir, `selftest-${randomUUID()}`)
  const repo = join(work, "repo")
  await mkdir(repo, { recursive: true })
  await copyFixture(repo)
  await applyCopies(task, repo)
  const negative = await runCommand(task.grade, repo, 120000)
  await applySolution(task, repo)
  const positive = await runCommand(task.grade, repo, 120000)
  if (!keep) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined)
  return {
    id: task.id,
    title: task.title,
    negativeControl: !negative.pass,
    positiveControl: positive.pass,
    negativeCode: negative.code,
    positiveCode: positive.code,
    positiveOutput: positive.output.slice(-2000),
  }
}

function table(rows, headers) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)))
  const line = (cells) => cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ")
  return [line(headers), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(line)].join("\n")
}

async function main() {
  const tasks = await readJson(join(here, "tasks.json"))
  const selected = tasks.filter((task) => only.size === 0 || only.has(task.id))
  if (selected.length === 0) throw new Error(`No hay tareas que coincidan con ${[...only].join(", ")}`)
  await mkdir(resultsDir, { recursive: true })
  await mkdir(runsDir, { recursive: true })

  if (flag("--check")) {
    const work = join(runsDir, `check-${randomUUID()}`)
    const repo = join(work, "repo")
    const profile = join(work, "profile")
    await mkdir(repo, { recursive: true })
    await mkdir(profile, { recursive: true })
    await copyFixture(repo)
    let engine
    try {
      engine = await startEngine(profile, repo)
      const model = await pickModel(engine.api, value("--model"))
      log(`Motor listo. Modelo: ${model.providerID}/${model.modelID}`)
      if (jsonOnly) console.log(JSON.stringify({ ok: true, model }))
    } finally {
      if (engine) await engine.stop().catch(() => undefined)
      if (!keep) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined)
    }
    return
  }

  if (mock) {
    const rows = []
    for (const task of selected) rows.push(await selfTest(task))
    const ok = rows.every((row) => row.negativeControl && row.positiveControl)
    log(table(rows.map((row) => [row.id, row.negativeControl ? "ok" : "FALLA", row.positiveControl ? "ok" : "FALLA"]), ["Tarea", "Control negativo", "Control positivo"]))
    const result = { mode: "selftest", ok, tasks: rows, at: new Date().toISOString() }
    await writeFile(join(resultsDir, "latest-selftest.json"), JSON.stringify(result, null, 2))
    if (jsonOnly) console.log(JSON.stringify(result, null, 2))
    process.exitCode = ok ? 0 : 1
    return
  }

  const engineReady = await stat(enginePath).then(() => true).catch(() => false)
  if (!engineReady) throw new Error(`Falta el motor en ${enginePath}. Ejecutá npm run release:engine.`)
  const results = []
  for (const task of selected) {
    for (let attempt = 1; attempt <= repeat; attempt++) {
      log(`\n▶ ${task.id} (${attempt}/${repeat})`)
      try {
        const result = await runTask(task)
        results.push({ ...result, attempt })
        log(`${result.pass ? "PASS" : "FAIL"} · ${(result.durationMs / 1000).toFixed(1)}s · ${result.toolCalls} tools · ${result.tokens.input + result.tokens.output} tokens · $${result.cost.toFixed(4)}`)
      } catch (error) {
        results.push({ id: task.id, title: task.title, attempt, pass: false, error: String(error), durationMs: 0, tokens: {}, toolCalls: 0, cost: 0, changed: [], grade: { output: String(error) } })
        log(`FAIL · ${error}`)
      }
    }
  }
  const passed = results.filter((result) => result.pass).length
  const summary = {
    mode: "agent",
    at: new Date().toISOString(),
    model: results[0]?.model ?? value("--model") ?? "auto",
    passRate: results.length ? passed / results.length : 0,
    results,
  }
  await writeFile(join(resultsDir, `${new Date().toISOString().replaceAll(":", "-")}.json`), JSON.stringify(summary, null, 2))
  await writeFile(join(resultsDir, "latest.json"), JSON.stringify(summary, null, 2))
  log(`\n${table(results.map((row) => [row.id, row.pass ? "PASS" : "FAIL", `${((row.durationMs ?? 0) / 1000).toFixed(1)}s`, row.toolCalls ?? 0, (row.tokens?.input ?? 0) + (row.tokens?.output ?? 0), `$${(row.cost ?? 0).toFixed(4)}`]), ["Tarea", "Resultado", "Tiempo", "Tools", "Tokens", "Costo"])}`)
  log(`\nAprobadas: ${passed}/${results.length} (${Math.round(summary.passRate * 100)}%)`)
  if (jsonOnly) console.log(JSON.stringify(summary, null, 2))
  process.exitCode = passed === results.length ? 0 : 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
