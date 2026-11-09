import { useState } from "react"
import { teamCall } from "../state/teams"
import { Icon } from "../components/ui"
import { DeliveryReview } from "./DeliveryReview"
import { EvidenceComparison } from "./EvidenceComparison"
import { GoalAnalysis, SupportReports } from "./SupportReports"
import { taskChecks } from "./board"
import { runStatusLabel, type DeliveryFlow, type TeamRun } from "./types"
import { formatDateTime } from "../lib/time"
import { firstTeamSentence } from "../lib/team-response"
import { readableTeamError } from "../lib/provider-error"

export function DeliveryResults({ run, history, chatId, onOpenPage, onSession, onPrepare, onApprove, onChanges }: {
  run: TeamRun; history: TeamRun[]; chatId: string; onOpenPage: (label: string, title: string) => void
  onSession: (id: string, directory: string) => void; onPrepare: (flow: DeliveryFlow) => Promise<void>
  onApprove: () => void; onChanges: () => void
}) {
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null)
  const attempts = run.tasks.flatMap(task => {
    const attempt = task.attempts.at(-1)
    return attempt ? [{ task, attempt }] : []
  })
  const commands = attempts.flatMap(({ task, attempt }) => attempt.commands.map(command => ({ task, attempt, command })))
  const failed = commands.filter(item => item.command.exitCode != null && item.command.exitCode !== 0)
  const passed = commands.filter(item => item.command.exitCode === 0)
  const approvedReviews = attempts.filter(({ attempt }) => attempt.review?.status === "approved").length
  const observations = attempts.reduce((total, { attempt }) => total + (attempt.observations?.length ?? 0), 0)
  const canDecide = ["completed", "awaiting_manual_qa"].includes(run.status)
  const approved = run.status === "qa_approved"
  const summary = run.deliveryReview?.summary || run.chatSummary?.done || firstTeamSentence(run.summary)
  return <div className="delivery-results">
    <header className="delivery-summary">
      <div><h3>Entrega</h3><p>{summary || "El equipo todavía no registró un resumen de la entrega."}</p></div>
      <span className={`team-status ${run.status}`}>{runStatusLabel(run.status)}</span>
    </header>

    <DeliveryReview run={run} chatId={chatId} onOpenPage={onOpenPage} onSession={onSession} onPrepare={onPrepare} />

    <section className="delivery-section" aria-label="Qué se comprobó">
      <h3><Icon name="pass" /> Qué se comprobó</h3>
      <p className="team-note">{commands.length ? `${passed.length} de ${commands.length} ${commands.length === 1 ? "comprobación pasó" : "comprobaciones pasaron"}` : "No se registraron comandos de comprobación."}{approvedReviews ? ` · ${approvedReviews} ${approvedReviews === 1 ? "revisión aprobada" : "revisiones aprobadas"}` : ""}{observations ? ` · ${observations} ${observations === 1 ? "observación" : "observaciones"}` : ""}</p>
      {failed.length > 0 && <ul className="delivery-failures">
        <li className="delivery-failures-title">{failed.length === 1 ? "Esta comprobación falló" : `Estas ${failed.length} comprobaciones fallaron`}</li>
        {failed.map(({ task, command }, index) => <li key={index}>
          <strong>{task.id} · {task.title}</strong>
          <code>{command.command}</code>
          <span>Código {command.exitCode}</span>
          <details><summary>Ver resultado</summary><pre className="team-evidence-preview">{command.output || "Sin salida registrada."}</pre></details>
        </li>)}
      </ul>}
      <ul className="delivery-task-checks">
        {run.tasks.filter(task => task.taskKind !== "group").map(task => {
          const checks = taskChecks(task)
          const review = task.attempts.at(-1)?.review
          return <li key={task.id}>
            <strong>{task.id} · {task.title}</strong>
            <span>{checks ? `${checks.ok}/${checks.total} comprobaciones` : "Sin comprobaciones registradas"}</span>
            <span className={review?.status === "approved" ? "ok" : review ? "warn" : ""}>{review?.status === "approved" ? "Revisión aprobada" : review ? "Revisión con observaciones" : "Sin revisión final"}</span>
          </li>
        })}
      </ul>
    </section>

    <section className="delivery-section delivery-decision" aria-label="Qué decidís">
      <h3><Icon name="checklist" /> Qué decidís</h3>
      {approved ? <>
        <p>Entrega aprobada. Podés enviar el siguiente pedido cuando quieras.</p>
      </> : canDecide ? <>
        <p>Revisá lo que cambió y las comprobaciones. Si está bien, aprobá la entrega; si falta algo, pedí cambios y el Lead lo organiza.</p>
        <div className="team-chat-actions">
          <button className="btn btn-primary" onClick={onApprove}><Icon name="pass" /> Aprobar entrega</button>
          <button className="btn" onClick={onChanges}><Icon name="edit" /> Pedir cambios</button>
        </div>
        <p className="team-note">Aprobar cierra esta ejecución y habilita el siguiente trabajo. Los cambios ya están aplicados en el proyecto.</p>
      </> : <p className="team-note">{run.status === "failed" || run.status === "cancelled" ? "La ejecución se detuvo. Los cambios ya aplicados se conservan y podés pedirle al Lead que retome lo pendiente." : "La decisión aparece cuando el equipo termina la entrega."}</p>}
    </section>

    <EvidenceComparison run={run} history={history} chatId={chatId} />
    <GoalAnalysis run={run} />
    <details className="delivery-section delivery-technical">
      <summary>Evidencia técnica</summary>
      <p className="team-note selectable">{run.evidenceDir}</p>
      <div className="team-actions"><button className="btn btn-sm" onClick={() => void teamCall("team_evidence_open", { runId: run.id })}><Icon name="folder-opened" /> Abrir carpeta</button></div>
      {run.evidenceExpiredAt && <p className="team-note">Las evidencias de esta entrega expiraron según la retención configurada. El historial del trabajo se conserva.</p>}
      <SupportReports run={run} onOpen={onSession} />
      {run.artifacts.map(artifact => <article className="team-artifact" key={artifact.id}>
        <div><strong>{artifact.phase} · {artifact.kind}</strong><p>{artifact.relativePath || "Sin archivo de captura"}</p><small>{artifact.source} · {formatDateTime(artifact.capturedAt)}</small></div>
        {artifact.status === "captured" && artifact.kind !== "screenshot" ? <button className="btn btn-xs" onClick={() => void teamCall<string>("team_evidence_read", { runId: run.id, path: artifact.relativePath }).then(text => { if (text !== null) setPreview({ title: artifact.relativePath, text }) })}>{artifact.kind === "diff" ? "Abrir diff" : "Ver evidencia"}</button> : artifact.status !== "captured" ? <p className="team-note">No disponible: {artifact.reason ? readableTeamError(artifact.reason) : "El archivo no está disponible."}</p> : <span className="team-note">Ver en el comparador</span>}
      </article>)}
      {preview && <section className="team-card"><div className="team-section-title"><h4>{preview.title}</h4><button className="btn btn-xs" onClick={() => setPreview(null)}>Cerrar</button></div><pre className="team-evidence-preview">{preview.text}</pre></section>}
    </details>
  </div>
}
