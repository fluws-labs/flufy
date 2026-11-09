import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

// P0 gate: real bundled OpenCode, disposable profile, deterministic inference.
// No real account, project, desktop input or external side effects. This tests
// engine contracts, not the (not yet implemented) durable Flufy actor.
const parent = join(process.env.LOCALAPPDATA, "Temp", "opencode")
const profile = await mkdtemp(join(parent, "lead-session-"))
const delay = ms => new Promise(done => setTimeout(done, ms))
const generations = [], calls = [], errors = []
let releaseHeld, heldStarted, engineOrigin
const held = new Promise(resolve => { heldStarted = resolve })
let holdNext = false

function stream(response, item) {
  const id = `resp-${randomUUID()}`
  const events = [
    { type: "response.created", response: { id, model: "qa-lead", created_at: 0 } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", content: [], status: "in_progress" } },
    ...(item.type === "function_call" ? [
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
      { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
    ] : [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 8 } } },
  ]
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
}
const mock = createServer((request, response) => {
  void (async () => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    if (request.url === "/lose-ack") {
      // Deliberately lose the transport acknowledgement AFTER OpenCode accepted
      // the prompt. The caller must observe messageID, not POST again.
      const upstream = await fetch(`${engineOrigin}/session/${body.session}/prompt_async`, {
        method: "POST", headers, body: JSON.stringify(body.prompt), signal: AbortSignal.timeout(15000),
      })
      assert.ok(upstream.ok)
      await upstream.text()
      response.destroy()
      return
    }
    if (request.url === "/mcp/teams") {
      if (body.id === undefined) { response.writeHead(202); response.end(); return }
      let result = {}
      if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "lead-gate", version: "1" } }
      if (body.method === "tools/list") result = { tools: ["commit_decision", "unsafe_operation"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: false } })) }
      if (body.method === "tools/call") {
        calls.push(body.params.name)
        result = { content: [{ type: "text", text: "decision recorded" }] }
      }
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
      return
    }
    if (!request.url?.endsWith("/responses")) { response.end("{}"); return }
    const latestIndex = body.input.findLastIndex(item => item.role === "user")
    const latest = body.input[latestIndex]
    const text = typeof latest.content === "string" ? latest.content : latest.content.map(part => part.text ?? "").join("\n")
    const hasOutput = body.input.slice(latestIndex + 1).some(item => item.type === "function_call_output")
    generations.push({ text, input: body.input, tools: (body.tools ?? []).map(tool => tool.name) })
    if (holdNext) {
      holdNext = false
      heldStarted()
      await new Promise(resolve => { releaseHeld = resolve })
    }
    const requested = text.match(/CALL:(\w+)/)?.[1]
    let item
    if (requested && !hasOutput) {
      const args = requested === "write" ? { filePath: join(profile, "forbidden.txt"), content: "unexpected effect" }
        : requested === "read" ? { filePath: join(profile, "context.txt") } : {}
      item = { type: "function_call", id: `fc-${randomUUID()}`, call_id: `call-${randomUUID()}`, name: requested, arguments: JSON.stringify(args), status: "completed" }
    } else {
      item = { type: "message", id: `msg-${randomUUID()}`, role: "assistant", content: [{ type: "output_text", text: `ACK ${text}`, annotations: [] }], status: "completed" }
    }
    stream(response, item)
  })().catch(error => { errors.push(error); response.writeHead(500); response.end(String(error)) })
})
await new Promise(done => mock.listen(0, "127.0.0.1", done))
const origin = `http://127.0.0.1:${mock.address().port}`
const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"].filter(key => process.env[key]).map(key => [key, process.env[key]]))
Object.assign(env, {
  USERPROFILE: profile, HOME: profile, APPDATA: profile, LOCALAPPDATA: profile,
  XDG_DATA_HOME: join(profile, "data"), XDG_CONFIG_HOME: join(profile, "config"), XDG_CACHE_HOME: join(profile, "cache"), XDG_STATE_HOME: join(profile, "state"),
  OPENCODE_CONFIG_DIR: join(profile, "config", "opencode"), OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_SERVER_PASSWORD: "qa-password",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    enabled_providers: ["openai"],
    provider: { openai: { options: { apiKey: "qa-fake-key", baseURL: `${origin}/v1` }, models: { "qa-lead": { name: "QA Lead", limit: { context: 200000, output: 32000 } } } } },
    mcp: { teams: { type: "remote", url: `${origin}/mcp/teams`, oauth: false } },
    permission: "allow",
    agent: { title: { disable: true }, summary: { disable: true } },
  }),
})
await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
await writeFile(join(profile, "context.txt"), "Decisión anterior: mantener el historial.")
const child = spawn(resolve("src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe"), ["serve", "--hostname", "127.0.0.1", "--port", "0"], { env, cwd: profile, windowsHide: true, stdio: "pipe" })
let log = ""
for (const output of [child.stdout, child.stderr]) output.on("data", bytes => { log = (log + bytes).slice(-10000); engineOrigin ||= log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] })
const headers = { Authorization: `Basic ${Buffer.from("opencode:qa-password").toString("base64")}`, "Content-Type": "application/json" }
async function api(method, path, body) {
  const response = await fetch(`${engineOrigin}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) })
  const text = await response.text()
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}
const messageId = () => `msg_${Date.now().toString(16)}${randomUUID().replaceAll("-", "")}`
const prompt = (text, id = messageId()) => ({ messageID: id, model: { providerID: "openai", modelID: "qa-lead" }, agent: "build", parts: [{ type: "text", text }] })
async function settled(session, parentID) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const messages = await api("GET", `/session/${session}/message`)
    const status = await api("GET", "/session/status")
    const answer = messages.findLast(m => m.info.role === "assistant" && m.info.parentID === parentID)
    if (answer?.info.time.completed && (!status[session] || status[session].type === "idle")) {
      assert.equal(answer.info.error, undefined, JSON.stringify(answer))
      return messages
    }
    await delay(100)
  }
  throw new Error(`Session did not settle: ${log}\n${JSON.stringify(await api("GET", `/session/${session}/message`))}`)
}
try {
  for (let n = 0; !engineOrigin && n < 150; n++) await delay(200)
  assert.ok(engineOrigin, log)
  const session = await api("POST", "/session", { title: "Conversación original" })
  const original = prompt("ORIGINAL: mantener decisiones e historial")
  await api("POST", `/session/${session.id}/prompt_async`, original)
  const before = await settled(session.id, original.messageID)
  const leadTools = JSON.parse(await readFile(resolve("src-tauri/src/teams/lead_tools.json"), "utf8"))
  const permissions = [
    { permission: "*", pattern: "*", action: "deny" },
    ...leadTools.map(permission => ({ permission, pattern: "*", action: "allow" })),
  ]
  await api("PATCH", `/session/${session.id}`, { permission: permissions })
  assert.deepEqual((await api("GET", `/session/${session.id}`)).permission, permissions)
  for (const tool of ["read", "teams_commit_decision", "write", "teams_unsafe_operation"]) {
    const turn = prompt(`LEAD CALL:${tool}`)
    await api("POST", `/session/${session.id}/prompt_async`, turn)
    const history = await settled(session.id, turn.messageID)
    const parts = history.filter(m => m.info.parentID === turn.messageID).flatMap(m => m.parts).filter(p => p.type === "tool")
    assert.ok(parts.some(p => p.tool === tool), `${tool}: missing tool observation`)
    if (["write", "teams_unsafe_operation"].includes(tool)) assert.ok(parts.some(p => p.state.status === "error"), `${tool}: expected denied tool`)
    else assert.ok(parts.some(p => p.state.status === "completed"), `${tool}: allowed tool failed ${JSON.stringify(parts)}`)
  }
  assert.deepEqual(calls, ["commit_decision"])
  await assert.rejects(readFile(join(profile, "forbidden.txt")), { code: "ENOENT" })
  assert.deepEqual(await api("GET", "/permission"), [])
  const history = await api("GET", `/session/${session.id}/message`)
  for (const old of before) assert.ok(history.some(m => m.info.id === old.info.id), "Adoption lost history")
  assert.ok(generations.at(-1).input.some(item => JSON.stringify(item).includes(original.parts[0].text)), "Lead lost original context")
  console.log("PASS adoption: same session/history; read and coordination allowed; write and unrelated MCP denied")

  // A held response lets the actor reconcile a dispatched event while busy.
  // The test intentionally does NOT resubmit the same messageID: the engine is
  // not assumed to provide effect-idempotency for POST /prompt_async.
  holdNext = true
  const event = prompt("EVENT: resultado de especialista")
  await assert.rejects(fetch(`${origin}/lose-ack`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: session.id, prompt: event }),
    signal: AbortSignal.timeout(20000),
  }), "The injected connection loss must be observable to the dispatcher")
  await Promise.race([held, delay(15000).then(() => { throw new Error("Held turn never reached inference") })])
  const live = await api("GET", `/session/${session.id}/message`)
  assert.equal(live.filter(m => m.info.id === event.messageID).length, 1, "Cannot reconcile persisted messageID")
  assert.equal((await api("GET", "/session/status"))[session.id]?.type, "busy")
  const queued = prompt("USER: ajustar el alcance después del evento")
  // This models the required actor order, not OpenCode's concurrent POST policy.
  releaseHeld()
  await settled(session.id, event.messageID)
  await api("POST", `/session/${session.id}/prompt_async`, queued)
  const final = await settled(session.id, queued.messageID)
  assert.equal(final.filter(m => m.info.id === event.messageID).length, 1)
  assert.equal(generations.filter(g => g.text === event.parts[0].text).length, 1)
  assert.ok(final.findIndex(m => m.info.id === event.messageID) < final.findIndex(m => m.info.id === queued.messageID))
  assert.equal((await api("GET", `/session/${session.id}`)).id, session.id)
  assert.deepEqual(errors, [])
  console.log("PASS reconciliation: lost HTTP acknowledgement, persisted messageID visible while busy; event then user turn on original session, no replay")
  console.log("P0 engine capabilities passed. Activation, durable mailbox, actor and send routing are implemented; typed board orchestration remains a separate gate.")
} finally {
  releaseHeld?.()
  child.kill()
  await new Promise(done => child.exitCode !== null ? done() : child.once("exit", done))
  mock.closeAllConnections()
  await new Promise(done => mock.close(done))
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
}
