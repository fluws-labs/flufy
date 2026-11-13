import { useCallback, useEffect, useRef, useState } from "react"
import { Icon } from "../components/ui"
import { call, errorMessage, onEvent } from "../lib/tauri"
import { localModelUsesAgent } from "../lib/localModels"
import { loadAgentMeta, useAgent } from "../state/agent"
import { notify } from "../state/toasts"

type ModelEntry = {
  id: string
  name: string
  params: string
  quant: string
  sizeGb: number
  contextK: number
  kind: string
  grade: string
  fit: string
  fitNote: string
  tokS: number
  installed: boolean
}

type Hardware = {
  gpu: string | null
  vramMb: number
  ramMb: number
  cpuCores: number
  bandwidthGbs: number
  source: string
}

type OllamaStatus = { installed: boolean; running: boolean; version: string | null; error: string | null }

type Progress = {
  model: string
  status: string
  completed: number
  total: number
  percent: number
  error?: string | null
  done?: boolean
}

type InstallProgress = {
  status: string
  completed: number
  total: number
  percent: number
  error?: string | null
  done?: boolean
}

type State = { hardware: Hardware; models: ModelEntry[]; ollama: OllamaStatus; download: Progress | null; install: InstallProgress | null }

function gb(value: number): string {
  return value >= 1 ? `${value.toFixed(1)} GB` : `${Math.round(value * 1024)} MB`
}

function contextLabel(k: number): string {
  return k >= 1000 ? `${(k / 1000).toFixed(0)}M` : `${k}K`
}

function percentLabel(progress: Progress): string {
  if (progress.total > 0) return `${Math.round(progress.percent)}%`
  return progress.status || "Descargando"
}

const GRADE_ORDER: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 }

