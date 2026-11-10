import { useEffect, useMemo, useRef, useState } from "react"
import { teamCall, useTeams } from "../state/teams"
import { openFallbackModels } from "../state/fallback"
import { ensureSessionView, insertComposerText, pendingRequests, selectSession, useAgent } from "../state/agent"
import { useResources } from "../state/resources"
import { Chat } from "./Chat"
import { Composer } from "./Composer"
import { PermissionCard, QuestionCard } from "./Interactions"
import { permissionNeedsResponse, useApprovals } from "../state/approvals"
import { modelKey, rememberSessionDirectory } from "../lib/opencode"
import { openEditor } from "../state/editors"
import { confirmAction } from "../components/Dialog"
import { Icon } from "../components/ui"
import { Markdown } from "./Markdown"
import { chatFallback, runStatusLabel, runActive } from "../team/types"
import { formatDateTime } from "../lib/time"
import { isAccountLimitError, readableTeamError } from "../lib/provider-error"
import { runProblem } from "../team/problem"
import { ChatImages } from "../team/ChatImages"
import { TeamComposer, type TeamComposerHandle } from "../team/TeamComposer"
import { TeamSettings } from "../team/TeamSettings"
import { attentionLabel, teamAttention, type TeamAttention } from "../team/attention"
import { leadRecovery, memberState } from "../team/member-state"
import { TeamProblems } from "../team/TeamProblems"
import { TeamBrowser } from "../team/TeamBrowser"
import { memberSession } from "../team/session-index"
import { TeamFolderConflicts } from "../team/TeamFolderConflicts"
import { TeamBoard } from "../team/TeamBoard"
import { LeadMessage } from "../team/LeadMessage"
import { projectBoard, taskVerified } from "../team/board"
import { TeamActivity } from "../team/TeamActivity"
import { GoalAnalysis, SupportReports } from "../team/SupportReports"
import { DeliveryResults } from "../team/DeliveryResults"
import { GoalMessage } from "../team/GoalMessage"
import { RunBudget } from "../team/RunBudget"

function openSession(id: string, directory: string) {
  rememberSessionDirectory(id, directory)
  openEditor({ kind: "chat", sessionId: id })
}

