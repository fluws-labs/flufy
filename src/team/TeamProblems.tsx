import { Icon } from "../components/ui"
import type { TeamAttention } from "./attention"
import type { TeamRun } from "./types"
import { problemHelp } from "./problem"

export function TeamProblems({ items, run, pending, onInspect, onSettings, onAsk, onContinue }: {
  items: TeamAttention[]; run?: TeamRun; pending: boolean; onInspect: (item: TeamAttention) => void; onSettings: () => void; onAsk: () => void; onContinue: () => void
}) {
  if (!items.length) return null
  const impact = (item: TeamAttention) => {
    const task = run?.tasks.find(t => t.id === item.id)
    if (!task) return ""
    const dependents = run!.tasks.filter(t => t.dependencies.includes(task.id) && t.status !== "completed")
    const ids = dependents.slice(0, 3).map(t => t.id).join(", ")
    return dependents.length ? `${ids}${dependents.length > 3 ? " y otras" : ""} ${dependents.length === 1 ? "espera" : "esperan"} esta tarea.` : ""
  }
  return <section className="team-attention" aria-label="Bloqueos del equipo">
    <div className="team-problems-title"><h3>Necesita tu decisión</h3><span className="team-note">{items.length === 1 ? "El equipo sigue con lo demás mientras respondés." : "El equipo sigue con lo demás mientras respondés."}</span></div>
    <div className="team-attention-list">{items.map(item => {
      const help = problemHelp(item)
      const reason = item.reason
      const permission = item.kind === "permission"
      const question = item.kind === "question"
      const canResume = ["blocked", "failed", "planning_blocked"].includes(run?.status ?? "")
      const primary = permission ? "Ver permiso" : question ? "Responder al agente" : help.model ? "Cambiar modelo" : canResume ? "Continuar lo pendiente" : "Preguntarle al Lead"
      return <article key={item.id} className={`team-problem-card ${item.kind}`}>
        <div className="team-problem-heading"><Icon name={permission || question ? "shield" : "warning"} /><strong>{item.name}</strong><span>{permission ? "Necesita un permiso" : question ? "Necesita una respuesta" : "Necesita tu decisión"}</span></div>
        <p className="team-problem-task">{item.task}</p>
        <p className="team-problem-reason">{reason}</p>
        {impact(item) && <p className="team-problem-impact">{impact(item)}</p>}
        <div className="team-problem-actions">
          <button className="btn btn-sm btn-primary" disabled={pending && !permission && !question} onClick={() => {
            if (permission || question) onInspect(item)
            else if (help.model) onSettings()
            else if (canResume) onContinue()
            else onAsk()
          }}>{primary}</button>
          {!permission && !question && help.model && canResume && <button className="btn btn-sm" disabled={pending} onClick={onContinue}>Reanudar</button>}
          {!permission && !question && <button className="btn btn-sm" onClick={() => onInspect(item)}>Ver sesión</button>}
        </div>
      </article>
    })}</div>
    <div className="team-problem-actions"><button className="btn btn-xs" onClick={onAsk}>Preguntarle al Lead qué pasó</button></div>
  </section>
}