export function LocalModelsEditor() {
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [install, setInstall] = useState<InstallProgress | null>(null)
  const synced = useRef(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const next = await call<State>("local_models_state")
      setState(next)
      if (next.download && !next.download.done) setProgress(next.download)
      if (next.install) setInstall(next.install)
    } catch (e) {
      notify.error("No se pudo leer el hardware", errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const stopDownload = onEvent<Progress>("local-models:progress", (payload) => {
      setProgress(payload)
      if (!payload.done) return
      void refresh()
      if (payload.error) return
      notify.info("Modelo descargado", "Recargo el motor para que aparezca en el selector.")
      void (async () => {
        try {
          await call("reload_engine")
          for (let attempt = 0; attempt < 12; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500))
            try {
              await loadAgentMeta()
            } catch {
              // The engine is still restarting.
            }
          }
        } catch (e) {
          notify.error("No se pudo recargar el motor", errorMessage(e))
        }
      })()
    })
    const stopInstall = onEvent<InstallProgress>("local-models:install", (payload) => {
      setInstall(payload)
      if (payload.done) void refresh()
    })
    return () => {
      stopDownload()
      stopInstall()
    }
  }, [refresh])

  useEffect(() => {
    if (!state || synced.current) return
    const hasInstalled = state.models.some((model) => model.installed)
    const hasProvider = useAgent.getState().models.some((model) => model.providerID === "ollama")
    if (!state.ollama.running || !hasInstalled || hasProvider) return
    synced.current = true
    notify.info("Modelos locales detectados", "Recargo el motor para que aparezcan en el selector.")
    void (async () => {
      try {
        await call("reload_engine")
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          try {
            await loadAgentMeta()
          } catch {
            // The engine is still restarting.
          }
        }
      } catch (e) {
        notify.error("No se pudo recargar el motor", errorMessage(e))
      }
    })()
  }, [state])

  const download = async (model: ModelEntry) => {
    try {
      setProgress({ model: model.id, status: "Iniciando", completed: 0, total: 0, percent: 0 })
      await call("local_models_pull", { model: model.id })
    } catch (e) {
      setProgress(null)
      notify.error("No se pudo descargar el modelo", errorMessage(e))
    }
  }

  const cancel = async () => {
    try {
      await call("local_models_cancel")
    } catch (e) {
      notify.error("No se pudo cancelar la descarga", errorMessage(e))
    }
  }

  const installOllama = async () => {
    try {
      setInstall({ status: "Iniciando", completed: 0, total: 0, percent: 0 })
      await call("local_models_install")
    } catch (e) {
      setInstall(null)
      notify.error("No se pudo instalar Ollama", errorMessage(e))
    }
  }

  const useModel = async (model: ModelEntry) => {
    try {
      setBusy(true)
      let available = useAgent.getState().models.some((item) => item.providerID === "ollama" && item.modelID === model.id)
      if (!available) {
        notify.info("Habilitando el modelo", "Recargo el motor para que aparezca en el selector.")
        await call("reload_engine")
        for (let attempt = 0; attempt < 12 && !available; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          try {
            await loadAgentMeta()
          } catch {
            // The engine is still restarting.
          }
          available = useAgent.getState().models.some((item) => item.providerID === "ollama" && item.modelID === model.id)
        }
      }
      if (!available) {
        notify.error("El modelo todavía no está en el selector", "Reiniciá Flufy y volvé a intentar.")
        return
      }
      useAgent.setState({ model: { providerID: "ollama", modelID: model.id } })
      notify.success("Modelo local seleccionado", `${model.name} · ~${model.tokS} tok/s`)
    } catch (e) {
      notify.error("No se pudo usar el modelo", errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return (
      <div className="doc-page local-models-page">
        <div className="doc-header">
          <div>
            <h1>Modelos locales</h1>
            <p>Reviso el hardware y el catálogo de modelos…</p>
          </div>
        </div>
      </div>
    )
  }

  const { hardware, ollama, models } = state
  const ordered = [...models].sort((a, b) => (GRADE_ORDER[a.grade] ?? 9) - (GRADE_ORDER[b.grade] ?? 9) || a.name.localeCompare(b.name))
  const gpuLabel = hardware.gpu ? `${hardware.gpu}${hardware.vramMb ? ` · ${gb(hardware.vramMb / 1024)} VRAM` : ""}` : "Sin GPU dedicada"

  return (
    <div className="doc-page local-models-page">
      <div className="doc-header">
        <div>
          <h1>Modelos locales</h1>
          <p>Revisá qué modelos entran en esta PC, descargalos y usalos como cualquier proveedor.</p>
        </div>
        <div className="doc-actions">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void refresh()}>
            <Icon name="refresh" /> Actualizar
          </button>
        </div>
      </div>

      <section className="doc-section local-models-hardware">
        <div className="local-models-stat">
          <span>GPU</span>
          <strong>{gpuLabel}</strong>
        </div>
        <div className="local-models-stat">
          <span>RAM</span>
          <strong>{gb(hardware.ramMb / 1024)}</strong>
        </div>
        <div className="local-models-stat">
          <span>CPU</span>
          <strong>{hardware.cpuCores} hilos</strong>
        </div>
        <div className="local-models-stat">
          <span>Ancho de banda</span>
          <strong>~{hardware.bandwidthGbs} GB/s</strong>
        </div>
      </section>

      {!ollama.running && (
        <section className="doc-section local-models-notice">
          <div>
            <strong>{ollama.installed ? "Ollama no está corriendo" : "Falta Ollama para descargar y ejecutar modelos"}</strong>
            <p>
              {ollama.installed
                ? "Abrí la app Ollama y volvé a actualizar. Después vas a poder descargar y usar los modelos desde acá."
                : "Ollama es el runtime local que descarga y ejecuta los modelos. Instalalo una vez y Flufy lo detecta solo."}
            </p>
          </div>
          {!ollama.installed && (
            install && !install.done ? (
              <div className="local-models-install">
                <span className="voice-progress-track">
                  <span className="voice-progress-bar" style={{ width: `${Math.min(100, install.percent)}%` }} />
                </span>
                <small>{install.status}{install.total > 0 ? ` · ${Math.round(install.percent)}%` : ""}</small>
              </div>
            ) : (
              <div className="local-models-install">
                {install?.error && <span className="local-model-note is-bad">{install.error}</span>}
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void installOllama()}>
                  <Icon name="cloud-download" /> {install?.error ? "Reintentar instalación" : "Instalar Ollama"}
                </button>
              </div>
            )
          )}
        </section>
      )}

      <section className="doc-section">
        <div className="local-models-heading">
          <h2>¿Qué puedo correr?</h2>
          <small className="muted">Los tok/s son una estimación; al ejecutar el modelo se ajustan a la medición real.</small>
        </div>
        <div className="local-models-list">
          {ordered.map((model) => {
            const current = progress && progress.model === model.id && !progress.done ? progress : null
            const failed = progress && progress.model === model.id && progress.done && progress.error ? progress : null
            return (
              <article key={model.id} className={`local-model-row${model.installed ? " is-installed" : ""}`}>
                <div className="local-model-grade" data-grade={model.grade}>{model.grade}</div>
                <div className="local-model-info">
                  <div className="local-model-title">
                    <strong>{model.name}</strong>
                    <span className="routine-pill">{model.kind}</span>
                    {localModelUsesAgent(model.id) ? <span className="routine-pill ok">Agente</span> : <span className="routine-pill">Chat simple</span>}
                    {model.installed && <span className="routine-pill ok">Descargado</span>}
                  </div>
                  <span className="local-model-meta">
                    {model.params} · {model.quant} · {gb(model.sizeGb)} · {contextLabel(model.contextK)} contexto
                  </span>
                  <span className={`local-model-note${model.grade === "F" ? " is-bad" : ""}`}>{model.fitNote}</span>
                  {current && (
                    <div className="local-model-progress">
                      <span className="voice-progress-track">
                        <span className="voice-progress-bar" style={{ width: `${Math.min(100, current.percent)}%` }} />
                      </span>
                      <small>
                        {percentLabel(current)} · {gb(current.completed / (1024 * 1024 * 1024))} de {current.total ? gb(current.total / (1024 * 1024 * 1024)) : "—"}
                      </small>
                    </div>
                  )}
                  {failed && <span className="local-model-note is-bad">{failed.error}</span>}
                </div>
                <div className="local-model-speed">
                  <strong>~{model.tokS}</strong>
                  <small>tok/s</small>
                </div>
                <div className="local-model-actions">
                  {current ? (
                    <button type="button" className="btn btn-sm" onClick={() => void cancel()}>
                      <Icon name="close" /> Cancelar
                    </button>
                  ) : model.installed ? (
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void useModel(model)}>
                      <Icon name="play" /> Usar
                    </button>
                  ) : model.grade === "F" ? (
                    <button type="button" className="btn btn-sm" disabled>
                      No entra
                    </button>
                  ) : (
                    <button type="button" className="btn btn-sm" disabled={busy || !ollama.installed || !ollama.running} onClick={() => void download(model)}>
                      <Icon name="cloud-download" /> Descargar
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}
