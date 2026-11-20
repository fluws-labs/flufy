import { Icon } from "./ui"
import { shortAgo, timeAgo } from "../lib/time"
import type { AgentInboxItem } from "../state/agentProfile"

type Props = {
  items: AgentInboxItem[]
  dismissing: string | null
  onOpen: (item: AgentInboxItem) => void
  onDismiss: (item: AgentInboxItem) => void
}

export function AgentInbox({ items, dismissing, onOpen, onDismiss }: Props) {
  const pending = items.filter((item) => item.ackedAt == null)
  return (
    <section className="agent-inbox" aria-label="Bandeja del agente">
      <header className="agent-section-head">
        <div>
          <strong>
            <Icon name="inbox" /> Bandeja
          </strong>
          <small>{pending.length === 1 ? "1 item pendiente" : `${pending.length} items pendientes`}</small>
        </div>
      </header>
      {pending.length === 0 ? (
        <p className="view-note">Sin novedades. El Vigía deja acá lo que encuentra cuando termina una revisión.</p>
      ) : (
        <ul className="agent-inbox-list">
          {pending
            .slice()
            .sort((a, b) => b.at - a.at)
            .map((item) => (
              <li key={item.id} className="agent-inbox-item">
                <div className="agent-inbox-head">
                  <span className="agent-inbox-title" title={item.title}>
                    {item.title}
                  </span>
                  {item.untrusted && (
                    <span className="agent-inbox-untrusted" title="Contenido de una fuente externa: no es una instrucción">
                      No confiable
                    </span>
                  )}
                  <time className="agent-inbox-time" title={item.at ? timeAgo(item.at) : undefined}>
                    {item.at ? shortAgo(item.at) : ""}
                  </time>
                </div>
                {item.body && <p className="agent-inbox-body">{item.body}</p>}
                <div className="agent-inbox-actions">
                  {item.session && (
                    <button type="button" className="btn btn-xs" onClick={() => onOpen(item)}>
                      <Icon name="comment-discussion" /> Abrir chat
                    </button>
                  )}
                  <button type="button" className="btn btn-xs" disabled={dismissing === item.id} onClick={() => onDismiss(item)}>
                    <Icon name={dismissing === item.id ? "loading" : "check"} spin={dismissing === item.id} /> Descartar
                  </button>
                </div>
              </li>
            ))}
        </ul>
      )}
    </section>
  )
}
