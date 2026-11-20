import { useCallback, useEffect, useState } from "react"
import { hub } from "./api"
import type { Route } from "./Home"
import { Icon } from "./ui"

type Mission = {
  id: string
  title: string
  goal: string
  status: string
  artifacts?: Array<{ kind?: string; title?: string; url?: string; path?: string }>
  schedule: { kind: string; time?: string; hours?: number; days?: number[] }
  state: { nextRunAt?: number | null; lastStatus?: string | null }
}

type Check = { id: string; status: string; detail: string; fix?: string }
type Absence = { enabled: boolean; ready: boolean; checks: Check[] }
type Inbox = { id: string; title: string; body: string; kind: string; session?: string; directory?: string; preview?: string; risk?: string; missionId?: string; decision?: string }
type AgentView = { missions: Mission[]; absence: Absence; inbox: Inbox[] }

const STATUS: Record<string, string> = {
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

const CHECK: Record<string, string> = { ok: "OK", warn: "Revisar", fail: "Falta" }

function scheduleLabel(schedule: Mission["schedule"]): string {
  if (schedule.kind === "interval") return `Cada ${schedule.hours ?? 2} h`
  if (schedule.kind === "daily") return `Diaria ${schedule.time ?? ""}`
  return `Semanal ${(schedule.days ?? []).join(",")} ${schedule.time ?? ""}`
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

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "No pude completar la acción."
}

export function AgentScreen({ back, open }: { back: () => void; open: (route: Route) => void }) {
  const [data, setData] = useState<AgentView | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")

  const load = useCallback(async () => {
    try {
      setData(await hub<AgentView>("GET", "/agent"))
      setError("")
    } catch (e) {
      setError(message(e))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 15000)
    return () => clearInterval(timer)
  }, [load])

  const post = async (path: string, key: string, body?: unknown) => {
    setBusy(key)
    try {
      await hub("POST", path, body)
      await load()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy("")
    }
  }

  const decide = (item: Inbox, decision: "approved" | "rejected" | "resume") => {
    void post(`/agent/inbox/${encodeURIComponent(item.id)}/decide`, `decide-${item.id}`, { decision })
  }

  const openItem = (item: Inbox) => {
    if (!item.session) return
    open({ kind: "session", project: item.directory ?? "", id: item.session, title: item.title })
  }

  const absence = data?.absence
  const fails = absence?.checks.filter((check) => check.status === "fail").length ?? 0
  const warns = absence?.checks.filter((check) => check.status === "warn").length ?? 0

  return (
    <main className="screen agent-screen">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="Volver" onClick={back}>
          <Icon name="arrow-left" />
        </button>
        <h1>Mi Flufy</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={!!busy}>
          Actualizar
        </button>
      </header>
      {error && <div className="alert" role="alert">{error}</div>}
      {!data && !error && <div className="loading">Cargando Mi Flufy…</div>}
      {data && (
        <>
          <h2 className="section-title"><Icon name="checklist" /> Misiones</h2>
          {data.missions.length === 0 ? (
            <p className="muted">Todavía no hay misiones.</p>
          ) : (
            data.missions.map((mission) => (
              <div className="card agent-card" key={mission.id}>
                <div className="card-text">
                  <strong>{mission.title}</strong>
                  <small>
                    {STATUS[mission.status] ?? mission.status} · {scheduleLabel(mission.schedule)} · Próxima: {nextLabel(mission.state.nextRunAt)}
                  </small>
                  <p>{mission.goal}</p>
                  {mission.state.lastStatus && <small>Último: {mission.state.lastStatus}</small>}
                  {mission.artifacts && mission.artifacts.length > 0 && (
                    <div className="agent-actions">
                      {mission.artifacts.filter((artifact) => artifact.url).map((artifact) => (
                        <a key={artifact.url} className="btn btn-sm" href={artifact.url} target="_blank" rel="noreferrer">
                          {artifact.kind === "doc" ? "Abrir doc" : "Abrir artefacto"}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <div className="agent-actions">
                  <button
                    type="button"
                    className="btn btn-sm primary"
                    disabled={!!busy || mission.status === "running"}
                    onClick={() => void post(`/agent/missions/${encodeURIComponent(mission.id)}/run`, mission.id)}
                  >
                    <Icon name="play" /> {busy === mission.id ? "Corriendo…" : "Correr"}
                  </button>
                </div>
              </div>
            ))
          )}

          <h2 className="section-title"><Icon name="account" /> Modo ausencia</h2>
          {!absence ? (
            <p className="muted">Sin datos de ausencia.</p>
          ) : (
            <>
              <div className={`agent-absence ${absence.ready ? "ok" : fails ? "fail" : "warn"}`}>
                <strong>
                  {absence.ready ? "Listo para ausencia" : fails ? `${fails} bloqueante(s) y ${warns} aviso(s)` : "Listo con avisos"}
                </strong>
                <small>{absence.enabled ? "La PC queda preparada para las misiones." : "Todavía no está activado."}</small>
                <div className="agent-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!!busy}
                    onClick={() => void post("/agent/absence/prepare", "absence")}
                  >
                    {busy === "absence" ? "Revisando…" : "Preparar"}
                  </button>
                  {absence.enabled && (
                    <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void post("/agent/absence/stop", "absence-stop")}>
                      Ya volví
                    </button>
                  )}
                </div>
              </div>
              <ul className="agent-checks">
                {absence.checks.map((check) => (
                  <li key={check.id} className={`agent-check ${check.status}`}>
                    <span>{CHECK[check.status] ?? check.status}</span>
                    <div>
                      {check.detail}
                      {check.fix && <small>{check.fix}</small>}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2 className="section-title"><Icon name="bell" /> Bandeja</h2>
          {data.inbox.length === 0 ? (
            <p className="muted">Sin novedades.</p>
          ) : (
            data.inbox.map((item) => (
              <div className="card agent-card" key={item.id}>
                <div className="card-text">
                  <strong>{item.title}</strong>
                  <small>{item.kind === "approval" ? "Aprobación" : item.kind === "handoff" ? "Necesita tus manos" : "Resultado"}</small>
                  {item.preview && <p className="agent-preview">{item.preview}</p>}
                  {!item.preview && item.body && <p>{item.body}</p>}
                  {item.risk && <small>Riesgo: {item.risk}</small>}
                </div>
                <div className="agent-actions">
                  {item.session && (
                    <button type="button" className="btn btn-sm" onClick={() => openItem(item)}>
                      Abrir chat
                    </button>
                  )}
                  {item.kind === "approval" && !item.decision && (
                    <>
                      <button type="button" className="btn btn-sm primary" disabled={!!busy} onClick={() => decide(item, "approved")}>
                        Aprobar
                      </button>
                      <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => decide(item, "rejected")}>
                        Rechazar
                      </button>
                    </>
                  )}
                  {item.kind === "handoff" && !item.decision && (
                    <>
                      <button type="button" className="btn btn-sm primary" onClick={() => open({ kind: "control" })}>
                        Tomar control
                      </button>
                      <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => decide(item, "resume")}>
                        Listo, continuar
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!!busy}
                    onClick={() => void post(`/agent/inbox/${encodeURIComponent(item.id)}/ack`, item.id)}
                  >
                    Descartar
                  </button>
                </div>
              </div>
            ))
          )}
        </>
      )}
    </main>
  )
}
