import { useEffect, useMemo, useRef, useState } from "react"
import { Icon } from "../components/ui"
import { SessionPane } from "../agent/AgentPanel"
import { PreviewPane } from "../agent/PreviewHost"
import { PreviewConversation } from "../agent/PreviewConversation"
import { PreviewLibrary } from "../agent/PreviewLibrary"
import { previewIdentityFor, usePreviewTaskId } from "../agent/preview-identity"
import { newSession, rememberPreviewTask, selectSession, sessionInProject, focusComposer, sendPrompt, useAgent } from "../state/agent"
import { loadMemory, openMemory, useMemory } from "../state/memory"
import { useProject } from "../state/project"
import { selectTeamChat, useTeams } from "../state/teams"
import { openFallbackModels, setContinuousMode } from "../state/fallback"
import { useStudio, type StudioMode } from "../state/studio"
import { unarchivedSessions } from "../lib/sessions"
import { notify } from "../state/toasts"
import { TeamWorkspace } from "../team/TeamWorkspace"
import { runStatusLabel, type TeamChatRecord } from "../team/types"
import { previewIdentityKey, type PreviewEditorContext } from "../preview"

const LEAD_IMPLEMENT_PROMPT = "Implementá esto con el equipo usando el plan y el diseño aprobado."
const LEAD_CONTINUOUS_PROMPT = " Trabajá de forma continua: corregí los problemas que encuentres y seguí hasta dejar el trabajo verificado, sin pedirme confirmaciones innecesarias."

function MemoryCards() {
  const data = useMemory(s => s.data)
  const error = useMemory(s => s.error)
  const loaded = useMemory(s => s.loaded)
  const open = (id?: string) => {
    openMemory("notes", id ? { kind: "notes", id } : undefined)
    useStudio.getState().setMode("code")
  }
  return <section className="studio-side-section">
    <h3>Memoria compartida <span className="studio-live">local</span></h3>
    {error ? <p role="alert" className="team-error">{error}</p> : data.notes.slice(0, 4).map(note => <button type="button" className="studio-memory-card" key={note.id} onClick={() => open(note.id)}><strong>{note.title}</strong><small>{note.kind}</small></button>)}
    {!error && !data.notes.length && <p className="studio-muted">{loaded ? "Todavía no hay notas compartidas." : "Cargando memoria…"}</p>}
    <button type="button" className="studio-text-button" onClick={() => open()}>+ Gestionar notas</button>
  </section>
}

