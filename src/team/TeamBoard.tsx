import { useEffect, useMemo, useRef, useState } from "react"
import { Icon } from "../components/ui"
import "./board.css"
import { boardColumns, nextTaskIds, projectBoard, taskChecks } from "./board"
import { shortProblem, taskProblem } from "./problem"
import { recoveredAutomatically } from "./ownership"
import type { TeamRun, TeamTask } from "./types"
import { formatDateTime } from "../lib/time"

type Props = { run: TeamRun; onSession: (id: string, directory: string) => void; onRetry: () => Promise<unknown>; onEvidence?: () => void; readOnly?: boolean }
type Card = ReturnType<typeof projectBoard>[number]

export function TeamBoard({ run, onSession, onRetry, onEvidence, readOnly = false }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const detail = useRef<HTMLElement>(null)
  const origin = useRef<HTMLButtonElement | null>(null)
  const cards = useMemo(() => projectBoard(run), [run])
  const selected = run.tasks.find(t => t.id === selectedId)
  const verified = cards.filter(c => c.column === "verified").length
  const next = nextTaskIds(run)
  const hasOpenTasks = run.tasks.some(task => task.taskKind !== "group" && !["completed", "cancelled"].includes(task.status))
  useEffect(() => { if (selectedId) detail.current?.focus() }, [selectedId])
  const close = () => { setSelectedId(null); origin.current?.focus() }
  const open = (task: TeamTask, button?: HTMLButtonElement) => { origin.current = button ?? null; setSelectedId(task.id) }
  const attempt = selected?.attempts.at(-1)
  const review = attempt?.review
  const criteriaVerified = review?.status === "approved"
  const causeFor = (task: TeamTask, column: string) => ["blocked", "needs_changes"].includes(column)
    ? task.status === "waiting_dependency"
      ? run.coordination?.findLast(c => c.fromTaskId === task.id && c.status !== "resolved")?.summary || "Espera una entrega o una respuesta del Lead."
      : taskProblem(task)
    : ""
  const selectedCause = selected ? causeFor(selected, cards.find(c => c.task.id === selected.id)?.column ?? "") : ""

  function renderCard(card: Card) {
    const { task, agent, column } = card
    const checks = taskChecks(task)
    const cause = causeFor(task, column)
    const owner = task.status === "waiting_dependency" ? "Espera una entrega o una respuesta."
      : column === "needs_changes" ? "Espera una corrección."
      : recoveredAutomatically(cause) ? `El Lead lo está resolviendo${task.attempts.length > 1 ? ` · intento ${task.attempts.length}` : ""}.`
      : "Necesita tu decisión."
    return <article key={task.id} className={`team-board-card is-${column}`} data-task-id={task.id} data-column={column}>
      <div className="team-board-card-meta"><span>{task.id}</span>{checks && <span>{checks.ok}/{checks.total} comprobaciones</span>}</div>
      <button className="team-board-card-title" onClick={e => open(task, e.currentTarget)} aria-label={`Abrir tarea ${task.id}: ${task.title}`}>{task.title}</button>
      <p className="team-board-owner"><span className="team-board-avatar" aria-hidden="true">{(agent?.name ?? "?").slice(0, 2).toUpperCase()}</span>{agent?.name ?? "Sin responsable"}{agent?.role.toLowerCase() !== agent?.name.toLowerCase() && <small>{agent?.role}</small>}</p>
      <span className="team-board-state"><Icon name={boardColumns.find(c => c.id === column)!.icon} /> {boardColumns.find(c => c.id === column)!.label}</span>
      {!!task.dependencies.length && ["todo", "ready"].includes(column) && <p className="team-note">Depende de {task.dependencies.join(", ")}</p>}
      {cause && <><p className="team-board-cause">{owner}</p><p className="team-note team-board-cause-detail">{shortProblem(cause, 130)}</p></>}
    </article>
  }

  function columns(lane: Card[]) {
    return <div className="team-board-columns">{boardColumns.filter(column => ["todo", "ready", "running", "verifying", "verified"].includes(column.id) || lane.some(c => c.column === column.id)).map(column => {
      const content = lane.filter(c => c.column === column.id)
      return <section key={column.id} className={`team-board-column is-${column.id}`} aria-label={column.label}>
        <h4><Icon name={column.icon} /> {column.label}<span>{content.length}</span></h4>
        <div className="team-board-stack">{content.map(renderCard)}{!content.length && <p className="team-board-empty">Sin tareas</p>}</div>
      </section>
    })}</div>
  }

  return <section className="team-board" aria-label="Tablero de tareas">
    <header className="team-board-header">
      <div><span className="team-board-eyebrow">{run.planV2?.enabled ? `PLAN VIVO · v${run.planV2.revisionNumber}` : "TABLERO DE TRABAJO"}</span><h3>{verified}/{cards.length} verificadas</h3>
        <p className="team-note">{run.planV2?.enabled ? `Etapa: ${{ discovery: "Descubriendo", proposal: "Proponiendo", repair: "Reparando", validation: "Validando cobertura", plan_invalid: "Plan inválido", validated: "Plan validado", dispatch: "Ejecución" }[run.planV2.stage] ?? run.planV2.stage}` : "Estado derivado de tareas, sesiones y evidencias."}</p>
        <p className="team-board-next">{next.length ? <>Sigue: <strong>{next.join(" → ")}</strong></> : hasOpenTasks ? "El equipo está cerrando las tareas en curso." : "No queda nada pendiente: después te toca revisar la entrega."}</p>
      </div>
      {onEvidence && <button className="btn btn-xs" onClick={onEvidence}>Ver evidencias</button>}
    </header>
    {run.status === "planning_blocked" && <section className="team-error" role="alert"><strong>El plan necesita corrección. No se inició ningún trabajador.</strong><ul>{run.planV2?.validation?.issues.map((issue, i) => <li key={i}>{issue.code} · {issue.taskIds.join(", ")} {issue.message}</li>)}</ul><button className="btn btn-sm" disabled={retrying || readOnly} onClick={() => { setRetrying(true); void onRetry().finally(() => setRetrying(false)) }}>Reintentar planificación</button></section>}
    {!cards.length && run.status !== "planning_blocked" && <p className="team-board-empty">{run.status === "planning" ? "El Lead está preparando el plan. Las tarjetas aparecen después de validarlo." : "Esta ejecución todavía no tiene tareas."}</p>}
    {!!cards.length && columns(cards)}
    {selected && <aside className="team-board-detail" ref={detail} tabIndex={-1} aria-label={`Detalle de ${selected.id}`} onKeyDown={e => { if (e.key === "Escape") close() }}>
      <header><h3>{selected.id} · {selected.title}</h3><button className="btn btn-xs" onClick={close}>Cerrar detalle</button></header>
      <p>{selected.objective}</p>
      <p className="team-note">{run.team.members.find(a => a.id === selected.assignedAgentId)?.name} · {boardColumns.find(c => c.id === cards.find(c => c.task.id === selected.id)?.column)?.label}</p>
      {selectedCause && <><h4>Qué está pasando</h4><p className="team-board-cause-full selectable">{selectedCause}</p></>}
      <h4>Criterios de aceptación</h4>
      <ul className="team-criteria">{selected.acceptanceCriteria.map((criterion, i) => <li key={i} className={criteriaVerified ? "ok" : "pending"}><Icon name={criteriaVerified ? "pass" : "circle-outline"} />{criterion}</li>)}</ul>
      {review && <p className="team-note">{review.summary}</p>}
      {selected.verificationPlan?.length ? <><h4>Verificación prevista</h4><ul className="team-criteria">{selected.verificationPlan.map((step, i) => {
        const done = step.kind === "command" ? !!attempt?.commands.some(c => c.command === step.command && c.exitCode === 0) : !!attempt?.observations?.length
        return <li key={i} className={done ? "ok" : "pending"}><Icon name={done ? "pass" : "circle-outline"} /><code>{step.command ?? "Observación"}</code> · {step.expected}</li>
      })}</ul></> : null}
      <h4>Comprobaciones</h4>
      {attempt?.commands.length ? attempt.commands.map((command, index) => <details key={index}><summary>{command.command} · {command.exitCode == null ? "Sin resultado" : command.exitCode === 0 ? "Correcto" : `Falló (código ${command.exitCode})`}</summary><pre className="team-evidence-preview">{command.output}</pre></details>) : <p className="team-note">Todavía no hay comandos registrados.</p>}
      {attempt?.observations?.length ? <details><summary>Observaciones del navegador, la web y las apps</summary>{attempt.observations.map((observation, index) => <details key={index}><summary>{observation.tool}</summary><pre className="team-evidence-preview">{observation.output}</pre></details>)}</details> : null}
      <h4>Archivos</h4>
      <p className="team-note selectable">{selected.writePaths?.join(", ") || selected.expectedFiles.join(", ") || "Sin archivos declarados."}</p>
      <p className="team-note">Depende de {selected.dependencies.join(", ") || "ninguna tarea"}</p>
      {selected.attempts.map((entry, i) => <section key={entry.id}><h4>Intento {i + 1} · {entry.agent.name}</h4><p className="team-note">{formatDateTime(entry.startedAt)} · {entry.finishedAt ? formatDateTime(entry.finishedAt) : "Sin cierre observado"}</p>{entry.summary && <p>{entry.summary}</p>}{entry.review && <p>Revisión: {entry.review.status === "approved" ? "Aprobada" : "Con observaciones"} · {entry.review.summary}</p>}{entry.sessionId && <button className="btn btn-xs" onClick={() => onSession(entry.sessionId!, selected.repository)}>Abrir sesión del intento</button>}{entry.reviewSessionId && <button className="btn btn-xs" onClick={() => onSession(entry.reviewSessionId!, selected.repository)}>Abrir revisión</button>}</section>)}
    </aside>}
  </section>
}
