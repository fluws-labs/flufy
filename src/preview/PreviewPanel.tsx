import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PreviewClient, PreviewEditorContext, PreviewIdentity, PreviewLayout, PreviewNode, PreviewOperation, PreviewState, PreviewViewport } from "./types"
import { previewIdentityKey } from "./types"
import { flattenNodes, findNode, parentOf } from "./document"
import { usePreview } from "./usePreview"
import { PreviewFrame } from "./PreviewFrame"
import { PreviewLayers } from "./PreviewLayers"
import { useStudio } from "../state/studio"
import "./preview.css"

export type PreviewPanelProps = {
  onContextChange?: (context: PreviewEditorContext) => void
  identity: PreviewIdentity; client?: PreviewClient; onApproved?: (state: PreviewState) => void
  onStateChange?: (state: PreviewState | null) => void; onClose?: () => void
}

type ColorTarget = "color" | "background" | "borderColor"
const COLOR_PRESETS = ["#FAFAFA", "#FFFFFF", "#172033", "#7668F5", "#46BB98", "#EB7D7D", "#F5C451", "#202024"]
const FONT_FAMILIES = ["Inter, Segoe UI, system-ui, sans-serif", "Segoe UI, system-ui, sans-serif", "Georgia, Times New Roman, serif", "Menlo, Consolas, monospace"]
const FONT_WEIGHTS = [[300, "Light"], [400, "Regular"], [500, "Medium"], [600, "Semibold"], [700, "Bold"], [800, "Extra bold"]] as const
function familyName(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim().replace(/^["']|["']$/g, "")
}
function weightName(value: number | undefined): string | undefined {
  return FONT_WEIGHTS.find(([weight]) => weight === value)?.[1]
}
function normalizeHex(raw: string): string | undefined {
  const text = raw.trim().startsWith("#") ? raw.trim() : `#${raw.trim()}`
  if (/^#[0-9a-f]{3}$/i.test(text)) return `#${[...text.slice(1)].map(ch => ch + ch).join("").toUpperCase()}`
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase()
}
function ColorPicker({ value, presets, onCommit }: { value?: string; presets: string[]; onCommit: (hex: string) => void }) {
  const [draft, setDraft] = useState(value ?? "")
  const latest = useRef(value); latest.current = value
  const timer = useRef<number | null>(null)
  useEffect(() => { setDraft(value ?? "") }, [value])
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  const invalid = draft.trim() !== "" && !normalizeHex(draft)
  const commit = (raw: string) => {
    const hex = normalizeHex(raw)
    if (!hex || hex.toLowerCase() === (latest.current ?? "").toLowerCase()) return
    onCommit(hex)
  }
  const commitSoon = (raw: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { timer.current = null; commit(raw) }, 160)
  }
  const flush = () => { if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null } commit(draft) }
  return <>
    <label className="preview-color-well">Elegir un color<input type="color" aria-label="Elegir un color" value={normalizeHex(draft) ?? "#000000"} onChange={e => { setDraft(e.target.value); commitSoon(e.target.value) }} /></label>
    <label>Código hexadecimal<input type="text" value={draft} placeholder="#FAFAFA" spellCheck={false} aria-invalid={invalid || undefined} onChange={e => setDraft(e.target.value)} onBlur={flush} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur() } }} /></label>
    {invalid && <p className="preview-color-invalid" role="alert">Usá un código como #FAFAFA.</p>}
    <div className="preview-color-swatches" role="group" aria-label="Colores rápidos">{presets.map(hex => <button key={hex} type="button" title={hex} aria-label={`Aplicar ${hex}`} style={{ background: hex }} onMouseDown={e => e.preventDefault()} onClick={() => { setDraft(hex); commit(hex) }} />)}</div>
  </>
}
/** Keyed child guarantees selection, text drafts and undo state cannot cross identities. */
export function PreviewPanel(props: PreviewPanelProps) { return <Panel key={previewIdentityKey(props.identity)} {...props} /> }
function Panel({ identity, client, onApproved, onStateChange, onClose, onContextChange }: PreviewPanelProps) {
  const preview = usePreview(identity, client)
  const { state, revision, busy, loading, error } = preview
  const [viewport, setViewport] = useState<PreviewViewport>("desktop")
  const [selected, setSelected] = useState<string>()
  const [propertiesOpen, setPropertiesOpen] = useState(false)
  const [fit, setFit] = useState(true)
  const [layersOpen, setLayersOpen] = useState(() => !useStudio.getState().layouts.design.sidebarCollapsed)
  const [fontsOpen, setFontsOpen] = useState(true)
  const [screenId, setScreenId] = useState<string>()
  const screens = useMemo(() => revision ? revision.document.screens ?? [{ id: 'default', name: revision.document.title, nodeId: revision.document.root.id }] : [], [revision])
  const activeScreen = screens.find(screen => screen.id === screenId) ?? screens[0]
  const [notes, setNotes] = useState("")
  const [historyState, setHistoryState] = useState<{ revisionId: string; undo: string[]; redo: string[] } | null>(null)
  const [textDraft, setTextDraft] = useState("")
  const [textBase, setTextBase] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteTarget, setPaletteTarget] = useState<ColorTarget>("background")
  const [detachRequest, setDetachRequest] = useState<{ nodeId: string; requestId: number }>()
  const palette = useMemo(() => {
    const tokens = Object.values(revision?.document.theme.tokens ?? {}).filter(value => /^#[0-9a-f]{3,8}$/i.test(value)).map(value => value.toUpperCase())
    return [...new Set([...tokens, ...COLOR_PRESETS])].slice(0, 16)
  }, [revision])
  useEffect(() => { onContextChange?.({ revisionId: revision?.id, nodeId: selected, screenId: activeScreen?.id, viewport, saving: busy || loading || !!textBase }) }, [revision?.id, selected, activeScreen?.id, viewport, busy, loading, textBase, onContextChange])
  const selectNode = useCallback((id: string) => {
    if (textBase) return
    const screen = revision && screens.find(item => { const root = findNode(revision.document.root, item.nodeId); return root && findNode(root, id) })
    if (screen) setScreenId(screen.id)
    setSelected(id || undefined)
  }, [revision, screens, textBase])
  const node = revision && selected ? findNode(revision.document.root, selected) : undefined
  const fontOptions = useMemo(() => {
    const options = [revision?.document.theme.tokens.fontFamily, ...FONT_FAMILIES].filter((value): value is string => !!value)
    return [...new Set(options)]
  }, [revision?.document.theme.tokens.fontFamily])
  const parent = revision && node ? parentOf(revision.document.root, node.id) : undefined
  const nodes = revision ? flattenNodes(revision.document.root).filter(node => !node.placeholderFor) : []
  const layout = node ? (viewport === "mobile" ? { ...node.layout, ...node.mobile } : node.layout) : {}
  const ancestors: string[] = []
  let ancestor = revision?.parentId
  while (ancestor && !ancestors.includes(ancestor) && ancestors.length < (state?.revisions.length ?? 0)) {
    ancestors.unshift(ancestor)
    ancestor = state?.revisions.find(r => r.id === ancestor)?.parentId
  }
  const undo = historyState?.revisionId === revision?.id ? historyState?.undo ?? [] : ancestors
  const redo = historyState?.revisionId === revision?.id ? historyState?.redo ?? [] : []
  useEffect(() => { onStateChange?.(state) }, [state, onStateChange])
  useEffect(() => { setTextDraft(node?.text ?? ""); setTextBase(null) }, [selected])
  useEffect(() => { if (selected) setPropertiesOpen(true) }, [selected])
  // Remote revisions are undoable too: keep the prior revision, not a second mutable document.
  const apply = async (operations: PreviewOperation[], summary: string, base = revision?.id) => {
    if (!base) return
    const next = await preview.change({ baseRevisionId: base, operations, author: "user", summary })
    if (next?.currentRevisionId) { setHistoryState({ revisionId: next.currentRevisionId, undo: [...undo, base], redo: [] }); setTextBase(null) }
    return next
  }
  const patchLayout = (patch: PreviewLayout) => { if (node) void apply([{ type: "layout", nodeId: node.id, viewport, patch }], "Ajuste de layout") }
  const patchStyle = (patch: NonNullable<PreviewNode["style"]>) => { if (node) void apply([{ type: "style", nodeId: node.id, patch }], "Ajustar tipografía") }
  const setLayers = (open: boolean) => { setLayersOpen(open); useStudio.getState().setLayout("design", { sidebarCollapsed: !open }) }
  const history = async (direction: "undo" | "redo") => {
    if (!revision) return
    const stack = direction === "undo" ? undo : redo
    const target = stack.at(-1)
    if (!target) return
    const next = await preview.restore(target)
    if (next?.currentRevisionId) {
      setHistoryState({ revisionId: next.currentRevisionId,
        undo: direction === "undo" ? stack.slice(0, -1) : [...undo, revision.id],
        redo: direction === "undo" ? [...redo, revision.id] : stack.slice(0, -1) })
    }
  }
  const reorder = (offset: number) => {
    if (!node || !parent) return
    const index = parent.children.findIndex(n => n.id === node.id) + offset
    void apply([{ type: "move", nodeId: node.id, parentId: parent.id, index: Math.max(0, index) }], "Reordenar bloque")
  }
  const approvedCurrent = !!revision && state?.approval?.revisionId === revision.id
  return <section className="preview-panel" aria-label="Previsualización editable">
    <header className="preview-header"><div><h2>Previsualización</h2><p aria-live="polite">{state?.status ?? (loading ? "Cargando…" : "Sin diseño")}{revision ? ` · Revisión ${revision.id}` : ""}</p></div>{onClose && <button className="btn btn-sm" onClick={onClose}>Cerrar panel</button>}</header>
    {error && <div role="alert" className="preview-error">{error}<button className="btn btn-sm" disabled={busy} onClick={() => void preview.refresh()}>Recargar revisión</button></div>}
    {!state && !loading && !error && <p>Creá una previsualización para revisar el diseño antes de implementar.</p>}
    {(!state || state.status === "pending") && !loading && <div className="preview-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void preview.choose("create")}>Crear previsualización</button><button className="btn" disabled={busy} onClick={() => void preview.choose("skip")}>Omitir previsualización</button></div>}
    {state?.status === "skipped" && <p>Previsualización omitida para esta tarea.</p>}
    {state && !revision && state.status !== "skipped" && state.status !== "pending" && <p role="status">Esperando el documento generado con la identidad visual del proyecto. Podés continuar conversando.</p>}
    {revision && <>
      <div className="preview-actions" aria-label="Controles del diseño">
        <button className={`btn btn-sm ${viewport === "desktop" ? "btn-primary" : ""}`} aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")}>Escritorio · 1280</button>
        <button className={`btn btn-sm ${viewport === "mobile" ? "btn-primary" : ""}`} aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")}>Móvil · 390</button>
        <button className="btn btn-sm" disabled={busy || !undo.length} onClick={() => void history("undo")}>Deshacer</button>
        <button className="btn btn-sm" disabled={busy || !redo.length} onClick={() => void history("redo")}>Rehacer</button>
        <button className="btn btn-sm" aria-pressed={fit} onClick={() => setFit(value => !value)}>{fit ? "Ajustar al espacio" : "Zoom 100 %"}</button>
        <button className="btn btn-sm" aria-expanded={propertiesOpen} onClick={() => setPropertiesOpen(value => !value)}>Propiedades</button>
        <button className="btn btn-sm" aria-expanded={layersOpen} onClick={() => setLayers(!layersOpen)}>Pantallas y capas</button>
        <label className="preview-layer-picker">Bloque seleccionado<select value={selected ?? ""} onChange={e => selectNode(e.target.value)}><option value="">Elegir bloque · capas</option>{nodes.map(n => <option key={n.id} value={n.id}>{n.id} · {n.kind}</option>)}</select></label>
      </div>
      <div className="preview-guide"><span><strong>Mové</strong> solo el bloque elegido; los demás conservan su lugar. Fuera de su caja, queda independiente.</span><span><strong>Redimensioná</strong> desde la esquina.</span><span><strong>Navegá</strong> con doble clic en un botón vinculado.</span></div>
      <div className={`preview-editor${propertiesOpen ? " properties-open" : ""}${layersOpen ? " layers-open" : ""}`}>
        {layersOpen && <PreviewLayers document={revision.document} screens={screens} activeScreen={activeScreen} selected={selected} disabled={busy || loading || !!textBase} onClose={() => setLayers(false)} onScreen={screen => { setScreenId(screen.id); setSelected(undefined) }} onSelect={selectNode} onOperation={async operation => {
          const next = await apply([operation], operation.type === 'screen-add' ? 'Añadir pantalla' : operation.type === 'screen-rename' ? 'Renombrar pantalla' : 'Mover capa por arrastre')
          if (next && operation.type === 'screen-add') { setScreenId(operation.screenId); setSelected(undefined) }
        }} />}
        <PreviewFrame document={revision.document} artifactHtml={revision.html} artifactCss={revision.css} identityKey={previewIdentityKey(identity)} revisionId={revision.id} viewport={viewport} selectedId={selected} onSelect={selectNode} screenNodeId={activeScreen?.nodeId} detachRequest={detachRequest} onNavigate={target => { setScreenId(target); setSelected(undefined) }} fit={fit} readOnly={busy || loading || !!textBase} onOperation={operation => {
          if (busy || loading || textBase) return
          void apply([operation], operation.type === 'detach' ? 'Separar bloque de su contenedor' : operation.type === "move" ? "Mover bloque por arrastre" : operation.type === "offset" ? "Mover bloque en el lienzo" : "Redimensionar bloque por arrastre")
        }} />
        <aside className="preview-properties" aria-label="Propiedades del bloque" hidden={!propertiesOpen}>
          <h3>Inspector</h3>
          {!node && <p className="preview-note">Seleccioná un texto, botón o caja para editarlo.</p>}
          {node && <fieldset disabled={busy}><legend>{node.text?.slice(0, 42) || node.id}</legend>
            <div className="preview-selection-info"><span>{({ container: 'Contenedor', heading: 'Título', text: 'Texto', button: 'Botón', image: 'Imagen' })[node.kind]}</span><code>{node.id}</code><p>{node.layout.position === 'absolute' ? 'Libre en la pantalla · ya no sigue a su caja anterior' : parent ? `Dentro de ${parent.text || parent.id} · se mueve con ese contenedor` : 'Contenedor de la pantalla'}</p></div>
            <div className={`preview-fonts${fontsOpen ? " open" : ""}`}>
              <button type="button" className="preview-fonts-head" aria-expanded={fontsOpen} onClick={() => setFontsOpen(value => !value)}>
                <span>Fuentes <em>Nuevo</em></span><span aria-hidden="true">{fontsOpen ? "⌃" : "⌄"}</span>
              </button>
              <p className="preview-fonts-summary">{familyName(node.style?.fontFamily ?? revision.document.theme.tokens.fontFamily) ?? "Heredar"} · {node.style?.fontSize ?? "—"} px · {weightName(node.style?.fontWeight) ?? "Regular"}</p>
              {fontsOpen && <div className="preview-fonts-row">
                <label className="preview-font-field"><span>Familia</span><select value={node.style?.fontFamily ?? ""} onChange={event => patchStyle({ fontFamily: event.target.value })}><option value="">Heredar</option>{[...new Set([node.style?.fontFamily, ...fontOptions].filter((value): value is string => !!value))].map(font => <option key={font} value={font}>{familyName(font)}</option>)}</select></label>
                <label className="preview-font-field"><span>Tamaño</span><input type="number" min={8} max={200} key={`${node.id}-${revision.id}-size`} defaultValue={node.style?.fontSize ?? ""} placeholder="Auto" onBlur={event => { const value = Number(event.target.value); if (event.target.value !== "" && event.target.validity.valid && value !== node.style?.fontSize) patchStyle({ fontSize: value }) }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur() }} /></label>
                <label className="preview-font-field"><span>Peso</span><select value={node.style?.fontWeight ?? ""} onChange={event => patchStyle({ fontWeight: Number(event.target.value) })}>{node.style?.fontWeight === undefined && <option value="">Automático</option>}{node.style?.fontWeight !== undefined && !FONT_WEIGHTS.some(([weight]) => weight === node.style?.fontWeight) && <option value={node.style.fontWeight}>{node.style.fontWeight}</option>}{FONT_WEIGHTS.map(([weight, label]) => <option key={weight} value={weight}>{label}</option>)}</select></label>
              </div>}
              <p className="preview-note">Tipografía y tamaños más compactos</p>
            </div>
            {(node.kind === 'button' || node.kind === 'text' || node.targetScreenId) && <div className="preview-property-section">
              <h4>Navegación</h4><label>Pantalla de destino<select value={node.targetScreenId ?? ''} onChange={e => void apply([{ type: 'link', nodeId: node.id, screenId: e.target.value || null }], 'Vincular botón con pantalla')}><option value="">Sin enlace</option>{screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}</select></label>
              {node.targetScreenId ? <><button type="button" className="btn btn-sm" onClick={() => { setScreenId(node.targetScreenId); setSelected(undefined) }}>Probar enlace →</button><p className="preview-note">También podés hacer doble clic en el botón del lienzo. El destino se guarda con el diseño.</p></> : <p className="preview-note">Creá la pantalla con «+ Pantalla» y elegila acá como destino.</p>}
            </div>}
            {node.kind !== "container" && node.kind !== "image" && <label>Texto<textarea value={textBase ? textDraft : node.text ?? ""} onChange={e => { setTextBase(textBase ?? revision.id); setTextDraft(e.target.value) }} /><button className="btn btn-sm" disabled={!textBase} onClick={() => void apply([{ type: "text", nodeId: node.id, text: textDraft }], "Editar texto", textBase ?? revision.id)}>Guardar texto</button></label>}
            <h4 className="preview-section-heading">Posición y organización</h4>
            {parent && parent.id !== activeScreen?.nodeId && !screens.some(screen => screen.nodeId === node.id) && <button type="button" className="btn btn-sm" disabled={busy || !!textBase} onClick={() => setDetachRequest({ nodeId: node.id, requestId: Date.now() })}>Separar de la caja</button>}
            {parent && <><div className="preview-actions"><button className="btn btn-sm" disabled={parent.children[0]?.id === node.id} onClick={() => reorder(-1)}>Subir</button><button className="btn btn-sm" disabled={parent.children.at(-1)?.id === node.id} onClick={() => reorder(1)}>Bajar</button></div><label>Mover al contenedor<select value={parent.id} onChange={e => void apply([{ type: "move", nodeId: node.id, parentId: e.target.value, index: 1000 }], "Mover entre contenedores")}>
              {nodes.filter(n => n.kind === "container" && !findNode(node, n.id)).map(n => <option key={n.id} value={n.id}>{n.id}</option>)}</select></label></>}
            <h4 className="preview-section-heading">Tamaño y espaciado</h4>
            <div className="preview-dimension-grid">{(["width", "height", "gap", "padding"] as const).map(property => <label key={`${node.id}-${viewport}-${property}`}>{({ width: "Ancho", height: "Alto", gap: "Separación", padding: "Espacio interior" })[property]} (px)<input type="number" min={0} max={10000} key={`${revision.id}-${layout[property]}`} defaultValue={layout[property] ?? ""} placeholder="Automático" onBlur={e => { if (e.target.value !== "" && Number(e.target.value) !== layout[property] && e.target.validity.valid) patchLayout({ [property]: Number(e.target.value) }) }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur() }} /></label>)}</div>
            <label>Alineación<select value={layout.align ?? "stretch"} onChange={e => patchLayout({ align: e.target.value as PreviewLayout["align"] })}>{["stretch", "start", "center", "end"].map(v => <option key={v} value={v}>{({ stretch: "Estirar", start: "Inicio", center: "Centro", end: "Final" })[v]}</option>)}</select></label>
            <label>Distribución<select value={layout.justify ?? "start"} onChange={e => patchLayout({ justify: e.target.value as PreviewLayout["justify"] })}><option value="start">Inicio</option><option value="center">Centro</option><option value="end">Final</option><option value="space-between">Espacio entre bloques</option></select></label>
            {node.kind === "container" && <><label>Layout<select value={layout.display ?? "flex"} onChange={e => patchLayout({ display: e.target.value as "flex" | "grid" })}><option value="flex">Flex</option><option value="grid">Grid</option></select></label><label>Dirección<select value={layout.direction ?? "column"} onChange={e => patchLayout({ direction: e.target.value as "row" | "column" })}><option value="column">Columna</option><option value="row">Fila</option></select></label>{layout.display === "grid" && <label>Columnas<input type="number" min={1} max={12} value={layout.columns ?? 1} onChange={e => { if (e.target.validity.valid) patchLayout({ columns: Number(e.target.value) }) }} /></label>}</>}
            <div className="preview-colors">
              <button type="button" className="btn btn-sm" aria-expanded={paletteOpen} onClick={() => setPaletteOpen(open => !open)}>Paleta de colores</button>
              {paletteOpen && <div className="preview-color-palette">
                <label>Aplicar a<select value={paletteTarget} onChange={e => setPaletteTarget(e.target.value as ColorTarget)}><option value="background">Fondo</option><option value="color">Texto</option><option value="borderColor">Borde</option></select></label>
                <ColorPicker key={`${node.id}-${paletteTarget}`} value={node.style?.[paletteTarget]} presets={palette} onCommit={hex => {
                  const patch: NonNullable<PreviewNode["style"]> = {}
                  patch[paletteTarget] = hex
                  void apply([{ type: "style", nodeId: node.id, patch }], "Ajustar color")
                }} />
              </div>}
            </div>
          </fieldset>}
          <p className="preview-note">Los ajustes se guardan por revisión. Móvil conserva sus propias reglas; el orden estructural es compartido.</p>
        </aside>
      </div>
      <details className="preview-theme"><summary>Identidad visual y procedencia</summary><ul>{revision.document.theme.sources.map((s, i) => <li key={i}><code>{s.path}</code> · {s.description}</li>)}</ul>{!revision.document.theme.sources.length && <p>No se declararon fuentes de identidad visual.</p>}<dl>{Object.entries(revision.document.theme.tokens).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>{revision.document.theme.approximations.map((a, i) => <p key={i}>Aproximación: {a}</p>)}</details>
      {state?.approval && !approvedCurrent && <p className="preview-note">La referencia aprobada sigue siendo {state.approval.revisionId}. Este borrador todavía no la reemplaza.</p>}
      <footer className="preview-approval"><label>Observaciones para la aprobación<textarea value={notes} onChange={e => setNotes(e.target.value)} disabled={busy || approvedCurrent} /></label><button className="btn btn-primary" disabled={busy || approvedCurrent || loading || !!textBase} onClick={async () => { const approved = await preview.approve(notes, revision.id); if (approved) onApproved?.(approved) }}>{busy ? "Guardando…" : approvedCurrent ? "Revisión aprobada" : `Aprobar revisión ${revision.id}`}</button><p className="preview-note">La aprobación congela esta revisión para la implementación. Editar después crea un borrador nuevo.</p></footer>
    </>}
  </section>
}
