import { useState } from 'react'
import { abortSession, sendPrompt, useAgent } from '../state/agent'
import { errorMessage } from '../lib/tauri'
import type { PreviewEditorContext, PreviewIdentity } from '../preview/types'
import { Chat } from './Chat'
import { PermissionCard, QuestionCard } from './Interactions'

export function PreviewConversation({ identity, context, expanded = false }: { identity: PreviewIdentity; context: PreviewEditorContext; expanded?: boolean }) {
  const session = useAgent(s => s.allSessions.find(item => item.id === identity.conversationId))
  const connected = useAgent(s => s.connected)
  const status = useAgent(s => s.statuses[identity.conversationId]?.type ?? 'idle')
  const permissions = useAgent(s => s.permissions)
  const questions = useAgent(s => s.questions)
  const sessions = useAgent(s => s.allSessions)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const busy = status === 'busy' || status === 'retry'
  const children = new Set(sessions.filter(item => item.parentID === identity.conversationId).map(item => item.id))
  const mine = (id: string) => id === identity.conversationId || children.has(id)
  const submit = async () => {
    if (!text.trim() || sending || busy || context.saving || !context.revisionId || !connected || !session) return
    setSending(true); setError('')
    const sent = text
    try {
      await sendPrompt(sent, identity.project, null, identity.conversationId, { identity, ...context })
      setText(current => current === sent ? '' : current)
    } catch (e) { setError(errorMessage(e)) }
    finally { setSending(false) }
  }
  return <aside className="preview-conversation" aria-label="Agente de previsualización">
    <header><strong>Conversá sobre el diseño</strong>{expanded && <span className="studio-chip">Ampliado</span>}<p>Mismo agente y conversación. Pedí cambios sin salir del editor.</p></header>
    <div className="preview-conversation-history">{session ? <Chat session={session} busy={busy} /> : <p className="preview-note">La conversación se mostrará al cargar la sesión.</p>}</div>
    <div className="preview-conversation-interactions">{permissions.filter(item => mine(item.sessionID)).map(request => <PermissionCard key={request.id} request={request} />)}{questions.filter(item => mine(item.sessionID)).map(request => <QuestionCard key={request.id} request={request} />)}</div>
    <form onSubmit={event => { event.preventDefault(); void submit() }}>
      <p className="preview-note">{context.nodeId ? `Capa: ${context.nodeId}` : 'Diseño completo'}{context.screenId ? ` · Pantalla: ${context.screenId}` : ''}</p>
      <label htmlFor="preview-agent-request">Pedile un cambio al agente</label>
      <textarea id="preview-agent-request" value={text} onChange={event => setText(event.target.value)} placeholder="Agregá una pantalla de inicio de sesión y mantené estos colores…" rows={3} />
      {error && <p role="alert">{error}</p>}
      {!connected && <p role="status">Conectando con el agente…</p>}
      <div>{busy && <button type="button" className="btn btn-sm" onClick={() => void abortSession(identity.conversationId)}>Detener agente</button>}<button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || sending || busy || context.saving || !context.revisionId || !connected || !session}>{sending ? 'Enviando…' : busy ? 'El agente está trabajando…' : 'Pedir cambio'}</button></div>
    </form>
  </aside>
}
