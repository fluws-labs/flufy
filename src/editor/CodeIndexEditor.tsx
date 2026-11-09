import { useEffect, useState } from "react"
import { Icon } from "../components/ui"
import { Toggle } from "../components/fields"
import {
  loadCodeIndex,
  rebuildCodeIndex,
  saveCodeIndex,
  searchCodeIndex,
  useCodeIndex,
  type CodeIndexConfig,
} from "../state/codeIndex"

function bytes(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10} MB`
  if (value >= 1_000) return `${Math.round(value / 1_000)} KB`
  return `${value} B`
}

export function CodeIndexEditor() {
  const config = useCodeIndex((s) => s.config)
  const status = useCodeIndex((s) => s.status)
  const loading = useCodeIndex((s) => s.loading)
  const saving = useCodeIndex((s) => s.saving)
  const rebuilding = useCodeIndex((s) => s.rebuilding)
  const error = useCodeIndex((s) => s.error)
  const query = useCodeIndex((s) => s.query)
  const hits = useCodeIndex((s) => s.hits)
  const searching = useCodeIndex((s) => s.searching)
  const [draft, setDraft] = useState<CodeIndexConfig | null>(null)
  const [term, setTerm] = useState("")

  useEffect(() => {
    void loadCodeIndex()
  }, [])

  useEffect(() => {
    if (config) setDraft(config)
  }, [config])

  const update = (patch: Partial<CodeIndexConfig>) => {
    if (!draft) return
    setDraft({ ...draft, ...patch })
  }

  const pill = status?.busy
    ? { text: "Indexando…", tone: "busy" }
    : status && status.files > 0
      ? { text: `${status.files} archivos`, tone: "ok" }
      : { text: "Sin índice", tone: "" }

  return (
    <div className="doc-page remote-page">
      <header className="doc-header">
        <div className="doc-kicker">
          <Icon name="search" /> Código
        </div>
        <h1>Índice de código</h1>
        <div className="doc-meta">
          <span className={`routine-pill ${pill.tone}`}>{pill.text}</span>
          {status?.updated ? <span className="accounts-detail">Actualizado {new Date(status.updated).toLocaleString()}</span> : null}
        </div>
        <div className="doc-actions">
          <span className="toolbar-spacer" />
          <button type="button" className="btn btn-sm" disabled={rebuilding || saving} onClick={() => void rebuildCodeIndex()}>
            <Icon name={rebuilding ? "loading" : "refresh"} spin={rebuilding} /> Reconstruir
          </button>
        </div>
      </header>
      <section className="doc-section remote-section">
        <p className="remote-text">
          El agente busca en el proyecto con un índice local: símbolos, imports y fragmentos rankeados. Nada sale de esta PC. El índice se actualiza solo cuando una búsqueda lo necesita.
        </p>
        {loading && !draft && <p className="remote-text"><Icon name="loading" spin /> Leyendo la configuración…</p>}
        {error && <div className="view-error">{error}</div>}
        {draft && (
          <>
            <div className="remote-steps">
              <strong><Icon name="search" /> Búsqueda</strong>
              <Toggle checked={draft.enabled} disabled={saving} onChange={(value) => { update({ enabled: value }); void saveCodeIndex({ enabled: value }) }} label="Incluir el índice de código en el agente" />
              <span>Si lo apagás, el agente vuelve a recorrer carpetas y usar grep. El índice queda en disco pero no se usa.</span>
            </div>
            <div className="remote-steps">
              <strong><Icon name="settings-gear" /> Límites</strong>
              <div className="remote-command">
                <label htmlFor="code-index-refresh">Actualizar cada (minutos)</label>
                <input id="code-index-refresh" className="input" type="number" min={1} max={1440} value={draft.refreshMinutes} disabled={saving} onChange={(event) => update({ refreshMinutes: Number(event.target.value) })} />
              </div>
              <div className="remote-command">
                <label htmlFor="code-index-files">Máximo de archivos</label>
                <input id="code-index-files" className="input" type="number" min={100} max={100000} value={draft.maxFiles} disabled={saving} onChange={(event) => update({ maxFiles: Number(event.target.value) })} />
              </div>
              <div className="remote-command">
                <label htmlFor="code-index-size">Tamaño máximo por archivo</label>
                <input id="code-index-size" className="input" type="number" min={10000} max={20000000} step={10000} value={draft.maxFileBytes} disabled={saving} onChange={(event) => update({ maxFileBytes: Number(event.target.value) })} />
              </div>
              <label htmlFor="code-index-include">Incluir (globs separados por coma)</label>
              <input id="code-index-include" className="input" value={draft.include} placeholder="src/**, packages/**" disabled={saving} onChange={(event) => update({ include: event.target.value })} />
              <label htmlFor="code-index-exclude">Excluir (globs separados por coma)</label>
              <input id="code-index-exclude" className="input" value={draft.exclude} placeholder="vendor/**, **/*.min.js" disabled={saving} onChange={(event) => update({ exclude: event.target.value })} />
              <div className="remote-command">
                <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void saveCodeIndex(draft)}>
                  <Icon name={saving ? "loading" : "save"} spin={saving} /> Guardar límites
                </button>
              </div>
            </div>
            <div className="remote-steps">
              <strong><Icon name="info" /> Estado</strong>
              {status ? (
                <>
                  <span className="accounts-detail">{status.root}</span>
                  <span>{status.files} archivos · {status.symbols} símbolos · {status.chunks} fragmentos</span>
                  <span className="accounts-hint">Límite por archivo: {bytes(draft.maxFileBytes)}</span>
                </>
              ) : (
                <span className="accounts-hint">Todavía no hay datos del índice.</span>
              )}
            </div>
            <div className="remote-steps">
              <strong><Icon name="search" /> Probar búsqueda</strong>
              <form className="accounts-key-form" onSubmit={(event) => { event.preventDefault(); void searchCodeIndex(term) }}>
                <div className="remote-command">
                  <input className="input" value={term} placeholder="Ej: dónde se valida el login" disabled={searching} onChange={(event) => setTerm(event.target.value)} />
                  <button type="submit" className="btn btn-sm btn-primary" disabled={!term.trim() || searching}>
                    <Icon name={searching ? "loading" : "search"} spin={searching} /> Buscar
                  </button>
                </div>
              </form>
              {query && !searching && hits.length === 0 && <span className="accounts-hint">Sin resultados para «{query}».</span>}
              <ul className="accounts-list">
                {hits.map((hit) => (
                  <li key={`${hit.path}:${hit.startLine}`}>
                    <div className="accounts-item">
                      <span className="accounts-name">{hit.path}:{hit.startLine}-{hit.endLine}</span>
                      <span className="accounts-detail">{hit.reason} · {hit.score.toFixed(1)}</span>
                      <pre className="accounts-hint" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{hit.snippet}</pre>
                      {hit.symbols.length > 0 && <span className="accounts-hint">{hit.symbols.join(" · ")}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
        <div className="remote-note">
          <Icon name="info" />
          <span>Las herramientas code_search, code_symbols, code_context y code_apply_patch viven en el motor local y se suman a todas las conversaciones.</span>
        </div>
      </section>
    </div>
  )
}
