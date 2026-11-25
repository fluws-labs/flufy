import { useCallback, useEffect, useState } from "react"
import { hub } from "./api"
import type { Route } from "./Home"
import { Icon, Sheet } from "./ui"

type Mission = {
  id: string
  title: string
  goal: string
  status: string
  botId?: string | null
  artifacts?: Array<{ kind?: string; title?: string; url?: string; path?: string }>
  schedule: { kind: string; time?: string; hours?: number; days?: number[]; cooldownMinutes?: number }
  state: {
    nextRunAt?: number | null
    lastStatus?: string | null
    progress?: { next?: string; advanced?: boolean; blockers?: string[] } | null
    pausedByBot?: boolean
  }
}

type BotCapabilities = { desktop: boolean; files: boolean; terminal: boolean }
type BotModel = { providerID: string; modelID: string }
type Bot = {
  id: string
  name: string
  role: string
  instructions: string
  model?: BotModel | null
  fallbackModel?: BotModel | null
  autonomy: string
  capabilities: BotCapabilities
  enabled: boolean
  control: string
}

type BotDraft = {
  id?: string
  name: string
  role: string
  instructions: string
  model?: BotModel | null
  fallbackModel?: BotModel | null
  autonomy: string
  capabilities: BotCapabilities
  enabled: boolean
  control: string
}

type Check = { id: string; status: string; detail: string; fix?: string }
type Absence = { enabled: boolean; ready: boolean; checks: Check[] }
type Inbox = { id: string; title: string; body: string; kind: string; session?: string; directory?: string; preview?: string; risk?: string; missionId?: string; decision?: string }
type AgentView = { missions: Mission[]; bots: Bot[]; absence: Absence; inbox: Inbox[] }

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
  if (schedule.kind === "continuous") return `Continuo · ${schedule.cooldownMinutes ?? 5} min`
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

function emptyBotDraft(): BotDraft {
  return {
    name: "",
    role: "",
    instructions: "",
    model: null,
    fallbackModel: null,
    autonomy: "alta",
    capabilities: { desktop: false, files: true, terminal: true },
    enabled: true,
    control: "playing",
  }
}

function modelKey(model?: BotModel | null): string {
  return model ? `${model.providerID}/${model.modelID}` : ""
}

function parseModelKey(value: string): BotModel | null {
  const index = value.indexOf("/")
  if (index <= 0) return null
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) }
}

function BotToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" className="bot-toggle-row" aria-pressed={value} onClick={() => onChange(!value)}>
      <span className={`toggle ${value ? "on" : ""}`} />
      <span>{label}</span>
    </button>
  )
}

