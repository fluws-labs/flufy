import { useEffect, useState } from "react"
import { AgentInbox } from "../components/AgentInbox"
import { Toggle } from "../components/fields"
import { Icon } from "../components/ui"
import { rememberSessionDirectory } from "../lib/opencode"
import { shortAgo, timeAgo } from "../lib/time"
import { isTauri } from "../lib/tauri"
import { selectSession } from "../state/agent"
import { useLayout } from "../state/layout"
import {
  deleteAgentMission,
  dismissAgentInboxItem,
  loadAgentAbsence,
  loadAgentInbox,
  loadAgentProfile,
  loadAgentMissions,
  prepareAgentAbsence,
  runAgentMission,
  saveAgentMission,
  saveAgentProfile,
  setAgentPulse,
  startAgentProfile,
  stopAgentAbsence,
  useAgentProfile,
  type AgentInboxItem,
  type AgentMission,
} from "../state/agentProfile"

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

const MISSION_STATUS: Record<string, string> = {
  draft: "Borrador",
  armed: "Armada",
  queued: "En cola",
  running: "Corriendo",
  "waiting-approval": "Espera aprobación",
  "waiting-hands": "Necesita tus manos",
  paused: "Pausada",
  done: "Terminada",
  failed: "Falló",
}

const CHECK_STATUS: Record<string, string> = { ok: "OK", warn: "Revisar", fail: "Falta" }

