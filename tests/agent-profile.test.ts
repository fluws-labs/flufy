import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FlufyMemory } from "../src-tauri/src/memory_plugin.js"

const PERFIL = "# Flufy Bots\n\nSos el agente personal de Guille. Respondé en español."

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "flufy-agent-profile-"))
}

function writeAgent(root, { profile = PERFIL, log = [], inbox = null, truncatedLog = null } = {}) {
  const agent = join(root, "agent")
  mkdirSync(join(agent, "log"), { recursive: true })
  mkdirSync(join(agent, "inbox"), { recursive: true })
  if (profile !== null) writeFileSync(join(agent, "profile.md"), profile, "utf8")
  const logText = log.map((entry) => JSON.stringify(entry)).join("\n") + (log.length ? "\n" : "")
  writeFileSync(join(agent, "log", "log.ndjson"), logText + (truncatedLog || ""), "utf8")
  if (inbox) {
    writeFileSync(
      join(agent, "inbox", "inbox.ndjson"),
      inbox.map((item) => JSON.stringify(item)).join("\n") + "\n",
      "utf8",
    )
  }
  return agent
}

function logEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    at: `2026-11-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
    kind: "done",
    project: "C:/proyecto",
    text: `entrada-${String(index + 1).padStart(2, "0")}`,
  }))
}

const inboxItems = [
  { at: "2026-11-18T10:00:00Z", title: "Revisar la release", body: "El CI quedó en rojo." },
  { at: "2026-11-18T11:00:00Z", title: "Responder al usuario", body: "Quedó una consulta abierta." },
  { at: "2026-11-18T12:00:00Z", title: "Ya visto", body: "No molestar.", ackedAt: "2026-11-18T13:00:00Z" },
]

async function inject(root, config, sessionID, info = {}) {
  const client = {
    session: {
      get: async () => ({ data: { id: sessionID, ...info } }),
    },
  }
  const handlers = await FlufyMemory({ client, directory: root }, { root, config, agent: join(root, "agent") })
  const output = { system: [] }
  await handlers["experimental.chat.system.transform"]({ sessionID }, output)
  return output.system.join("\n\n")
}

test("la sesión raíz recibe perfil, últimas 20 entradas del log y resumen de bandeja", async () => {
  const root = tempRoot()
  try {
    writeAgent(root, { log: logEntries(25), inbox: inboxItems })
    const config = join(root, "config.json")
    writeFileSync(config, JSON.stringify({ sessions: {} }), "utf8")

    const text = await inject(root, config, "ses-raiz", { directory: "C:/proyecto" })
    assert.ok(text.includes("## Flufy Bots"))
    assert.ok(text.includes("Sos el agente personal de Guille"))
    assert.ok(text.includes("## Log del agente"))
    assert.ok(text.includes("[done] C:/proyecto: entrada-25"))
    assert.ok(text.includes("[done] C:/proyecto: entrada-06"))
    assert.ok(!text.includes("entrada-05"))
    assert.ok(text.includes("Bandeja: 2 pendientes"))
    assert.ok(text.includes("«Revisar la release»"))
    assert.ok(!text.includes("«Ya visto»"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("un perfil más largo que el tope inyecta 4000 caracteres y avisa el recorte", async () => {
  const root = tempRoot()
  try {
    writeAgent(root, { profile: "A".repeat(8000) })
    const config = join(root, "config.json")
    writeFileSync(config, JSON.stringify({ sessions: {} }), "utf8")

    const text = await inject(root, config, "ses-raiz", { directory: "C:/proyecto" })
    assert.ok(text.includes("## Flufy Bots"))
    assert.equal(text.match(/A/g)?.length, 4000)
    assert.ok(!/A{4001}/.test(text))
    assert.ok(
      text.includes("(perfil recortado: 4000 de 8000 caracteres; el completo está en agent/profile.md)"),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("un subagente recibe solo el puntero de una línea, sin el perfil completo", async () => {
  const root = tempRoot()
  try {
    writeAgent(root, { log: logEntries(3), inbox: inboxItems })
    const config = join(root, "config.json")
    writeFileSync(config, JSON.stringify({ sessions: {} }), "utf8")

    const text = await inject(root, config, "ses-hijo", { parentID: "ses-raiz" })
    assert.equal(text.split(/\r?\n/).filter(Boolean).length, 1)
    assert.ok(text.includes("agent/profile.md"))
    assert.ok(!text.includes("Sos el agente personal de Guille"))
    assert.ok(!text.includes("## Log del agente"))
    assert.ok(!text.includes("Bandeja:"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("con la memoria apagada la sesión no recibe nada", async () => {
  const root = tempRoot()
  try {
    writeAgent(root, { log: logEntries(5), inbox: inboxItems })
    const config = join(root, "config.json")
    writeFileSync(config, JSON.stringify({ sessions: { "ses-apagada": false } }), "utf8")

    const text = await inject(root, config, "ses-apagada", { directory: "C:/proyecto" })
    assert.equal(text, "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("archivos ausentes o con JSON truncado no rompen la inyección", async () => {
  const vacio = tempRoot()
  try {
    const config = join(vacio, "config.json")
    writeFileSync(config, JSON.stringify({ sessions: {} }), "utf8")
    assert.equal(await inject(vacio, config, "ses-raiz"), "")
  } finally {
    rmSync(vacio, { recursive: true, force: true })
  }

  const root = tempRoot()
  try {
    writeAgent(root, {
      log: logEntries(2),
      inbox: inboxItems,
      truncatedLog: "{\"at\":\"2026-11-18T14:00:00Z\",\"kind\":\"done\",\"te",
    })
    const config = join(root, "config.json")
    writeFileSync(config, "no es json", "utf8")

    const text = await inject(root, config, "ses-raiz", { directory: "C:/proyecto" })
    assert.ok(text.includes("Sos el agente personal de Guille"))
    assert.ok(text.includes("entrada-02"))
    assert.ok(text.includes("Bandeja: 2 pendientes"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("un worktree usa la memoria del proyecto principal y su checkpoint durable", async () => {
  const root = tempRoot()
  try {
    const main = join(root, "repo")
    mkdirSync(join(main, ".git"), { recursive: true })
    const worktree = join(main, ".worktrees", "rama")
    mkdirSync(worktree, { recursive: true })
    const gitdir = join(main, ".git", "worktrees", "rama")
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir.replace(/\\/g, "/")}\n`, "utf8")

    const workspace = join(root, "workspaces", "repo")
    mkdirSync(join(workspace, "tasks"), { recursive: true })
    writeFileSync(join(workspace, "_digest.md"), "DIGEST DEL PROYECTO PRINCIPAL", "utf8")
    writeFileSync(
      join(workspace, "tasks", "ses-raiz.json"),
      JSON.stringify({ summary: "Checkpoint guardado", next: "Paso pendiente", files: ["src/a.ts"], compacted: true }),
      "utf8",
    )
    writeFileSync(
      join(root, "scopes.json"),
      JSON.stringify({ [main.replace(/\\/g, "/").toLowerCase()]: { workspace: "repo", updated: "2026-01-01T00:00:00Z" } }),
      "utf8",
    )
    writeAgent(root, { log: logEntries(25), inbox: inboxItems })
    const config = join(root, "config.json")
    writeFileSync(config, JSON.stringify({ sessions: {} }), "utf8")

    const text = await inject(root, config, "ses-raiz", { directory: worktree })
    assert.ok(text.includes("DIGEST DEL PROYECTO PRINCIPAL"))
    assert.ok(text.includes("## Checkpoint de esta conversación"))
    assert.ok(text.includes("Checkpoint guardado"))
    assert.ok(text.indexOf("## Checkpoint") < text.indexOf("DIGEST DEL PROYECTO PRINCIPAL"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("el contexto recordado tiene un presupuesto acotado aunque el perfil y el digest sean enormes", async () => {
  const root = tempRoot()
  try {
    writeAgent(root, {
      profile: "P".repeat(8000),
      log: Array.from({ length: 20 }, (_, index) => ({
        at: `2026-11-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
        kind: "done",
        text: "L".repeat(500),
      })),
      inbox: inboxItems,
    })
    const workspace = join(root, "workspaces", "proyecto")
    mkdirSync(join(workspace, "tasks"), { recursive: true })
    writeFileSync(join(workspace, "_digest.md"), "D".repeat(30000), "utf8")
    writeFileSync(
      join(workspace, "tasks", "ses-raiz.json"),
      JSON.stringify({ summary: "C".repeat(4000), compacted: true }),
      "utf8",
    )
    const config = join(root, "config.json")
    writeFileSync(config, JSON.stringify({ sessions: {} }), "utf8")

    const text = await inject(root, config, "ses-raiz", { directory: "C:/proyecto" })
    assert.ok(text.length <= 12200)
    assert.ok(text.includes("## Flufy Bots"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