function BotEditor({ draft, models, saving, error, onChange, onClose, onSave }: { draft: BotDraft; models: BotModel[]; saving: boolean; error: string; onChange: (draft: BotDraft) => void; onClose: () => void; onSave: () => void }) {
  const set = (patch: Partial<BotDraft>) => onChange({ ...draft, ...patch })
  const capabilities = draft.capabilities
  const setCapabilities = (patch: Partial<BotCapabilities>) => set({ capabilities: { ...capabilities, ...patch } })
  const optionsFor = (model?: BotModel | null) => {
    const key = modelKey(model)
    const options = [{ value: "", label: "Modelo del agente" }, ...models.map((item) => ({ value: modelKey(item), label: `${item.modelID} · ${item.providerID}` }))]
    if (key && !options.some((option) => option.value === key)) options.push({ value: key, label: `${model!.modelID} · ${model!.providerID}` })
    return options
  }
  return (
    <Sheet
      title={draft.id ? "Editar bot" : "Nuevo bot"}
      className="bot-sheet"
      onClose={onClose}
      actions={<button type="button" className="btn btn-sm primary" disabled={saving || !draft.name.trim()} onClick={onSave}>{saving ? "Guardando…" : "Guardar"}</button>}
    >
      {error && <div className="alert" role="alert">{error}</div>}
      <label className="bot-field">
        <span>Nombre</span>
        <input className="bot-input" value={draft.name} placeholder="Ej. Growth Quiero Menú" onChange={(event) => set({ name: event.target.value })} />
      </label>
      <label className="bot-field">
        <span>Rol</span>
        <input className="bot-input" value={draft.role} placeholder="Qué hace y de qué se ocupa" onChange={(event) => set({ role: event.target.value })} />
      </label>
      <label className="bot-field">
        <span>Instrucciones</span>
        <textarea className="bot-textarea" value={draft.instructions} placeholder="Identidad, prioridades, límites y forma de trabajar." onChange={(event) => set({ instructions: event.target.value })} />
      </label>
      <div className="bot-grid bot-model-grid">
        <label className="bot-field">
          <span>Modelo</span>
          <select className="bot-select" value={modelKey(draft.model)} onChange={(event) => set({ model: parseModelKey(event.target.value) })}>
            {optionsFor(draft.model).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="bot-field">
          <span>Fallback</span>
          <select className="bot-select" value={modelKey(draft.fallbackModel)} onChange={(event) => set({ fallbackModel: parseModelKey(event.target.value) })}>
            {optionsFor(draft.fallbackModel).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <div className="bot-grid">
        <label className="bot-field">
          <span>Autonomía</span>
          <select className="bot-select" value={draft.autonomy} onChange={(event) => set({ autonomy: event.target.value })}>
            <option value="alta">Alta</option>
            <option value="manual">Manual</option>
          </select>
        </label>
      </div>
      <div className="bot-field">
        <span>Capacidades</span>
        <div className="bot-toggles">
          <BotToggle label="Archivos" value={capabilities.files} onChange={(value) => setCapabilities({ files: value })} />
          <BotToggle label="Terminal" value={capabilities.terminal} onChange={(value) => setCapabilities({ terminal: value })} />
          <BotToggle label="Escritorio" value={capabilities.desktop} onChange={(value) => setCapabilities({ desktop: value })} />
        </div>
      </div>
      <BotToggle label="Bot activo" value={draft.enabled} onChange={(value) => set({ enabled: value, control: value ? "playing" : "off" })} />
      <p className="muted bot-note">Las instrucciones y capacidades se usan en sus próximas misiones. Las rutinas nativas son del proyecto y no se asignan a bots.</p>
    </Sheet>
  )
}

export function AgentScreen({ back, open }: { back: () => void; open: (route: Route) => void }) {
  const [data, setData] = useState<AgentView | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [botDraft, setBotDraft] = useState<BotDraft | null>(null)
  const [botError, setBotError] = useState("")
  const [savingBot, setSavingBot] = useState(false)
  const [models, setModels] = useState<BotModel[]>([])

  useEffect(() => {
    void hub<{ models?: BotModel[] }>("GET", "/agent/models")
      .then((result) => setModels(Array.isArray(result.models) ? result.models : []))
      .catch(() => undefined)
  }, [])

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

  const editBot = (bot: Bot) => {
    setBotError("")
    setBotDraft({
      id: bot.id,
      name: bot.name,
      role: bot.role,
      instructions: bot.instructions,
      model: bot.model ?? null,
      fallbackModel: bot.fallbackModel ?? null,
      autonomy: bot.autonomy || "alta",
      capabilities: { ...bot.capabilities },
      enabled: bot.enabled !== false,
      control: bot.control ?? (bot.enabled === false ? "off" : "playing"),
    })
  }

  const saveBot = async () => {
    if (!botDraft || !botDraft.name.trim() || savingBot) return
    setSavingBot(true)
    setBotError("")
    try {
      await hub("POST", "/agent/bots", {
        bot: {
          id: botDraft.id,
          name: botDraft.name.trim(),
          role: botDraft.role.trim(),
          instructions: botDraft.instructions.trim(),
          model: botDraft.model ?? null,
          fallbackModel: botDraft.fallbackModel ?? null,
          autonomy: botDraft.autonomy,
          capabilities: botDraft.capabilities,
          enabled: botDraft.enabled,
          control: botDraft.enabled ? (botDraft.control === "paused" ? "paused" : "playing") : "off",
        },
      })
      await load()
      setBotDraft(null)
    } catch (e) {
      setBotError(message(e))
    } finally {
      setSavingBot(false)
    }
  }

  const controlBot = (bot: Bot, action: "play" | "pause" | "resume" | "off") => {
    void post(`/agent/bots/${encodeURIComponent(bot.id)}/control`, `control-${bot.id}`, { action })
  }

  const bots = data?.bots ?? []
  const absence = data?.absence
  const fails = absence?.checks.filter((check) => check.status === "fail").length ?? 0
  const warns = absence?.checks.filter((check) => check.status === "warn").length ?? 0

  return (
    <main className="screen agent-screen">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="Volver" onClick={back}>
          <Icon name="arrow-left" />
        </button>
        <h1>Flufy Bots</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={!!busy}>
          Actualizar
        </button>
      </header>
      {error && <div className="alert" role="alert">{error}</div>}
      {!data && !error && <div className="loading">Cargando Flufy Bots…</div>}
      {data && (
        <>
          <div className="agent-section-head">
            <h2 className="section-title"><Icon name="hubot" /> Bots <span className="agent-count">{bots.length}</span></h2>
            <button type="button" className="btn btn-sm" onClick={() => { setBotError(""); setBotDraft(emptyBotDraft()) }}>
              <Icon name="add" /> Nuevo
            </button>
          </div>
          {bots.length === 0 ? (
            <p className="muted">Todavía no hay bots.</p>
          ) : (
            bots.map((bot) => {
              const count = data.missions.filter((mission) => (mission.botId ?? "flufy") === bot.id).length
              return (
                <div className="card agent-card bot-card" key={bot.id}>
                  <div className="bot-card-head">
                    <span className={`bot-avatar ${bot.control === "playing" ? "on" : "off"}`}><Icon name="hubot" /></span>
                    <div className="card-text">
                      <strong>{bot.name}</strong>
                      <small>{bot.role || "Sin rol"} · {bot.model?.modelID || "modelo del agente"}{bot.fallbackModel?.modelID ? ` → ${bot.fallbackModel.modelID}` : ""}</small>
                      <div className="bot-meta">
                        <span className={`bot-pill ${bot.control === "playing" ? "on" : "off"}`}>{bot.control === "playing" ? "En marcha" : bot.control === "paused" ? "En pausa" : "Apagado"}</span>
                        <span className="bot-pill">{bot.autonomy === "manual" ? "Manual" : "Autonomía alta"}</span>
                        <span className="bot-pill">{count} {count === 1 ? "misión" : "misiones"}</span>
                      </div>
                    </div>
                  </div>
                  <div className="agent-actions">
                    <button type="button" className="icon-btn" title="Play" aria-label="Play" disabled={!!busy || bot.control === "playing"} onClick={() => controlBot(bot, "play")}>
                      <Icon name="play" />
                    </button>
                    <button type="button" className="icon-btn" title="Pause" aria-label="Pause" disabled={!!busy || bot.control !== "playing"} onClick={() => controlBot(bot, "pause")}>
                      <Icon name="debug-pause" />
                    </button>
                    <button type="button" className="icon-btn" title="Resume" aria-label="Resume" disabled={!!busy || bot.control !== "paused"} onClick={() => controlBot(bot, "resume")}>
                      <Icon name="debug-continue" />
                    </button>
                    <button type="button" className="icon-btn" title="Off" aria-label="Off" disabled={!!busy || bot.control === "off"} onClick={() => controlBot(bot, "off")}>
                      <Icon name="debug-stop" />
                    </button>
                    <button type="button" className="btn btn-sm primary" onClick={() => editBot(bot)}>
                      <Icon name="edit" /> Editar bot
                    </button>
                  </div>
                </div>
              )
            })
          )}

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
                  {mission.state.progress?.next && <small>Próximo paso: {mission.state.progress.next}</small>}
                  {mission.state.progress?.blockers && mission.state.progress.blockers.length > 0 && <small className="bot-error">Bloqueo: {mission.state.progress.blockers[0]}</small>}
                  {mission.state.pausedByBot && <small className="bot-error">En pausa por el control del bot.</small>}
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
      {botDraft && (
        <BotEditor
          draft={botDraft}
          models={models}
          saving={savingBot}
          error={botError}
          onChange={setBotDraft}
          onClose={() => setBotDraft(null)}
          onSave={() => void saveBot()}
        />
      )}
    </main>
  )
}
