import { useEffect, useMemo, useState } from "react"
import { Icon } from "../components/ui"
import { SessionPane } from "../agent/AgentPanel"
import { PreviewPane } from "../agent/PreviewHost"
import { PreviewConversation } from "../agent/PreviewConversation"
import { PreviewLibrary } from "../agent/PreviewLibrary"
import { previewIdentityFor, usePreviewTaskId } from "../agent/preview-identity"
import { newSession, rememberPreviewTask, selectSession, useAgent } from "../state/agent"
import { loadMemory, openMemory, useMemory } from "../state/memory"
import { useProject } from "../state/project"
import { useTeams } from "../state/teams"
import { useStudio, type StudioMode } from "../state/studio"
import { TeamWorkspace } from "../team/TeamWorkspace"
import { previewIdentityKey, type PreviewEditorContext } from "../preview"

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

function ResearchSidebar() {
  const sessionId = useAgent(s => s.activeSessionId)
  const messages = useAgent(s => sessionId ? s.views[sessionId]?.messages : undefined)
  const todos = useAgent(s => sessionId ? s.todos[sessionId] : undefined)
  const memoryEnabled = useAgent(s => sessionId ? s.memoryEnabled[sessionId] !== false : true)
  const notes = useMemory(s => s.data.notes)
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
    <section className="studio-side-section"><h3>Fuentes <span>{sources.length} enlaces</span></h3><p className="studio-muted">Enlaces citados en la conversación</p>
      {sources.map(url => <a className="studio-source" href={url} key={url} target="_blank" rel="noreferrer" title={url}>{new URL(url).hostname.replace(/^www\./, "")}{new URL(url).pathname === "/" ? "" : new URL(url).pathname}<Icon name="link-external" /></a>)}
      {!sources.length && <div className="research-empty-context"><Icon name="link-external" /><p>Tu biblioteca de fuentes empieza acá.<small>Los enlaces citados se reúnen automáticamente.</small></p></div>}
    </section>
    <section className="studio-side-section"><h3>Memoria del proyecto</h3><div className="studio-summary-card"><strong>{notes.length} notas compartidas</strong><span className={memoryEnabled ? "studio-live" : "studio-muted"}>{memoryEnabled ? "habilitada" : "desactivada"}</span><p>Preferencias, contexto y decisiones del proyecto.</p></div></section>
    <section className="studio-side-section"><h3>Plan</h3>{todos?.length ? <ol className="studio-plan">{todos.map((todo, index) => <li key={todo.id ?? index} className={todo.status === "completed" ? "done" : ""}><Icon name={todo.status === "completed" ? "check" : todo.status === "in_progress" ? "circle-filled" : "circle-outline"} /><span>{todo.content}</span></li>)}</ol> : <div className="research-empty-context"><Icon name="checklist" /><p>Un paso a la vez.<small>El plan aparece cuando la conversación lo necesita.</small></p></div>}</section>
    {!!todos?.length && <section className="studio-side-section"><h3>Progreso</h3><p className="studio-muted">{completed} de {todos.length} pasos completados</p><progress className="studio-progress" max={todos.length} value={completed} /></section>}
    <div className="studio-bottom-action"><p className="studio-muted">Continuá con el Lead y sus especialistas.</p><button type="button" className="btn btn-primary" onClick={() => useStudio.getState().setMode("team")}>Pasar al modo Equipo <Icon name="arrow-right" /></button></div>
  </aside>
}

function ResearchWorkspace() {
  const activeId = useAgent(s => s.activeSessionId)
  const sessions = useAgent(s => s.allSessions)
  const active = sessions.find(session => session.id === activeId)
  return <div className="studio-columns studio-research">
    <aside className="studio-sidebar" aria-label="Investigaciones"><section className="studio-side-section"><h3>Investigación</h3><button type="button" className="studio-nav-item active" onClick={() => { useTeams.setState({ activeChatId: null }); newSession() }}><Icon name="add" /> Nueva consulta</button></section><MemoryCards /></aside>
    <main className="studio-content"><header className="studio-page-heading research-heading"><div className="research-heading-icon"><Icon name="search" /></div><h1>Investigación profunda</h1><span className="research-heading-session" title={active?.title}>{active?.title || "Nueva conversación"}</span></header><SessionPane sessionId={activeId} variant="panel" onPreviewOpen={() => useStudio.getState().setMode("design")} /></main>
    <ResearchSidebar />
  </div>
}

function DesignWorkspace() {
  const root = useProject(s => s.root)
  const activeId = useAgent(s => s.activeSessionId)
  const taskId = usePreviewTaskId(activeId)
  const identity = taskId ? previewIdentityFor(root, activeId, taskId) : null
  const [library, setLibrary] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [context, setContext] = useState<PreviewEditorContext>({ saving: true })
  return <main className="studio-design"><header className="studio-design-toolbar"><div><Icon name="paintcan" /><strong>Diseño del proyecto</strong><span>/ Editor visual</span></div><div><button type="button" className="btn btn-sm" onClick={() => setLibrary(true)}><Icon name="library" /> Diseños guardados</button><button type="button" className="btn btn-sm" aria-pressed={chatOpen} disabled={!identity} onClick={() => setChatOpen(value => !value)}><Icon name="comment-discussion" /> Chat del diseño</button></div></header>
    <div className={`studio-design-body${chatOpen && identity ? " with-conversation" : ""}`}>
      {identity ? <PreviewPane key={previewIdentityKey(identity)} identity={identity} onClose={() => useStudio.getState().setMode("research")} onContextChange={setContext} /> : <div className="studio-empty"><Icon name="paintcan" /><h1>Tu próxima idea empieza acá</h1><p>Abrí un diseño guardado o iniciá una conversación para crear y ajustar sus pantallas.</p><button type="button" className="btn btn-primary" onClick={() => setLibrary(true)}>Abrir diseños guardados</button><button type="button" className="btn" onClick={() => useStudio.getState().setMode("research")}>Ir a la conversación</button></div>}
      {chatOpen && identity && <PreviewConversation key={previewIdentityKey(identity)} identity={identity} context={context} />}
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
