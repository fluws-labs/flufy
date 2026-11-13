import { useEffect, useMemo, useState } from "react"
import { Icon } from "../components/ui"
import { shortAgo, timeAgo } from "../lib/time"
import { loadTeamActivity, useTeamActivity, type TeamActivityEvent } from "../state/team-activity"
import { useTeams } from "../state/teams"
import type { TeamRun } from "./types"

type Props = { run: TeamRun; onSession: (id: string, directory: string) => void; compact?: boolean; onOpen?: () => void }
type Tone = "working" | "waiting" | "error" | "done" | "idle"

const REASON_LABELS: Record<string, string> = {
  "user.message_received": "mensaje del usuario",
  "team.activated": "activación",
  "run.attention": "atención del trabajo",
  "run.completed": "trabajo terminado",
  "run.blocked": "trabajo bloqueado",
  "run.reconciled": "reconciliación",
  "dependency.unlocked": "dependencia liberada",
  "task.unblocked": "tarea liberada",
  "task.blocked": "tarea bloqueada",
  "coordination.requested": "coordinación",
  "coordination.updated": "coordinación",
  "lead.coordination": "coordinación",
  "response.expected": "respuesta esperada",
}

function reasonLabel(kind: string) {
  return REASON_LABELS[kind] ?? kind
}

function waitLabel(nextAt: number) {
  const seconds = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000))
  return seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`
}

function formatTokens(tokens: number) {
  return new Intl.NumberFormat("es-AR").format(tokens)
}

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
  const summary = useTeams((state) => state.ledger?.find((item) => item.runId === run.id))
  const guard = useTeams((state) => {
    const chat = state.chats.find((item) => item.runs.some((entry) => entry.id === run.id))
    return chat ? state.guards?.find((item) => item.chatId === chat.id) : undefined
  })
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
    {(guard || summary) && <div className="team-activity-ledger" aria-label="Resumen de coordinación">
      {guard && <p className="team-note" role="status"><Icon name="sync" /> En espera: {guard.reason} · vuelve en {waitLabel(guard.nextAt)} · {guard.repeats} {guard.repeats === 1 ? "repetición" : "repeticiones"}</p>}
      {summary && <p className="team-note">{summary.tokens == null ? "Tokens sin dato del motor" : `${formatTokens(summary.tokens)} tokens`} · {summary.leadTurns} {summary.leadTurns === 1 ? "turno del Lead" : "turnos del Lead"} · {summary.uiOnlyEvents} {summary.uiOnlyEvents === 1 ? "aviso sin turno" : "avisos sin turno"}{summary.noticesGrouped > 0 ? ` · ${summary.noticesGrouped} agrupados` : ""}{summary.reasons.length > 0 ? ` · ${summary.reasons.map((item) => `${reasonLabel(item.reason)} ×${item.count}`).join(", ")}` : ""}</p>}
    </div>}
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
