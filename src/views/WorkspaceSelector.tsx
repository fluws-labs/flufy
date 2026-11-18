import { useEffect, useState } from "react"
import { loadJson, saveJson } from "../lib/persist"
import { sessionInRoot, useAgent } from "../state/agent"
import { useTerminals } from "../state/terminals"
import {
  cleanupWorkspaces,
  isAppRunning,
  openFeatureCreate,
  prepareWorkspace,
  removeWorkspace,
  runApp,
  selectWorkspace,
  stopApp,
  useFeatures,
  workspaceTitle,
} from "../state/features"
import { openMenuAt, type MenuItem } from "../components/ContextMenu"
import { Icon, IconButton, Section, Spinner } from "../components/ui"
import type { Workspace } from "../lib/features"

const OPEN_KEY = "scm.workspacesOpen"

export function showWorkspaceList(): void {
  saveJson(OPEN_KEY, true)
  window.dispatchEvent(new Event("flufy:workspaces"))
}

function useWorkspaceActivity(ws: Workspace): { busy: number; waiting: number } {
  const sessions = useAgent((s) => s.allSessions)
  const statuses = useAgent((s) => s.statuses)
  const permissions = useAgent((s) => s.permissions)
  const questions = useAgent((s) => s.questions)
  const roots = ws.repos.map((r) => r.root)
  const mine = sessions.filter((x) => roots.some((root) => sessionInRoot(x, root)))
  const ids = new Set(mine.map((x) => x.id))
  return {
    busy: mine.filter((x) => statuses[x.id] && statuses[x.id].type !== "idle").length,
    waiting: permissions.filter((p) => ids.has(p.sessionID)).length + questions.filter((q) => ids.has(q.sessionID)).length,
  }
}

function changesOf(ws: Workspace): number {
  return ws.repos.reduce((n, r) => n + (r.changes ? r.changes.staged + r.changes.unstaged + r.changes.untracked + r.changes.conflicts : 0), 0)
}

function WorkspaceRow({ ws, active }: { ws: Workspace; active: boolean }) {
  const activity = useWorkspaceActivity(ws)
  const changes = changesOf(ws)
  const prepare = useFeatures((s) => s.prepare[ws.id])
  const runId = useFeatures((s) => s.runTerminalId)
  const runWorkspaceId = useFeatures((s) => s.runWorkspaceId)
  const terminals = useTerminals((s) => s.terminals)
  const running = ws.id === runWorkspaceId && isAppRunning(runId, terminals)
  const feature = ws.kind === "feature"
  const missing = ws.repos.every((r) => r.missing)
  const branches = Array.from(new Set(ws.repos.map((r) => r.branch).filter((b): b is string => !!b)))
  const bases = Array.from(new Set(ws.repos.map((r) => r.base).filter((b): b is string => !!b)))
  const baseNote = bases.length === 1 ? bases[0] : bases.length > 1 ? "por repo" : null
  const baseTitle = ws.repos.map((r) => `${r.name}: ${r.base ?? "sin base"}`).join("\n")
  const ahead = ws.repos.reduce((total, r) => total + (r.ahead ?? 0), 0)
  const behind = ws.repos.reduce((total, r) => total + (r.behind ?? 0), 0)
  const pathNote = ws.repos.length === 1 ? `${ws.repos[0].name} · ${ws.repos[0].path}` : `${ws.repos.length} repos · ${ws.repos.map((r) => r.name).join(", ")}`
  const menu = (): MenuItem[] => {
    const items: MenuItem[] = []
    if (!active) {
      items.push({ label: "Usar este espacio", icon: "check", run: () => void selectWorkspace(ws.id) })
      if (!missing) items.push({ label: "Correr la app acá", icon: "play", run: async () => { await selectWorkspace(ws.id); await runApp() } })
    }
    items.push({ label: "Preparar el entorno", icon: "tools", disabled: missing, run: () => void prepareWorkspace(ws) })
    if (running) items.push({ label: "Detener la app", icon: "debug-stop", run: () => void stopApp() })
    else if (active) items.push({ label: "Correr la app", icon: "play", run: () => void runApp() })

    if (feature) {
      items.push({ separator: true })
      items.push({ label: "Eliminar el trabajo…", icon: "trash", danger: true, run: () => void removeWorkspace(ws) })
    }
    return items
  }
  return (
    <div
      className={`feature-row${active ? " active" : ""}${ws.archived ? " archived" : ""}`}
      onClick={() => {
        if (!active) void selectWorkspace(ws.id)
      }}
      onContextMenu={(e) => openMenuAt(e.currentTarget, menu())}
      title={`${ws.kind === "main" ? "Copia principal del proyecto" : "Trabajo separado"}\n${ws.repos.map((r) => `${r.name}: ${r.path}`).join("\n")}`}
    >
      <span className="feature-chevron" />
      <Icon name={ws.kind === "main" ? "home" : "worktree"} className="feature-icon" />
      <div className="feature-text">
        <div className="feature-name">
          <span>{workspaceTitle(ws)}</span>
          {feature && <span className="feature-badge">trabajo</span>}
          {active && <span className="feature-badge active">activo</span>}
        </div>
        <div className="feature-sub">
          <Icon name="git-branch" />
          <span className="mono">{branches.length ? branches.join(", ") : "HEAD"}</span>
          {baseNote && <span className="feature-base-tag" title={baseTitle}>← {baseNote}</span>}
          {(ahead > 0 || behind > 0) && <span className="feature-sync">{ahead > 0 ? `↑${ahead}` : ""}{behind > 0 ? ` ↓${behind}` : ""}</span>}
        </div>
        <div className="feature-sub feature-where" title={ws.repos.map((r) => `${r.name}: ${r.path}`).join("\n")}>
          <Icon name="folder" />
          <span className="mono">{missing ? "carpeta no encontrada" : pathNote}</span>
          {prepare?.status === "preparing" && (
            <span className="feature-badge">
              <Spinner size={10} /> preparando
            </span>
          )}
          {prepare?.status === "ready" && <span className="feature-badge">entorno listo</span>}
          {prepare?.status === "error" && <span className="feature-badge conflict">error al preparar</span>}
        </div>
      </div>
      <span className="feature-indicators">
        {activity.waiting > 0 && (
          <span className="feature-pill attention" title="Un agente espera tu respuesta">
            <Icon name="bell-dot" /> {activity.waiting}
          </span>
        )}
        {activity.busy > 0 && (
          <span className="feature-pill busy" title="Agentes trabajando">
            <Spinner size={10} /> {activity.busy}
          </span>
        )}
        {running && (
          <span className="feature-pill running" title="La app está corriendo">
            <Icon name="play" />
          </span>
        )}
        {changes > 0 && (
          <span className="feature-pill" title="Archivos con cambios sin commitear">
            {changes}
          </span>
        )}
      </span>
      <span className="feature-actions" onClick={(e) => e.stopPropagation()}>
        {running ? (
          <IconButton icon="debug-stop" title="Detener la app" onClick={() => void stopApp()} />
        ) : active ? (
          <IconButton icon="play" title="Correr la app" onClick={() => void runApp()} />
        ) : (
          <IconButton icon="check" title="Usar este espacio" onClick={() => void selectWorkspace(ws.id)} />
        )}
        <IconButton icon="tools" title="Preparar el entorno de este trabajo" disabled={missing} onClick={() => void prepareWorkspace(ws)} />
        <IconButton icon="ellipsis" title="Más acciones" onClick={(e) => openMenuAt(e.currentTarget, menu())} />
      </span>
    </div>
  )
}

