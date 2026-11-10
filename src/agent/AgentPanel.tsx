import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  compactSession,
  contextUsage,
  ensureSessionView,
  focusComposer,
  newSession,
  queuedUserIds,
  rememberPreviewTask,
  selectSession,
  sessionInProject,
  setSessionArchived,
  useAgent,
} from "../state/agent"
import { notify } from "../state/toasts"
import { bubbleDraft, bubbleOut } from "../state/bubbles"
import { permissionNeedsResponse, useApprovals } from "../state/approvals"
import { percent } from "../lib/format"
import { planIsCurrent } from "../lib/plan"
import { useLayout } from "../state/layout"
import { useProject } from "../state/project"
import { openEditor } from "../state/editors"
import { useResources } from "../state/resources"
import { Chat } from "./Chat"
import { Composer } from "./Composer"
import { SessionTabs } from "./SessionTabs"
import { ChangesBar, PermissionCard, QuestionCard, TodoList } from "./Interactions"
import { Icon, IconButton } from "../components/ui"
import { Logo } from "../components/Logo"
import { ageTone, shortAgo } from "../lib/time"
import { projectName } from "../lib/paths"
import { archivedSessionOwner, unarchivedSessions } from "../lib/sessions"
import { providerErrorMessage } from "../lib/autoretry"

import { newTeamChat, refreshTeams, selectTeamChat, useTeams } from "../state/teams"
import { call } from "../lib/tauri"
import { openMenuAt } from "../components/ContextMenu"
import { confirmAction } from "../components/Dialog"
import { TeamChat } from "./TeamChat"
import { groupTeamSessions } from "../team/session-index"
import { TeamSessionHistory } from "../team/TeamSessionHistory"
import { PreviewFloatingEditor } from "./PreviewHost"
import { PreviewLibrary } from "./PreviewLibrary"
import { previewIdentityFor, usePreviewTaskId } from "./preview-identity"
import { previewIdentityKey } from "../preview"

const SUGGESTIONS = [
  { icon: "telescope", title: "Entender el proyecto", text: "Explicame la arquitectura de este proyecto y dónde está cada cosa." },
  { icon: "bug", title: "Buscar y arreglar", text: "Corré el build y el linter, y arreglá los errores que encuentres." },
  { icon: "beaker", title: "Agregar tests", text: "Agregá tests para el módulo que tengo abierto y correlos." },
  { icon: "git-pull-request", title: "Revisar mis cambios", text: "/review" },
]

