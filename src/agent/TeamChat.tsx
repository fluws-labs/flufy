import { useEffect, useRef, useState } from "react"
import { teamCall, useTeams } from "../state/teams"
import { focusComposer, pendingRequests, selectSession, useAgent } from "../state/agent"
import { useApprovals } from "../state/approvals"
import { modelKey, rememberSessionDirectory } from "../lib/opencode"
import { openEditor } from "../state/editors"
import { confirmAction } from "../components/Dialog"
import { Icon } from "../components/ui"
import { Markdown } from "./Markdown"
import { runStatusLabel, runActive } from "../team/types"
import { formatDateTime } from "../lib/time"
import { isAccountLimitError, readableTeamError } from "../lib/provider-error"
import { runProblem } from "../team/problem"
import { ChatImages } from "../team/ChatImages"
import { TeamSettings } from "../team/TeamSettings"
import { attentionLabel, teamAttention } from "../team/attention"
import { leadRecovery, memberState } from "../team/member-state"
import { TeamProblems } from "../team/TeamProblems"
import { TeamBrowser } from "../team/TeamBrowser"
import { TeamFolderConflicts } from "../team/TeamFolderConflicts"
import { TeamBoard } from "../team/TeamBoard"
import { LeadMessage } from "../team/LeadMessage"
import { projectBoard } from "../team/board"
import { TeamActivity } from "../team/TeamActivity"
import { GoalAnalysis, SupportReports } from "../team/SupportReports"
import { DeliveryResults } from "../team/DeliveryResults"
import { GoalMessage } from "../team/GoalMessage"
import { RunBudget } from "../team/RunBudget"
import { TeamComposer, type TeamComposerHandle } from "../team/TeamComposer"

function openSession(id: string, directory: string) {
  rememberSessionDirectory(id, directory)
  openEditor({ kind: "chat", sessionId: id })
}