export function WorkspaceSelector() {
  const list = useFeatures((s) => s.list)
  const active = useFeatures((s) => s.activeWorkspace)
  const [open, setOpen] = useState(() => loadJson(OPEN_KEY, true))
  useEffect(() => {
    const show = () => {
      setOpen(true)
      window.setTimeout(() => document.querySelector(".scm-view .feature-list")?.scrollIntoView({ block: "nearest" }), 0)
    }
    window.addEventListener("flufy:workspaces", show)
    return () => window.removeEventListener("flufy:workspaces", show)
  }, [])
  if (!list?.git) return null
  const workspaces = list.workspaces ?? []
  const features = workspaces.filter((w) => w.kind !== "main")
  const mains = workspaces.filter((w) => w.kind === "main")
  const toggle = () => {
    setOpen(!open)
    saveJson(OPEN_KEY, !open)
  }
  return (
    <Section
      title="Espacios de trabajo"
      count={features.length || undefined}
      open={open}
      onToggle={toggle}
      actions={<>
        <IconButton icon="add" title="Pedirle al agente un trabajo nuevo" onClick={() => void openFeatureCreate()} />
        <IconButton icon="trash" title="Limpiar trabajos sin cambios ni commits propios" onClick={() => void cleanupWorkspaces()} />
      </>}
    >
      <div className="feature-list">
        {mains.map((w) => (
          <WorkspaceRow key={w.id} ws={w} active={w.id === active} />
        ))}
        {features.map((w) => (
          <WorkspaceRow key={w.id} ws={w} active={w.id === active} />
        ))}
        {features.length === 0 && (
          <button type="button" className="feature-empty" onClick={() => void openFeatureCreate()}>
            <Icon name="git-branch-create" />
            <span>
              <strong>Pedile al agente un trabajo separado</strong>
              <span>El agente crea un worktree por repositorio y lo prepara. Acá cambiás entre Principal y cada trabajo.</span>
            </span>
          </button>
        )}
      </div>
    </Section>
  )
}