function ResearchSidebar({ leadChat, continuousOn, onToggleContinuous, onImplement, implementing, onCollapse }: {
  leadChat: TeamChatRecord | undefined
  continuousOn: boolean
  onToggleContinuous: () => Promise<void>
  onImplement: () => Promise<void>
  implementing: boolean
  onCollapse: () => void
}) {
  const sessionId = useAgent(s => s.activeSessionId)
  const messages = useAgent(s => sessionId ? s.views[sessionId]?.messages : undefined)
  const todos = useAgent(s => sessionId ? s.todos[sessionId] : undefined)
  const memoryEnabled = useAgent(s => sessionId ? s.memoryEnabled[sessionId] !== false : true)
  const leadRun = leadChat?.runs.at(-1)
  const notes = useMemory(s => s.data.notes)
  const [sourcesOpen, setSourcesOpen] = useState(true)
  const sources = useMemo(() => {
    const urls = new Set<string>()
    for (const message of messages ?? []) {
      if (message.info.role !== "assistant") continue
      for (const part of message.parts) {
        if (part.type !== "text") continue
        for (const match of part.text.matchAll(/https?:\/\/[^\s<>"'\])]+/g)) {
          try { const url = new URL(match[0].replace(/[.,;:!?]+$/, "")); if (url.protocol === "https:" || url.protocol === "http:") urls.add(url.href) } catch { /* Incomplete link in a streaming response. */ }
        }
      }
    }
    return [...urls]
  }, [messages])
  const completed = todos?.filter(todo => todo.status === "completed").length ?? 0
  return <aside className="studio-inspector" aria-label="Contexto de investigación">
    <div className="studio-inspector-bar"><span>Contexto</span><button type="button" className="studio-collapse" title="Ocultar contexto" aria-label="Ocultar contexto" onClick={onCollapse}><Icon name="chevron-right" /></button></div>
    <section className="studio-side-section">
      <div className="studio-side-head">
        <h3>Fuentes</h3>
        <button type="button" className="studio-section-toggle" aria-expanded={sourcesOpen} aria-label={`${sourcesOpen ? "Ocultar" : "Mostrar"} fuentes`} onClick={() => setSourcesOpen(value => !value)}>
          <span>{sources.length}</span><Icon name={sourcesOpen ? "chevron-up" : "chevron-down"} />
        </button>
      </div>
      {sourcesOpen && <>
        <p className="studio-muted">Enlaces citados en la conversación</p>
        {sources.map(url => <a className="studio-source" href={url} key={url} target="_blank" rel="noreferrer" title={url}>{new URL(url).hostname.replace(/^www\./, "")}{new URL(url).pathname === "/" ? "" : new URL(url).pathname}<Icon name="link-external" /></a>)}
        {!sources.length && <div className="research-empty-context"><Icon name="link-external" /><p>Tu biblioteca de fuentes empieza acá.<small>Los enlaces citados se reúnen automáticamente.</small></p></div>}
      </>}
    </section>
    <section className="studio-side-section"><h3>Memoria del proyecto</h3><div className="studio-summary-card"><strong>{notes.length} notas compartidas</strong><span className={memoryEnabled ? "studio-live" : "studio-muted"}>{memoryEnabled ? "habilitada" : "desactivada"}</span><p>Preferencias, contexto y decisiones del proyecto.</p></div></section>
    <section className="studio-side-section"><h3>Plan</h3>{todos?.length ? <ol className="studio-plan">{todos.map((todo, index) => <li key={todo.id ?? index} className={todo.status === "completed" ? "done" : ""}><Icon name={todo.status === "completed" ? "check" : todo.status === "in_progress" ? "circle-filled" : "circle-outline"} /><span>{todo.content}</span></li>)}</ol> : <div className="research-empty-context"><Icon name="checklist" /><p>Un paso a la vez.<small>El plan aparece cuando la conversación lo necesita.</small></p></div>}</section>
    {!!todos?.length && <section className="studio-side-section"><h3>Progreso</h3><p className="studio-muted">{completed} de {todos.length} pasos completados</p><progress className="studio-progress" max={todos.length} value={completed} /></section>}
    <div className="studio-bottom-action research-lead-card">
      <span className="research-lead-eyebrow">Lead del equipo</span>
      {leadChat ? <>
        <strong className="research-lead-status"><span className="studio-member-dot is-active" /> {leadRun ? runStatusLabel(leadRun.status) : "Equipo vinculado"}</strong>
        <p className="studio-muted">El plan, las tareas y las evidencias viven en el tablero de este equipo.</p>
        <button type="button" className={`studio-continuous${continuousOn ? " is-on" : ""}`} role="switch" aria-checked={continuousOn} onClick={() => void onToggleContinuous()}><Icon name={continuousOn ? "circle-filled" : "circle-outline"} /><span>Trabajo continuo</span><em>{continuousOn ? "activado" : "desactivado"}</em></button>
        <p className="studio-muted">Si el modelo se corta, sigue con otro y termina las correcciones.</p>
        <button type="button" className="btn btn-primary" onClick={() => selectTeamChat(leadChat.id)}>Ver tablero <Icon name="arrow-right" /></button>
      </> : <>
        <p>Si decís «vamos a implementarlo», toda esta charla pasa a ser el Lead del equipo.</p>
        <button type="button" className={`studio-continuous${continuousOn ? " is-on" : ""}`} role="switch" aria-checked={continuousOn} onClick={() => void onToggleContinuous()}><Icon name={continuousOn ? "circle-filled" : "circle-outline"} /><span>Trabajo continuo</span><em>{continuousOn ? "activado" : "desactivado"}</em></button>
        <p className="studio-muted">Si el modelo se corta, sigue con otro y termina las correcciones.</p>
        <button type="button" className="btn btn-primary" disabled={implementing} onClick={() => void onImplement()}>{implementing ? "Enviando…" : "Implementar con el equipo"} <Icon name="arrow-right" /></button>
        <small className="studio-muted">No se abre otra conversación.</small>
      </>}
    </div>
  </aside>
}

const RESEARCH_STARTERS = [
  { icon: "telescope", title: "Investigar una decisión", text: "Compará las alternativas que estoy evaluando y recomendá una con fundamentos." },
  { icon: "book", title: "Revisar documentación", text: "Buscá en la documentación oficial cómo se hace esto y resumí los pasos." },
  { icon: "law", title: "Analizar el código", text: "Explicame cómo funciona este módulo, sus límites y qué conviene tocar." },
  { icon: "checklist", title: "Preparar una propuesta", text: "Reuní antecedentes, riesgos y próximos pasos sobre este tema." },
]

function ResearchWelcome() {
  return <div className="agent-welcome research-welcome">
    <div className="agent-welcome-hero research-welcome-hero">
      <span className="research-welcome-badge" aria-hidden="true"><Icon name="telescope" /></span>
      <h2>¿Qué querés investigar?</h2>
      <p>Cruzá memoria compartida, navegador y fuentes en una conversación. El agente cita lo que encuentra y arma el plan paso a paso.</p>
    </div>
    <div className="agent-suggestions research-starters">
      {RESEARCH_STARTERS.map(starter => <button key={starter.title} type="button" className="agent-suggestion" onClick={() => focusComposer(starter.text)}>
        <Icon name={starter.icon} />
        <span><strong>{starter.title}</strong><em>{starter.text}</em></span>
      </button>)}
    </div>
    <p className="research-welcome-hint"><Icon name="link-external" /> Las fuentes citadas se reúnen en «Fuentes», a la derecha.</p>
  </div>
}

function ResearchWorkspace() {
  const activeId = useAgent(s => s.activeSessionId)
  const sessions = useAgent(s => s.allSessions)
  const root = useProject(s => s.root)
  const layout = useStudio(s => s.layouts.research)
  const setLayout = useStudio(s => s.setLayout)
  const leadChat = useTeams(s => s.chats.find(chat => chat.origin?.sessionId === activeId))
  const [continuous, setContinuous] = useState(false)
  const [implementing, setImplementing] = useState(false)
  const continuousPending = useRef(false)
  const continuousOn = leadChat ? leadChat.continuousMode === true : continuous
  useEffect(() => {
    if (!leadChat || !continuousPending.current) return
    continuousPending.current = false
    if (leadChat.continuousMode !== true) void setContinuousMode(leadChat.id, true)
  }, [leadChat])
  const recent = unarchivedSessions(sessions).filter(session => !session.parentID && sessionInProject(session)).slice(0, 12)
  const active = sessions.find(session => session.id === activeId)
  const implement = async () => {
    if (implementing) return
    setImplementing(true)
    continuousPending.current = continuous
    try { await sendPrompt(continuous ? `${LEAD_IMPLEMENT_PROMPT}${LEAD_CONTINUOUS_PROMPT}` : LEAD_IMPLEMENT_PROMPT, root, null, activeId) }
    catch (e) { notify.error("No se pudo pedir la implementación", e instanceof Error ? e.message : String(e)) }
    finally { setImplementing(false) }
  }
  const toggleContinuous = async () => {
    const next = !continuousOn
    if (leadChat) { await setContinuousMode(leadChat.id, next); return }
    if (next && !useTeams.getState().fallbackModels?.length) {
      if (!await openFallbackModels() || !useTeams.getState().fallbackModels?.length) return
    }
    setContinuous(next)
  }
  const continuousPill = <button type="button" className={`composer-pill${continuousOn ? " on" : ""}`} aria-pressed={continuousOn} aria-label="Trabajo continuo" title={continuousOn ? "Trabajo continuo activado" : "Activar trabajo continuo"} onClick={() => void toggleContinuous()}><Icon name={continuousOn ? "circle-filled" : "sync"} /><span>Trabajo continuo</span></button>
  return <div className={`studio-columns studio-research${layout.sidebarCollapsed ? " sidebar-collapsed" : ""}${layout.inspectorCollapsed ? " inspector-collapsed" : ""}${layout.chatExpanded ? " chat-expanded" : ""}`}>
    <aside className="studio-sidebar" aria-label="Investigaciones">
      <section className="studio-side-section">
        <div className="studio-side-head"><h3>Investigación</h3><button type="button" className="studio-collapse" title="Ocultar lateral" aria-label="Ocultar lateral" onClick={() => setLayout("research", { sidebarCollapsed: true })}><Icon name="chevron-left" /></button></div>
        <button type="button" className={`studio-nav-item${activeId ? "" : " active"}`} onClick={() => { useTeams.setState({ activeChatId: null }); newSession() }}><Icon name="add" /> Nueva consulta</button>
        <div className="studio-session-list">{recent.map(session => <button type="button" className={`studio-nav-item${session.id === activeId ? " selected" : ""}`} key={session.id} title={session.title || "Sin título"} onClick={() => selectSession(session.id)}>{session.title || "Sin título"}</button>)}</div>
      </section>
      <MemoryCards />
    </aside>
    <main className="studio-content">
      <header className="studio-page-heading research-heading">
        {layout.sidebarCollapsed && <button type="button" className="studio-collapse" title="Mostrar lateral" aria-label="Mostrar lateral" onClick={() => setLayout("research", { sidebarCollapsed: false })}><Icon name="chevron-right" /></button>}
        <div className="research-heading-icon"><Icon name="search" /></div>
        <h1>Investigación profunda</h1>
        <span className="research-heading-session" title={active?.title}>{active?.title || "Nueva conversación"}</span>
        <div className="studio-heading-actions">
          {layout.inspectorCollapsed && <button type="button" className="studio-collapse" title="Mostrar contexto" aria-label="Mostrar contexto" onClick={() => setLayout("research", { inspectorCollapsed: false })}><Icon name="layout-sidebar-right" /></button>}
          <button type="button" className={`studio-chat-expand${layout.chatExpanded ? " is-expanded" : ""}`} aria-pressed={layout.chatExpanded} title={layout.chatExpanded ? "Restaurar el chat" : "Ampliar el chat"} onClick={() => setLayout("research", { chatExpanded: !layout.chatExpanded })}><Icon name={layout.chatExpanded ? "screen-normal" : "screen-full"} /><span>{layout.chatExpanded ? "Restaurar" : "Ampliar chat"}</span></button>
        </div>
      </header>
      <SessionPane sessionId={activeId} variant="panel" emptyState={<ResearchWelcome />} preferences={continuousPill} onPreviewOpen={() => useStudio.getState().setMode("design")} />
    </main>
    <ResearchSidebar leadChat={leadChat} continuousOn={continuousOn} onToggleContinuous={toggleContinuous} onImplement={implement} implementing={implementing} onCollapse={() => setLayout("research", { inspectorCollapsed: true })} />
  </div>
}

function DesignWorkspace() {
  const root = useProject(s => s.root)
  const activeId = useAgent(s => s.activeSessionId)
  const taskId = usePreviewTaskId(activeId)
  const identity = taskId ? previewIdentityFor(root, activeId, taskId) : null
  const layout = useStudio(s => s.layouts.design)
  const setLayout = useStudio(s => s.setLayout)
  const [library, setLibrary] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [context, setContext] = useState<PreviewEditorContext>({ saving: true })
  const expanded = chatOpen && layout.chatExpanded
  return <main className="studio-design"><header className="studio-design-toolbar"><div><Icon name="paintcan" /><strong>Diseño del proyecto</strong><span>/ Editor visual</span></div><div><button type="button" className="btn btn-sm" onClick={() => setLibrary(true)}><Icon name="library" /> Diseños guardados</button><button type="button" className="btn btn-sm" aria-pressed={chatOpen} disabled={!identity} onClick={() => setChatOpen(value => !value)}><Icon name="comment-discussion" /> Chat del diseño</button>{chatOpen && <button type="button" className="btn btn-sm" aria-pressed={layout.chatExpanded} onClick={() => setLayout("design", { chatExpanded: !layout.chatExpanded })}><Icon name={layout.chatExpanded ? "screen-normal" : "screen-full"} /> {layout.chatExpanded ? "Restaurar" : "Ampliar chat"}</button>}{expanded && <span className="studio-chip">Ampliado</span>}</div></header>
    <div className={`studio-design-body${chatOpen && identity ? " with-conversation" : ""}${expanded ? " chat-expanded" : ""}`}>
      {identity ? <PreviewPane key={previewIdentityKey(identity)} identity={identity} onClose={() => useStudio.getState().setMode("research")} onContextChange={setContext} /> : <div className="studio-empty"><Icon name="paintcan" /><h1>Tu próxima idea empieza acá</h1><p>Abrí un diseño guardado o iniciá una conversación para crear y ajustar sus pantallas.</p><button type="button" className="btn btn-primary" onClick={() => setLibrary(true)}>Abrir diseños guardados</button><button type="button" className="btn" onClick={() => useStudio.getState().setMode("research")}>Ir a la conversación</button></div>}
      {chatOpen && identity && <PreviewConversation key={previewIdentityKey(identity)} identity={identity} context={context} expanded={layout.chatExpanded} />}
    </div>
    {library && root && <PreviewLibrary projectRoot={root} onClose={() => setLibrary(false)} onOpen={design => { rememberPreviewTask(root, design.identity.sessionId, design.identity.taskId); selectSession(design.identity.sessionId); setContext({ saving: true }); setLibrary(false) }} />}
  </main>
}

export function StudioWorkspace({ mode }: { mode: Exclude<StudioMode, "code"> }) {
  const root = useProject(s => s.root)
  const [visited, setVisited] = useState([mode])
  if (!visited.includes(mode)) setVisited([...visited, mode])
  useEffect(() => { if (root) void loadMemory(root) }, [root])
  return <div className={`studio-workspace mode-${mode}`}>{visited.map(view => <div className="studio-mode-page" key={view} hidden={view !== mode}>{view === "design" ? <DesignWorkspace /> : view === "team" ? <TeamWorkspace /> : <ResearchWorkspace />}</div>)}</div>
}
