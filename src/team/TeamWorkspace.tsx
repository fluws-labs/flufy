import { useEffect, useState } from "react"
import { Icon } from "../components/ui"
import { TeamChat } from "../agent/TeamChat"
import { samePath } from "../lib/paths"
import { pendingRequests, useAgent } from "../state/agent"
import { useApprovals } from "../state/approvals"
import { useProject } from "../state/project"
import { useStudio } from "../state/studio"
import { teamAttention } from "./attention"
import { memberSession } from "./session-index"
import { newTeamChat, selectTeamChat, startTeams, teamCall, useTeams } from "../state/teams"
import { TeamsView } from "../views/TeamsView"
import { taskVerified } from "./board"
import { runStatusLabel, type TeamChatRecord } from "./types"
import { formatDateTime } from "../lib/time"
import "./workspace.css"

export function TeamWorkspace() {
  const root = useProject(s => s.root)
  const chats = useTeams(s => s.chats)
  const error = useTeams(s => s.error)
  const [openedId, setOpenedId] = useState<string | null>(null)
  const teamRequest = useStudio(s => s.teamRequest)
  useEffect(() => { if (teamRequest) setOpenedId(teamRequest.chatId) }, [teamRequest])
  const [creating, setCreating] = useState(false)
  const mine = chats.filter(chat => !chat.archived && samePath(chat.team.projectRoot, root ?? ""))
  const opened = chats.find(chat => chat.id === openedId && samePath(chat.team.projectRoot, root ?? ""))
  useEffect(() => startTeams(), [])
  useEffect(() => useTeams.subscribe((next, previous) => {
    if (next.activeChatId !== previous.activeChatId) setOpenedId(next.activeChatId)
  }), [])
  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      const previousId = useTeams.getState().activeChatId
      await newTeamChat()
      const id = useTeams.getState().activeChatId
      if (id && id !== previousId) setOpenedId(id)
    } finally { setCreating(false) }
  }
  if (opened) return <TeamSpace key={opened.id} chat={opened} onBack={() => setOpenedId(null)} onCreate={() => void create()} creating={creating} />
  return <main className="team-hub" aria-label="Mis equipos">
    <header className="team-hub-heading"><div><span className="team-workspace-eyebrow">TU ESPACIO DE TRABAJO</span><h1>Equipos</h1><p>Elegí un equipo para entrar a su tablero, agentes y evidencias.</p></div><button type="button" className="btn btn-primary" disabled={creating} onClick={() => void create()}><Icon name="add" /> {creating ? "Creando…" : "Nuevo equipo"}</button></header>
    {error && <p role="alert" className="team-error">{error}</p>}
    {mine.length ? <div className="team-hub-grid">{mine.slice().reverse().map(chat => {
      const run = chat.runs.at(-1)
      const team = run?.team ?? chat.team
      const verified = run?.tasks.filter(taskVerified).length ?? 0
      return <button type="button" className="team-hub-card" key={chat.id} onClick={() => { selectTeamChat(chat.id); setOpenedId(chat.id) }} aria-label={`Abrir equipo ${chat.title}`}>
        <span className="team-hub-icon"><Icon name="organization" /></span><span className="team-hub-card-status">{run ? runStatusLabel(run.status) : "Listo para tu objetivo"}</span>
        <strong>{chat.title}</strong><p>{run?.goal || "Un objetivo, un Lead y sus especialistas."}</p>
        <span className="team-hub-card-members">{team.members.slice(0, 4).map((member, index) => <span className={`studio-avatar tone-${index % 4}`} key={member.id} title={member.name}>{member.name.slice(0, 1)}</span>)}<small>{team.members.length} {team.members.length === 1 ? "agente" : "agentes"}{run && ` · ${verified}/${run.tasks.length} verificadas`}</small><Icon name="arrow-right" /></span>
      </button>
    })}</div> : <section className="studio-empty team-hub-empty"><Icon name="organization" /><h2>Un objetivo. Todo un equipo.</h2><p>Contale al Lead qué querés conseguir. Acá vas a encontrar cada equipo y su espacio de trabajo.</p><button type="button" className="btn btn-primary" disabled={creating} onClick={() => void create()}>Crear mi primer equipo</button></section>}
    <details className="team-hub-manage"><summary>Plantillas e historial archivado</summary><TeamsView /></details>
  </main>
}

