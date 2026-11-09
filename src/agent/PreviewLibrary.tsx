import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../components/ui'
import { errorMessage } from '../lib/tauri'
import { formatDateTime } from '../lib/time'
import { loadPreviewLibrary, type PreviewLibraryResult, type SavedPreview } from '../preview/library'
import { useAgent } from '../state/agent'
import './preview-host.css'

export function PreviewLibrary({ projectRoot, onOpen, onClose }: { projectRoot: string; onOpen: (design: SavedPreview) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [refresh, setRefresh] = useState(0)
  const [result, setResult] = useState<PreviewLibraryResult | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  useEffect(() => {
    let disposed = false
    setResult(null); setError('')
    void loadPreviewLibrary(projectRoot).then(value => { if (!disposed) setResult(value) }).catch(e => { if (!disposed) setError(errorMessage(e)) })
    return () => { disposed = true }
  }, [projectRoot, refresh])
  const sessions = useAgent(state => state.allSessions)
  const titles = useMemo(() => new Map((sessions ?? []).map(session => [session.id, session.title?.trim() || 'Sin título'])), [sessions])
  const conversationTitle = (sessionId: string) => titles.get(sessionId) ?? 'Sin título'
  const designs = (result?.designs ?? []).filter(design => {
    const approved = design.approvedRevisionId === design.currentRevisionId
    return (filter === 'all' || (filter === 'approved' ? approved : !approved)) && `${design.title} ${conversationTitle(design.identity.sessionId)} ${design.identity.taskId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  })
  return createPortal(<dialog ref={dialog} className="preview-library" aria-label="Diseños guardados" onCancel={event => { event.preventDefault(); onClose() }}>
    <header><div><h2><Icon name="library" /> Diseños</h2><p>Los diseños guardados de este proyecto, con su conversación y sus revisiones.</p></div><button type="button" className="btn btn-sm" onClick={onClose}>Cerrar diseños</button></header>
    <div className="preview-library-tools"><label>Buscar diseños<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nombre, conversación o tarea…" /></label><label>Estado<select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Todos</option><option value="draft">Borradores</option><option value="approved">Aprobados</option></select></label><button type="button" className="btn btn-sm" onClick={() => setRefresh(value => value + 1)}>Recargar diseños</button></div>
    <div className="preview-library-body">
      {error && <p role="alert">No se pudieron cargar los diseños: {error}</p>}
      {!result && !error && <p role="status">Cargando diseños guardados…</p>}
      {!!result?.unreadable && <p role="status">No se pudieron leer {result.unreadable} registros. Se conservaron sin modificar.</p>}
      {result && !result.designs.length && <div className="preview-library-empty"><Icon name="paintcan" /><h3>Todavía no hay diseños guardados</h3><p>Pedile al agente una previsualización en una conversación de este proyecto. Cuando genere un borrador, aparecerá acá automáticamente.</p></div>}
      {result && result.designs.length > 0 && !designs.length && <p role="status">No hay diseños que coincidan con la búsqueda y el estado elegidos.</p>}
      <ul className="preview-library-grid">{designs.map(design => {
        const approved = design.approvedRevisionId === design.currentRevisionId
        const date = new Date(design.updatedAt), validDate = Number.isFinite(date.getTime())
        return <li key={JSON.stringify(design.identity)}><button type="button" className="preview-library-card" aria-label={`Abrir diseño ${design.title}`} onClick={() => onOpen(design)}>
          <div className="preview-library-card-top"><Icon name="paintcan" /><span className={approved ? 'approved' : 'draft'}>{approved ? 'Aprobado' : design.approvedRevisionId ? 'Borrador nuevo' : 'Borrador'}</span></div>
          <strong>{design.title}</strong><span>{design.screenCount} {design.screenCount === 1 ? 'pantalla' : 'pantallas'} · {design.revisionCount} {design.revisionCount === 1 ? 'revisión' : 'revisiones'}</span>
          <small title={design.identity.sessionId}>Conversación: {conversationTitle(design.identity.sessionId)}</small><time dateTime={validDate ? date.toISOString() : undefined}>{validDate ? formatDateTime(design.updatedAt) : 'Fecha no disponible'}</time><span className="preview-library-open">Abrir en el editor <Icon name="arrow-right" /></span>
        </button></li>
      })}</ul>
    </div>
  </dialog>, document.body)
}
