import { useCallback, useMemo, useState } from "react"
import type { Session } from "@opencode-ai/sdk"
import { deleteSession, newSession, renameSession, selectSession, sessionInProject, sessionInRoot, setSessionArchived, useAgent } from "../state/agent"
import { sessionMark, useSessionMark, useUnseen } from "../state/unseen"
import { useProject } from "../state/project"
import { archivedSessionIds, archivedSessionOwner } from "../lib/sessions"
import { openEditor } from "../state/editors"
import { useLayout } from "../state/layout"
import { promptInput } from "../state/quickinput"
import { ageTone, shortAgo } from "../lib/time"
import { openContextMenu } from "../components/ContextMenu"
import { confirmAction } from "../components/Dialog"
import { EmptyState, Icon, IconButton } from "../components/ui"
import { useTeams } from "../state/teams"
import { useApprovals } from "../state/approvals"
import { teamChatActive } from "../team/chat-active"
import { groupTeamSessions } from "../team/session-index"
import { TeamSessionHistory } from "../team/TeamSessionHistory"

function SessionRow({ session, depth, childCount, lead, showDirectory = false }: { session: Session; depth: number; childCount: number; lead?: string; showDirectory?: boolean }) {
  const active = useAgent((s) => s.activeSessionId === session.id)
  const mark = useSessionMark(session.id)
  const teamBusy = useTeams((s) => s.chats.some((chat) => chat.origin?.sessionId === session.id && chat.runs.some((run) => run.finishedAt == null && ["planning", "running", "delivering", "cancelling"].includes(run.status))))
  const displayMark = mark === "attention" ? "attention" : teamBusy ? "busy" : mark
  const flash = useAgent((s) => !!s.doneFlash[session.id])
  const sessions = useAgent((s) => s.allSessions)
  const archived = archivedSessionOwner(session, sessions)
  const [saving, setSaving] = useState(false)
  const summary = session.summary

  const toggleArchive = async () => {
    setSaving(true)
    await setSessionArchived(archived?.id ?? session.id, !archived)
    setSaving(false)
  }

  const open = () => {
    useLayout.getState().toggleAgent(true)
    useTeams.setState({ activeChatId: null })
    selectSession(session.id)
  }

  const menu = (e: React.MouseEvent) =>
    openContextMenu(e, [
      { label: "Abrir en el panel", icon: "comment-discussion", run: open },
      { label: "Abrir en una pestaña", icon: "go-to-file", run: () => openEditor({ kind: "chat", sessionId: session.id }) },
      { label: "Revisar cambios", icon: "diff-multiple", run: () => openEditor({ kind: "review", sessionId: session.id }) },
      {
        label: "Renombrar…",
        icon: "edit",
        run: async () => {
          const title = await promptInput({ title: "Renombrar sesión", value: session.title })
          if (title?.trim()) await renameSession(session.id, title.trim())
        },
      },
      {
        label: archived ? "Restaurar conversación" : "Archivar conversación",
        icon: archived ? "discard" : "archive",
        disabled: saving,
        run: () => void toggleArchive(),
      },
      { separator: true },
      {
        label: "Eliminar",
        icon: "trash",
        danger: true,
        run: async () => {
          if (await confirmAction("Eliminar sesión", `"${session.title}" se borra con su historial.`, "Eliminar", true)) await deleteSession(session.id)
        },
      },
    ])

  return (
    <div
      className={`session-row state-${displayMark}${active ? " active" : ""}${displayMark === "busy" || displayMark === "retry" ? " busy" : ""}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      onClick={open}
      onDoubleClick={() => openEditor({ kind: "chat", sessionId: session.id })}
      onContextMenu={menu}
      title={session.title}
    >
      <span className="session-state">
        {displayMark === "attention" ? (
          <Icon name="bell-dot" className="attention" />
        ) : displayMark === "busy" ? (
          <Icon name="loading" spin />
        ) : displayMark === "retry" ? (
          <Icon name="warning" />
        ) : displayMark === "unseen" || flash ? (
          <Icon name="pass-filled" className="done" />
        ) : (
          <Icon name={archived ? "archive" : depth > 0 ? "hubot" : "comment-discussion"} />
        )}
      </span>
      <span className="session-main">
        <span className="session-title">{session.title || "Sin título"}</span>
        {showDirectory && <span className="session-meta" title={session.directory}>{session.directory}</span>}
        <span className="session-meta">
          {summary && summary.files > 0 && (
            <span className="session-diff">
              <span className="add">+{summary.additions}</span>
              <span className="del">−{summary.deletions}</span>
            </span>
          )}
          {displayMark === "attention" && <span className="session-flag attention">espera tu respuesta</span>}
          {teamBusy && mark !== "attention" && <span className="session-flag busy">equipo trabajando</span>}
          {displayMark === "unseen" && <span className="session-flag done">terminó</span>}
          {lead && <span className="session-children" title="Esta conversaci�n es el Lead del equipo">Lead de equipo</span>}
          {childCount > 0 && <span className="session-children">{childCount} subagentes</span>}
          <span className={`session-time tone-${ageTone(session.time.updated)}`}>{shortAgo(session.time.updated)}</span>
        </span>
      </span>
      <IconButton
        icon={archived ? "discard" : "archive"}
        title={archived ? "Restaurar conversación" : "Archivar conversación"}
        className="session-archive-action"
        disabled={saving}
        onClick={(e) => {
          e.stopPropagation()
          void toggleArchive()
        }}
      />
    </div>
  )
}

export function AgentsView() {
  const allSessions = useAgent((s) => s.allSessions)
  const sessions = useMemo(() => allSessions.filter(sessionInProject), [allSessions])
  const root = useProject((s) => s.root)
  const chats = useTeams(s => s.chats)
  const leadSessions = useMemo(() => new Map(chats
    .filter((chat) => chat.origin && chat.runs.some((run) => run.planV2?.conversationLead))
    .map((chat) => [chat.origin!.sessionId, chat])), [chats])
  const loaded = useAgent((s) => s.sessionsLoaded)
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<"active" | "all" | "archived">("active")
  const archived = useMemo(() => archivedSessionIds(sessions), [sessions])
  const statuses = useAgent((s) => s.statuses)
  const permissions = useAgent((s) => s.permissions)
  const questions = useAgent((s) => s.questions)
  const unseen = useUnseen((s) => s.ids)
  const approvals = useApprovals()
  const teamActive = useMemo(() => new Set(chats.filter(teamChatActive).map((chat) => chat.id)), [chats])
  const activeSessions = useMemo(() => {
    const source = { allSessions, permissions, questions, statuses }
    const ids = new Set<string>()
    for (const session of sessions) {
      if (archived.has(session.id)) continue
      const mark = sessionMark(source, unseen, session.id, approvals)
      if (mark === "attention" || mark === "busy" || mark === "retry") ids.add(session.id)
    }
    return ids
  }, [sessions, archived, allSessions, permissions, questions, statuses, unseen, approvals])
  const rowsFor = useCallback((mode: "active" | "all" | "archived") => {
    const grouped = groupTeamSessions(sessions.filter((s) => archived.has(s.id) === (mode === "archived")), chats, allSessions)
    if (mode !== "active") return { visible: grouped.normal, groups: grouped.groups }
    const working = new Set(teamActive)
    for (const chat of chats) if (chat.origin?.sessionId && activeSessions.has(chat.origin.sessionId)) working.add(chat.id)
    const groups = grouped.groups.filter(g => working.has(g.id) || g.sessions.some(s => activeSessions.has(s.id)))
    const present = new Set(groups.map(g => g.id))
    const origins = new Set(chats.filter(c => c.origin?.sessionId && present.has(c.id)).map(c => c.origin!.sessionId))
    const visible = grouped.normal.filter(s => activeSessions.has(s.id) && !origins.has(s.id))
    return { visible, groups }
  }, [sessions, archived, chats, allSessions, activeSessions, teamActive])
  const counts = useMemo(() => {
    const count = (mode: "active" | "all" | "archived") => {
      const { visible, groups } = rowsFor(mode)
      const ids = new Set(visible.map(s => s.id))
      return groups.length + visible.filter(s => !s.parentID || !ids.has(s.parentID)).length
    }
    return { active: count("active"), all: count("all"), archived: count("archived") }
  }, [rowsFor])

  const tree = useMemo(() => {
    const { visible, groups } = rowsFor(view)
    const ids = new Set(visible.map((s) => s.id))
    const children = new Map<string, Session[]>()
    for (const s of visible) {
      if (!s.parentID) continue
      const list = children.get(s.parentID) ?? []
      list.push(s)
      children.set(s.parentID, list)
    }
    const q = query.trim().toLowerCase()
    const roots = visible.filter((s) => (!s.parentID || !ids.has(s.parentID)) && (!q || (s.title ?? "").toLowerCase().includes(q)))
    const filtered = groups.filter(g => !q || g.title.toLowerCase().includes(q) || g.sessions.some(s => s.title.toLowerCase().includes(q)))
    return { roots, children, groups: filtered }
  }, [rowsFor, view, query])

  return (
    <div className="view agents-view">
      <div className="view-header">
        <span className="view-title">Sesiones del agente</span>
        <span className="view-actions">
          <IconButton icon="checklist" title="Trabajos" onClick={() => useLayout.getState().showView("teams", false)} />
          <IconButton
            icon="add"
            title="Nueva sesión"
            onClick={() => {
              useLayout.getState().toggleAgent(true)
              newSession()
            }}
          />
        </span>
      </div>
      <div className="segmented session-filters" role="group" aria-label="Estado de las conversaciones">
        <button type="button" className={view === "active" ? "active" : ""} aria-pressed={view === "active"} onClick={() => setView("active")}>
          Activas ({counts.active})
        </button>
        <button type="button" className={view === "all" ? "active" : ""} aria-pressed={view === "all"} onClick={() => setView("all")}>
          Todas ({counts.all})
        </button>
        <button type="button" className={view === "archived" ? "active" : ""} aria-pressed={view === "archived"} onClick={() => setView("archived")}>
          Archivadas ({counts.archived})
        </button>
      </div>
      <div className="view-filter">
        <Icon name="search" />
        <input placeholder="Filtrar sesiones" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="session-list">
        {loaded && tree.roots.length === 0 && tree.groups.length === 0 && (
          <EmptyState icon={view === "archived" ? "archive" : view === "active" ? "pulse" : "comment-discussion"} title={query ? "Sin resultados" : view === "active" ? "No hay conversaciones activas" : view === "archived" ? "No hay conversaciones archivadas" : "Todavía no hay sesiones"}>
            {!query && (view === "active" ? "Las que están trabajando o esperan tu respuesta aparecen acá. Las demás están en «Todas»." : view === "archived" ? "Archivá una conversación para guardarla acá con todo su historial." : "Escribile al agente en el panel de la derecha.")}
          </EmptyState>
        )}
        {tree.roots.map((s) => {
          const kids = tree.children.get(s.id) ?? []
          return (
            <div key={s.id}>
              <div className="session-row-wrap">
                {kids.length > 0 && (
                  <button type="button" className="session-expand" onClick={() => setExpanded((e) => ({ ...e, [s.id]: !e[s.id] }))}>
                    <Icon name={expanded[s.id] ? "chevron-down" : "chevron-right"} />
                  </button>
                )}
                <SessionRow session={s} depth={0} childCount={kids.length} lead={leadSessions.get(s.id)?.title} showDirectory={!sessionInRoot(s, root)} />
              </div>
              {expanded[s.id] && kids.map((k) => <SessionRow key={k.id} session={k} depth={1} childCount={0} showDirectory={!sessionInRoot(k, root)} />)}
            </div>
          )
        })}
        {tree.groups.map(group => <TeamSessionHistory key={group.id} group={group}>
          {group.sessions.map(s => <SessionRow key={s.id} session={s} depth={1} childCount={0} showDirectory={!sessionInRoot(s, root)} />)}
        </TeamSessionHistory>)}
      </div>
    </div>
  )
}
