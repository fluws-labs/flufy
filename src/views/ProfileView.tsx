import { useEffect, useMemo, useRef, useState } from "react"
import { Select, Toggle } from "../components/fields"
import { Icon } from "../components/ui"
import { rememberSessionDirectory } from "../lib/opencode"
import { basename, samePath } from "../lib/paths"
import { shortAgo, timeAgo } from "../lib/time"
import { isTauri } from "../lib/tauri"
import { call } from "../lib/tauri"
import { BOT_ADMIN_MARKER, focusComposer, loadSessions, openSessionInDirectory, renameSession, selectSession, sendPrompt, useAgent, type ProviderModel } from "../state/agent"
import {
  decideAgentInboxItem,
  deleteAgentMission,
  dismissAgentInboxItem,
  generateAgentMissionBrief,
  loadAgentAbsence,
  loadAgentInbox,
  loadAgentMissions,
  loadAgentProfile,
  prepareAgentAbsence,
  resumeAgentMission,
  runAgentMission,
  saveAgentMission,
  saveAgentProfile,
  setAgentPulse,
  startAgentProfile,
  stopAgentAbsence,
  useAgentProfile,
  type AgentInboxItem,
  type AgentMission,
  type AgentMissionRun,
} from "../state/agentProfile"
import { useLayout } from "../state/layout"
import { useProject } from "../state/project"
import { openRoutine, runStatusLabel as routineRunLabel, scheduleLabel as routineScheduleLabel, setRoutineEnabled, startRoutines, useRoutines, type Routine } from "../state/routines"
import { patchSessionRuntime, sessionRuntime } from "../state/session-runtime"
import { startBots, useBots, type Bot } from "../state/bots"
import { pickOne } from "../state/quickinput"
import { notify } from "../state/toasts"

function scheduleLabel(schedule: AgentMission["schedule"]): string {
  if (schedule.kind === "interval") return `Cada ${schedule.hours} h`
  if (schedule.kind === "daily") return `Diaria ${schedule.time}`
  const days = schedule.days.map((day) => ["L", "M", "X", "J", "V", "S", "D"][day] ?? "?").join("")
  return `${days} ${schedule.time}`
}