export function TeamChat({ chatId }: { chatId: string }) {
  const chat = useTeams((s) => s.chats.find((c) => c.id === chatId))
  const models = useAgent((s) => s.models)
  const permissions = useAgent(s => s.permissions)
  const questions = useAgent(s => s.questions)
  const allSessions = useAgent(s => s.allSessions)
  const approvals = useApprovals()
  const [viewChoice, setViewChoice] = useState<{ runId?: string; view: string | null } | null>(null)
  const viewRun = chat?.runs.at(-1)
  const conversationLead = !!viewRun?.planV2?.conversationLead
  const readOnly = !!chat?.archived
  const view = (viewChoice?.runId === viewRun?.id ? viewChoice?.view : null) ?? "Tablero"
  const setView = (view: string | null) => setViewChoice({ runId: viewRun?.id, view })
  const [expanded, setExpanded] = useState(false)
  const [browser, setBrowser] = useState<{ page?: string; title: string } | null>(null)
  const selectedRunId = useTeams(s => s.selectedRunIds[chatId] ?? null)
  const setSelectedRunId = (id: string | null) => useTeams.setState(s => ({ selectedRunIds: { ...s.selectedRunIds, [chatId]: id } }))
  const bottom = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const body = useRef<HTMLDivElement>(null)
  const composer = useRef<TeamComposerHandle>(null)
  const problems = useRef<HTMLDivElement>(null)
  const modelSettings = useRef<HTMLDetailsElement>(null)
  const messages = chat?.messages ?? []
  const lastMessageStatus = messages.at(-1)?.status
  useEffect(() => { followLatest.current = true }, [chatId])
  useEffect(() => { if (view === "Chat" && followLatest.current) bottom.current?.scrollIntoView({ block: "nearest" }) }, [messages.length, lastMessageStatus, view, chatId])
  useEffect(() => { if ((view === "Configuración" || view === "Entrega") && body.current) body.current.scrollTop = 0 }, [view, selectedRunId])
  if (!chat) return <div className="team-note">Cargando conversación de equipo…</div>
  const openSource = (draft?: string) => {
    const origin = chat.origin
    if (!origin) return
    rememberSessionDirectory(origin.sessionId, origin.directory)
    useTeams.setState({ activeChatId: null })
    selectSession(origin.sessionId)
    if (draft) focusComposer(draft)
  }
  // The conversational Lead lives in the source chat; manual team chats keep
  // their own Lead, so steering stays inside this board.
  const askInChat = (text: string) => {
    if (conversationLead) { openSource(text); return }
    setView("Chat")
    requestAnimationFrame(() => composer.current?.write(text))
  }
  const run = chat.runs.find((r) => r.id === selectedRunId) ?? chat.runs.at(-1)
  const roster = run?.team ?? chat.team
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
  const act = (action: string) => run && teamCall("team_runs_control", { runId: run.id, action })
  const forceContinue = () => confirmAction(
    "Detener la sesión y continuar",
    "El trabajo figura detenido pero una sesión sigue activa. Se detendrá para reconciliar; los cambios ya aplicados se conservan.",
    "Detener y continuar",
    true,
  ).then(yes => { if (yes) void act("force_retry") })
  const askLeadToUnblock = () => {
    if (!run) return
    const pending = run.tasks.filter(t => !["completed", "cancelled"].includes(t.status))
      .map(t => `${t.id}: ${t.status}`).join(", ").slice(0, 800)
    const waiting = (run.coordination ?? []).filter(c => !["resolved", "cancelled"].includes(c.status))
      .map(c => `${c.fromTaskId} → ${c.taskIds.join("/") || "Lead"} (${c.status})`).join(", ").slice(0, 500)
    const reason = readableTeamError(run.error || "no hay tareas que puedan avanzar").replace(/[.。]+$/, "")
    const text = `El equipo quedó bloqueado: ${reason}. Tareas: ${pending || "ninguna"}. Coordinación pendiente: ${waiting || "ninguna"}. Revisá la estrategia y resolvé el bloqueo sin repetir trabajo; reasigná, dividí o cancelá tareas si hace falta y continuá hasta la entrega.`
    void teamCall<string>("team_chat_send", { chatId, text, images: [] }).then(sent => { if (sent) setView(conversationLead ? "Tablero" : "Chat") })
  }
  const browserNames = Object.fromEntries([...messages.filter(m => m.sessionId).map(m => [m.sessionId!, "Lead"]), ...(run?.tasks ?? []).flatMap(t => t.attempts.filter(a => a.sessionId).map(a => [a.sessionId!, a.agent.name]))])
  const boardCards = run ? projectBoard(run) : []
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
    : ["blocked", "failed", "planning_blocked"].includes(run.status) ? activeSessions
      ? { label: "Detener y continuar", action: "force_retry", title: "Una sesión sigue activa", detail: "El trabajo figura detenido pero una sesión sigue activa. Se detendrá para reconciliar sin repetir el trabajo ya hecho.", secondary: { label: "Pedirle al Lead que lo resuelva", action: "lead" } }
      : stuck
      ? { label: "Continuar", action: "retry", title: "El equipo no puede avanzar", detail: "El Lead va a revisar la estrategia y separar las tareas sin repetir trabajo. El trabajo ya hecho se conserva.", secondary: { label: "Pedirle al Lead que lo resuelva", action: "lead" } }
      : { label: "Continuar", action: "retry", title: "El equipo se detuvo", detail: "Revisá el motivo y continuá; el trabajo ya hecho se conserva.", secondary: { label: "Pedirle al Lead que lo resuelva", action: "lead" } }
    : run.status === "running" && !activeSessions && (readyCount > 0 || reconciling) ? { label: "Continuar", action: "continue", title: reconciling ? "Hay sesiones por reconciliar" : `${readyCount} tarea${readyCount === 1 ? "" : "s"} lista${readyCount === 1 ? "" : "s"} para continuar`, detail: reconciling ? "Reconciliá el estado incierto y seguí sin repetir efectos." : "El equipo no tiene sesiones activas. Continuá para que retome las tareas listas." }
    : ["completed", "awaiting_manual_qa"].includes(run.status) ? { label: "Revisar entrega", action: "deliver", title: "La entrega está lista", detail: "Revisá qué cambió, el escenario preparado y las evidencias." }
    : null
  return <section className={`team-chat${expanded || browser ? " team-chat-expanded" : ""}`}>
    <header className="team-chat-header">
      <div className="team-section-title">
        <strong><Icon name="organization" /> {chat.title}</strong>
        <details className="team-chat-menu">
          <summary className="btn btn-xs" aria-label="Más opciones del equipo">⋯</summary>
          <div className="team-chat-menu-panel">
            {run && run.status !== "cancelling" && (runActive(run.status) || ["blocked", "planning_blocked"].includes(run.status)) && <button type="button" className="btn btn-xs" onClick={() => void confirmAction("Cancelar ejecución", "Se abortan las sesiones y se conservan los cambios ya aplicados. Revisá Git antes de continuar.", "Cancelar ejecución", true).then((yes) => { if (yes) void act("cancel") })}>Cancelar ejecución</button>}
          </div>
        </details>
        <button type="button" className="btn btn-xs" aria-label={expanded ? "Restaurar tamaño del chat" : "Ampliar chat del equipo"} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}><Icon name={expanded ? "screen-normal" : "screen-full"} />{expanded ? "Restaurar" : "Ampliar"}</button>
        {run && ["planning", "running"].includes(run.status) && <button type="button" className="btn btn-xs" onClick={() => void act("pause")}>Pausar nuevas tareas</button>}
        <button type="button" className="btn btn-xs" aria-label="Configuración del equipo" aria-pressed={view === "Configuración"} onClick={() => setView(view === "Configuración" ? (conversationLead ? "Tablero" : "Chat") : "Configuración")}><Icon name="settings-gear" /> Configuración</button>
      </div>
      <p>{roster.members.length > 1 ? `${roster.members.length} integrantes · ` : ""}{headerStatus}{ownerLabel && (needsUserHelp ? <button type="button" className="team-attention-badge team-attention-jump team-attention-summary" aria-live="polite" onClick={() => { setView(conversationLead ? "Tablero" : "Chat"); requestAnimationFrame(() => problems.current?.scrollIntoView({ block: "start" })) }}> · {ownerLabel}</button> : <span className="team-waiting-badge" aria-live="polite"> · {ownerLabel}</span>)}</p>
      {chat.origin && <div className="team-origin"><Icon name="git-pull-request" /><span>Desde el chat «{chat.origin.title}»</span>{chat.origin.error && <span className="team-error">El Lead no pudo responder: {readableTeamError(chat.origin.error)}</span>}<button type="button" className="btn btn-xs" onClick={() => openSource()}><Icon name="arrow-left" /> Volver al chat de origen</button></div>}
    </header>

    {view !== "Configuración" && /carpeta.*ocupada|equipo o una sesión pendiente|otro equipo.*carpetas/i.test(folderFailure) && <TeamFolderConflicts chatId={chatId} failure={folderFailure} />}
    <nav className="team-chat-nav" aria-label="Vistas del trabajo">{(conversationLead ? ["Ahora", "Tablero", "Entrega"] : ["Chat", "Ahora", "Tablero", "Entrega"]).map((v) => <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>{v}</button>)}</nav>
    {conversationLead && <div className="context-banner lead-banner"><Icon name="comment-discussion" /><span>La conversación es el Lead. Podés escribir acá o volver al chat de origen.</span>{chat.origin && <button type="button" className="btn btn-xs" onClick={() => openSource()}>Volver al chat</button>}</div>}
    {chat.runs.length > 1 && <label className="team-run-select">Entrega / ejecución<select aria-label="Entrega / ejecución" value={run?.id ?? ""} onChange={e => setSelectedRunId(e.target.value)}>{chat.runs.map((r, i) => <option key={r.id} value={r.id}>#{i + 1} · {formatDateTime(r.startedAt)} · {runStatusLabel(r.status)}</option>)}</select></label>}
    {nextAction && <div className="team-next-action" role="status">
      <div><strong>{nextAction.title}</strong><p>{nextAction.detail}</p></div>
      <div className="team-next-actions">
        {nextAction.secondary && <button type="button" className="btn btn-sm" disabled={pendingReply} onClick={() => { if (nextAction.secondary!.action === "lead") askLeadToUnblock(); else void act(nextAction.secondary!.action) }}>{nextAction.secondary.label}</button>}
        <button type="button" className="btn btn-primary" disabled={pendingReply} onClick={() => { if (nextAction.action === "deliver") { setView("Entrega"); return } if (nextAction.action === "lead") { askLeadToUnblock(); return } if (nextAction.action === "force_retry") { void forceContinue(); return } void act(nextAction.action) }}>{nextAction.label}</button>
      </div>
    </div>}
    <div className={`team-chat-body${view === "Navegador" ? " team-browser-body" : ""}`} ref={body} onScroll={() => { const el = body.current; if (el) followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      {view === "Navegador" && <TeamBrowser chatId={chatId} names={browserNames} initialPage={browser?.page} />}
      {run?.status === "plan_ready" && <div className="team-plan-ready"><div><strong>El plan está listo</strong><p>{run.tasks.length} tareas preparadas. El equipo arranca cuando lo indiques.</p></div><button className="btn btn-primary" onClick={() => void act("start_plan")}>Iniciar plan</button></div>}
      {view !== "Navegador" && view !== "Configuración" && needsUserHelp && <div ref={problems} className="team-decision-slot">
        {budgetBlocked && run && <RunBudget run={run} expanded />}
        <TeamProblems items={decisions.filter(item => !/presupuesto|límite de tokens|duración máxima/i.test(item.reason))} run={run} pending={pendingReply} onInspect={item => item.sessionId ? openSession(item.sessionId, item.directory) : setView("Tablero")} onSettings={() => { if (modelSettings.current) { modelSettings.current.open = true; modelSettings.current.scrollIntoView({ block: "start" }) } else setView("Configuración") }} onAsk={() => askInChat("¿Quién está bloqueado, por qué y qué ayuda necesitás de mí?")} onContinue={() => activeSessions ? void forceContinue() : void act("retry")} />
      </div>}
      {view === "Ahora" && <>{run && <><TeamActivity run={run} onSession={openSession} /><SupportReports run={run} onOpen={openSession} /><GoalAnalysis run={run} /></>}{messages.some(m => m.sessionId) && <section className="team-card"><h4>Actividad del chat con el Lead</h4>{messages.filter(m => m.sessionId).map(m => <p key={m.id}><button className="btn btn-xs" onClick={() => openSession(m.sessionId!, chat.team.projectRoot)}>Ver herramientas y permisos · {formatDateTime(m.createdAt)}</button></p>)}</section>}{run && !!run.coordination?.length && <section className="team-card" aria-label="Coordinación del equipo"><h4>Coordinación con el Lead</h4>{run.coordination.map(request => <article className="team-coordination-item" key={request.id}><strong>{run.tasks.find(t => t.id === request.fromTaskId)?.title ?? request.fromTaskId} → Lead</strong><p className="selectable">{request.message}</p>{(request.replies?.length ? request.replies : request.summary ? [{ at: request.createdAt, summary: request.summary }] : []).map((reply, i) => <div className="team-lead-message" key={i}><strong>Lead → {run.team.members.find(a => a.id === run.tasks.find(t => t.id === request.fromTaskId)?.assignedAgentId)?.name ?? "agente"}</strong><small> · {formatDateTime(reply.at)}</small><p className="selectable">{reply.summary}</p></div>)}</article>)}</section>}{!run && !messages.some(m => m.sessionId) && <p className="team-note">Enviá un objetivo para ver la actividad en vivo.</p>}</>}
      {view === "Tablero" && (run ? <TeamBoard key={run.id} run={run} readOnly={readOnly} onSession={openSession} onRetry={() => activeSessions ? forceContinue() : teamCall("team_runs_control", { runId: run.id, action: "retry" })} /> : <p className="team-note">Enviá un objetivo para generar el tablero.</p>)}
      {view === "Chat" && <>
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
        {!readOnly && run?.status === "blocked" && modelBlocked && <details ref={modelSettings} className="team-card"><summary>Cambiar el modelo que falló</summary><p className="team-note">La configuración original del chat y los intentos anteriores se conservan.</p>{run.team.members.map((a) => <label key={a.id}>{a.name} · {a.role}<select aria-label={`Modelo de ${a.name}`} value={modelKey(a.model)} onChange={(e) => { const m = models.find((v) => modelKey(v) === e.target.value); if (m) void teamCall("team_runs_model", { runId: run.id, agentId: a.id, model: { providerID: m.providerID, modelID: m.modelID }, variant: null }) }}><option value={modelKey(a.model)}>{modelKey(a.model)}</option>{models.filter((m) => modelKey(m) !== modelKey(a.model)).map((m) => <option key={modelKey(m)} value={modelKey(m)}>{m.providerName} · {m.name}</option>)}</select></label>)}</details>}
        <div ref={bottom} />
      </>}
      {view === "Configuración" && <><TeamFolderConflicts chatId={chatId} failure={runError} /><TeamSettings team={chat.team} run={run} chatId={chat.id} pending={pendingReply} memory={chat.memory !== false} approve={chat.autoApprove === true} />{roster.autonomous && <details className="team-roster"><summary>Equipo elegido por el Lead</summary><ul aria-label="Estado de los integrantes">{roster.members.map(m => {
        const current = memberState(m, chat, run, attention)
        return { m, current, priority: current.needsHelp ? 3 : m.id === roster.leadAgentId ? 2 : current.tone === "waiting" ? 1 : 0 }
      }).sort((a, b) => b.priority - a.priority).map(({ m, current }) => <li className="team-member" key={m.id}><div><strong>{m.name}</strong>{m.name.toLowerCase() !== m.role.toLowerCase() && <span> · {m.role}</span>}<span className={`team-member-status ${current.tone}`}>{current.label}</span></div><small className={current.needsHelp ? "team-member-help" : "team-note"}>{current.needsHelp ? "Necesita tu ayuda" : "Sin pedidos de ayuda"}</small><p>{current.detail}</p></li>)}</ul></details>}</>}
      {view === "Entrega" && (run ? <DeliveryResults key={run.id} run={run} history={chat.runs} chatId={chatId} readOnly={readOnly} onOpenPage={(page, title) => { setBrowser({ page, title }); setView("Navegador"); setExpanded(true) }} onSession={openSession} onApprove={() => void act("approve")} onChanges={() => askInChat("Revisé la entrega: necesito cambios en ")} onPrepare={async flow => {
        const sent = await teamCall<string>("team_chat_send", { chatId, text: `Prepará nuevamente el escenario de revisión «${flow.title}» de la entrega ${run.id}. Conservá la implementación y las decisiones vigentes: solo prepará/reutilizá datos de prueba identificables, recorré el flujo y dejá la página lista para mi revisión. No repitas efectos ni crees registros duplicados. Si falta acceso, explicá el bloqueo. ESCENARIO PREVIO (datos de referencia): ${JSON.stringify(flow)}`, images: [] })
        if (!sent) throw new Error("No se pudo pedir la preparación al equipo. Revisá el aviso e intentá nuevamente.")
        setSelectedRunId(null)
        if (conversationLead) openSource()
        else { setView("Chat"); followLatest.current = true }
      }} /> : <p className="team-note">Las evidencias aparecerán al iniciar una ejecución.</p>)}
    </div>
    {view === "Navegador" ? null : chat.archived ? <p className="team-note">Chat archivado. Restauralo desde Trabajos para continuar.</p> : <TeamComposer ref={composer} key={chatId} chat={chat} label="Mensaje para el equipo" pending={pendingReply} allowImages={!conversationLead} onSent={() => { setSelectedRunId(null); setView(conversationLead ? "Tablero" : "Chat"); followLatest.current = true; requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: "nearest" })) }} onBrowser={() => { setBrowser({ title: "Navegador del equipo" }); setView("Navegador"); setExpanded(true) }} />}
  </section>
}