function MissionsSection() {
  const missions = useAgentProfile((s) => s.missions)
  const error = useAgentProfile((s) => s.missionsError)
  const busyMission = useAgentProfile((s) => s.busyMission)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState("")
  const [goal, setGoal] = useState("")
  const [time, setTime] = useState("08:30")

  const create = () => {
    if (!title.trim() || !goal.trim()) return
    void saveAgentMission({
      title: title.trim(),
      goal: goal.trim(),
      status: "armed",
      schedule: { kind: "daily", time },
      budget: { minutesPerRun: 15, runsPerDay: 2, tokensPerDay: 60000 },
      policy: { reads: "auto", drafts: "auto", commits: "approval" },
    }).then((saved) => {
      if (!saved) return
      setCreating(false)
      setTitle("")
      setGoal("")
    })
  }

  const toggle = (mission: AgentMission) => {
    const status = mission.status === "armed" ? "paused" : "armed"
    void saveAgentMission({ ...mission, status, state: { ...mission.state, nextRunAt: status === "armed" ? null : mission.state.nextRunAt } })
  }

  return (
    <section className="agent-section" aria-label="Misiones">
      <header className="agent-section-head">
        <div>
          <strong>
            <Icon name="checklist" /> Misiones
          </strong>
          <small>Objetivos que corren solos cuando la PC y Flufy están disponibles.</small>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => setCreating((value) => !value)}>
          <Icon name={creating ? "close" : "add"} /> {creating ? "Cancelar" : "Nueva"}
        </button>
      </header>
      {error && <div className="view-error">{error}</div>}
      {creating && (
        <div className="agent-mission-form">
          <input className="agent-input" value={title} placeholder="Título (ej. Briefing diario)" onChange={(e) => setTitle(e.target.value)} />
          <textarea className="agent-input" rows={2} value={goal} placeholder="¿Qué tiene que lograr y qué no debe hacer?" onChange={(e) => setGoal(e.target.value)} />
          <label className="agent-inline-field">
            <span>Hora</span>
            <input className="agent-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <div className="agent-form-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!title.trim() || !goal.trim()} onClick={create}>
              <Icon name="check" /> Crear y armar
            </button>
            <span className="agent-saved">Se ejecuta a la hora local de esta PC.</span>
          </div>
        </div>
      )}
      {missions.length === 0 ? (
        <p className="view-note">Todavía no hay misiones. Creá una y armala.</p>
      ) : (
        <ul className="agent-missions">
          {missions.map((mission) => (
            <li key={mission.id} className="agent-mission">
              <div className="agent-mission-main">
                <div className="agent-mission-title">
                  <strong>{mission.title}</strong>
                  <span className={`agent-mission-status ${mission.status}`}>{MISSION_STATUS[mission.status] ?? mission.status}</span>
                </div>
                <small className="agent-mission-meta">
                  {scheduleLabel(mission.schedule)} · Próxima: {nextLabel(mission.state.nextRunAt)}
                  {mission.state.lastStatus ? ` · Último: ${mission.state.lastStatus}` : ""}
                </small>
                <p>{mission.goal}</p>
                {mission.artifacts && mission.artifacts.length > 0 && (
                  <div className="agent-mission-actions">
                    {mission.artifacts.filter((artifact) => artifact.url).map((artifact) => (
                      <a key={artifact.url} className="btn btn-sm" href={artifact.url} target="_blank" rel="noreferrer">
                        {artifact.kind === "doc" ? "Abrir doc" : "Artefacto"}
                      </a>
                    ))}
                  </div>
                )}
              </div>
              <div className="agent-mission-actions">
                <button type="button" className="btn btn-sm" disabled={busyMission === mission.id || mission.status === "running"} onClick={() => void runAgentMission(mission.id)}>
                  <Icon name="play" /> Correr
                </button>
                <button type="button" className="btn btn-sm" disabled={mission.status === "running"} onClick={() => toggle(mission)}>
                  {mission.status === "armed" ? "Pausar" : "Armar"}
                </button>
                <button type="button" className="btn btn-sm" disabled={mission.status === "running"} onClick={() => void deleteAgentMission(mission.id)}>
                  Borrar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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

export function ProfileView() {
  const profile = useAgentProfile((s) => s.profile)
  const firstRun = useAgentProfile((s) => s.firstRun)
  const loaded = useAgentProfile((s) => s.loaded)
  const error = useAgentProfile((s) => s.error)
  const saving = useAgentProfile((s) => s.saving)
  const savedAt = useAgentProfile((s) => s.savedAt)
  const inbox = useAgentProfile((s) => s.inbox)
  const inboxError = useAgentProfile((s) => s.inboxError)
  const dismissing = useAgentProfile((s) => s.dismissing)
  const pulse = useAgentProfile((s) => s.pulse)
  const pulseError = useAgentProfile((s) => s.pulseError)
  const [draft, setDraft] = useState(profile)
  const [synced, setSynced] = useState(profile)

  useEffect(() => {
    startAgentProfile()
  }, [])

  // El perfil cargado reemplaza al borrador solo cuando cambia en el store
  // (primer uso o refresco), no en cada tecla.
  if (profile !== synced) {
    setSynced(profile)
    setDraft(profile)
  }

  const dirty = draft !== profile
  const showQuestion = firstRun

  const save = () => {
    if (!dirty) return
    void saveAgentProfile(draft)
  }

  const openItem = (item: AgentInboxItem) => {
    if (!item.session) return
    if (item.directory) rememberSessionDirectory(item.session, item.directory)
    useLayout.getState().toggleAgent(true)
    selectSession(item.session)
  }

  const dismissItem = (item: AgentInboxItem) => {
    void dismissAgentInboxItem(item.id)
  }

  return (
    <div className="view profile-view">
      <div className="view-header">
        <span className="view-title">Mi Flufy</span>
        <span className="view-actions">
          <button type="button" className="icon-button" title="Actualizar" aria-label="Actualizar" onClick={() => {
            void loadAgentProfile()
            void loadAgentInbox()
            void loadAgentMissions()
            void loadAgentAbsence()
          }}>
            <Icon name="refresh" />
          </button>
        </span>
      </div>
      {!isTauri ? (
        <p className="view-note">Mi Flufy está disponible solo en la app de escritorio.</p>
      ) : (
        <div className="profile-body">
          {error && <div className="view-error">{error}</div>}
          <section className="agent-section" aria-label="Perfil del agente">
            <header className="agent-section-head">
              <div>
                <strong>
                  <Icon name="account" /> Tu agente
                </strong>
                <small>Se guarda solo en esta PC y lo usa el agente al empezar cada conversación.</small>
              </div>
            </header>
            {showQuestion && (
              <div className="agent-first-run" role="note">
                <Icon name="sparkle" />
                <p>¿Cómo querés que te hable y qué debería saber de vos?</p>
              </div>
            )}
            <label className="agent-field">
              <span>Perfil</span>
              <textarea
                className="agent-profile-input"
                value={draft}
                placeholder="Ejemplo: trato de vos, respuestas cortas, trabajo en proyectos web."
                rows={7}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault()
                    save()
                  }
                }}
              />
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

          <section className="agent-section" aria-label="Registro del agente">
            <header className="agent-section-head">
              <div>
                <strong>
                  <Icon name="history" /> Registro
                </strong>
                <small>Últimas 20 entradas que dejó el agente.</small>
              </div>
            </header>
            <LogList />
          </section>

          {inboxError && <div className="view-error">{inboxError}</div>}
          <AgentInbox items={inbox} dismissing={dismissing} onOpen={openItem} onDismiss={dismissItem} />

          <MissionsSection />
          <AbsenceSection />

          <section className="agent-section agent-pulse" aria-label="Vigía">
            <header className="agent-section-head">
              <div>
                <strong>
                  <Icon name="pulse" /> Vigía
                </strong>
                <small>Corre solo cuando la PC y Flufy están disponibles. Si no, no hace nada. Apagado por defecto.</small>
              </div>
              <Toggle checked={pulse} label={pulse ? "Activado" : "Apagado"} onChange={(value) => void setAgentPulse(value)} />
            </header>
            {pulseError && <div className="view-error">{pulseError}</div>}
          </section>
        </div>
      )}
    </div>
  )
}