export function SessionPane({ sessionId, variant, onPreviewOpen, emptyState }: { sessionId: string | null; variant: "panel" | "editor"; onPreviewOpen?: () => void; emptyState?: ReactNode }) {
  const session = useAgent((s) => s.allSessions.find((x) => x.id === sessionId) ?? null)
  const status = useAgent((s) => (sessionId ? (s.statuses[sessionId]?.type ?? "idle") : "idle"))
  const retry = useAgent((s) => (sessionId ? s.statuses[sessionId] : undefined))
  const permissions = useAgent((s) => s.permissions)
  const questions = useAgent((s) => s.questions)
  const approvals = useApprovals()
  const allSessions = useAgent((s) => s.allSessions)
  const todos = useAgent((s) => (sessionId ? s.todos[sessionId] : undefined))
  const view = useAgent((s) => (sessionId ? s.views[sessionId] : undefined))
  const sessions = useMemo(() => allSessions.filter(sessionInProject), [allSessions])
  const root = useProject((s) => s.root)
  const busy = status === "busy" || status === "retry"
  const archived = archivedSessionOwner(session, sessions)
  const chats = useTeams(s => s.chats)
  const history = useMemo(() => groupTeamSessions(unarchivedSessions(sessions), chats, allSessions), [sessions, chats, allSessions])
  const recent = history.normal.filter(s => !s.parentID).slice(0, 6)
  const [leadBound, setLeadBound] = useState(false)
  const leadChat = useMemo(() => chats.find((chat) => chat.origin?.sessionId === sessionId), [chats, sessionId])
  const leadRun = leadChat?.runs.at(-1)
  const leadTasks = leadRun?.tasks.filter((task) => task.taskKind !== "group") ?? []
  const leadDone = leadTasks.filter((task) => task.status === "completed").length
  const leadStatus: Record<string, string> = {
    planning: "planificando", plan_ready: "plan listo", running: "en curso",
    paused: "pausado", blocked: "bloqueado", planning_blocked: "plan bloqueado",
    delivering: "revisando entrega", completed: "terminado", cancelled: "cancelado",
  }
  const resourcePressure = useResources((s) => s.status?.pressure ?? "normal")

  useEffect(() => {
    if (sessionId) void ensureSessionView(sessionId)
  }, [sessionId])

  useEffect(() => {
    setLeadBound(false)
    if (!sessionId) return
    let live = true
    void call<boolean>("teams_lead_bound", { session: sessionId })
      .then((bound) => { if (live) setLeadBound(bound) })
      .catch(() => undefined)
    return () => { live = false }
  }, [sessionId, chats])

  const unbindLead = async () => {
    if (!sessionId) return
    const ok = await confirmAction(
      "Desvincular el equipo",
      "La conversación vuelve a ser un chat normal. El equipo y su tablero quedan disponibles como equipo manual.",
      "Desvincular",
      true,
    )
    if (!ok) return
    try {
      await call("teams_lead_unbind", { session: sessionId })
      setLeadBound(false)
      await refreshTeams()
    } catch (e) {
      notify.error("No se pudo desvincular el equipo", e instanceof Error ? e.message : String(e))
    }
  }

  const mine = useMemo(() => {
    if (!sessionId) return { permissions: [], questions: [] }
    const children = new Set(sessions.filter((s) => s.parentID === sessionId).map((s) => s.id))
    return {
      permissions: permissions.filter((p) => p.sessionID === sessionId || children.has(p.sessionID)),
      questions: questions.filter((q) => q.sessionID === sessionId || children.has(q.sessionID)),
    }
  }, [permissions, questions, sessions, sessionId])

  const planCurrent = useMemo(() => {
    const messages = view?.messages ?? []
    return planIsCurrent(messages, queuedUserIds(messages, busy))
  }, [view, busy])
  const changes = useMemo(() => {
    const byFile = new Map<string, { additions: number; deletions: number }>()
    for (const m of view?.messages ?? []) {
      const diffs = (m.info as { summary?: { diffs?: Array<{ file?: string; additions: number; deletions: number }> } }).summary?.diffs
      if (m.info.role !== "user" || !diffs) continue
      for (const d of diffs) {
        if (!d.file) continue
        const prev = byFile.get(d.file) ?? { additions: 0, deletions: 0 }
        byFile.set(d.file, { additions: prev.additions + d.additions, deletions: prev.deletions + d.deletions })
      }
    }
    const fromMessages = { files: 0, additions: 0, deletions: 0 }
    for (const c of byFile.values()) {
      fromMessages.files += 1
      fromMessages.additions += c.additions
      fromMessages.deletions += c.deletions
    }
    const summary = session?.summary
    if (fromMessages.files === 0 && summary && summary.files > 0) return summary
    return fromMessages
  }, [view, session?.summary])

  const models = useAgent((s) => s.models)
  const usage = useMemo(() => (session ? contextUsage(view?.messages ?? [], models) : null), [session, view, models])

  return (
    <div className={`session-pane ${variant}`}>
      {session ? (
        <Chat session={session} busy={busy} />
      ) : emptyState ? (
        emptyState
      ) : (
        <div className="agent-welcome">
          <div className="agent-welcome-hero">
            <Logo size={48} className="agent-logo-svg" />
            <h2>¿Qué hacemos en {projectName(root)}?</h2>
            <p>El agente lee y edita el código con vos. Lo que cambie lo ves en el editor al instante y lo revisás hunk por hunk.</p>
          </div>
          <div className="agent-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.title} type="button" className="agent-suggestion" onClick={() => focusComposer(s.text)}>
                <Icon name={s.icon} />
                <span>
                  <strong>{s.title}</strong>
                  <em>{s.text}</em>
                </span>
              </button>
            ))}
          </div>
          {(recent.length > 0 || history.groups.length > 0) && (
            <div className="agent-recent">
              <div className="agent-recent-title">Sesiones recientes</div>
              {recent.map((s) => (
                <button key={s.id} type="button" className="agent-recent-item" aria-label={s.title || "Sin título"} onClick={() => selectSession(s.id)}>
                  <Icon name="comment-discussion" />
                  <span className="agent-recent-name">{s.title || "Sin título"}</span>
                  <span className={`agent-recent-time tone-${ageTone(s.time.updated)}`}>{shortAgo(s.time.updated)}</span>
                </button>
              ))}
              {history.groups.map(group => <TeamSessionHistory key={group.id} group={group}>
                {group.sessions.map(s => <button key={s.id} type="button" className="agent-recent-item" aria-label={s.title} onClick={() => selectSession(s.id)}>
                  <Icon name="hubot" /><span className="agent-recent-name">{s.title}</span>
                  <span className={`agent-recent-time tone-${ageTone(s.time.updated)}`}>{shortAgo(s.time.updated)}</span>
                </button>)}
              </TeamSessionHistory>)}
            </div>
          )}
        </div>
      )}
      <div className="session-dock">
        {leadBound && (
          <div className="context-banner lead-banner">
            <Icon name="organization" />
            <span>
              {leadRun
                ? `Equipo: ${leadStatus[leadRun.status] ?? leadRun.status} · ${leadDone}/${leadTasks.length} tareas`
                : "Lead de equipo activo. Pedile que implemente algo y vas a ver el tablero acá."}
              {leadChat?.origin?.error && <span className="team-error"> · El Lead no pudo responder: {leadChat.origin.error}</span>}
            </span>
            {leadChat && (
              <button type="button" className="btn btn-xs" onClick={() => selectTeamChat(leadChat.id)}>
                Ver tablero
              </button>
            )}
            <button type="button" className="btn btn-xs" onClick={() => void unbindLead()}>
              Desvincular
            </button>
          </div>
        )}
        {resourcePressure !== "normal" && (
          <div className={`context-banner lead-banner${resourcePressure === "critical" ? " danger" : ""}`}>
            <Icon name="pulse" />
            <span>
              {resourcePressure === "critical"
                ? "La PC está al límite: Flufy no lanzará agentes nuevos. Cerrá otros programas o esperá."
                : "La PC está cargada: Flufy está limitando la concurrencia del equipo."}
            </span>
            <button type="button" className="btn btn-xs" onClick={() => openEditor({ kind: "resources" })}>
              Ver recursos
            </button>
          </div>
        )}
        {retry?.type === "retry" && (
          <div className="retry-banner">
            <Icon name="sync" spin /> Reintentando ({retry.attempt}): {providerErrorMessage({ data: { message: retry.message } })}
          </div>
        )}
        {mine.questions.map((q) => (
          <QuestionCard key={q.id} request={q} />
        ))}
        {mine.permissions
          .filter((p) => permissionNeedsResponse(p, allSessions, approvals))
          .map((p) => (
            <PermissionCard key={p.id} request={p} />
          ))}
        {todos && todos.length > 0 && planCurrent && <TodoList key={`${sessionId}-${busy}`} todos={todos} live={busy} />}
        {session && changes.files > 0 && (
          <ChangesBar sessionId={session.id} files={changes.files} additions={changes.additions} deletions={changes.deletions} />
        )}
        {session && usage && usage.ratio >= 0.8 && !busy && (
          <div className={`context-banner${usage.ratio >= 0.95 ? " danger" : ""}`}>
            <Icon name="warning" />
            <span>
              El contexto está al {percent(usage.ratio)}. Compactar resume la conversación y libera espacio para seguir.
            </span>
            <button
              type="button"
              className="btn btn-xs"
              onClick={() =>
                void compactSession(session.id)
                  .then(() => notify.info("Compactando la sesión…"))
                  .catch((e) => notify.error("No se pudo compactar", e instanceof Error ? e.message : String(e)))
              }
            >
              Compactar
            </button>
          </div>
        )}
        {archived ? (
          <div className="session-archived-banner">
            <Icon name="archive" />
            <span>Conversación archivada. Restaurala para continuar.</span>
            <button type="button" className="btn btn-xs" onClick={() => void setSessionArchived(archived.id, false)}>Restaurar</button>
          </div>
        ) : (
          <Composer sessionId={sessionId} busy={busy} compact={variant === "panel"} usage={usage} onPreviewOpen={onPreviewOpen} />
        )}
      </div>
    </div>
  )
}