function TeamSpace({ chat, onBack, onCreate, creating }: { chat: TeamChatRecord; onBack: () => void; onCreate: () => void; creating: boolean }) {
  const [view, setView] = useState("Tablero")
  const [agentSession, setAgentSession] = useState<{ sessionId: string; memberId: string } | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const layout = useStudio(s => s.layouts.team)
  const setLayout = useStudio(s => s.setLayout)
  const run = chat.runs.at(-1)
  const team = run?.team ?? chat.team
  const lead = team.members.find(member => member.id === team.leadAgentId)
  const verified = run?.tasks.filter(taskVerified).length ?? 0
  const running = run?.tasks.filter(task => task.status === "running").length ?? 0
  const pending = run?.tasks.filter(task => ["pending", "blocked", "waiting_dependency", "interrupted"].includes(task.status)).length ?? 0
  const captures = run?.observations?.filter(item => item.status === "captured") ?? []
  const latestCapture = captures.at(-1)
  const permissions = useAgent(s => s.permissions)
  const questions = useAgent(s => s.questions)
  const allSessions = useAgent(s => s.allSessions)
  const approvals = useApprovals()
  const requests = pendingRequests({ permissions, questions, allSessions }, approvals)
  const alertCount = teamAttention(chat, run, [
    ...requests.permissions.map(request => ({ sessionID: request.sessionID, kind: "permission" as const, detail: request.permission })),
    ...requests.questions.map(request => ({ sessionID: request.sessionID, kind: "question" as const, detail: request.questions[0]?.question })),
  ]).filter(item => item.kind !== "waiting").length
  const nav = [["Tablero", "layout", "Tablero"], ["Alertas", "bell", "Alertas"], ["Plan", "list-tree", "Plan detallado"], ["Agentes", "organization", "Agentes"], ["Navegador", "browser", "Navegador interno"], ["Chat", "comment-discussion", "Chat del equipo"], ["Entrega", "verified", "Entrega y evidencias"]]
  const startPlan = async () => {
    if (!run || actionPending) return
    setActionPending(true)
    try { await teamCall("team_runs_control", { action: "start_plan", runId: run.id }) }
    finally { setActionPending(false) }
  }
  return <div className={`studio-columns studio-team team-space${layout.sidebarCollapsed ? " sidebar-collapsed" : ""}${layout.chatExpanded ? " chat-expanded" : ""}`} aria-label={`Espacio de ${chat.title}`}>
    <aside className="studio-sidebar" aria-label="Equipo y agentes">
      <button type="button" className="team-space-back" onClick={onBack}><Icon name="arrow-left" /> Todos los equipos</button>
      <section className="studio-side-section"><div className="studio-side-head"><h3>Tablero</h3><button type="button" className="studio-collapse" title="Ocultar lateral" aria-label="Ocultar lateral" onClick={() => setLayout("team", { sidebarCollapsed: true })}><Icon name="chevron-left" /></button></div><nav aria-label="Navegación del equipo">{nav.map(([id, icon, label]) => <button type="button" className={`studio-nav-item${view === id ? " active" : ""}`} aria-current={view === id ? "page" : undefined} key={id} onClick={() => { setAgentSession(null); setView(id) }}><Icon name={icon} /> {label}{id === "Alertas" && alertCount > 0 && <span className="team-nav-badge">{alertCount}</span>}</button>)}</nav></section>
      <section className="studio-side-section"><h3>Agentes <span>{team.members.length}</span></h3><div className="studio-roster">{team.members.map((member, index) => {
        const active = run?.tasks.some(task => task.assignedAgentId === member.id && task.status === "running")
        const session = memberSession(chat, member.id)
        return <button type="button" key={member.id} title={session ? `Ver conversación de ${member.name}` : `Ver agentes · ${member.name}`} onClick={() => { if (session) setAgentSession({ sessionId: session.id, memberId: member.id }); setView("Agentes") }}><span className={`studio-avatar tone-${index % 4}`}>{member.name.slice(0, 1)}</span><span><strong>{member.name}</strong><small>{member.role}</small></span><span className={`studio-member-dot${active ? " is-active" : ""}`} title={active ? "Trabajando" : "Sin tarea en curso"} /></button>
      })}</div></section>
      <section className="studio-side-section"><h3>Sesión</h3><div className="studio-summary-card"><strong>{run ? runStatusLabel(run.status) : "Esperando tu objetivo"}</strong><p>{team.members.length} agentes · {run?.tasks.length ?? 0} tareas</p>{run && <p>Iniciada {formatDateTime(run.startedAt)}</p>}</div></section>
      <div className="team-space-sidebar-bottom"><button type="button" className="studio-text-button" onClick={() => setView("Configuración")}><Icon name="settings-gear" /> Configuración</button><button type="button" className="btn" disabled={creating} onClick={onCreate}>+ Nuevo tablero</button></div>
    </aside>
    <main className="studio-content"><header className="studio-page-heading"><div><h1>{({ Tablero: "Tablero del equipo", Alertas: "Alertas", Plan: "Plan detallado", Agentes: "Agentes del equipo", Navegador: "Navegador interno", Chat: "Chat del equipo", Entrega: "Entrega y evidencias", Ahora: "Actividad del equipo", Configuración: "Configuración del equipo" } as Record<string, string>)[view] ?? view}</h1><p>{view === "Alertas" ? "Lo que necesita tu atención, en texto claro." : "El Lead reparte el trabajo y revisa las evidencias."}</p></div><div className="studio-heading-actions">{layout.sidebarCollapsed && <button type="button" className="studio-collapse" title="Mostrar lateral" aria-label="Mostrar lateral" onClick={() => setLayout("team", { sidebarCollapsed: false })}><Icon name="chevron-right" /></button>}<button type="button" className={`studio-chat-expand${layout.chatExpanded ? " is-expanded" : ""}`} aria-pressed={layout.chatExpanded} title={layout.chatExpanded ? "Restaurar el chat" : "Ampliar el chat"} onClick={() => setLayout("team", { chatExpanded: !layout.chatExpanded })}><Icon name={layout.chatExpanded ? "screen-normal" : "screen-full"} /><span>{layout.chatExpanded ? "Restaurar" : "Ampliar chat"}</span></button><button type="button" className="team-space-mobile-back" onClick={onBack}><Icon name="arrow-left" /> Equipos</button></div></header>
      <div className="team-sprint"><div><strong>{chat.title}</strong><small>{run ? `${verified} de ${run.tasks.length} tareas verificadas` : "Listo para recibir tu objetivo"}</small></div><progress className="studio-progress team-progress" max={Math.max(run?.tasks.length ?? 0, 1)} value={verified} /><div><strong>{lead?.name ?? "Lead"}</strong><small>{run ? runStatusLabel(run.status) : "Coordinación del equipo"}</small></div><span className={`studio-member-dot${running ? " is-active" : ""}`} /></div>
      <TeamChat chatId={chat.id} workspace currentView={view} onViewChange={setView} agentSession={agentSession} onAgentSession={setAgentSession} />
    </main>
    <aside className="studio-inspector" aria-label="Plan y evidencias">
      <section className="studio-side-section"><h3>Plan detallado <span>{run?.tasks.length ?? 0} pasos</span></h3>{run?.tasks.length ? <ol className="studio-plan">{run.tasks.slice(0, 6).map(task => <li key={task.id} className={taskVerified(task) ? "done" : ""}><Icon name={taskVerified(task) ? "check" : task.status === "running" ? "circle-filled" : "circle-outline"} /><button type="button" onClick={() => setView("Plan")}><strong>{task.title}</strong><small>{team.members.find(member => member.id === task.assignedAgentId)?.name ?? "Sin asignar"}</small></button></li>)}</ol> : <p className="studio-muted">El Lead prepara el plan a partir de tu objetivo.</p>}{!!run && run.tasks.length > 6 && <button type="button" className="studio-text-button" onClick={() => setView("Plan")}>Ver los {run.tasks.length} pasos</button>}</section>
      <section className="studio-side-section"><h3>Navegador interno</h3><button type="button" className="team-browser-preview" onClick={() => setView("Navegador")}><span className="team-browser-preview-dots"><i /><i /><i /><small>{latestCapture ? "Última observación capturada" : "Navegador del equipo"}</small></span><Icon name="browser" /><strong>{latestCapture?.details.title || "Abrir navegador"}</strong><small>{latestCapture ? `${latestCapture.details.width ?? "—"} × ${latestCapture.details.height ?? "—"} · Ver página actual` : "Las páginas del equipo aparecen acá"}</small></button></section>
      <section className="studio-side-section"><h3>Evidencias <span>{captures.length} capturas</span></h3>{captures.length ? captures.slice(-3).map(capture => <button type="button" className="studio-evidence" key={capture.id} onClick={() => setView("Entrega")}><Icon name="file-media" /><span><strong>{capture.details.title || capture.targetId}</strong><small>{capture.details.width} × {capture.details.height}</small></span><Icon name="check" /></button>) : <p className="studio-muted">Las capturas reales aparecerán durante el trabajo.</p>}</section>
      <section className="studio-side-section"><h3>Estado</h3><div className="studio-summary-card team-space-status"><p><i className="status-running" /> {running} en curso</p><p><i className="status-pending" /> {pending} pendientes</p><p><i className="status-verified" /> {verified} verificadas</p></div></section>
      <div className="studio-bottom-action"><p className="studio-muted">El Lead revisa las evidencias antes de entregar.</p><div>{run?.status === "plan_ready" && <button type="button" className="btn btn-primary" disabled={actionPending} onClick={() => void startPlan()}>{actionPending ? "Iniciando…" : "Aprobar e iniciar plan"}</button>}<button type="button" className={`btn${run?.status === "plan_ready" ? "" : " btn-primary"}`} onClick={() => setView(view === "Chat" ? "Tablero" : "Chat")}>{view === "Chat" ? "Ver tablero" : "Ver chat del equipo"}</button></div></div>
    </aside>
  </div>
}
