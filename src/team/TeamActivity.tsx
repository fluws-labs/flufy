import { useEffect, useMemo, useState } from "react"
import { Icon } from "../components/ui"
import { shortAgo, timeAgo } from "../lib/time"
import { loadTeamActivity, useTeamActivity, type TeamActivityEvent } from "../state/team-activity"
import type { TeamRun } from "./types"

type Props = { run: TeamRun; onSession: (id: string, directory: string) => void; compact?: boolean; onOpen?: () => void }
type Tone = "working" | "waiting" | "error" | "done" | "idle"

function tone(event: TeamActivityEvent | undefined): Tone {
  if (!event) return "idle"
  if (event.status === "error") return "error"
  if (event.status === "blocked") return "waiting"
  if (event.status === "info") return Date.now() - event.at > 60_000 ? "idle" : "working"
  if (["running", "pending"].includes(event.status)) return "working"
  return Date.now() - event.at > 120_000 ? "idle" : "done"
}

const toneRank: Record<Tone, number> = { error: 4, waiting: 3, working: 2, done: 1, idle: 0 }
const NO_EVENTS: TeamActivityEvent[] = []

export function TeamActivity({ run, onSession, compact = false, onOpen }: Props) {
  const events = useTeamActivity((state) => state.byRun[run.id])
  const loaded = useTeamActivity((state) => state.loaded[run.id])
  const [agentFilter, setAgentFilter] = useState("")
  useEffect(() => { void loadTeamActivity(run.id) }, [run.id])
  const list = events ?? NO_EVENTS
  const latest = useMemo(() => {
    const map = new Map<string, TeamActivityEvent>()
    for (const event of list) map.set(event.agentId, event)
    return map
  }, [list])
  const members = [...run.team.members].sort((a, b) => {
    const left = latest.get(a.id), right = latest.get(b.id)
    return toneRank[tone(right)] - toneRank[tone(left)] || (right?.at ?? 0) - (left?.at ?? 0)
  })
  const visible = list.filter((event) => !agentFilter || event.agentId === agentFilter)
  const recent = visible.slice(compact ? -3 : -120).reverse()
  const directory = (event: TeamActivityEvent) => run.tasks.find((task) => task.id === event.taskId)?.repository ?? run.team.allowedRepositories[0]
  const active = members.filter((member) => ["working", "waiting", "error"].includes(tone(latest.get(member.id)))).length
  return <section className={`team-activity${compact ? " team-activity-compact" : ""}`} aria-label="Actividad en vivo del equipo">
    <header className="team-activity-head">
      <div><strong><Icon name="play" /> Ahora</strong><small>{active ? `${active} en movimiento · ` : ""}{list.length} eventos observados</small></div>
      {compact ? <button className="btn btn-xs" type="button" onClick={onOpen}>Ver todo</button> : <label className="team-activity-filter">Agente<select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}><option value="">Todos</option>{run.team.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>}
    </header>
    <div className="team-activity-cards">
      {members.map((member) => {
        const event = latest.get(member.id)
        const current = tone(event)
        const target = event?.target && !event.label.includes(event.target) ? event.target : null
        return <button key={member.id} type="button" className={`team-activity-card is-${current}`} disabled={!event} onClick={() => event && onSession(event.sessionId, directory(event))} title={event ? "Abrir la sesión de este agente" : "Sin actividad en vivo todavía"}>
          <span className="team-activity-name"><span className={`team-activity-dot ${current}`} />{member.name}<small>{member.role}</small></span>
          <span className="team-activity-line">{event ? event.label : loaded ? "Sin actividad en vivo" : "Cargando actividad…"}</span>
          {target && <code className="team-activity-target">{target}</code>}
          {event && <small className="team-activity-time">{event.taskId ? `${event.taskId} · ` : ""}{timeAgo(event.at)}</small>}
        </button>
      })}
    </div>
    {recent.length > 0 ? <ol className="team-activity-feed" aria-label="Últimas acciones observadas">{recent.map((event) => {
      const current = tone(event)
      const target = event.target && !event.label.includes(event.target) ? event.target : null
      return <li key={event.seq}><button type="button" className={`team-activity-row is-${current}`} onClick={() => onSession(event.sessionId, directory(event))} title="Abrir la sesión de este agente">
        <time>{shortAgo(event.at)}</time>
        <span className="team-activity-who">{event.agentName}</span>
        <span className="team-activity-what"><span className={`team-activity-dot ${current}`} />{event.label}{target && <code className="team-activity-target">{target}</code>}</span>
        {event.taskId && <span className="team-activity-task">{event.taskId}</span>}
      </button></li>
    })}</ol> : <p className="team-note">{loaded ? "Todavía no hay actividad en vivo en esta ejecución. Aparece cuando el motor empieza a usar herramientas." : "Cargando actividad en vivo…"}</p>}
    {!compact && <p className="team-note">La actividad en vivo se conserva mientras Flufy está abierto. El historial completo queda en Actividad.</p>}
  </section>
}
