import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { modelKey, type ModelRef } from "../lib/opencode"
import { call, errorMessage } from "../lib/tauri"
import { useAgent } from "../state/agent"
import { closeFallbackModels, useFallbackDialog } from "../state/fallback"
import { refreshTeams, useTeams } from "../state/teams"
import { Icon } from "./ui"

export function FallbackModels() {
  const request = useFallbackDialog(s => s.request)
  return request ? <FallbackModelsDialog /> : null
}

function FallbackModelsDialog() {
  const models = useAgent(s => s.models)
  const [draft, setDraft] = useState<ModelRef[]>([])
  const [selected, setSelected] = useState("")
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const dialog = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  useEffect(() => {
    let alive = true
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    void refreshTeams().then(() => {
      if (!alive) return
      const state = useTeams.getState()
      setDraft([...(state.fallbackModels ?? [])]); setError(state.error ?? ""); setLoadFailed(!!state.error); setLoading(false)
    })
    return () => { alive = false; previous?.focus() }
  }, [])
  const available = models.filter((model, index) => models.findIndex(item => modelKey(item) === modelKey(model)) === index
    && !draft.some(item => modelKey(item) === modelKey(model)))
  const move = (index: number, delta: number) => setDraft(previous => {
    const next = [...previous]
    ;[next[index], next[index + delta]] = [next[index + delta], next[index]]
    return next
  })
  const save = async () => {
    if (busy.current || loading || loadFailed) return
    busy.current = true; setSaving(true); setError("")
    try {
      await call("team_fallback_models_set", { models: draft })
      await refreshTeams()
      if (useTeams.getState().error) throw new Error(useTeams.getState().error!)
      closeFallbackModels(true)
    } catch (e) { setError(errorMessage(e)) }
    finally { busy.current = false; setSaving(false) }
  }
  return createPortal(<div className="dialog-backdrop" onMouseDown={() => { if (!busy.current) closeFallbackModels(false) }}>
    <div ref={dialog} className="dialog fallback-models-dialog" role="dialog" aria-modal="true" aria-labelledby="fallback-models-title" tabIndex={-1} onMouseDown={e => e.stopPropagation()} onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!busy.current) closeFallbackModels(false) }
      if (e.key === "Tab") {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])
        const first = controls[0], last = controls.at(-1)
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first?.focus() }
      }
    }}>
      <div className="dialog-head"><Icon name="list-ordered" /><div><h2 className="dialog-title" id="fallback-models-title">Modelos Fallback</h2><p className="dialog-message">El equipo comienza con el modelo seleccionado. Si se agota su cuota, prueba esta lista en orden y al terminar restaura el modelo inicial.</p></div></div>
      {loading ? <p role="status">Cargando modelos fallback…</p> : <>
        <label className="fallback-models-add">Modelo disponible<select aria-label="Modelo fallback disponible" value={selected} disabled={saving} onChange={e => setSelected(e.target.value)}><option value="">Seleccionar modelo…</option>{available.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.providerName} · {model.name}</option>)}</select></label>
        <button type="button" className="btn" disabled={saving || loadFailed || draft.length >= 100 || !available.some(model => modelKey(model) === selected)} onClick={() => { const model = available.find(item => modelKey(item) === selected); if (model) setDraft(previous => previous.some(item => modelKey(item) === modelKey(model)) ? previous : [...previous, { providerID: model.providerID, modelID: model.modelID }]); setSelected("") }}><Icon name="add" /> Agregar modelo</button>
        {!models.length && <p className="team-note">No hay modelos disponibles. Conectá una cuenta desde Cuentas de IA.</p>}
        {!draft.length && <p className="team-note">Todavía no hay modelos fallback. Agregá al menos uno para activar el modo continuo.</p>}
        <ol className="fallback-models-list" aria-label="Orden de modelos fallback">{draft.map((model, index) => {
          const info = models.find(item => modelKey(item) === modelKey(model))
          const name = info ? `${info.providerName} · ${info.name}` : modelKey(model)
          return <li key={modelKey(model)}><span className="fallback-model-number" aria-hidden="true">{index + 1}</span><span className="fallback-model-name">{name}{!info && <small>No disponible en el catálogo actual</small>}</span><div className="fallback-model-actions"><button type="button" className="btn btn-xs" disabled={saving || index === 0} aria-label={`Subir ${name}`} onClick={() => move(index, -1)}><Icon name="arrow-up" /></button><button type="button" className="btn btn-xs" disabled={saving || index === draft.length - 1} aria-label={`Bajar ${name}`} onClick={() => move(index, 1)}><Icon name="arrow-down" /></button><button type="button" className="btn btn-xs" disabled={saving} aria-label={`Quitar ${name}`} onClick={() => setDraft(previous => previous.filter(item => modelKey(item) !== modelKey(model)))}><Icon name="trash" /></button></div></li>
        })}</ol>
      </>}
      {error && <p className="team-error" role="alert">{error}</p>}
      <div className="dialog-buttons"><button type="button" className="btn" disabled={saving} onClick={() => closeFallbackModels(false)}>Cancelar</button><button type="button" className="btn btn-primary" disabled={saving || loading || loadFailed} onClick={() => void save()}>{saving ? "Guardando…" : "Guardar"}</button></div>
    </div>
  </div>, document.body)
}
