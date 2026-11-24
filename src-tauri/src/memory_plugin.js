// Memoria local de Flufy: inyecta el contexto recordado antes de cada llamada
// al modelo y bloquea las herramientas de memoria cuando el toggle está apagado.
// Se ejecuta dentro del motor de opencode y solo lee la carpeta local.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"

const PROFILE_MAX = 4000
const AGENT_LOG_LINES = 20
const INBOX_TITLES = 3
// Presupuesto total del contexto recordado. Cada capa tiene su tope y, si el
// total se agota, se recortan las capas de menor prioridad antes que el perfil
// o el proyecto.
const BUDGET = 12000
const CAPS = { checkpoint: 900, profile: 4400, digest: 6000, log: 1600, inbox: 320 }
const CHILD_POINTER = "Perfil del agente (Mi Flufy) disponible en la memoria local: agent/profile.md. Leelo solo si necesitás su tono o sus reglas."

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

function normPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\/?/, "")
    .replace(/\/+$/, "")
    .toLowerCase()
}

// Misma regla que project_root en memory.rs: subcarpetas y worktrees comparten
// la memoria del repositorio principal. Windows no distingue mayúsculas.
function projectRoot(directory) {
  const original = normPath(directory)
  if (!original) return ""
  let current = original
  for (let depth = 0; depth < 6; depth++) {
    const dot = join(current, ".git")
    if (existsSync(dot)) {
      try {
        if (statSync(dot).isFile()) {
          const text = readFileSync(dot, "utf8")
          const line = text.split(/\r?\n/).find((entry) => entry.trim().toLowerCase().startsWith("gitdir:"))
          if (line) {
            let gitdir = line.slice(line.indexOf(":") + 1).trim()
            if (!isAbsolute(gitdir)) gitdir = join(current, gitdir)
            const normalized = gitdir.replace(/\\/g, "/")
            const marker = /\/\.git\/worktrees\//i.exec(normalized)
            if (marker && marker.index > 0) return normalized.slice(0, marker.index)
          }
        }
      } catch {
        // Si no se puede leer, el proyecto es la carpeta que contiene .git.
      }
      return current
    }
    const parent = dirname(current)
    if (!parent || parent === current) break
    current = parent
  }
  return original
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

  const scopes = () => {
    try {
      const map = JSON.parse(readFileSync(join(root, "scopes.json"), "utf8"))
      return map && typeof map === "object" ? map : {}
    } catch {
      return {}
    }
  }

  const workspaceFor = (dir, registry) => {
    const project = projectRoot(dir)
    if (!project) return slug(dir)
    const entry = registry[project]
    return entry?.workspace || slug(project)
  }

  const digestFor = (dir, registry) => {
    try {
      const path = join(root, "workspaces", workspaceFor(dir, registry), "_digest.md")
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

  const checkpointFor = (sessionID, dir, registry) => {
    if (!sessionID) return null
    try {
      const path = join(root, "workspaces", workspaceFor(dir, registry), "tasks", `${slug(sessionID)}.json`)
      if (!existsSync(path)) return null
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return null
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
      return `## Mi Flufy\n\n${body}${notice}\n\nEl perfil define identidad y tono; las reglas específicas del proyecto en la memoria del proyecto prevalecen cuando sean más concretas.`
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

  const checkpointBlock = (sessionID, dir, registry) => {
    const checkpoint = checkpointFor(sessionID, dir, registry)
    if (!checkpoint) return ""
    const state = checkpoint.summary || checkpoint.progress
    if (!state) return ""
    const compacted = checkpoint.compacted ? "\nContexto compactado: el resumen del historial está incluido arriba." : ""
    return `## Checkpoint de esta conversación\n\nEs el estado guardado al terminar el turno anterior; contrastalo con el historial.\n${String(state).slice(0, CAPS.checkpoint)}${compacted}`
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input?.sessionID || !enabled(input.sessionID)) return
      const info = await sessionInfo(input.sessionID)
      const dir = info.directory || directory || ""
      const registry = scopes()
      const blocks = []
      let used = 0
      const push = (text, cap) => {
        if (!text) return
        const room = BUDGET - used
        if (room <= 100) return
        const body = String(text).slice(0, Math.max(0, Math.min(cap, room)))
        if (!body.trim()) return
        blocks.push(body)
        used += body.length
      }

      if (info?.parentID) {
        push(digestFor(dir, registry) || preferences(), CAPS.digest)
        push(CHILD_POINTER, 300)
      } else {
        push(checkpointBlock(input.sessionID, dir, registry), CAPS.checkpoint)
        push(profileBlock(), CAPS.profile)
        push(digestFor(dir, registry) || preferences(), CAPS.digest)
        push(logBlock(), CAPS.log)
        push(inboxBlock(), CAPS.inbox)
      }

      for (const block of blocks) output.system.push(block)
    },
    "tool.execute.before": async (input) => {
      if (!input?.sessionID) return
      if (String(input.tool || "").startsWith("memory_") && !enabled(input.sessionID)) {
        throw new Error("La memoria está apagada en esta conversación. Activala con el interruptor «Memoria» del compositor.")
      }
    },
  }
}