function nextLabel(ms?: number | null): string {
  if (!ms) return "sin programar"
  const diff = ms - Date.now()
  if (diff <= 0) return "pendiente"
  const minutes = Math.round(diff / 60000)
  if (minutes < 60) return `en ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `en ${hours} h`
  return new Date(ms).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function durationLabel(start: number, end?: number | null): string {
  if (!start) return ""
  const ms = Math.max(0, (end ?? Date.now()) - start)
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

function openMissionSession(mission: AgentMission, session: string, currentProject: string | null) {
  const directory = mission.project ?? currentProject ?? ""
  const open = async () => {
    try {
      const opened = directory ? await openSessionInDirectory(directory, session) : false
      if (!opened) selectSession(session)
    } finally {
      useLayout.getState().toggleAgent(true)
      focusComposer()
    }
  }
  void open()
}

function openMissionChat(mission: AgentMission, currentProject: string | null) {
  if (mission.state.sessionId) openMissionSession(mission, mission.state.sessionId, currentProject)
}

const MISSION_STATUS: Record<string, string> = {
  draft: "Borrador",
  armed: "Programada",
  queued: "En cola",
  running: "Corriendo",
  "waiting-approval": "Espera aprobación",
  "waiting-hands": "Te necesita",
  paused: "Pausada",
  done: "Lista",
  failed: "Falló",
}

const RUN_STATUS: Record<string, string> = {
  ok: "Lista",
  blocked: "Bloqueada",
  "needs-approval": "Espera aprobación",
  "needs-hands": "Te necesita",
  interrupted: "Interrumpida",
  running: "Corriendo",
}

const CHECK_STATUS: Record<string, string> = { ok: "OK", warn: "Revisar", fail: "Falta" }

type MissionFilter = "all" | "active" | "scheduled" | "paused" | "done"

function modelKey(model?: { providerID: string; modelID: string } | null): string {
  return model ? `${model.providerID}/${model.modelID}` : ""
}

function parseModelKey(value: string): { providerID: string; modelID: string } | null {
  if (!value) return null
  const slash = value.indexOf("/")
  if (slash < 0) return null
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

function MissionModelSelect({ value, models, onChange, disabled }: { value: string; models: ProviderModel[]; onChange: (value: string) => void; disabled?: boolean }) {
  const current = models.find((model) => modelKey(model) === value)
  const label = value
    ? current
      ? `${current.providerName} · ${current.name}`
      : value.replace("/", " · ")
    : "Predeterminado de la misión"
  const choose = async () => {
    const items = [
      {
        id: "",
        label: "Predeterminado de la misión",
        description: "Usa el modelo por defecto del motor",
        icon: value ? "circle-small" : "check",
        group: "Misión",
      },
      ...models.map((model) => ({
        id: modelKey(model),
        label: model.name,
        description: model.providerName,
        icon: modelKey(model) === value ? "check" : "circle-small",
        group: model.providerName,
      })),
    ]
    if (value && !current) {
      items.push({ id: value, label: value.replace("/", " · "), description: "Modelo configurado", icon: "check", group: "Configurado" })
    }
    const picked = await pickOne(items, { title: "Modelo de la misión", placeholder: "Buscar modelo" })
    if (picked) onChange(picked.id)
  }
  return (
    <button type="button" className="agent-model-button mi-model-button" disabled={disabled} title="Elegir el modelo con el que corre esta misión" onClick={() => void choose()}>
      <Icon name="server" />
      <span>{label}</span>
      <Icon name="chevron-down" />
    </button>
  )
}

function LogList() {
  const log = useAgentProfile((s) => s.log)
  const entries = log.slice().sort((a, b) => b.at - a.at).slice(0, 20)
  if (entries.length === 0) return <p className="view-note">Todavía no hay entradas en el registro.</p>
  return (
    <ol className="agent-log">
      {entries.map((entry, index) => (
        <li key={`${entry.at}-${index}`} className="agent-log-row">
          <time title={entry.at ? timeAgo(entry.at) : undefined}>{entry.at ? shortAgo(entry.at) : ""}</time>
          <span className="agent-log-kind">{entry.kind}</span>
          <span className="agent-log-text">{entry.text}</span>
        </li>
      ))}
    </ol>
  )
}

function AbsenceSection() {
  const absence = useAgentProfile((s) => s.absence)
  const error = useAgentProfile((s) => s.absenceError)
  const preparing = useAgentProfile((s) => s.preparingAbsence)
  const fails = absence?.checks.filter((check) => check.status === "fail").length ?? 0
  const warns = absence?.checks.filter((check) => check.status === "warn").length ?? 0

  return (
    <section className="agent-section" aria-label="Modo ausencia">
      <header className="agent-section-head">
        <div>
          <strong>
            <Icon name="checklist" /> Modo ausencia
          </strong>
          <small>Antes de irte, Flufy revisa lo necesario y avisa al teléfono.</small>
        </div>
        <button type="button" className="btn btn-sm btn-primary" disabled={preparing} onClick={() => void prepareAgentAbsence()}>
          <Icon name={preparing ? "loading" : "check"} spin={preparing} /> {preparing ? "Revisando…" : "Preparar para ausencia"}
        </button>
      </header>
      {error && <div className="view-error">{error}</div>}
      {absence && (absence.enabled || absence.checks.length > 0) && (
        <>
          <div className={`absence-summary ${absence.ready ? "ok" : fails ? "fail" : "warn"}`}>
            <strong>
              {absence.ready
                ? "Listo para ausencia"
                : fails
                  ? `${fails} bloqueante(s) y ${warns} aviso(s)`
                  : "Listo con avisos"}
            </strong>
            <span>
              {absence.enabled
                ? fails
                  ? "Corregí lo que falta antes de irte; mientras tanto, las misiones pueden fallar."
                  : "La PC queda preparada para que las misiones sigan solas."
                : "Todavía no lo activaste."}
            </span>
            {absence.enabled && (
              <button type="button" className="btn btn-sm" onClick={() => void stopAgentAbsence()}>
                Ya volví
              </button>
            )}
          </div>
          <ul className="absence-checks">
            {absence.checks.map((check) => (
              <li key={check.id} className={`absence-check ${check.status}`}>
                <span className="absence-check-status">{CHECK_STATUS[check.status] ?? check.status}</span>
                <span className="absence-check-detail">
                  {check.detail}
                  {check.fix ? <small>{check.fix}</small> : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function openItem(item: AgentInboxItem) {
  const session = item.session
  if (!session) return
  useLayout.getState().showView("agents", false)
  useLayout.getState().toggleAgent(true)
  void (async () => {
    const current = useProject.getState().project ?? useProject.getState().root
    if (item.directory && current && !samePath(item.directory, current)) {
      await openSessionInDirectory(item.directory, session)
    } else {
      if (item.directory) rememberSessionDirectory(session, item.directory)
      selectSession(session)
    }
  })()
}

function startNewChat() {
  const root = useProject.getState().project ?? useProject.getState().root
  useLayout.getState().showView("agents", false)
  useLayout.getState().toggleAgent(true)
  const hidden = "Estoy en Mi Flufy y no entiendo qué está pasando con mis misiones. Revisá el estado, la bandeja y las misiones; explicame qué tengo corriendo, qué está trabado y qué me conviene hacer. No ejecutes cambios todavía."
  void sendPrompt("¿Qué está pasando con mis misiones?", root, null, null, undefined, hidden).catch((cause) => notify.error("No pude abrir el chat de Mi Flufy", cause instanceof Error ? cause.message : String(cause)))
}

function NowSection({ missions, selectedId, onSelect }: { missions: AgentMission[]; selectedId?: string | null; onSelect: (mission: AgentMission) => void }) {
  const active = missions.filter((mission) => mission.status === "running" || mission.status === "queued")
  return (
    <section className="mi-block" aria-label="Ahora">
      <header className="mi-block-head">
        <strong><Icon name="vm-running" /> Ahora</strong>
        <span>{active.length || "—"}</span>
      </header>
      {active.length === 0 ? (
        <p className="mi-muted">No hay misiones corriendo ni en cola.</p>
      ) : (
        active.map((mission) => (
          <button key={mission.id} type="button" className={`mi-now-row${selectedId === mission.id ? " selected" : ""}`} onClick={() => onSelect(mission)}>
            <span className={`mi-dot ${mission.status}`} />
            <span className="mi-now-main">
              <strong>{mission.title}</strong>
              <small>{mission.status === "queued" ? "En cola: espera a que termine la que está corriendo." : `Corriendo desde hace ${durationLabel(mission.updatedAt)}`}</small>
            </span>
            <span className="mi-now-action"><Icon name="chevron-right" /></span>
          </button>
        ))
      )}
    </section>
  )
}

function AttentionSection({ items, onOpen }: { items: AgentInboxItem[]; onOpen: (item: AgentInboxItem) => void }) {
  const dismissing = useAgentProfile((s) => s.dismissing)
  if (items.length === 0) {
    return (
      <section className="mi-block">
        <header className="mi-block-head"><strong><Icon name="bell" /> Te necesita</strong><span>0</span></header>
        <p className="mi-muted">Nada pendiente. Todo lo que corre está bajo control.</p>
      </section>
    )
  }
  return (
    <section className="mi-block" aria-label="Te necesita">
      <header className="mi-block-head"><strong><Icon name="bell-dot" /> Te necesita</strong><span>{items.length}</span></header>
      {items.map((item) => (
        <article key={item.id} className="mi-attention">
          <div className="mi-attention-head">
            <span className="mi-attention-kind">{item.kind === "approval" ? "Aprobación" : item.kind === "handoff" ? "Manos" : "Aviso"}</span>
            <span className="mi-muted">{shortAgo(item.at)}</span>
          </div>
          <strong>{item.title}</strong>
          {item.preview || item.body ? <p>{item.preview || item.body}</p> : null}
          <div className="mi-attention-actions">
            {item.kind === "approval" && (
              <>
                <button type="button" className="btn btn-xs btn-primary" disabled={dismissing === item.id} onClick={() => void decideAgentInboxItem(item, "approved")}>Aprobar</button>
                <button type="button" className="btn btn-xs" disabled={dismissing === item.id} onClick={() => void decideAgentInboxItem(item, "rejected")}>Rechazar</button>
              </>
            )}
            {item.kind === "handoff" && (
              <button type="button" className="btn btn-xs btn-primary" disabled={dismissing === item.id} onClick={() => void decideAgentInboxItem(item, "resume")}>Listo, continuar</button>
            )}
            {item.kind === "alert" && item.missionId && (
              <button type="button" className="btn btn-xs btn-primary" onClick={() => void resumeAgentMission(item.missionId!).then(() => dismissAgentInboxItem(item.id))}>Reanudar</button>
            )}
            {item.session && <button type="button" className="btn btn-xs" onClick={() => onOpen(item)}>Abrir chat</button>}
            <button type="button" className="btn btn-xs" disabled={dismissing === item.id} onClick={() => void dismissAgentInboxItem(item.id)}>Descartar</button>
          </div>
        </article>
      ))}
    </section>
  )
}

function ResultsSection({ items, onOpen }: { items: AgentInboxItem[]; onOpen: (item: AgentInboxItem) => void }) {
  const dismissing = useAgentProfile((s) => s.dismissing)
  if (items.length === 0) return null
  return (
    <details className="mi-results">
      <summary><Icon name="inbox" /> Resultados y avisos <span>{items.length}</span></summary>
      {items.map((item) => (
        <article key={item.id} className="mi-result">
          <strong>{item.title}</strong>
          {item.body ? <p>{item.body}</p> : null}
          <div className="mi-attention-actions">
            {item.session && <button type="button" className="btn btn-xs" onClick={() => onOpen(item)}>Abrir chat</button>}
            <button type="button" className="btn btn-xs" disabled={dismissing === item.id} onClick={() => void dismissAgentInboxItem(item.id)}>Descartar</button>
          </div>
        </article>
      ))}
    </details>
  )
}

function AutomationRow({ mission, selected, onSelect, project }: { mission: AgentMission; selected: boolean; onSelect: () => void; project: string | null }) {
  const lastRun = mission.state.runs?.[0]
  const sameProject = !mission.project || !project || samePath(mission.project, project)
  return (
    <button type="button" className={`mi-row${selected ? " selected" : ""}`} onClick={onSelect}>
      <span className={`mi-dot ${mission.status}`} />
      <span className="mi-row-main">
        <span className="mi-row-title">
          <strong>{mission.title}</strong>
          <span className={`mi-status ${mission.status}`}>{MISSION_STATUS[mission.status] ?? mission.status}</span>
        </span>
        <span className="mi-row-meta">
          {scheduleLabel(mission.schedule)} · {basename(mission.project ?? "") || "Sin proyecto"}
          {!sameProject ? " · otro proyecto" : ""}
        </span>
        <span className="mi-row-meta">
          {mission.status === "paused"
            ? mission.state.lastError ? `Pausada: ${mission.state.lastError}` : "Pausada · activá para que corra"
            : mission.status === "armed" ? `Próxima: ${nextLabel(mission.state.nextRunAt)}` : lastRun ? `Última: ${RUN_STATUS[lastRun.status] ?? lastRun.status} ${shortAgo(lastRun.finishedAt)}` : "Sin corridas todavía"}
        </span>
      </span>
      <span className="mi-row-model">{modelKey(mission.model) ? mission.model?.modelID : "modelo predeterminado"}</span>
    </button>
  )
}

function RunReportDialog({ mission, run, onClose, onOpenSession }: { mission: AgentMission; run: AgentMissionRun; onClose: () => void; onOpenSession: (session: string) => void }) {
  const summary = agendaResult(run)
  const raw = (run.summary ?? "").trim()
  const showRaw = !!raw && raw !== summary
  return (
    <div className="mi-overlay" onMouseDown={onClose}>
      <div className="mi-dialog mi-run-dialog" role="dialog" aria-modal="true" aria-label={`Resumen de ${mission.title}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="mi-settings-head">
          <div>
            <span className="mi-eyebrow">CORRIDA</span>
            <h2>{mission.title}</h2>
            <p className="mi-muted">{RUN_STATUS[run.status] ?? run.status} · {agendaWhen(run.finishedAt)} · {durationLabel(run.startedAt, run.finishedAt)}</p>
          </div>
          <button type="button" className="icon-button" title="Cerrar" aria-label="Cerrar" onClick={onClose}><Icon name="close" /></button>
        </header>
        <section className="mi-run-report-section">
          <span className="mi-eyebrow">RESUMEN</span>
          <p>{run.error || summary || "La corrida terminó sin un resumen escrito."}</p>
        </section>
        {showRaw && (
          <details className="mi-run-raw">
            <summary>Ver informe crudo</summary>
            <pre>{raw}</pre>
          </details>
        )}
        <div className="mi-brief-actions">
          {run.sessionId ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpenSession(run.sessionId!)}>
              <Icon name="comment-discussion" /> Abrir reporte completo
            </button>
          ) : (
            <span className="mi-muted">Esta corrida no tiene una sesión guardada.</span>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  )
}