export function AgentPanel({ previewOpen = false, onPreviewOpen = () => {}, onPreviewClose = () => {} }: { previewOpen?: boolean; onPreviewOpen?: () => void; onPreviewClose?: () => void }) {
  const [libraryProject, setLibraryProject] = useState<string | null>(null)
  const [previewRequest, setPreviewRequest] = useState(0)
  const teamChatId = useTeams((s) => s.activeChatId)
  const activeId = useAgent((s) => s.activeSessionId)
  const connected = useAgent((s) => s.connected)
  const busyCount = useAgent((s) => Object.values(s.statuses).filter((x) => x.type === "busy").length)
  const focusChat = useLayout((s) => s.focusChat)
  const root = useProject((s) => s.root)
  const conversationId = teamChatId ? null : activeId
  const taskId = usePreviewTaskId(conversationId)
  const previewIdentity = taskId ? previewIdentityFor(root, conversationId, taskId) : null

  useEffect(() => {
    if (activeId) void ensureSessionView(activeId)
  }, [activeId])

  useEffect(() => {
    if (teamChatId && previewOpen) onPreviewClose()
  }, [teamChatId, previewOpen, onPreviewClose])

  return (
    <aside className="agent-panel">
      <div className="agent-tabbar">
        <SessionTabs />
        <div className="agent-tabbar-actions">
          {busyCount > 0 && (
            <span className="agent-busy-count" title="Sesiones trabajando">
              <Icon name="loading" spin /> {busyCount}
            </span>
          )}
          {!teamChatId && (activeId ? (
            <IconButton
              icon="multiple-windows"
              title="Sacar el chat como burbuja flotante"
              onClick={() => void bubbleOut(activeId)}
            />
          ) : (
            <IconButton
              icon="multiple-windows"
              title="Abrir una conversación nueva en una burbuja flotante"
              onClick={() => void bubbleDraft()}
            />
          ))}
          {root && <button type="button" className="btn btn-xs" title="Ver los diseños guardados del proyecto" onClick={() => setLibraryProject(root)}><Icon name="library" /> Diseños</button>}
          <IconButton icon="add" title="Nuevo chat (Ctrl+Alt+N)" onClick={(e) => openMenuAt(e.currentTarget, [
            { label: "Chat normal", icon: "comment-discussion", run: () => { useTeams.setState({ activeChatId: null }); newSession() } },
            { label: "Modo equipo", icon: "organization", run: () => void newTeamChat() },
          ])} />
          <IconButton
            icon={focusChat ? "screen-normal" : "screen-full"}
            title={focusChat ? "Salir del foco en el chat (Ctrl+Alt+M)" : "Foco en el chat (Ctrl+Alt+M)"}
            active={focusChat}
            onClick={() => useLayout.getState().toggleFocusChat()}
          />
          {!teamChatId && previewIdentity && (
            <IconButton
              icon="browser"
              title={previewOpen ? "Ocultar previsualización editable" : "Abrir previsualización editable"}
              active={previewOpen}
              onClick={() => (previewOpen ? onPreviewClose() : onPreviewOpen())}
            />
          )}
          <IconButton icon="close" title="Ocultar panel del agente (Ctrl+Alt+B)" onClick={() => useLayout.getState().toggleAgent(false)} />
        </div>
      </div>
      {!connected && (
        <div className="agent-offline">
          <Icon name="debug-disconnect" /> Conectando con Fluws…
        </div>
      )}
      <div className={`agent-body${previewOpen && previewIdentity ? " with-preview" : ""}`}>
        <div className="agent-chat-col">
          {teamChatId ? <TeamChat key={teamChatId} chatId={teamChatId} /> : <SessionPane sessionId={activeId} variant="panel" onPreviewOpen={onPreviewOpen} />}
        </div>
        {previewOpen && previewIdentity && (
          <PreviewFloatingEditor key={previewIdentityKey(previewIdentity)} identity={previewIdentity} onClose={onPreviewClose} onBrowseDesigns={() => setLibraryProject(root)} openRequest={previewRequest} />
        )}
      </div>
      {root && libraryProject === root && <PreviewLibrary key={root} projectRoot={root} onClose={() => setLibraryProject(null)} onOpen={design => {
        rememberPreviewTask(root, design.identity.sessionId, design.identity.taskId)
        selectSession(design.identity.sessionId)
        setLibraryProject(null)
        setPreviewRequest(value => value + 1)
        onPreviewOpen()
      }} />}
    </aside>
  )
}