export function TeamChat({ chatId, initialView = "Chat", workspace = false, currentView, onViewChange, agentSession, onAgentSession }: { chatId: string; initialView?: string; workspace?: boolean; currentView?: string; onViewChange?: (view: string) => void; agentSession?: { sessionId: string; memberId: string } | null; onAgentSession?: (value: { sessionId: string; memberId: string } | null) => void }) {
  const chat = useTeams((s) => s.chats.find((c) => c.id === chatId))
  const models = useAgent((s) => s.models)
  const permissions = useAgent(s => s.permissions)
  const questions = useAgent(s => s.questions)
  const allSessions = useAgent(s => s.allSessions)
  const approvals = useApprovals()
  const [viewChoice, setViewChoice] = useState<{ runId?: string; view: string | null } | null>(null)
  const viewRun = chat?.runs.at(-1)
  const conversationLead = !!viewRun?.planV2?.conversationLead
  const resourcePressure = useResources(s => s.status?.pressure ?? "normal")
  const view = currentView ?? (viewChoice?.runId === viewRun?.id ? viewChoice?.view : null) ?? initialView
  const setView = (view: string | null) => { setViewChoice({ runId: viewRun?.id, view }); onViewChange?.(view ?? initialView) }
  const [expanded, setExpanded] = useState(false)
  const [browser, setBrowser] = useState<{ page?: string; title: string } | null>(null)
  const selectedRunId = useTeams(s => s.selectedRunIds[chatId] ?? null)
  const setSelectedRunId = (id: string | null) => useTeams.setState(s => ({ selectedRunIds: { ...s.selectedRunIds, [chatId]: id } }))
  const bottom = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const body = useRef<HTMLDivElement>(null)
  const problems = useRef<HTMLDivElement>(null)
  const composer = useRef<TeamComposerHandle>(null)
  const modelSettings = useRef<HTMLDetailsElement>(null)
  const messages = chat?.messages ?? []
  const lastMessageStatus = messages.at(-1)?.status
  useEffect(() => { followLatest.current = true }, [chatId])
  useEffect(() => { if (view === "Chat" && followLatest.current) bottom.current?.scrollIntoView({ block: "nearest" }) }, [messages.length, lastMessageStatus, view, chatId])
  useEffect(() => { if ((view === "Configuración" || view === "Entrega") && body.current) body.current.scrollTop = 0 }, [view, selectedRunId])
  if (!chat) return <div className="team-note">Cargando conversación de equipo…</div>
  const run = chat.runs.find((r) => r.id === selectedRunId) ?? chat.runs.at(-1)
  const roster = run?.team ?? chat.team
  const fallbackSource = chatFallback(chat, selectedRunId)
  const fallback = fallbackSource?.state
  const fallbackModel = fallback ? models.find(model => modelKey(model) === modelKey(fallback.currentModel))?.name ?? fallback.currentModel.modelID : ""
  const agentMember = agentSession ? roster.members.find(member => member.id === agentSession.memberId) : undefined
  const runError = run?.error ?? ""
  const folderFailure = messages.at(-1)?.status === "error" ? messages.at(-1)!.text : runError
  const budgetBlocked = /presupuesto|límite de tokens|duración máxima/i.test(runError)
  const modelBlocked = /modelo|proveedor|variante/i.test(runError) || isAccountLimitError(runError)
  const pendingReply = messages.some(m => m.status === "pending")
  const requests = pendingRequests({ permissions, questions, allSessions }, approvals)
  const attention = teamAttention(chat, run, [
    ...requests.permissions.map(r => ({ sessionID: r.sessionID, kind: "permission" as const, detail: `${({ bash: "ejecutar el comando", edit: "editar el archivo", read: "leer el archivo", external_directory: "acceder a la carpeta", webfetch: "consultar la página" } as Record<string, string>)[r.permission] ?? r.permission}${r.patterns?.length ? `: ${r.patterns.join(", ").slice(0,180)}` : " (el motor no indicó la ruta ni el comando)"}` })),
    ...requests.questions.map(r => ({ sessionID: r.sessionID, kind: "question" as const, detail: r.questions[0]?.question?.slice(0, 240) })),
  ])
  const decisions = attention.filter(item => item.kind !== "waiting")
  const needsUserHelp = decisions.length > 0
  const activeSupport = run?.supportReports?.findLast(s => s.finishedAt == null)
  const headerStatus = !needsUserHelp && activeSupport ? activeSupport.kind === "plan_change" ? "Revisando tu indicación para actualizar el plan" : activeSupport.kind === "investigation" ? "El Solucionador está investigando para el Lead" : activeSupport.kind === "goal_analysis" ? "El Supervisor compara el objetivo y el resultado" : "El Supervisor está revisando entregas" : !needsUserHelp && leadRecovery(run) ? "El Lead está resolviendo un bloqueo" : run ? runStatusLabel(run.status) : attention.length ? "Necesita tu ayuda" : pendingReply ? "El Lead está trabajando" : "Listo para recibir tu objetivo"
  const ownerLabel = attentionLabel(attention)
  const act = async (action: string) => {
    if (!run) return
    if (action === "retry" && activeSessions && ["blocked", "paused", "paused_budget"].includes(run.status)) {
      const yes = await confirmAction("Detener la sesión y continuar", "Una sesión todavía figura activa. Se detendrá para reconciliar el estado; los cambios ya aplicados se conservan.", "Detener y continuar", true)
      if (!yes) return
      action = "force_retry"
    }
    return teamCall("team_runs_control", { runId: run.id, action })
  }
  const openModelSettings = () => { if (modelSettings.current) { modelSettings.current.open = true; modelSettings.current.scrollIntoView({ block: "start" }) } else setView("Configuración") }
  const askLead = () => { setView("Chat"); window.setTimeout(() => {
    const text = "¿Quién está bloqueado, por qué y qué ayuda necesitás de mí?"
    if (conversationLead && chat.origin?.sessionId) insertComposerText(chat.origin.sessionId, text)
    else composer.current?.write(text)
  }, 0) }
  const inspectSession = (id: string, directory: string) => {
    if (!workspace || !onAgentSession) { openSession(id, directory); return }
    const owner = roster.members.find(member => memberSession(chat, member.id, run)?.id === id)
    onAgentSession({ sessionId: id, memberId: owner?.id ?? roster.leadAgentId })
    setView("Agentes")
  }
  const inspectAttention = (item: TeamAttention) => {
    if (!item.sessionId) { setView("Tablero"); return }
    if (workspace && onAgentSession && item.kind !== "permission" && item.kind !== "question") { inspectSession(item.sessionId, item.directory); return }
    openSession(item.sessionId, item.directory)
  }
  const askLeadToUnblock = () => {
    if (!run) return
    const pending = run.tasks.filter(t => !["completed", "cancelled"].includes(t.status))
      .map(t => `${t.id}: ${t.status}`).join(", ").slice(0, 800)
    const waiting = (run.coordination ?? []).filter(c => !["resolved", "cancelled"].includes(c.status))
      .map(c => `${c.fromTaskId} → ${c.taskIds.join("/") || "Lead"} (${c.status})`).join(", ").slice(0, 500)
    const reason = readableTeamError(run.error || "no hay tareas que puedan avanzar").replace(/[.。]+$/, "")
    const text = `El equipo quedó bloqueado: ${reason}. Tareas: ${pending || "ninguna"}. Coordinación pendiente: ${waiting || "ninguna"}. Revisá la estrategia y resolvé el bloqueo sin repetir trabajo; reasigná, dividí o cancelá tareas si hace falta y continuá hasta la entrega.`
    void teamCall<string>("team_chat_send", { chatId, text, images: [] }).then(sent => { if (sent) setView("Chat") })
  }
  const browserNames = Object.fromEntries([...messages.filter(m => m.sessionId).map(m => [m.sessionId!, "Lead"]), ...(run?.tasks ?? []).flatMap(t => t.attempts.filter(a => a.sessionId).map(a => [a.sessionId!, a.agent.name]))])
  const boardCards = run ? projectBoard(run) : []
  const verifiedTasks = run?.tasks.filter(taskVerified).length ?? 0
  const runningTasks = run?.tasks.filter(task => ["running", "verifying"].includes(task.status)).length ?? 0
  const pendingTasks = run?.tasks.filter(task => ["pending", "blocked", "waiting_dependency", "interrupted"].includes(task.status)).length ?? 0
  const readyCount = boardCards.filter(c => c.column === "ready").length
  const reconciling = boardCards.some(c => c.column === "reconciling")
  const activeSessions = !!run && (
    run.status === "planning"
    || run.tasks.some(t => ["running", "verifying"].includes(t.status)
      || t.attempts.some(a => a.finishedAt == null && (a.sessionId || a.reviewSessionId)))
    || (run.supportReports ?? []).some(s => s.finishedAt == null)
    || (run.coordination ?? []).some(c => c.status === "checking")
  )
  const stuck = /no hay tareas que puedan avanzar|dependencias pendientes/i.test(run?.error ?? "")
  const nextAction: { label: string; action: string; title: string; detail: string; secondary?: { label: string; action: string } } | null = !run ? null
    : run.status === "plan_ready" ? { label: "Iniciar plan", action: "start_plan", title: "El plan está listo", detail: `${run.tasks.length} tareas preparadas. El equipo arranca cuando lo indiques.` }
    : run.status === "paused" ? { label: "Reanudar", action: "resume", title: "El equipo está pausado", detail: "Las tareas terminadas se conservan. Reanudá para continuar con lo pendiente." }
    : ["blocked", "failed", "planning_blocked"].includes(run.status) ? stuck
      ? { label: "Continuar", action: "retry", title: "El equipo no puede avanzar", detail: "El Lead va a revisar la estrategia y separar las tareas sin repetir trabajo. El trabajo ya hecho se conserva.", secondary: { label: "Pedirle al Lead que lo resuelva", action: "lead" } }
      : { label: "Continuar", action: "retry", title: "El equipo se detuvo", detail: "Revisá el motivo y continuá; el trabajo ya hecho se conserva.", secondary: { label: "Pedirle al Lead que lo resuelva", action: "lead" } }
    : run.status === "running" && !activeSessions && (readyCount > 0 || reconciling) ? { label: "Continuar", action: "continue", title: reconciling ? "Hay sesiones por reconciliar" : `${readyCount} tarea${readyCount === 1 ? "" : "s"} lista${readyCount === 1 ? "" : "s"} para continuar`, detail: reconciling ? "Reconciliá el estado incierto y seguí sin repetir efectos." : "El equipo no tiene sesiones activas. Continuá para que retome las tareas listas." }
    : ["completed", "awaiting_manual_qa"].includes(run.status) ? { label: "Revisar entrega", action: "deliver", title: "La entrega está lista", detail: "Revisá qué cambió, el escenario preparado y las evidencias." }
    : null
  return <section className={`team-chat${!workspace && (expanded || browser) ? " team-chat-expanded" : ""}${workspace ? " team-chat-workspace" : ""}`}>
    <header className="team-chat-header">
      <div className="team-section-title">
        <strong><Icon name="organization" /> {chat.title}</strong>
        <details className="team-chat-menu">
          <summary className="btn btn-xs" aria-label="Más opciones del equipo">⋯</summary>
          <div className="team-chat-menu-panel">
            {workspace && <button type="button" className="btn btn-xs" onClick={() => setView("Configuración")}>Configuración</button>}
            {workspace && run && ["planning", "running"].includes(run.status) && <button type="button" className="btn btn-xs" onClick={() => void act("pause")}>Pausar nuevas tareas</button>}
            {run && run.status !== "cancelling" && (runActive(run.status) || ["blocked", "planning_blocked"].includes(run.status)) && <button type="button" className="btn btn-xs" onClick={() => void confirmAction("Cancelar ejecución", "Se abortan las sesiones y se conservan los cambios ya aplicados. Revisá Git antes de continuar.", "Cancelar ejecución", true).then((yes) => { if (yes) void act("cancel") })}>Cancelar ejecución</button>}
          </div>
        </details>
        <button type="button" className="btn btn-xs" aria-label={expanded ? "Restaurar tamaño del chat" : "Ampliar chat del equipo"} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><Icon name={expanded ? "screen-normal" : "screen-full"} />{expanded ? "Restaurar" : "Ampliar"}</button>
        {run && ["planning", "running"].includes(run.status) && <button type="button" className="btn btn-xs" onClick={() => void act("pause")}>Pausar nuevas tareas</button>}
        <button type="button" className="btn btn-xs" aria-label="Configuración del equipo" aria-pressed={view === "Configuración"} onClick={() => setView(view === "Configuración" ? "Chat" : "Configuración")}><Icon name="settings-gear" /> Configuración</button>
        {chat.autoApprove === false && <button type="button" className="btn btn-xs" onClick={() => void teamCall("team_chats_settings", { chatId, memory: chat.memory !== false, autoApprove: true })}><Icon name="shield" /> Dar acceso total</button>}
      </div>
      <p>{roster.members.length > 1 ? `${roster.members.length} integrantes · ` : ""}{headerStatus}{ownerLabel && (needsUserHelp ? <button type="button" className="team-attention-badge team-attention-jump team-attention-summary" aria-live="polite" onClick={() => { setView("Chat"); requestAnimationFrame(() => problems.current?.scrollIntoView({ block: "start" })) }}> · {ownerLabel}</button> : <span className="team-waiting-badge" aria-live="polite"> · {ownerLabel}</span>)}</p>
      {!workspace && chat.origin && <div className="team-origin"><Icon name="git-pull-request" /><span>Desde el chat «{chat.origin.title}»</span>{chat.origin.error ? <span className="team-error">No se pudo iniciar: {readableTeamError(chat.origin.error)}</span> : <button type="button" className="btn btn-xs" onClick={() => { const origin = chat.origin!; rememberSessionDirectory(origin.sessionId, origin.directory); useTeams.setState({ activeChatId: null }); selectSession(origin.sessionId) }}><Icon name="arrow-left" /> Volver al chat de origen</button>}</div>}
    </header>

    {fallback?.enabled && <div className="team-fallback-status" role="status">
      <span>{fallback.restored ? `Modelo inicial restaurado: ${models.find(model => modelKey(model) === modelKey(fallback.originalModel))?.name ?? fallback.originalModel.modelID}` : `Modo continuo · ${modelKey(fallback.currentModel) === modelKey(fallback.originalModel) ? "Modelo inicial" : "Modelo alternativo"}: ${fallbackModel}`}</span>
      {!fallback.restored && fallback.nextIndex >= fallback.candidates.length && ["blocked", "planning_blocked", "error"].includes(fallbackSource!.status) && <strong>Lista de modelos fallback agotada. El trabajo se conserva; revisá las cuotas antes de reintentar.</strong>}
      <button type="button" className="btn btn-xs" onClick={() => void openFallbackModels()}>Modelos Fallback</button>
    </div>}

    {view !== "Configuración" && /carpeta.*ocupada|equipo o una sesión pendiente|otro equipo.*carpetas/i.test(folderFailure) && <TeamFolderConflicts chatId={chatId} failure={folderFailure} />}
    {!workspace && <nav className="team-chat-nav" aria-label="Vistas del equipo">{["Chat", "Ahora", "Tablero", "Entrega", "Navegador"].map((v) => <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{v}</button>)}</nav>}
    {chat.runs.length > 1 && <label className="team-run-select">Entrega / ejecución<select aria-label="Entrega / ejecución" value={run?.id ?? ""} onChange={e => setSelectedRunId(e.target.value)}>{chat.runs.map((r, i) => <option key={r.id} value={r.id}>#{i + 1} · {formatDateTime(r.startedAt)} · {runStatusLabel(r.status)}</option>)}</select></label>}
    {nextAction && view !== "Plan" && view !== "Agentes" && <div className="team-next-action" role="status">
      <div><strong>{nextAction.title}</strong><p>{nextAction.detail}</p></div>
      <div className="team-next-actions">
        {nextAction.secondary && <button type="button" className="btn btn-sm" disabled={pendingReply} onClick={() => { if (nextAction.secondary!.action === "lead") askLeadToUnblock(); else void act(nextAction.secondary!.action) }}>{nextAction.secondary.label}</button>}
        <button type="button" className="btn btn-primary" disabled={pendingReply} onClick={() => { if (nextAction.action === "deliver") { setView("Entrega"); return } if (nextAction.action === "lead") { askLeadToUnblock(); return } void act(nextAction.action) }}>{nextAction.label}</button>
      </div>
    </div>}
    <div className={`team-chat-body${view === "Navegador" ? " team-browser-body" : ""}${workspace && view === "Agentes" && agentMember ? " team-agent-conversation-body" : ""}`} ref={body} onScroll={() => { const el = body.current; if (el) followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      {view === "Navegador" && <TeamBrowser chatId={chatId} names={browserNames} initialPage={browser?.page} />}
      {run?.status === "plan_ready" && view !== "Agentes" && view !== "Alertas" && <div className="team-plan-ready"><div><strong>El plan está listo</strong><p>{run.tasks.length} tareas preparadas. El equipo arranca cuando lo indiques.</p></div><button className="btn btn-primary" onClick={() => void act("start_plan")}>Iniciar plan</button></div>}
      {workspace ? (needsUserHelp && view !== "Alertas" && ["Chat", "Tablero", "Entrega"].includes(view) && <button type="button" className="team-alerts-jump" onClick={() => setView("Alertas")}><Icon name="bell" /><span><strong>{decisions.length} {decisions.length === 1 ? "alerta" : "alertas"}</strong><small>Revisá qué necesita tu atención</small></span><Icon name="chevron-right" /></button>)
        : (view !== "Navegador" && view !== "Configuración" && view !== "Plan" && view !== "Agentes" && needsUserHelp && <div ref={problems} className="team-decision-slot">
          {budgetBlocked && run && <RunBudget run={run} expanded />}
          <TeamProblems items={decisions.filter(item => !/presupuesto|límite de tokens|duración máxima/i.test(item.reason))} run={run} pending={pendingReply} onInspect={inspectAttention} onSettings={openModelSettings} onAsk={askLead} onContinue={() => void act("retry")} />
        </div>)}
      {view === "Ahora" && <>{run && <><TeamActivity run={run} onSession={inspectSession} /><SupportReports run={run} onOpen={inspectSession} /><GoalAnalysis run={run} /></>}{messages.some(m => m.sessionId) && <section className="team-card"><h4>Actividad del chat con el Lead</h4>{messages.filter(m => m.sessionId).map(m => <p key={m.id}><button className="btn btn-xs" onClick={() => inspectSession(m.sessionId!, chat.team.projectRoot)}>Ver herramientas y permisos · {formatDateTime(m.createdAt)}</button></p>)}</section>}{run && !!run.coordination?.length && <section className="team-card" aria-label="Coordinación del equipo"><h4>Coordinación con el Lead</h4>{run.coordination.map(request => <article className="team-coordination-item" key={request.id}><strong>{run.tasks.find(t => t.id === request.fromTaskId)?.title ?? request.fromTaskId} → Lead</strong><p className="selectable">{request.message}</p>{(request.replies?.length ? request.replies : request.summary ? [{ at: request.createdAt, summary: request.summary }] : []).map((reply, i) => <div className="team-lead-message" key={i}><strong>Lead → {run.team.members.find(a => a.id === run.tasks.find(t => t.id === request.fromTaskId)?.assignedAgentId)?.name ?? "agente"}</strong><small> · {formatDateTime(reply.at)}</small><p className="selectable">{reply.summary}</p></div>)}</article>)}</section>}{!run && !messages.some(m => m.sessionId) && <p className="team-note">Enviá un objetivo para ver la actividad en vivo.</p>}</>}
      {workspace && view === "Plan" && <section className="team-workspace-plan" aria-label="Plan detallado del equipo">
        <header className="team-plan-heading">
          <span className="team-workspace-eyebrow">PLAN DE TRABAJO</span>
          <h2>{run?.tasks.length ? `${run.tasks.length} ${run.tasks.length === 1 ? "paso preparado" : "pasos preparados"} por el Lead` : "Todavía no hay un plan"}</h2>
          <p>{run?.tasks.length ? `${verifiedTasks} verificados · ${runningTasks} en curso · ${pendingTasks} pendientes` : "Escribile al Lead para que prepare el plan de trabajo."}</p>
        </header>
        {run?.tasks.length ? <ol>{run.tasks.map(task => <li key={task.id}><span>{task.id}</span><div><h3>{task.title}</h3><p className="team-plan-objective">{task.objective}</p><div className="team-plan-meta"><span className={`team-plan-status status-${task.status}`}>{task.status}</span><small>{roster.members.find(member => member.id === task.assignedAgentId)?.name ?? "Sin asignar"}</small>{!!task.dependencies.length && <small>Depende de {task.dependencies.join(", ")}</small>}</div>{!!task.acceptanceCriteria.length && <details className="team-plan-criteria"><summary>Criterios de aceptación</summary><ul>{task.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></details>}</div></li>)}</ol> : null}
      </section>}
      {workspace && view === "Alertas" && <section className="team-workspace-alerts" aria-label="Alertas del equipo">
        <header className="team-alerts-heading">
          <span className="team-alerts-icon"><Icon name="bell" /></span>
          <div><h2>{decisions.length ? `${decisions.length} ${decisions.length === 1 ? "alerta necesita" : "alertas necesitan"} tu atención` : "No hay alertas abiertas"}</h2><p>{decisions.length ? "Esto es lo que necesita una decisión o respuesta tuya. El equipo sigue con el resto mientras respondés." : "El equipo sigue trabajando sin necesitar tu intervención."}</p></div>
        </header>
        {needsUserHelp ? <>{budgetBlocked && run && <RunBudget run={run} expanded />}<TeamProblems items={decisions.filter(item => !/presupuesto|límite de tokens|duración máxima/i.test(item.reason))} run={run} pending={pendingReply} onInspect={inspectAttention} onSettings={openModelSettings} onAsk={askLead} onContinue={() => void act("retry")} /></> : <div className="team-alerts-empty"><Icon name="check" /><h3>Todo bajo control</h3><p>No hay permisos, preguntas ni bloqueos que necesiten tu atención.</p></div>}
      </section>}
      {workspace && view === "Agentes" && (agentSession && agentMember ? <AgentConversation sessionId={agentSession.sessionId} member={agentMember} index={roster.members.indexOf(agentMember)} onBack={() => onAgentSession?.(null)} approve={chat.autoApprove !== false} onGrant={() => void teamCall("team_chats_settings", { chatId, memory: chat.memory !== false, autoApprove: true })} readOnly={!!chat.archived} /> : <section className="team-workspace-agents" aria-label="Agentes del equipo">{roster.members.map((member, index) => {
        const session = memberSession(chat, member.id, run)
        const body = <><span className={`studio-avatar tone-${index % 4}`}>{member.name.slice(0, 1)}</span><div><h2>{member.name}</h2><p>{member.role}</p><small>{member.model.providerID} · {member.model.modelID}</small><ul>{run?.tasks.filter(task => task.assignedAgentId === member.id).map(task => <li key={task.id}>{task.title} · {task.status}</li>)}</ul><span className={`team-agent-open${session ? "" : " is-muted"}`}><Icon name={session ? "comment-discussion" : "clock"} /> {session ? "Ver conversación" : "Sin conversación todavía"}</span></div></>
        return session
          ? <button type="button" className="team-workspace-agent" key={member.id} aria-label={`Abrir conversación de ${member.name}`} onClick={() => onAgentSession ? onAgentSession({ sessionId: session.id, memberId: member.id }) : openSession(session.id, session.directory)}>{body}</button>
          : <article className="team-workspace-agent" key={member.id}>{body}</article>
      })}</section>)}
      {view === "Tablero" && (run ? <TeamBoard key={run.id} run={run} compact={workspace} readOnly={!!chat.archived} onSession={inspectSession} onRetry={() => act("retry")} /> : workspace ? <div className="team-workspace-welcome"><Icon name="organization" /><h2>Todo listo para empezar</h2><p>Contale tu objetivo al Lead. El plan y las tareas van a aparecer en este tablero.</p></div> : <p className="team-note">Enviá un objetivo para generar el tablero.</p>)}
      {workspace && view === "Tablero" && messages.some(message => message.role === "assistant") && <button type="button" className="team-space-activity" onClick={() => setView("Ahora")}><span className="studio-avatar">L</span><span>{messages.findLast(message => message.role === "assistant")?.text.slice(0, 100) || "El Lead actualizó el equipo"}</span><small>Ver actividad</small></button>}
      {view === "Chat" && conversationLead && chat.origin?.sessionId && <AgentConversation sessionId={chat.origin.sessionId} member={roster.members.find(m => m.id === roster.leadAgentId) ?? { name: "Lead", role: "Lead" }} index={0} onBack={() => setView("Tablero")} backLabel="Tablero" approve={chat.autoApprove !== false} onGrant={() => void teamCall("team_chats_settings", { chatId, memory: chat.memory !== false, autoApprove: true })} readOnly={!!chat.archived} />}
      {view === "Chat" && !(conversationLead && chat.origin?.sessionId) && <>
        {!chat.runs.length && <div className="team-chat-welcome"><Icon name="organization" /><h2>{chat.team.autonomous ? "Contame qué querés hacer" : "Un objetivo para todo el equipo"}</h2><p>{chat.team.autonomous ? "Hablás con el Lead. Él decide cuántos especialistas necesita, reparte las tareas y pone a trabajar en paralelo lo que se pueda hacer a la vez." : "El Lead descubre el proyecto, delega y revisa. El equipo completa las comprobaciones y entrega el resultado con evidencias; solo te consulta si necesita una decisión o un permiso."}</p><p className="team-note">Escribile cuando quieras: si hay trabajo en curso, el Lead ajusta el plan. Al terminar te avisa para que revises la entrega.</p></div>}
        {[
          ...chat.runs.flatMap((r) => {
            const delivered = ["completed", "awaiting_manual_qa", "qa_approved"].includes(r.status)
            const stopped = ["failed", "cancelled"].includes(r.status)
            const finished = r.finishedAt != null || delivered || stopped
            const items = [{ at: r.startedAt, key: `goal-${r.id}`, node: <article className="team-chat-message team-conversation user">
              <small>Vos · {formatDateTime(r.startedAt)}</small>
              <GoalMessage text={r.goal} />
              <ChatImages images={r.images} />
            </article> }]
            if (finished) items.push({ at: r.finishedAt ?? r.startedAt, key: `delivery-${r.id}`, node: <article className="team-chat-message team-conversation assistant">
              <small>Lead · {formatDateTime(r.finishedAt ?? r.startedAt)}</small>
              <div className="team-lead-message">
                <p className="lead-brief">{delivered ? ([r.chatSummary?.done, r.chatSummary?.tested].filter(Boolean).join(" ") || "La entrega está lista para revisar.") : readableTeamError(runProblem(r) || "La ejecución se detuvo antes de terminar.")}</p>
                {delivered && <details className="lead-details"><summary>Qué se hizo y probó</summary><p className="selectable">{r.chatSummary?.tested || "La entrega quedó registrada en Resultados."}</p></details>}
                {delivered && r.summary && <details className="lead-details"><summary>Detalles técnicos</summary><p className="selectable">{r.summary}</p></details>}
                <div className="team-chat-actions">
                  {delivered && <button className="btn btn-sm btn-primary" onClick={() => { setSelectedRunId(r.id); setView("Entrega") }}><Icon name="checklist" />Qué cambió y qué revisar</button>}
                  {!delivered && <button className="btn btn-sm" onClick={() => { setSelectedRunId(r.id); setView("Entrega") }}>Ver qué se hizo</button>}
                </div>
              </div>
            </article> })
            return items
          }),
          ...messages.filter(m => m.role !== "user" || !chat.runs.some(r => r.goal === m.text && Math.abs(r.startedAt - m.createdAt) < 30_000)).map(m => ({ at: m.createdAt, key: m.id, node: <article className={`team-chat-message team-conversation ${m.role}`}>
            <small>{m.role === "user" ? "Vos" : "Lead"} · {formatDateTime(m.createdAt)}</small>
            <div className={m.role === "assistant" ? "team-lead-message" : "selectable"}>
              {m.status === "pending" ? <p role="status">El Lead está leyendo…</p> : m.role === "assistant" ? <LeadMessage text={["error", "interrupted"].includes(m.status) ? readableTeamError(m.text) : m.text} /> : <Markdown text={m.text} />}
              <ChatImages images={m.images} />
            </div>
          </article> })),
        ].sort((a, b) => a.at - b.at).map(item => <div key={item.key}>{item.node}</div>)}
        {run?.status === "blocked" && modelBlocked && <details ref={modelSettings} className="team-card"><summary>Cambiar el modelo que falló</summary><p className="team-note">La configuración original del chat y los intentos anteriores se conservan.</p>{run.team.members.map((a) => <label key={a.id}>{a.name} · {a.role}<select aria-label={`Modelo de ${a.name}`} value={modelKey(a.model)} onChange={(e) => { const m = models.find((v) => modelKey(v) === e.target.value); if (m) void teamCall("team_runs_model", { runId: run.id, agentId: a.id, model: { providerID: m.providerID, modelID: m.modelID }, variant: null }) }}><option value={modelKey(a.model)}>{modelKey(a.model)}</option>{models.filter((m) => modelKey(m) !== modelKey(a.model)).map((m) => <option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}</select></label>)}</details>}
        <div ref={bottom} />
      </>}
      {view === "Configuración" && <><TeamFolderConflicts chatId={chatId} failure={runError} /><TeamSettings team={chat.team} run={run} chatId={chat.id} pending={pendingReply} memory={chat.memory !== false} approve={chat.autoApprove !== false} />{roster.autonomous && <details className="team-roster"><summary>Equipo elegido por el Lead</summary><ul aria-label="Estado de los integrantes">{roster.members.map(m => {
        const current = memberState(m, chat, run, attention)
        return { m, current, priority: current.needsHelp ? 3 : m.id === roster.leadAgentId ? 2 : current.tone === "waiting" ? 1 : 0 }
      }).sort((a, b) => b.priority - a.priority).map(({ m, current }) => <li className="team-member" key={m.id}><div><strong>{m.name}</strong>{m.name.toLowerCase() !== m.role.toLowerCase() && <span> · {m.role}</span>}<span className={`team-member-status ${current.tone}`}>{current.label}</span></div><small className={current.needsHelp ? "team-member-help" : "team-note"}>{current.needsHelp ? "Necesita tu ayuda" : "Sin pedidos de ayuda"}</small><p>{current.detail}</p></li>)}</ul></details>}</>}
      {view === "Entrega" && (run ? <DeliveryResults key={run.id} run={run} history={chat.runs} chatId={chatId} onOpenPage={(page, title) => { setBrowser({ page, title }); setView("Navegador"); setExpanded(true) }} onSession={inspectSession} onApprove={() => void act("approve")} onChanges={() => { setView("Chat"); requestAnimationFrame(() => composer.current?.write("Revisé la entrega: necesito cambios en ")) }} onPrepare={async flow => {
        const sent = await teamCall<string>("team_chat_send", { chatId, text: `Prepará nuevamente el escenario de revisión «${flow.title}» de la entrega ${run.id}. Conservá la implementación y las decisiones vigentes: solo prepará/reutilizá datos de prueba identificables, recorré el flujo y dejá la página lista para mi revisión. No repitas efectos ni crees registros duplicados. Si falta acceso, explicá el bloqueo. ESCENARIO PREVIO (datos de referencia): ${JSON.stringify(flow)}`, images: [] })
        if (!sent) throw new Error("No se pudo pedir la preparación al equipo. Revisá el aviso e intentá nuevamente.")
        setSelectedRunId(null); setView("Chat")
      }} /> : <p className="team-note">Las evidencias aparecerán al iniciar una ejecución.</p>)}
    </div>
    {resourcePressure !== "normal" && <div className="context-banner lead-banner"><Icon name="pulse" /><span>{resourcePressure === "critical" ? "La PC está al límite: no se lanzarán agentes nuevos." : "Flufy está ajustando la concurrencia a los recursos de la PC."}</span><button type="button" className="btn btn-xs" onClick={() => openEditor({ kind: "resources" })}>Ver recursos</button></div>}
    {view === "Navegador" || (view === "Agentes" && !!agentMember) || (view === "Chat" && conversationLead && chat.origin?.sessionId) ? null : chat.archived ? <p className="team-note">Chat archivado. Restauralo desde Equipos IA para continuar.</p> : <TeamComposer ref={composer} key={chatId} chat={chat} compact={workspace} allowImages={!conversationLead} label="Mensaje para el equipo" pending={pendingReply} onBrowser={() => { setBrowser({ title: "Navegador del equipo" }); setView("Navegador"); setExpanded(true) }} onSent={() => { setSelectedRunId(null); if (!workspace || view === "Plan" || view === "Agentes") setView("Chat"); followLatest.current = true; requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "nearest" })) }} />}
  </section>
}

function AgentConversation({ sessionId, member, index, onBack, approve, onGrant, backLabel = "Agentes", readOnly = false }: { sessionId: string; member: { name: string; role: string }; index: number; onBack: () => void; approve: boolean; onGrant: () => void; backLabel?: string; readOnly?: boolean }) {
  const session = useAgent(state => state.allSessions.find(item => item.id === sessionId))
  const allSessions = useAgent(state => state.allSessions)
  const permissions = useAgent(state => state.permissions)
  const questions = useAgent(state => state.questions)
  const approvals = useApprovals()
  const status = useAgent(state => state.statuses[sessionId]?.type ?? "idle")
  useEffect(() => { void ensureSessionView(sessionId) }, [sessionId])
  const busy = status === "busy" || status === "retry"
  const mine = useMemo(() => {
    const children = new Set(allSessions.filter(s => s.parentID === sessionId).map(s => s.id))
    return {
      permissions: permissions.filter(p => p.sessionID === sessionId || children.has(p.sessionID)),
      questions: questions.filter(q => q.sessionID === sessionId || children.has(q.sessionID)),
    }
  }, [allSessions, permissions, questions, sessionId])
  return <section className="team-workspace-agent-chat" aria-label={`Conversación de ${member.name}`}>
    <header className="team-agent-chat-header">
      <button type="button" className="btn btn-xs" onClick={onBack}><Icon name="arrow-left" /> {backLabel}</button>
      <span className={`studio-avatar tone-${index % 4}`}>{member.name.slice(0, 1)}</span>
      <div><strong>{member.name}</strong><small>{member.role}</small></div>
      {approve ? <span className="team-agent-access"><Icon name="pass-filled" /> Acceso total</span> : <button type="button" className="btn btn-xs" onClick={onGrant}><Icon name="shield" /> Dar acceso total</button>}
    </header>
    {session ? <>
      <Chat session={session} busy={busy} teamSession />
      <div className="team-agent-chat-dock">
        {mine.questions.map((q) => <QuestionCard key={q.id} request={q} />)}
        {mine.permissions.filter((p) => permissionNeedsResponse(p, allSessions, approvals)).map((p) => <PermissionCard key={p.id} request={p} />)}
        {readOnly ? <p className="team-note">Chat archivado. Restauralo para continuar.</p> : <Composer sessionId={sessionId} busy={busy} compact />}
      </div>
    </> : <div className="team-agent-chat-empty"><Icon name="clock" /><p>La conversación todavía no está disponible. Volvé a intentarlo cuando la sesión termine de cargar.</p></div>}
  </section>
}