function RunHistory({ mission, onOpenSession }: { mission: AgentMission; onOpenSession: (session: string) => void }) {
  const [report, setReport] = useState<AgentMissionRun | null>(null)
  const runs = mission.state.runs ?? []
  const active = mission.status === "running"
  const lastSession = !!mission.state.sessionId && !active && runs.length === 0
  return (
    <section className="mi-detail-section" aria-label="Corridas">
      <header className="mi-detail-section-head">
        <strong>Corridas</strong>
        <span>{runs.length + (active ? 1 : 0) + (lastSession ? 1 : 0)}</span>
      </header>
      {!active && runs.length === 0 && !lastSession && <p className="mi-muted">Todavía no corrió.</p>}
      {lastSession && (
        <article className={`mi-run ${mission.state.lastStatus === "blocked" ? "blocked" : ""}`}>
          <span className={`mi-dot ${mission.state.lastStatus === "blocked" ? "blocked" : "done"}`} />
          <div>
            <strong>{RUN_STATUS[mission.state.lastStatus ?? ""] ?? "Sesión disponible"}</strong>
            <small>Última sesión sin historial detallado · {shortAgo(mission.updatedAt)}</small>
            {mission.state.lastError ? <p className="mi-run-error">{mission.state.lastError}</p> : null}
          </div>
        </article>
      )}
      {active && (
        <article className="mi-run running">
          <span className="mi-dot running" />
          <div>
            <strong>Corriendo ahora</strong>
            <small>{durationLabel(mission.updatedAt)} en curso{mission.state.sessionId ? " · chat disponible" : ""}</small>
          </div>
        </article>
      )}
      {runs.map((run: AgentMissionRun) => {
        const summary = agendaResult(run)
        return (
          <article key={run.id} className={`mi-run ${run.status}`}>
            <span className={`mi-dot ${run.status}`} />
            <div>
              <strong>{RUN_STATUS[run.status] ?? run.status}</strong>
              <small>{durationLabel(run.startedAt, run.finishedAt)} · {shortAgo(run.finishedAt)}</small>
              {run.error ? <p className="mi-run-error">{run.error}</p> : summary ? <p>{summary}</p> : null}
              <div className="mi-run-actions">
                <button type="button" className="btn btn-xs" onClick={() => setReport(run)}>Ver resumen</button>
                {run.sessionId && <button type="button" className="btn btn-xs" onClick={() => onOpenSession(run.sessionId!)}>Reporte completo</button>}
              </div>
            </div>
          </article>
        )
      })}
      {report && <RunReportDialog mission={mission} run={report} onClose={() => setReport(null)} onOpenSession={(sessionId) => { setReport(null); onOpenSession(sessionId) }} />}
    </section>
  )
}

