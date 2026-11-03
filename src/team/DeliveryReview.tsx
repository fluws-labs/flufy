import { useState } from "react"
import { call, errorMessage } from "../lib/tauri"
import { Icon } from "../components/ui"
import type { DeliveryFlow, TeamRun } from "./types"
import "./delivery-review.css"

type LivePage = { label: string; actor: string; url: string }

export function DeliveryReview({ run, chatId, onOpenPage, onSession, onPrepare }: {
  run: TeamRun; chatId: string; onOpenPage: (label: string, title: string) => void; onSession: (id: string, directory: string) => void; onPrepare: (flow: DeliveryFlow) => Promise<void>
}) {
  const [opening, setOpening] = useState<string | null>(null)
  const [preparing, setPreparing] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ title: string; text: string } | null>(null)
  const report = run.deliveryReview
  if (!report) return <p className="team-note">Esta entrega no tiene una guía de revisión registrada. Las comprobaciones disponibles están en las evidencias.</p>
  const source = (flow: DeliveryFlow) => {
    const task = run.tasks.find(t => t.id === flow.taskId)
    return { task, attempt: task?.attempts.find(a => a.id === flow.attemptId) }
  }
  const open = async (flow: DeliveryFlow) => {
    if (opening) return
    setOpening(flow.title); setProblem(null)
    try {
      const { attempt } = source(flow)
      const pages = await call<LivePage[]>("browser_internal_pages", { session: `team:${chatId}` })
      const matching = pages.filter(page => page.actor === attempt?.sessionId && page.url === flow.url)
      if (matching.length !== 1) throw new Error("El escenario ya no está disponible en su página original. Revisá la preparación guardada o pedile al equipo que lo prepare de nuevo. Abrir solo la URL no reconstruye los datos ni el estado.")
      onOpenPage(matching[0].label, flow.title)
    } catch (error) { setProblem({ title: flow.title, text: errorMessage(error) }) }
    finally { setOpening(null) }
  }
  return <section className="delivery-review" aria-label="Guía de revisión de la entrega">
    <header className="delivery-review-heading"><Icon name="checklist" /><div><h3>Qué cambió y qué revisar</h3><p>{report.summary}</p></div></header>
    {!report.uiRequired && <p className="team-note">{report.reason}</p>}
    <div className="delivery-review-flows">{report.flows.map((flow, index) => {
      const { task, attempt } = source(flow)
      return <article className="delivery-flow" key={`${flow.taskId}:${flow.title}`}>
        <div className="delivery-flow-heading"><span className="delivery-flow-number">{index + 1}</span><div><h4>{flow.title}</h4><p>{flow.change}</p></div></div>
        <div className="team-actions">
          {flow.ready && <button className="btn btn-sm" disabled={opening !== null || preparing !== null} onClick={() => void open(flow)}><Icon name="browser" />{opening === flow.title ? "Buscando escenario…" : "Abrir escenario preparado"}</button>}
          {(!flow.ready || problem?.title === flow.title) && <button className="btn btn-sm" disabled={preparing !== null} onClick={async () => {
            setPreparing(flow.title)
            try { await onPrepare(flow) }
            catch (error) { setProblem({ title: flow.title, text: errorMessage(error) }) }
            finally { setPreparing(null) }
          }}><Icon name="refresh" />{preparing === flow.title ? "Pidiendo preparación…" : "Volver a preparar con el equipo"}</button>}
          {attempt?.sessionId && task && <button className="btn btn-xs" onClick={() => onSession(attempt.sessionId!, task.repository)}>Ver recorrido y capturas</button>}
        </div>
        {problem?.title === flow.title && <p className="team-error" role="alert">{problem.text}</p>}
        <div className="delivery-flow-result"><Icon name="pass" /><div><strong>Qué deberías ver</strong><p>{flow.expected}</p></div></div>
        <ol className="delivery-flow-steps" aria-label={`Pasos para ${flow.title}`}>{flow.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
        <p className="delivery-flow-state"><Icon name={flow.ready ? "browser" : "info"} />{flow.stateNote}</p>
        <details className="delivery-flow-details"><summary>Preparación y comprobaciones del agente</summary>
          <h5>Datos y estado de prueba</h5><ul>{flow.preparation.map((step, i) => <li key={i}>{step}</li>)}</ul>
          <h5>Resultado observado</h5><p>{flow.observed}</p>
          <h5>Revisión visual del agente</h5><p>{flow.visualReview}</p>
          <p className="team-note selectable">{flow.url}</p>
        </details>
      </article>
    })}</div>
    {report.decisions.length > 0 && <details className="delivery-review-decisions"><summary>Decisiones del proyecto revisadas · {report.decisions.length}</summary><ul>{report.decisions.map((decision, i) => <li key={i}><strong>{decision.decision}</strong>{decision.status === "superseded" && <span className="team-note"> · Actualizada por vos</span>}<p>{decision.evidence}</p><small>{decision.source}</small></li>)}</ul></details>}
  </section>
}
