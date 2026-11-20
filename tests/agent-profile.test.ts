import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FlufyMemory } from "../src-tauri/src/memory_plugin.js"

const PERFIL = "# Mi Flufy\n\nSos el agente personal de Guille. Respondé en español."

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
    assert.ok(text.includes("## Mi Flufy"))
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

test("un perfil más largo que el tope inyecta 2000 caracteres y avisa el recorte", async () => {
  const root = tempRoot()
  try {
    writeAgent(root, { profile: "A".repeat(8000) })
    const config = join(root, "config.json")
    writeFileSync(config, JSON.stringify({ sessions: {} }), "utf8")

    const text = await inject(root, config, "ses-raiz", { directory: "C:/proyecto" })
    assert.ok(text.includes("## Mi Flufy"))
    assert.equal(text.match(/A/g)?.length, 2000)
    assert.ok(!/A{2001}/.test(text))
    assert.ok(
      text.includes("(perfil recortado: 2000 de 8000 caracteres; el completo está en agent/profile.md)"),
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