function MissionDetail({ mission, models }: { mission: AgentMission; models: ProviderModel[] }) {
  const [tab, setTab] = useState<"summary" | "runs">("summary")
  const [autoBriefError, setAutoBriefError] = useState(false)
  const [resumeNote, setResumeNote] = useState("")
  const autoRequested = useRef(false)
  const inbox = useAgentProfile((s) => s.inbox)
  const busy = useAgentProfile((s) => s.busyMission === mission.id)
  const currentProject = useProject((s) => s.project ?? s.root)
  const session = mission.state.sessionId
  const sameProject = !mission.project || !currentProject || samePath(mission.project, currentProject)
  const autoBrief = mission.autoBrief !== false
  const canBrief = !!session || (mission.state.runs?.length ?? 0) > 0 || inbox.some((item) => item.missionId === mission.id)
  const needsResume = mission.status === "paused" || mission.status === "waiting-hands" || (mission.status !== "waiting-approval" && mission.state.lastStatus === "blocked")
  const bots = useBots((s) => s.bots)
  const ownerId = mission.botId ?? "flufy"
  const ownerOptions = [
    ...(bots.some((bot) => bot.id === "flufy") ? [] : [{ value: "flufy", label: "Mi Flufy" }]),
    ...bots.map((bot) => ({ value: bot.id, label: bot.name })),
  ]

  useEffect(() => {
    if (mission.state.brief || !autoBrief || !canBrief || mission.status === "running" || autoRequested.current) return
    autoRequested.current = true
    void generateAgentMissionBrief(mission.id).then((brief) => { if (!brief) setAutoBriefError(true) })
  }, [mission.id, mission.state.brief, autoBrief, canBrief, mission.status])

  const openRunSession = (sessionId: string) => openMissionSession(mission, sessionId, currentProject)

  const toggle = () => {
    const status = mission.status === "armed" ? "paused" : "armed"
    void saveAgentMission({ ...mission, status, state: { ...mission.state, nextRunAt: status === "armed" ? null : mission.state.nextRunAt } })
  }

  return (
    <div className="mi-detail">
      <header className="mi-detail-head">
        <div>
          <span className={`mi-status ${mission.status}`}>{MISSION_STATUS[mission.status] ?? mission.status}</span>
          <h2>{mission.title}</h2>
          <p>{mission.goal}</p>
        </div>
        <div className="mi-detail-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={busy || mission.status === "running"} onClick={() => void runAgentMission(mission.id)}>
            <Icon name={busy ? "loading" : "play"} spin={busy} /> Correr ahora
          </button>
          <button type="button" className="btn btn-sm" disabled={mission.status === "running"} onClick={toggle}>
            {mission.status === "armed" ? "Pausar" : "Programar"}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => openMissionChat(mission, currentProject)} disabled={!session}>
            <Icon name="comment-discussion" /> Chat
          </button>
          <button type="button" className="icon-button" title="Borrar" aria-label="Borrar" disabled={mission.status === "running"} onClick={() => void deleteAgentMission(mission.id)}>
            <Icon name="trash" />
          </button>
        </div>
      </header>

      {mission.state.brief ? (
        <section className="mi-brief" aria-label="Resumen para mí">
          <header className="mi-brief-head">
            <span><Icon name="lightbulb" /> Resumen para mí</span>
            {mission.state.brief.confidence && <small>Confianza {mission.state.brief.confidence}</small>}
          </header>
          <h3>{mission.state.brief.headline}</h3>
          <p>{mission.state.brief.summary}</p>
          {mission.state.brief.findings.length > 0 && (
            <ul className="mi-brief-list">
              {mission.state.brief.findings.map((finding, index) => <li key={index}>{finding}</li>)}
            </ul>
          )}
          {mission.state.brief.decisions.length > 0 && (
            <div className="mi-brief-decisions"><strong>Para decidir</strong><ul>{mission.state.brief.decisions.map((decision, index) => <li key={index}>{decision}</li>)}</ul></div>
          )}
          <div className="mi-brief-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => openMissionChat(mission, currentProject)} disabled={!session}>Ver informe completo</button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void generateAgentMissionBrief(mission.id)}>
              <Icon name={busy ? "loading" : "refresh"} spin={busy} /> Actualizar resumen
            </button>
          </div>
        </section>
      ) : autoBrief && canBrief ? (
        <div className="mi-brief-empty">
          <Icon name={autoBriefError ? "warning" : "loading"} spin={!autoBriefError} />
          <p>{autoBriefError ? "No pude preparar el resumen automático." : "Preparando el resumen automático; el informe completo ya está en Chat."}</p>
          {autoBriefError && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setAutoBriefError(false); void generateAgentMissionBrief(mission.id).then((brief) => { if (!brief) setAutoBriefError(true) }) }}>
              Reintentar resumen
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => openMissionChat(mission, currentProject)} disabled={!session}>Ver informe completo</button>
        </div>
      ) : (
        <div className="mi-brief-empty">
          <Icon name="lightbulb" />
          <p>El informe crudo puede ser largo. Pedile a Mi Flufy un resumen breve con hallazgos y decisiones.</p>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void generateAgentMissionBrief(mission.id)}>
            <Icon name={busy ? "loading" : "lightbulb"} spin={busy} /> Generar resumen breve
          </button>
        </div>
      )}

      <div className="mi-meta-grid">
        <div><span>Dueño</span><Select className="mi-select" ariaLabel="Bot dueño de la misión" value={ownerId} options={ownerOptions} onChange={(value) => void saveAgentMission({ ...mission, botId: value })} /><small>{mission.originSessionId ? "Surgió en una conversación" : "Misión del bot"}</small></div>
        <div><span>Horario</span><strong>{scheduleLabel(mission.schedule)}</strong><small>Próxima: {nextLabel(mission.state.nextRunAt)}</small></div>
        <div><span>Proyecto</span><strong>{basename(mission.project ?? "") || "Sin proyecto"}</strong><small>{sameProject ? "Este proyecto" : "Otro proyecto"}</small></div>
        <div><span>Playbook</span><strong>{mission.playbook || "Predeterminado"}</strong><small>Instrucciones de la misión</small></div>
        <div><span>Supervisor</span><strong>Activo</strong><small>Vigila loops, estancamiento y desvíos</small></div>
        <div className="mi-meta-model">
          <span>Modelo</span>
          <MissionModelSelect value={modelKey(mission.model)} models={models} disabled={mission.status === "running"} onChange={(value) => void saveAgentMission({ ...mission, model: parseModelKey(value) })} />
          <small>Se usa en la próxima corrida</small>
        </div>
        <div className="mi-meta-autonomy">
          <span>Autonomía</span>
          <Select
            className="mi-select"
            ariaLabel="Autonomía de la misión"
            value={mission.autonomy ?? "alta"}
            disabled={mission.status === "running"}
            options={[
              { value: "alta", label: "Alta: sigue y cierra sola" },
              { value: "manual", label: "Manual: se detiene ante bloqueos" },
            ]}
            onChange={(value) => void saveAgentMission({ ...mission, autonomy: value })}
          />
          <small>Pide aprobación para enviar, publicar, pagar o borrar</small>
        </div>
        <div className="mi-meta-brief-setting">
          <span>Resumen</span>
          <Toggle checked={autoBrief} label={autoBrief ? "Automático" : "Manual"} onChange={(value) => void saveAgentMission({ ...mission, autoBrief: value })} />
          <small>El editor resume el informe después de cada corrida</small>
        </div>
        <div className="mi-meta-review-model">
          <span>Modelo revisor</span>
          <MissionModelSelect value={modelKey(mission.reviewModel)} models={models} disabled={mission.status === "running"} onChange={(value) => void saveAgentMission({ ...mission, reviewModel: parseModelKey(value) })} />
          <small>Vacío: usa el mismo modelo de la misión</small>
        </div>
      </div>

      {needsResume && (
        <div className="mi-alert" role="note">
          <Icon name="warning" />
          <div>
            <strong>{mission.status === "waiting-approval" ? "Espera tu aprobación." : "La misión está pausada."}</strong>
            <p>{mission.state.lastError || "Revisá el chat, contá qué decidiste y reanudá la misión."}</p>
            <div className="mi-resume-form">
              <input
                className="agent-input"
                value={resumeNote}
                placeholder="Tu respuesta o decisión (opcional)"
                onChange={(event) => setResumeNote(event.target.value)}
              />
              <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={() => void resumeAgentMission(mission.id, resumeNote).then(() => setResumeNote(""))}>
                <Icon name={busy ? "loading" : "play"} spin={busy} /> Reanudar
              </button>
              <button type="button" className="btn btn-xs" onClick={() => openMissionChat(mission, currentProject)} disabled={!session}>Abrir chat</button>
            </div>
          </div>
        </div>
      )}

      <div className="mi-tabs" role="tablist">
        <button type="button" className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")} role="tab">Resumen</button>
        <button type="button" className={tab === "runs" ? "active" : ""} onClick={() => setTab("runs")} role="tab">Corridas</button>
      </div>

      {tab === "summary" && (
        <div className="mi-detail-section">
          <RunHistory mission={mission} onOpenSession={openRunSession} />
          {mission.artifacts && mission.artifacts.length > 0 && (
            <section className="mi-detail-section">
              <header className="mi-detail-section-head"><strong>Artefactos</strong></header>
              <div className="mi-artifacts">
                {mission.artifacts.filter((artifact) => artifact.url).map((artifact) => (
                  <a key={artifact.url} className="btn btn-xs" href={artifact.url} target="_blank" rel="noreferrer">
                    <Icon name="link-external" /> {artifact.kind === "doc" ? "Abrir documento" : "Abrir artefacto"}
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
      {tab === "runs" && <RunHistory mission={mission} onOpenSession={openRunSession} />}

    </div>
  )
}

function EffectsSection() {
  const pulse = useAgentProfile((s) => s.pulse)
  const pulseError = useAgentProfile((s) => s.pulseError)
  return (
    <section className="agent-section" aria-label="Vigía">
      <header className="agent-section-head">
        <div>
          <strong><Icon name="pulse" /> Vigía</strong>
          <small>Revisa el proyecto solo cuando la PC y Flufy están disponibles. Si no, no hace nada.</small>
        </div>
        <Toggle checked={pulse} label={pulse ? "Activado" : "Apagado"} onChange={(value) => void setAgentPulse(value)} />
      </header>
      {pulseError && <div className="view-error">{pulseError}</div>}
    </section>
  )
}

function agendaWhen(ms?: number | null): string {
  if (!ms) return "sin fecha"
  return new Date(ms).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
}

function agendaResult(run: { summary?: string | null; error?: string | null }): string {
  if (run.error?.trim()) return run.error.trim()
  let text = (run.summary ?? "").trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim()
  if (!text) return ""
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as { summary?: unknown; message?: unknown }
      if (typeof data.summary === "string") return data.summary.trim()
      if (typeof data.message === "string") return data.message.trim()
    } catch {
      const match = text.match(/["']?summary["']?\s*:\s*(['"])([\s\S]*?)\1\s*(?:,|})/i)
      if (match) return match[2].replace(/\\n/g, " ").replace(/\\"/g, '"').trim()
    }
  }
  return text
}

function BotAgenda({ missions, onSelectMission }: { missions: AgentMission[]; onSelectMission: (mission: AgentMission) => void }) {
  const active = missions.filter((mission) => mission.status === "running" || mission.status === "queued")
  const upcoming = missions
    .filter((mission) => (mission.status === "armed" || mission.status === "queued") && mission.state.nextRunAt)
    .sort((a, b) => (a.state.nextRunAt ?? 0) - (b.state.nextRunAt ?? 0))
  const runs = missions
    .flatMap((mission) => (mission.state.runs ?? []).map((run) => ({ mission, run })))
    .sort((a, b) => b.run.finishedAt - a.run.finishedAt)
    .slice(0, 12)

  return (
    <div className="mi-bot-agenda">
      {active.length > 0 && (
        <section className="mi-detail-section">
          <header className="mi-detail-section-head"><strong>Ahora</strong><span>{active.length}</span></header>
          {active.map((mission) => (
            <button key={mission.id} type="button" className="mi-agenda-row" onClick={() => onSelectMission(mission)}>
              <span className={`mi-dot ${mission.status}`} />
              <span className="mi-row-main"><strong>{mission.title}</strong><small>{MISSION_STATUS[mission.status] ?? mission.status} · desde {agendaWhen(mission.updatedAt)}</small></span>
              <Icon name="chevron-right" />
            </button>
          ))}
        </section>
      )}
      <section className="mi-detail-section">
        <header className="mi-detail-section-head"><strong>Próximas</strong><span>{upcoming.length}</span></header>
        {upcoming.length === 0 ? <p className="mi-muted">No hay próximas corridas programadas.</p> : upcoming.map((mission) => (
          <button key={mission.id} type="button" className="mi-agenda-row" onClick={() => onSelectMission(mission)}>
            <span className={`mi-dot ${mission.status}`} />
            <span className="mi-row-main">
              <strong>{mission.title}</strong>
              <small>{agendaWhen(mission.state.nextRunAt)} · {scheduleLabel(mission.schedule)}</small>
              <small className="mi-agenda-goal">{mission.goal}</small>
            </span>
            <Icon name="chevron-right" />
          </button>
        ))}
      </section>
      <section className="mi-detail-section">
        <header className="mi-detail-section-head"><strong>Últimas corridas</strong><span>{runs.length}</span></header>
        {runs.length === 0 ? <p className="mi-muted">Todavía no hay corridas.</p> : runs.map(({ mission, run }) => {
          const result = agendaResult(run)
          return (
            <button key={`${mission.id}:${run.id}`} type="button" className="mi-agenda-row" onClick={() => onSelectMission(mission)}>
              <span className={`mi-dot ${run.status}`} />
              <span className="mi-row-main">
                <strong>{mission.title} · {RUN_STATUS[run.status] ?? run.status}</strong>
                <small>{agendaWhen(run.finishedAt)} · {durationLabel(run.startedAt, run.finishedAt)}</small>
                {result && <small className="mi-agenda-result">{result}</small>}
              </span>
              <Icon name="chevron-right" />
            </button>
          )
        })}
      </section>
    </div>
  )
}

function routineMissionStatus(status: string): string {
  if (status === "ok") return "ok"
  if (status === "corriendo") return "running"
  if (status === "esperando") return "needs-hands"
  if (status === "interrumpida") return "interrupted"
  return "failed"
}

function BotRoutines({ bot, routines, missions, onOpenMission, onConverted }: { bot?: Bot | null; routines: Routine[]; missions: AgentMission[]; onOpenMission: (mission: AgentMission) => void; onConverted: () => void }) {
  const [converting, setConverting] = useState<string | null>(null)

  const convert = async (routine: Routine) => {
    if (!bot || converting) return
    setConverting(routine.id)
    const runs = routine.runs.flatMap((run) => {
      if (run.status === "ok" && !run.summary.trim() && !run.error) return []
      return [{
        id: run.id,
        sessionId: run.sessionId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? run.startedAt,
        status: routineMissionStatus(run.status),
        summary: run.summary || null,
        error: run.error,
      }]
    })
    const saved = await saveAgentMission({
      title: routine.name,
      goal: routine.prompt,
      project: routine.project,
      status: "armed",
      botId: bot.id,
      originRoutineId: routine.id,
      schedule: routine.schedule,
      model: routine.model,
      autonomy: "alta",
      policy: { reads: "auto", drafts: "auto", commits: "approval" },
      computer: bot.capabilities,
      state: { runs, lastRunAt: runs[0]?.finishedAt ?? null, lastStatus: runs[0]?.status ?? null },
    })
    if (saved) {
      await setRoutineEnabled(routine.id, false)
      onConverted()
    }
    setConverting(null)
  }

  return (
    <section className="mi-detail-section mi-bot-missions">
      <header className="mi-detail-section-head"><strong>Rutinas heredadas</strong><span>{routines.length}</span></header>
      <p className="mi-muted">Para un bot, una rutina se convierte en misión: conserva horario, objetivo e historial, y la rutina queda pausada para no duplicar.</p>
      {routines.length === 0 ? <p className="mi-muted">No hay rutinas heredadas. Las misiones son el único scheduler de este bot.</p> : (
        <div className="mi-rows">
          {routines.map((routine) => {
            const last = routine.runs[0]
            const migrated = missions.find((mission) => mission.originRoutineId === routine.id)
            return (
              <div key={routine.id} className="mi-row mi-routine-row">
                <span className={`mi-dot ${migrated ? "done" : routine.enabled ? "armed" : "paused"}`} />
                <button type="button" className="mi-row-main mi-row-main-button" onClick={() => openRoutine(routine.id)}>
                  <strong>{routine.name}</strong>
                  <small>{routineScheduleLabel(routine.schedule)} · {migrated ? "Migrada a misión" : routine.enabled ? `Próxima: ${agendaWhen(routine.nextRun)}` : "Pausada"}</small>
                  {last && <small>{routineRunLabel(last).label} · {agendaWhen(last.finishedAt ?? last.startedAt)}</small>}
                </button>
                {migrated ? (
                  <button type="button" className="btn btn-xs" onClick={() => onOpenMission(migrated)}>Ver misión</button>
                ) : (
                  <button type="button" className="btn btn-xs btn-primary" disabled={Boolean(converting)} onClick={() => void convert(routine)}>
                    <Icon name={converting === routine.id ? "loading" : "arrow-right"} spin={converting === routine.id} /> Convertir
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function BotDetailPanel({ initial, routines, onSaved, onClose, onSelectMission, onCreateMission }: { initial?: Bot | null; routines: Routine[]; onSaved: (bot: Bot) => void; onClose: () => void; onSelectMission: (mission: AgentMission) => void; onCreateMission: (botId: string) => void }) {
  const models = useAgent((s) => s.models)
  const save = useBots((s) => s.save)
  const missions = useAgentProfile((s) => s.missions)
  const botMissions = initial ? missions.filter((mission) => (mission.botId ?? "flufy") === initial.id) : []
  const [name, setName] = useState(initial?.name ?? "")
  const [role, setRole] = useState(initial?.role ?? "")
  const [instructions, setInstructions] = useState(initial?.instructions ?? "")
  const [modelChoice, setModelChoice] = useState(modelKey(initial?.model))
  const [fallbackModelChoice, setFallbackModelChoice] = useState(modelKey(initial?.fallbackModel))
  const [autonomy, setAutonomy] = useState(initial?.autonomy ?? "alta")
  const [browser, setBrowser] = useState(initial?.capabilities?.browser ?? "borrowed")
  const [files, setFiles] = useState(initial?.capabilities?.files !== false)
  const [terminal, setTerminal] = useState(initial?.capabilities?.terminal !== false)
  const [desktop, setDesktop] = useState(initial?.capabilities?.desktop === true)
  const [enabled, setEnabled] = useState(initial?.enabled !== false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<"agenda" | "misiones" | "rutinas" | "configuracion">(initial ? "agenda" : "configuracion")

  const submit = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    const saved = await save({
      id: initial?.id,
      name: name.trim(),
      role: role.trim(),
      instructions: instructions.trim(),
      model: parseModelKey(modelChoice),
      fallbackModel: parseModelKey(fallbackModelChoice),
      autonomy,
      capabilities: { browser, files, terminal, desktop },
      enabled,
    })
    setBusy(false)
    if (saved) {
      setTab("agenda")
      onSaved(saved)
    }
  }

  return (
    <div className="mi-detail mi-bot-detail">
      <header className="mi-detail-head">
        <div>
          <span className="mi-status armed">Bot</span>
          <h2>{initial?.name || "Nuevo bot"}</h2>
          <p>{initial?.role || "Una identidad persistente con sus propias instrucciones, modelo y capacidades."}</p>
        </div>
        <div className="mi-detail-actions">
          {initial && <button type="button" className="btn btn-sm btn-primary" onClick={() => onCreateMission(initial.id)}><Icon name="add" /> Nueva misión</button>}
          <button type="button" className="btn btn-sm" onClick={onClose}>Volver</button>
        </div>
      </header>
      <div className="mi-tabs" role="tablist">
        <button type="button" className={tab === "agenda" ? "active" : ""} onClick={() => setTab("agenda")} role="tab">Agenda</button>
        <button type="button" className={tab === "misiones" ? "active" : ""} onClick={() => setTab("misiones")} role="tab">Misiones</button>
        <button type="button" className={tab === "rutinas" ? "active" : ""} onClick={() => setTab("rutinas")} role="tab">Rutinas</button>
        <button type="button" className={tab === "configuracion" ? "active" : ""} onClick={() => setTab("configuracion")} role="tab">Configuración</button>
      </div>
      {tab === "agenda" && <BotAgenda missions={botMissions} onSelectMission={onSelectMission} />}
      {tab === "rutinas" && <BotRoutines bot={initial} routines={routines} missions={botMissions} onOpenMission={onSelectMission} onConverted={() => setTab("agenda")} />}
      {tab === "misiones" && (
        <section className="mi-detail-section mi-bot-missions">
          <header className="mi-detail-section-head"><strong>Misiones de este bot</strong><span>{botMissions.length}</span></header>
          {botMissions.length === 0 ? <p className="mi-muted">Todavía no tiene misiones asignadas.</p> : (
            <div className="mi-rows">
              {botMissions.map((mission) => (
                <button key={mission.id} type="button" className="mi-row" onClick={() => onSelectMission(mission)}>
                  <span className={`mi-dot ${mission.status}`} />
                  <span className="mi-row-main"><strong>{mission.title}</strong><small>{MISSION_STATUS[mission.status] ?? mission.status} · {scheduleLabel(mission.schedule)}</small></span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {tab === "configuracion" && (
        <div className="agent-mission-form mi-bot-form">
          <label className="agent-field"><span>Nombre</span><input className="agent-input" value={name} placeholder="Ej. Revisor" onChange={(event) => setName(event.target.value)} /></label>
          <label className="agent-field"><span>Rol</span><input className="agent-input" value={role} placeholder="Ej. Revisa informes y escribe resúmenes" onChange={(event) => setRole(event.target.value)} /></label>
          <label className="agent-field"><span>Instrucciones</span><textarea className="agent-input" rows={6} value={instructions} placeholder="Cómo piensa, qué revisa y qué no debe hacer." onChange={(event) => setInstructions(event.target.value)} /></label>
          <div className="mi-meta-grid">
            <label className="agent-field"><span>Modelo</span><MissionModelSelect value={modelChoice} models={models} onChange={setModelChoice} /></label>
            <label className="agent-field"><span>Fallback</span><MissionModelSelect value={fallbackModelChoice} models={models} onChange={setFallbackModelChoice} /></label>
            <label className="agent-field"><span>Autonomía</span><Select value={autonomy} options={[{ value: "alta", label: "Alta" }, { value: "manual", label: "Manual" }]} onChange={setAutonomy} /></label>
            <label className="agent-field"><span>Chrome</span><Select value={browser} options={[{ value: "borrowed", label: "Prestado" }, { value: "own", label: "Propio" }, { value: "internal", label: "Interno" }]} onChange={setBrowser} /></label>
          </div>
          <div className="agent-mission-actions">
            <Toggle checked={files} label="Archivos" onChange={setFiles} />
            <Toggle checked={terminal} label="Terminal" onChange={setTerminal} />
            <Toggle checked={desktop} label="Escritorio" onChange={setDesktop} />
            <Toggle checked={enabled} label="Activo" onChange={setEnabled} />
          </div>
          <div className="agent-form-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
              <Icon name={busy ? "loading" : "check"} spin={busy} /> Guardar bot
            </button>
            {initial && <span className="agent-saved">Los cambios se aplican a sus próximas misiones.</span>}
          </div>
        </div>
      )}
    </div>
  )
}

function startBotAdminChat() {
  const root = useProject.getState().project ?? useProject.getState().root
  useLayout.getState().showView("agents", false)
  useLayout.getState().toggleAgent(true)
  const hidden = "Sos el administrador de los bots de Mi Flufy. Podés usar agent_bots_list, agent_bot_get, agent_bot_save, agent_missions_overview, agent_mission_create, agent_mission_assign y agent_mission_run, además de routine_list y routine_create. Primero listá bots, misiones y rutinas. Preguntame qué quiero cambiar; no desactives, borres ni ejecutes nada sin confirmación explícita. Para crear un bot pedime nombre, rol, instrucciones, modelo y capacidades. Para crear una misión usá agent_mission_create con título, objetivo, botId y horario; no afirmes que la creaste si la herramienta no devolvió la misión. Para asignar una misión existente, confirmá el id de la misión y el bot. Una rutina nativa es del proyecto y no es una misión del bot: no uses el id del bot como agent de una rutina ni la presentes como automatización del bot. Si el usuario quiere que un bot haga algo recurrente, creá una misión del bot; si quiere una rutina de proyecto, usá routine_create y decí que se administra en Mis rutinas."
  const open = async () => {
    await loadSessions().catch(() => false)
    const existing = useAgent.getState().allSessions
      .filter((session) => sessionRuntime(session.id).botAdmin === true || /^(Administrador de bots|Administración de bots|Gestión de bots y misiones|Bots y misiones de Mi Flufy)/.test(session.title))
      .sort((a, b) => b.time.updated - a.time.updated)[0]
    if (existing) {
      if (sessionRuntime(existing.id).botAdmin !== true) patchSessionRuntime(existing.id, { botAdmin: true })
      selectSession(existing.id)
      focusComposer()
      return
    }
    const id = await sendPrompt(BOT_ADMIN_MARKER, root, null, null, undefined, hidden)
    if (!id) return
    patchSessionRuntime(id, { botAdmin: true, draft: "" })
    await renameSession(id, "Administrador de bots").catch(() => undefined)
  }
  void open().catch((cause) => notify.error("No pude abrir el administrador de bots", cause instanceof Error ? cause.message : String(cause)))
}

function BotsSection({ selectedId, onSelect, onNew }: { selectedId?: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const bots = useBots((s) => s.bots)
  const loading = useBots((s) => s.loading)
  const error = useBots((s) => s.error)

  useEffect(() => {
    startBots()
  }, [])

  return (
    <section className="mi-block mi-bots" aria-label="Bots">
      <header className="mi-block-head">
        <strong><Icon name="hubot" /> Bots</strong>
        <div className="mi-filters">
          <button type="button" className="btn btn-xs" onClick={startBotAdminChat}><Icon name="comment-discussion" /> Administrar</button>
          <button type="button" className="btn btn-xs" onClick={onNew}><Icon name="add" /> Nuevo</button>
        </div>
      </header>
      {error && <div className="view-error">{error}</div>}
      {loading && bots.length === 0 && <p className="mi-muted">Cargando bots…</p>}
      {!loading && bots.length === 0 && <p className="mi-muted">Todavía no hay bots.</p>}
      <div className="mi-rows">
        {bots.map((bot) => (
          <button key={bot.id} type="button" className={`mi-bot-row${selectedId === bot.id ? " selected" : ""}`} onClick={() => onSelect(bot.id)}>
            <span className="mi-bot-avatar" style={bot.color ? { background: bot.color } : undefined}><Icon name="hubot" /></span>
            <span className="mi-row-main"><strong>{bot.name}</strong><small>{bot.role || "Sin rol"} · {bot.model?.modelID || "modelo del agente"}{bot.fallbackModel?.modelID ? ` → ${bot.fallbackModel.modelID}` : ""}</small></span>
            <span className={`mi-dot ${bot.enabled ? "armed" : "paused"}`} />
          </button>
        ))}
      </div>
    </section>
  )
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const profile = useAgentProfile((s) => s.profile)
  const firstRun = useAgentProfile((s) => s.firstRun)
  const loaded = useAgentProfile((s) => s.loaded)
  const error = useAgentProfile((s) => s.error)
  const saving = useAgentProfile((s) => s.saving)
  const savedAt = useAgentProfile((s) => s.savedAt)
  const [draft, setDraft] = useState(profile)
  const [synced, setSynced] = useState(profile)
  const [browserMode, setBrowserMode] = useState<"borrowed" | "own">("borrowed")
  const [browserCheck, setBrowserCheck] = useState("")
  const [checkingBrowser, setCheckingBrowser] = useState(false)

  useEffect(() => {
    void call<{ mode?: string }>("agent_browser_mode_get")
      .then((data) => { if (data?.mode === "own" || data?.mode === "borrowed") setBrowserMode(data.mode) })
      .catch(() => undefined)
  }, [])

  const changeBrowserMode = async (mode: "borrowed" | "own") => {
    setBrowserMode(mode)
    setBrowserCheck("")
    try {
      const data = await call<{ mode?: string }>("agent_browser_mode_set", { mode })
      if (data?.mode === "own" || data?.mode === "borrowed") setBrowserMode(data.mode)
      notify.info("Chrome de misiones", mode === "own" ? "Se usará un perfil dedicado. Iniciá sesión una vez cuando se abra." : "Se usará tu Chrome actual con una pestaña asignada.")
    } catch (cause) {
      notify.error("No se pudo cambiar el Chrome de misiones", cause instanceof Error ? cause.message : String(cause))
    }
  }

  const checkBrowser = async () => {
    setCheckingBrowser(true)
    setBrowserCheck("")
    try {
      const data = await call<{ mode?: string; workspace?: string; workspaceState?: { pages?: unknown[] } }>("agent_browser_preflight")
      const count = Array.isArray(data?.workspaceState?.pages) ? data.workspaceState.pages.length : 0
      setBrowserCheck(`Chrome listo (${data?.mode === "own" ? "perfil propio" : "prestado"}) · ${count} pestaña${count === 1 ? "" : "s"}.`)
    } catch (cause) {
      setBrowserCheck(`No pude preparar Chrome: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setCheckingBrowser(false)
    }
  }

  if (profile !== synced) {
    setSynced(profile)
    setDraft(profile)
  }
  const dirty = draft !== profile
  const save = () => {
    if (dirty) void saveAgentProfile(draft)
  }

  return (
    <div className="mi-overlay" onMouseDown={onClose}>
      <div className="mi-settings" role="dialog" aria-modal="true" aria-label="Ajustes de Mi Flufy" onMouseDown={(event) => event.stopPropagation()}>
        <header className="mi-settings-head">
          <div><span className="mi-eyebrow">MI FLUFY</span><h2>Ajustes</h2></div>
          <button type="button" className="icon-button" title="Cerrar" aria-label="Cerrar" onClick={onClose}><Icon name="close" /></button>
        </header>
        {error && <div className="view-error">{error}</div>}
        <section className="agent-section" aria-label="Perfil del agente">
          <header className="agent-section-head">
            <div><strong><Icon name="account" /> Tu agente</strong><small>Se guarda solo en esta PC y lo usa el agente al empezar cada conversación.</small></div>
          </header>
          {firstRun && <div className="agent-first-run" role="note"><Icon name="sparkle" /><p>¿Cómo querés que te hable y qué debería saber de vos?</p></div>}
          <label className="agent-field">
            <span>Perfil</span>
            <textarea className="agent-profile-input" value={draft} rows={7} placeholder="Ejemplo: trato de vos, respuestas cortas, trabajo en proyectos web." onChange={(event) => setDraft(event.target.value)} />
          </label>
          <div className="agent-form-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || saving} onClick={save}>
              <Icon name={saving ? "loading" : "save"} spin={saving} /> Guardar
            </button>
            {dirty && <span className="agent-saved">Cambios sin guardar</span>}
            {!dirty && savedAt && <span className="agent-saved">Guardado {shortAgo(savedAt)}</span>}
            {!loaded && !error && <span className="agent-saved">Cargando…</span>}
          </div>
        </section>
        <section className="agent-section" aria-label="Chrome de misiones">
          <header className="agent-section-head">
            <div><strong><Icon name="browser" /> Chrome de misiones</strong><small>El perfil propio no mezcla tus pestañas personales y conserva el login entre corridas.</small></div>
          </header>
          <label className="agent-field">
            <span>Modo</span>
            <Select
              ariaLabel="Chrome de misiones"
              value={browserMode}
              options={[
                { value: "borrowed", label: "Prestado: una pestaña de tu Chrome" },
                { value: "own", label: "Propio: perfil dedicado (recomendado para autonomía)" },
              ]}
              onChange={(value) => void changeBrowserMode(value as "borrowed" | "own")}
            />
          </label>
          <div className="agent-form-actions">
            <button type="button" className="btn btn-sm" disabled={checkingBrowser} onClick={() => void checkBrowser()}>
              <Icon name={checkingBrowser ? "loading" : "browser"} spin={checkingBrowser} /> Probar Chrome
            </button>
            {browserCheck && <span className="agent-saved">{browserCheck}</span>}
          </div>
        </section>
        <section className="agent-section" aria-label="Registro del agente">
          <header className="agent-section-head"><div><strong><Icon name="history" /> Registro</strong><small>Últimas 20 entradas que dejó el agente.</small></div></header>
          <LogList />
        </section>
        <AbsenceSection />
        <EffectsSection />
      </div>
    </div>
  )
}

function NewMissionDialog({ models, botId, botName, onCreate, onClose }: { models: ProviderModel[]; botId: string; botName?: string; onCreate: (mission: AgentMission) => void; onClose: () => void }) {
  const [title, setTitle] = useState("")
  const [goal, setGoal] = useState("")
  const [scheduleKind, setScheduleKind] = useState<"daily" | "interval">("daily")
  const [time, setTime] = useState("08:30")
  const [hours, setHours] = useState(3)
  const [modelChoice, setModelChoice] = useState("")
  const [saving, setSaving] = useState(false)

  const create = async () => {
    if (!title.trim() || !goal.trim() || saving) return
    setSaving(true)
    const every = Math.min(720, Math.max(1, Math.round(hours) || 1))
    const saved = await saveAgentMission({
      title: title.trim(),
      goal: goal.trim(),
      status: "armed",
      schedule: scheduleKind === "interval" ? { kind: "interval", hours: every } : { kind: "daily", time },
      policy: { reads: "auto", drafts: "auto", commits: "approval" },
      model: parseModelKey(modelChoice),
      autonomy: "alta",
      botId,
      computer: { browser: "borrowed", desktop: false, files: true, terminal: true },
    })
    setSaving(false)
    if (!saved) return
    onCreate(saved)
    onClose()
  }

  return (
    <div className="mi-overlay" onMouseDown={onClose}>
      <div className="mi-dialog" role="dialog" aria-modal="true" aria-label="Nueva misión" onMouseDown={(event) => event.stopPropagation()}>
        <header className="mi-settings-head">
          <div><span className="mi-eyebrow">MI FLUFY</span><h2>Nueva misión</h2></div>
          <button type="button" className="icon-button" title="Cerrar" aria-label="Cerrar" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="agent-mission-form">
          <input className="agent-input" value={title} placeholder="Título (ej. Briefing diario)" onChange={(event) => setTitle(event.target.value)} />
          <textarea className="agent-input" rows={3} value={goal} placeholder="¿Qué tiene que lograr y qué no debe hacer?" onChange={(event) => setGoal(event.target.value)} />
          <p className="mi-muted">Se asigna a <strong>{botName || botId}</strong>.</p>
          <label className="agent-inline-field">
            <span>Frecuencia</span>
            <Select
              value={scheduleKind}
              options={[{ value: "daily", label: "Todos los días" }, { value: "interval", label: "Cada X horas" }]}
              onChange={(value) => setScheduleKind(value as "daily" | "interval")}
            />
          </label>
          {scheduleKind === "daily" ? (
            <label className="agent-inline-field"><span>Hora</span><input className="agent-input" type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
          ) : (
            <label className="agent-inline-field"><span>Cada</span><input className="agent-input" type="number" min={1} max={720} value={hours} onChange={(event) => setHours(Number(event.target.value) || 1)} /><span>horas</span></label>
          )}
          <label className="agent-inline-field"><span>Modelo</span><MissionModelSelect value={modelChoice} models={models} onChange={setModelChoice} /></label>
          <div className="agent-form-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!title.trim() || !goal.trim() || saving} onClick={() => void create()}>
              <Icon name={saving ? "loading" : "check"} spin={saving} /> Crear y programar
            </button>
            <span className="agent-saved">Corre a la hora local; la PC y Flufy tienen que estar disponibles.</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ProfileView() {
  const missions = useAgentProfile((s) => s.missions)
  const inbox = useAgentProfile((s) => s.inbox)
  const inboxError = useAgentProfile((s) => s.inboxError)
  const project = useProject((s) => s.project ?? s.root)
  const models = useAgent((s) => s.models)
  const routines = useRoutines((s) => s.items)
  const [filter, setFilter] = useState<MissionFilter>("all")
  const [projectFilter, setProjectFilter] = useState<"all" | "current">("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [botSelection, setBotSelection] = useState<string | "new" | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [newMissionBotId, setNewMissionBotId] = useState("flufy")

  useEffect(() => {
    startAgentProfile()
    startBots()
    startRoutines()
  }, [])

  const sorted = useMemo(() => {
    const rank: Record<string, number> = { running: 0, queued: 1, "waiting-approval": 2, "waiting-hands": 3, armed: 4, paused: 5, done: 6, failed: 6, draft: 7 }
    return missions.slice().sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.updatedAt - a.updatedAt)
  }, [missions])

  const actionable = useMemo(() => {
    const byId = new Map(missions.map((mission) => [mission.id, mission]))
    return inbox.filter((item) => {
      if (item.ackedAt != null || !["approval", "handoff", "alert"].includes(item.kind)) return false
      const mission = item.missionId ? byId.get(item.missionId) : undefined
      if (mission && mission.state.lastStatus === "ok" && mission.updatedAt > item.at) return false
      return true
    })
  }, [inbox, missions])
  const results = useMemo(() => inbox.filter((item) => item.ackedAt == null && !["approval", "handoff", "alert"].includes(item.kind)), [inbox])
  const activeCount = missions.filter((mission) => mission.status === "running" || mission.status === "queued").length
  const scheduledCount = missions.filter((mission) => mission.status === "armed").length
  const armable = missions.filter((mission) => mission.status === "paused" && !["handoff-demo", "approval-demo"].includes(mission.playbook ?? ""))

  const filtered = useMemo(() => sorted.filter((mission) => {
    if (projectFilter === "current" && mission.project && project && !samePath(mission.project, project)) return false
    if (filter === "active") return mission.status === "running" || mission.status === "queued"
    if (filter === "scheduled") return mission.status === "armed"
    if (filter === "paused") return mission.status === "paused" || mission.status === "waiting-approval" || mission.status === "waiting-hands"
    if (filter === "done") return mission.status === "done" || mission.status === "failed" || mission.status === "draft"
    return true
  }), [sorted, filter, projectFilter, project])

  const selected = botSelection ? null : missions.find((mission) => mission.id === selectedId)
    ?? missions.find((mission) => mission.status === "running")
    ?? filtered[0]
    ?? missions[0]
    ?? null

  const bots = useBots((s) => s.bots)
  const selectedBot = botSelection && botSelection !== "new" ? bots.find((bot) => bot.id === botSelection) ?? null : null
  const selectedBotRoutines = selectedBot ? routines.filter((routine) => routine.agent === selectedBot.id) : []

  const select = (mission: AgentMission) => {
    setBotSelection(null)
    setSelectedId(mission.id)
  }

  const selectBot = (id: string) => {
    setSelectedId(null)
    setBotSelection(id)
  }

  const createBot = () => {
    setSelectedId(null)
    setBotSelection("new")
  }

  const openNewMission = (botId = "flufy") => {
    setNewMissionBotId(botId)
    setNewOpen(true)
  }

  const ask = () => {
    const target = missions.find((mission) => mission.status === "running" && mission.state.sessionId)
      ?? missions.find((mission) => mission.state.lastStatus === "blocked" && mission.state.sessionId)
      ?? missions.find((mission) => mission.state.sessionId)
    if (!target || !target.state.sessionId) {
      startNewChat()
      return
    }
    setBotSelection(null)
    openMissionChat(target, project)
  }

  const openAttention = (item: AgentInboxItem) => {
    if (item.missionId) {
      const mission = missions.find((candidate) => candidate.id === item.missionId)
      if (mission) {
        setBotSelection(null)
        openMissionChat(mission, project)
        return
      }
    }
    openItem(item)
  }

  const armAll = async () => {
    if (armable.length === 0) return
    for (const mission of armable) {
      await saveAgentMission({ ...mission, status: "armed", state: { ...mission.state, nextRunAt: null } })
    }
    notify.info("Misiones activadas", `${armable.length} quedaron programadas para correr solas. Las de prueba que necesitan manos siguen pausadas.`)
  }

  return (
    <div className="view profile-view mi-flufy">
      <header className="mi-top">
        <div>
          <span className="mi-eyebrow">MI FLUFY</span>
          <h1>Automatizaciones</h1>
          <p>{activeCount} en curso · {actionable.length} te necesita · {scheduledCount} programadas</p>
        </div>
        <div className="mi-top-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => openNewMission(selectedBot?.id ?? "flufy")}><Icon name="add" /> Nueva</button>
          <button type="button" className="btn btn-sm" onClick={ask}><Icon name="comment-discussion" /> Preguntar</button>
          <button type="button" className="icon-button" title="Ajustes" aria-label="Ajustes" onClick={() => setSettingsOpen(true)}><Icon name="settings-gear" /></button>
          <button type="button" className="icon-button" title="Actualizar" aria-label="Actualizar" onClick={() => {
            void loadAgentProfile()
            void loadAgentInbox()
            void loadAgentMissions()
            void loadAgentAbsence()
          }}><Icon name="refresh" /></button>
        </div>
      </header>

      {!isTauri ? (
        <p className="view-note">Mi Flufy está disponible solo en la app de escritorio.</p>
      ) : (
        <div className="mi-body">
          <aside className="mi-list" aria-label="Misiones">
            <BotsSection selectedId={selectedBot?.id} onSelect={selectBot} onNew={createBot} />
            <NowSection missions={sorted} selectedId={selected?.id} onSelect={select} />
            {inboxError && <div className="view-error">{inboxError}</div>}
            <AttentionSection items={actionable} onOpen={openAttention} />
            <section className="mi-block mi-automations">
              <header className="mi-block-head">
                <strong><Icon name="checklist" /> Misiones</strong>
                <div className="mi-filters">
                  <Select
                    className="mi-select"
                    ariaLabel="Filtrar por proyecto"
                    value={projectFilter}
                    options={[
                      { value: "all", label: "Todos los proyectos" },
                      { value: "current", label: "Proyecto actual" },
                    ]}
                    onChange={(value) => setProjectFilter(value as "all" | "current")}
                  />
                  {armable.length > 0 && <button type="button" className="btn btn-xs" onClick={() => void armAll()}>Activar {armable.length}</button>}
                </div>
              </header>
              <div className="mi-chips">
                {([["all", "Todas"], ["active", "En curso"], ["scheduled", "Programadas"], ["paused", "Pausadas"], ["done", "Historial"]] as Array<[MissionFilter, string]>).map(([value, label]) => (
                  <button key={value} type="button" className={`mi-chip${filter === value ? " active" : ""}`} onClick={() => setFilter(value)}>{label}</button>
                ))}
              </div>
              {filtered.length === 0 ? (
                <p className="mi-muted">No hay misiones con este filtro. Creá una o cambiá el filtro.</p>
              ) : (
                <div className="mi-rows">
                  {filtered.map((mission) => (
                    <AutomationRow key={mission.id} mission={mission} selected={selected?.id === mission.id} onSelect={() => select(mission)} project={project} />
                  ))}
                </div>
              )}
            </section>
            <ResultsSection items={results} onOpen={openAttention} />
          </aside>

          <main className="mi-detail-pane">
            {botSelection ? (
              <BotDetailPanel
                initial={selectedBot}
                routines={selectedBotRoutines}
                onSaved={(saved) => setBotSelection(saved.id)}
                onClose={() => setBotSelection(null)}
                onSelectMission={select}
                onCreateMission={openNewMission}
              />
            ) : selected ? (
              <MissionDetail key={selected.id} mission={selected} models={models} />
            ) : (
              <div className="mi-empty">
                <Icon name="rocket" />
                <h2>Todavía no tenés misiones</h2>
                <p>Pedile a Mi Flufy que haga algo todos los días, vigile un archivo o prepare un informe.</p>
                <button type="button" className="btn btn-primary" onClick={() => openNewMission(selectedBot?.id ?? "flufy")}><Icon name="add" /> Crear la primera</button>
              </div>
            )}
          </main>
        </div>
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {newOpen && (
        <NewMissionDialog
          models={models}
          botId={newMissionBotId}
          botName={bots.find((bot) => bot.id === newMissionBotId)?.name}
          onClose={() => setNewOpen(false)}
          onCreate={(mission) => {
            if (selectedBot && selectedBot.id === newMissionBotId) {
              setSelectedId(null)
              setBotSelection(selectedBot.id)
            } else {
              setBotSelection(null)
              setSelectedId(mission.id)
            }
          }}
        />
      )}
    </div>
  )
}
