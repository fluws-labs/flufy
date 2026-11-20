// Memoria local de Flufy: inyecta el contexto recordado antes de cada llamada
// al modelo y bloquea las herramientas de memoria cuando el toggle está apagado.
// Se ejecuta dentro del motor de opencode y solo lee la carpeta local.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const PROFILE_MAX = 2000
const AGENT_LOG_LINES = 20
const INBOX_TITLES = 3

function slug(value) {
  const base = String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .pop() || "workspace"
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned || "workspace"
}

function oneLine(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max)
}

function parseLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
}

export const FlufyMemory = async ({ client, directory }, options) => {
  const root = options?.root
  if (!root) return {}
  const configPath = options?.config || join(root, "config.json")
  const agentDir = options?.agent || join(root, "agent")

  const enabled = (sessionID) => {
    if (!sessionID) return true
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8"))
      return config?.sessions?.[sessionID] !== false
    } catch {
      return true
    }
  }

  const digestFor = (dir) => {
    try {
      const path = join(root, "workspaces", slug(dir), "_digest.md")
      return existsSync(path) ? readFileSync(path, "utf8").trim() : ""
    } catch {
      return ""
    }
  }

  const preferences = () => {
    try {
      const path = join(root, "global", "_preferences.md")
      return existsSync(path) ? readFileSync(path, "utf8").trim() : ""
    } catch {
      return ""
    }
  }

  const sessionInfo = async (sessionID) => {
    try {
      const response = await client.session.get({ path: { id: sessionID } })
      return response?.data || {}
    } catch {
      return {}
    }
  }

  const profileBlock = () => {
    try {
      const path = join(agentDir, "profile.md")
      if (!existsSync(path)) return ""
      const text = readFileSync(path, "utf8").trim()
      if (!text) return ""
      const body = text.slice(0, PROFILE_MAX)
      const notice =
        text.length > PROFILE_MAX
          ? `\n\n(perfil recortado: ${PROFILE_MAX} de ${text.length} caracteres; el completo está en agent/profile.md)`
          : ""
      return `## Mi Flufy\n\n${body}${notice}`
    } catch {
      return ""
    }
  }

  const logBlock = () => {
    try {
      const path = join(agentDir, "log", "log.ndjson")
      if (!existsSync(path)) return ""
      const entries = parseLines(readFileSync(path, "utf8"))
        .filter((entry) => entry && typeof entry.text === "string" && entry.text.trim())
        .slice(-AGENT_LOG_LINES)
      if (!entries.length) return ""
      const lines = entries.map((entry) => {
        const at = oneLine(entry.at, 40)
        const kind = oneLine(entry.kind, 40)
        const project = oneLine(entry.project, 160)
        const head = kind ? `[${kind}] ` : ""
        const where = project ? `${project}: ` : ""
        return `- ${at} · ${head}${where}${oneLine(entry.text, 400)}`
      })
      return `## Log del agente\n\n${lines.join("\n")}`
    } catch {
      return ""
    }
  }

  const inboxBlock = () => {
    try {
      const dir = join(agentDir, "inbox")
      if (!existsSync(dir)) return ""
      const pending = []
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".ndjson")) continue
        const items = parseLines(readFileSync(join(dir, name), "utf8"))
        for (const item of items) {
          if (item && typeof item.title === "string" && !item.ackedAt) pending.push(item)
        }
      }
      if (!pending.length) return ""
      const titles = pending.slice(0, INBOX_TITLES).map((item) => `«${oneLine(item.title, 80)}»`)
      const detail = titles.length ? `: ${titles.join(", ")}` : ""
      return `## Bandeja\n\nBandeja: ${pending.length} pendientes${detail}`
    } catch {
      return ""
    }
  }

  const agentBlock = (info) => {
    if (info?.parentID) {
      return "Perfil del agente (Mi Flufy) disponible en la memoria local: agent/profile.md. Leelo solo si necesitás su tono o sus reglas."
    }
    return [profileBlock(), logBlock(), inboxBlock()].filter(Boolean).join("\n\n")
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input?.sessionID || !enabled(input.sessionID)) return
      const info = await sessionInfo(input.sessionID)
      const dir = info.directory || directory || ""
      const text = digestFor(dir) || preferences()
      if (text) output.system.push(text)
      const agent = agentBlock(info)
      if (agent) output.system.push(agent)
    },
    "tool.execute.before": async (input) => {
      if (!input?.sessionID) return
      if (String(input.tool || "").startsWith("memory_") && !enabled(input.sessionID)) {
        throw new Error("La memoria está apagada en esta conversación. Activala con el interruptor «Memoria» del compositor.")
      }
    },
  }
}
