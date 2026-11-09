import { useEffect, useState } from "react"
import { Icon } from "../components/ui"
import { Toggle } from "../components/fields"
import {
  loadResources,
  saveResourceConfig,
  useResources,
  type ResourceConfig,
} from "../state/resources"

function gb(value: number): string {
  return `${(value / 1024).toFixed(1)} GB`
}

const PRESSURE_LABEL: Record<string, string> = {
  normal: "Normal",
  tight: "Cargada",
  critical: "Al límite",
}

export function ResourcesEditor() {
  const status = useResources((s) => s.status)
  const config = useResources((s) => s.config)
  const loading = useResources((s) => s.loading)
  const saving = useResources((s) => s.saving)
  const error = useResources((s) => s.error)
  const [draft, setDraft] = useState<ResourceConfig | null>(null)

  useEffect(() => {
    void loadResources()
  }, [])

  useEffect(() => {
    if (config) setDraft(config)
  }, [config])

  const update = (patch: Partial<ResourceConfig>) => {
    if (!draft) return
    setDraft({ ...draft, ...patch })
  }

  const pressure = status?.pressure ?? "normal"
  const tone = pressure === "critical" ? "error" : pressure === "tight" ? "warn" : "ok"

  return (
    <div className="doc-page remote-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="pulse" /> Sistema
        </div>
        <h1>Recursos de la PC</h1>
        <div className="doc-meta">
          <span className={`routine-pill ${tone}`}>{PRESSURE_LABEL[pressure] ?? pressure}</span>
          {status?.updatedAt ? <span className="accounts-detail">Actualizado {new Date(status.updatedAt).toLocaleTimeString()}</span> : null}
        </div>
      </header>
      <section className="doc-section remote-section">
        <p className="remote-text">
          Flufy mide la memoria, el commit y la CPU de esta PC y limita <strong>su propio trabajo</strong> para no
          dejar al sistema sin recursos. No cierra programas del usuario: si la PC está al límite, frena el lanzamiento
          de agentes nuevos y te avisa.
        </p>
        {loading && !status && <p className="remote-text"><Icon name="loading" spin /> Leyendo recursos…</p>}
        {error && <div className="view-error">{error}</div>}
        {status && (
          <div className="remote-steps">
            <strong><Icon name="dashboard" /> Estado actual</strong>
            <span>RAM libre: {gb(status.availableMemoryMb)} de {gb(status.totalMemoryMb)}</span>
            <span>Commit libre: {gb(status.commitAvailableMb)} de {gb(status.commitLimitMb)}</span>
            <span>CPU: {Math.round(status.cpuPercent)}% · {status.processCount} procesos</span>
            {status.otherFlufyInstances > 0 && (
              <span className="accounts-hint">
                Hay {status.otherFlufyInstances} instancia(s) más de Flufy abierta(s): el consumo se suma y Flufy reduce la concurrencia.
              </span>
            )}
            {pressure === "critical" && (
              <span className="team-error">La PC está al límite. Flufy no lanzará agentes nuevos hasta que haya recursos.</span>
            )}
            {pressure === "tight" && (
              <span className="accounts-hint">La PC está cargada. Flufy está limitando la concurrencia del equipo.</span>
            )}
          </div>
        )}
        {draft && (
          <>
            <div className="remote-steps">
              <strong><Icon name="settings-gear" /> Ajuste automático</strong>
              <Toggle
                checked={draft.autoThrottle}
                disabled={saving}
                onChange={(value) => { update({ autoThrottle: value }); void saveResourceConfig({ autoThrottle: value }) }}
                label="Ajustar la concurrencia según los recursos"
              />
              <span>Si lo apagás, Flufy usa el máximo configurado sin mirar la memoria disponible. No es recomendable.</span>
            </div>
            <div className="remote-steps">
              <strong><Icon name="shield" /> Reservas</strong>
              <div className="remote-command">
                <label htmlFor="resources-commit">Commit libre mínimo (MB)</label>
                <input id="resources-commit" className="input" type="number" min={512} max={16384} step={128} value={draft.reserveCommitMb} disabled={saving} onChange={(event) => update({ reserveCommitMb: Number(event.target.value) })} />
              </div>
              <div className="remote-command">
                <label htmlFor="resources-memory">RAM libre mínima (MB)</label>
                <input id="resources-memory" className="input" type="number" min={512} max={16384} step={128} value={draft.reserveMemoryMb} disabled={saving} onChange={(event) => update({ reserveMemoryMb: Number(event.target.value) })} />
              </div>
              <div className="remote-command">
                <label htmlFor="resources-agent">Memoria estimada por agente (MB)</label>
                <input id="resources-agent" className="input" type="number" min={128} max={4096} step={64} value={draft.perAgentMb} disabled={saving} onChange={(event) => update({ perAgentMb: Number(event.target.value) })} />
              </div>
              <div className="remote-command">
                <label htmlFor="resources-max">Máximo de agentes</label>
                <input id="resources-max" className="input" type="number" min={1} max={16} value={draft.maxAgents} disabled={saving} onChange={(event) => update({ maxAgents: Number(event.target.value) })} />
              </div>
              <div className="remote-command">
                <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void saveResourceConfig(draft)}>
                  <Icon name={saving ? "loading" : "save"} spin={saving} /> Guardar
                </button>
              </div>
            </div>
          </>
        )}
        <div className="remote-note">
          <Icon name="info" />
          <span>La reserva se calcula sobre el commit y la RAM libres. Flufy nunca mata procesos del usuario ni cancela tareas en curso por presión.</span>
        </div>
      </section>
    </div>
  )
}
