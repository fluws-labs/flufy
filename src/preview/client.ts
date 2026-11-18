import { call } from "../lib/tauri.ts"
import { applyOperations, PreviewConflictError, validateDocument } from "./document.ts"
import type {
  PreviewClient, PreviewDocument, PreviewIdentity, PreviewLayout,
  PreviewNode, PreviewOffset, PreviewOperation, PreviewRevision, PreviewState, PreviewImplementation, PreviewReference, PreviewReferenceIdentity, PreviewViewport, PreviewScreen,
} from "./types.ts"
import { implementationRejection } from "./comparison.ts"

/**
 * Native IPC adapter. The backend (src-tauri/src/preview.rs) is the single
 * persistence authority (Design/Reference) AND the single renderer
 * (Revision.html/css). Every translation between the wire shapes and the
 * in-memory PreviewState/PreviewDocument lives here, so the domain
 * (document.ts, renderer.ts, state.ts) and its tests stay untouched.
 * Assumptions: document-shape translation belongs to this adapter; the frozen
 * backend artifact is what the UI shows and what reference_context() hands to
 * chat/team; chat and team share one design by passing the same identity.
 */

type NativeIdentity = { projectRoot: string; sessionId: string; taskId: string; designId: string }

type NativeRevision = {
  id: string; parentId: string | null; createdAt: number; document: unknown
  html: string; css: string; assets?: unknown[]; notes: string
}

type NativeApproval = { revisionId: string; createdAt: number; notes: string }

type NativeDesign = {
  identity: NativeIdentity; choice: string; status: string
  currentRevisionId: string | null; approvedRevisionId: string | null
  revisions: NativeRevision[]; approvals?: NativeApproval[]
}

type NativeNode = {
  id: string; type: string; text?: string
  layout?: Record<string, string | number>; styles?: Record<string, string | number>
  mobileStyles?: Record<string, string | number>; children?: NativeNode[]
  previewKind?: string
  targetScreenId?: string
  placeholderFor?: string
}

type NativeTheme = {
  provenance?: { file?: string; description?: string; tokens?: { name: string; value: string }[] }[]
  approximations?: string[]; tokens?: Record<string, string>
}

export type NativeDocument = {
  screens?: PreviewScreen[]
  version?: number; title?: string; root?: NativeNode; theme?: NativeTheme
  preview?: PreviewDocument; author?: "user" | "agent"
}

// One design per visual task. taskId MUST vary per visual task (see T3) so two
// tasks in the same chat never share the (project,session,task,design) record.
const DESIGN_ID = "design"
const STATUSES = ["pending", "skipped", "draft", "review", "approved", "implementation"] as const

/** Aproximaciones declaradas del fallback para borradores del agente escritos
 * con preview_apply solo en forma nativa (sin el campo `preview`). La UI muestra
 * el artefacto nativo congelado, así que ninguna de estas pérdidas altera lo que
 * el usuario ve ni lo que recibe el ejecutor. */
export const PREVIEW_DERIVE_APPROXIMATIONS = [
  "El borrador solo tiene forma nativa: PreviewDocument.resources no se reconstruye (el iframe usa el artefacto congelado).",
  "El backend no tiene tipo 'heading': previewKind recupera el bloque editable, pero el artefacto renderiza <p>.",
  "Las propiedades CSS nativas no modeladas por PreviewNode.style (fontFamily, lineHeight, boxShadow, opacity, textAlign, objectFit, flex, ...) quedan solo en el artefacto congelado, no en el modelo editable.",
  "La identidad visual del tema se aplica al nodo raíz nativo (el backend no expone body), no al body del renderizador de dominio.",
] as const

export function toNativeIdentity(identity: PreviewIdentity): NativeIdentity {
  return {
    projectRoot: identity.project,
    sessionId: identity.conversationId,
    taskId: identity.taskId,
    designId: DESIGN_ID,
  }
}

function startEnd(value: string): string {
  return value === "start" ? "flex-start" : value === "end" ? "flex-end" : value
}

function offsetToCss(offset: PreviewOffset): string {
  return `translate(${offset.x}px, ${offset.y}px)`
}

function cssToOffset(styles: Record<string, string | number> | undefined): PreviewOffset | undefined {
  const value = styles?.transform
  if (typeof value !== "string") return undefined
  const match = /^translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)$/i.exec(value.trim())
  if (!match) return undefined
  const x = Math.round(Number(match[1])), y = Math.round(Number(match[2]))
  return [x, y].every(n => Number.isFinite(n) && Math.abs(n) <= 10000) ? { x, y } : undefined
}

function previewLayoutToCss(layout: PreviewLayout): Record<string, string> {
  const css: Record<string, string> = {}
  if (layout.position) css.position = layout.position
  for (const key of ['left', 'top'] as const) if (layout[key] !== undefined) css[key] = `${layout[key]}px`
  if (layout.display) css.display = layout.display
  if (layout.direction) css.flexDirection = layout.direction
  if (layout.columns) css.gridTemplateColumns = `repeat(${layout.columns}, minmax(0,1fr))`
  for (const key of ["gap", "padding", "width", "height"] as const) {
    if (layout[key] !== undefined) css[key] = `${layout[key]}px`
  }
  if (layout.align) css.alignItems = startEnd(layout.align)
  if (layout.justify) css.justifyContent = startEnd(layout.justify)
  return css
}

/** Resuelve referencias $token y valida contra las reglas de properties() del
 * backend: solo colores seguros, sin url()/;{}<>\ ni valores inyectables. */
function resolveSafeColor(value: string | undefined, tokens: Record<string, string>): string | undefined {
  if (!value) return undefined
  const resolved = value.startsWith("$") ? tokens[value.slice(1)] : value
  return resolved && /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\)|[a-z]{1,24})$/i.test(resolved) ? resolved : undefined
}

function safeFont(value: string | undefined): string | undefined {
  if (!value) return undefined
  const font = value.replace(/[^a-zA-Z0-9 ,_-]/g, "").trim()
  return font && font.length <= 500 ? font : undefined
}

function previewStyleToCss(style: NonNullable<PreviewNode["style"]>, tokens: Record<string, string>): Record<string, string> {
  const css: Record<string, string> = {}
  const color = resolveSafeColor(style.color, tokens); if (color) css.color = color
  const background = resolveSafeColor(style.background, tokens); if (background) css.background = background
  const borderColor = resolveSafeColor(style.borderColor, tokens); if (borderColor) css.borderColor = borderColor
  if (style.radius !== undefined) css.borderRadius = `${style.radius}px`
  const fontFamily = safeFont(style.fontFamily); if (fontFamily) css.fontFamily = fontFamily
  if (style.fontSize !== undefined) css.fontSize = `${style.fontSize}px`
  if (style.fontWeight !== undefined) css.fontWeight = String(style.fontWeight)
  return css
}

/** Paleta/tipografía del tema inyectadas en el root nativo: properties() admite
 * fontFamily/background/color y render() las copia al artefacto congelado, que
 * es el que recibe el ejecutor. El backend no expone body: es una aproximación. */
function themeRootStyles(document: PreviewDocument): Record<string, string> {
  const tokens = document.theme.tokens ?? {}
  const css: Record<string, string> = {}
  const background = resolveSafeColor(tokens.background, tokens); if (background) css.background = background
  const color = resolveSafeColor(tokens.text, tokens); if (color) css.color = color
  const fontFamily = safeFont(tokens.fontFamily); if (fontFamily) css.fontFamily = fontFamily
  return css
}

function nativeNode(node: PreviewNode, tokens: Record<string, string>): NativeNode {
  const out: NativeNode = {
    id: node.id,
    type: node.kind === "heading" ? "text" : node.kind,
    previewKind: node.kind,
  }
  if (node.text !== undefined) out.text = node.text
  if (node.targetScreenId) out.targetScreenId = node.targetScreenId
  if (node.placeholderFor) {
    out.placeholderFor = node.placeholderFor
    out.styles = { flexGrow: '0', flexShrink: '0' }
  }
  const layout = previewLayoutToCss(node.layout)
  if (Object.keys(layout).length) out.layout = layout
  if (node.mobile) {
    const mobile = previewLayoutToCss(node.mobile)
    if (Object.keys(mobile).length) out.mobileStyles = mobile
  }
  if (node.style) {
    const styles = previewStyleToCss(node.style, tokens)
    if (Object.keys(styles).length) out.styles = { ...out.styles, ...styles }
  }
  if (node.offset) out.styles = { ...(out.styles ?? {}), transform: offsetToCss(node.offset) }
  if (node.children.length) out.children = node.children.map(child => nativeNode(child, tokens))
  return out
}

/** Backend render lee solo document.root; los campos extra (preview, author,
 * previewKind) se ignoran al renderizar pero viajan en el documento persistido,
 * garantizando ida y vuelta sin pérdida y la procedencia de la edición. */
export function toNativeDocument(document: PreviewDocument, author: "user" | "agent" = "user"): NativeDocument {
  const tokens = document.theme.tokens ?? {}
  const root = nativeNode(document.root, tokens)
  const theme = themeRootStyles(document)
  if (Object.keys(theme).length) root.styles = { ...theme, ...(root.styles ?? {}) }
  return {
    version: 1,
    title: document.title,
    root,
    theme: {
      provenance: (document.theme.sources ?? []).map(source => ({
        file: source.path, description: source.description,
        tokens: Object.entries(tokens).map(([name, value]) => ({ name, value })),
      })),
      approximations: document.theme.approximations ?? [],
      tokens,
    },
    preview: document,
    ...(document.screens ? { screens: structuredClone(document.screens) } : {}),
    author,
  }
}

function nativeNodeIndex(root: NativeNode | undefined): Map<string, NativeNode> {
  const index = new Map<string, NativeNode>()
  const walk = (node: NativeNode | undefined) => {
    if (!node || typeof node.id !== "string" || index.has(node.id)) return
    index.set(node.id, node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return index
}

function emptyNativeNode(node: PreviewNode, tokens: Record<string, string>): NativeNode {
  const out: NativeNode = {
    id: node.id,
    type: node.kind === "heading" ? "text" : node.kind,
    previewKind: node.kind,
  }
  if (node.text !== undefined) out.text = node.text
  const layout = previewLayoutToCss(node.layout)
  if (Object.keys(layout).length) out.layout = layout
  if (node.mobile) {
    const mobile = previewLayoutToCss(node.mobile)
    if (Object.keys(mobile).length) out.mobileStyles = mobile
  }
  if (node.mobileOffset) out.mobileStyles = { ...(out.mobileStyles ?? {}), transform: offsetToCss(node.mobileOffset) }
  if (node.style) {
    const styles = previewStyleToCss(node.style, tokens)
    if (Object.keys(styles).length) out.styles = styles
  }
  if (node.offset) out.styles = { ...(out.styles ?? {}), transform: offsetToCss(node.offset) }
  return out
}

type NativeMergeContext = {
  tokens: Record<string, string>
  index: Map<string, NativeNode>
  texts: Map<string, string>
  layouts: Map<string, { viewport: PreviewViewport; patch: PreviewLayout }[]>
  offsets: Map<string, { viewport: PreviewViewport; offset: PreviewOffset }[]>
  styles: Map<string, NonNullable<PreviewNode["style"]>>
}

/**
 * Un ajuste de la UI parte del documento nativo persistido y aplica SOLO lo que
 * la operación cambió. Reconstruirlo desde el modelo editable descartaría las
 * propiedades CSS que ese modelo no representa (display, gap, padding,
 * tipografía, sombras…), que es justo lo que hace que el diseño se vea como
 * estaba. El árbol conserva cada nodo por id aunque cambie de padre.
 */
export function mergeNativeDocument(base: NativeDocument, next: PreviewDocument, operations: PreviewOperation[], author: "user" | "agent" = "user"): NativeDocument {
  const originalIndex = nativeNodeIndex(base.root)
  // A detach is structural and positional, persisted in the same revision.
  operations = operations.flatMap(operation => operation.type === 'detach' ? [
    operation,
    { type: 'layout', nodeId: operation.parentId, patch: { position: 'relative' } },
    { type: 'layout', nodeId: operation.nodeId, patch: { position: 'absolute', left: operation.x, top: operation.y, width: operation.width, height: operation.height } },
    { type: 'offset', nodeId: operation.nodeId, offset: { x: 0, y: 0 } },
    { type: 'offset', nodeId: operation.nodeId, viewport: 'mobile', offset: { x: 0, y: 0 } },
  ] as PreviewOperation[] : operation.type === 'move' && originalIndex.get(operation.nodeId)?.layout?.position === 'absolute' ? [
    operation,
    { type: 'layout', nodeId: operation.nodeId, patch: { position: 'relative', left: 0, top: 0 } },
    { type: 'offset', nodeId: operation.nodeId, offset: { x: 0, y: 0 } },
    { type: 'offset', nodeId: operation.nodeId, viewport: 'mobile', offset: { x: 0, y: 0 } },
  ] as PreviewOperation[] : [operation])
  const context: NativeMergeContext = {
    tokens: next.theme.tokens ?? {},
    index: nativeNodeIndex(base.root),
    texts: new Map(),
    layouts: new Map(),
    offsets: new Map(),
    styles: new Map(),
  }
  for (const operation of operations) {
    if (operation.type === "text") context.texts.set(operation.nodeId, operation.text)
    else if (operation.type === "layout") {
      const patches = context.layouts.get(operation.nodeId) ?? []
      patches.push({ viewport: operation.viewport ?? "desktop", patch: operation.patch })
      context.layouts.set(operation.nodeId, patches)
    } else if (operation.type === "style") context.styles.set(operation.nodeId, operation.patch)
    else if (operation.type === "offset") {
      const offsets = context.offsets.get(operation.nodeId) ?? []
      offsets.push({ viewport: operation.viewport ?? "desktop", offset: operation.offset })
      context.offsets.set(operation.nodeId, offsets)
    }
  }
  const mergeNode = (node: PreviewNode, persisted: NativeNode | undefined): NativeNode => {
    if (node.placeholderFor) {
      const source = persisted ?? context.index.get(node.placeholderFor)
      // Preserve the real native layout (margins, flex/grid placement, etc.),
      // not just the smaller editable model. Only the measured size is pinned.
      const slot: NativeNode = source ? { ...source, id: node.id, placeholderFor: node.placeholderFor } : nativeNode(node, context.tokens)
      delete slot.children; delete slot.text; delete slot.targetScreenId
      const measured = previewLayoutToCss({ width: node.layout.width, height: node.layout.height })
      slot.layout = { ...slot.layout, ...measured }
      slot.styles = { ...slot.styles, ...measured, flexGrow: '0', flexShrink: '0' }
      return slot
    }
    const out: NativeNode = persisted
      ? { ...persisted, id: node.id, type: node.kind === "heading" ? "text" : node.kind, previewKind: node.kind }
      : emptyNativeNode(node, context.tokens)
    if (node.targetScreenId) out.targetScreenId = node.targetScreenId; else delete out.targetScreenId
    if (operations.some(operation => operation.type === 'detach' && operation.nodeId === node.id)) {
      out.styles = { ...out.styles, margin: '0' }
      for (const key of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight']) { delete out.styles[key] }
    }
    if (context.texts.has(node.id)) out.text = context.texts.get(node.id) ?? ""
    const layout = { ...(out.layout ?? {}) }
    const mobile = { ...(out.mobileStyles ?? {}) }
    const styles = { ...(out.styles ?? {}) }
    for (const { viewport, patch } of context.layouts.get(node.id) ?? []) {
      const css = previewLayoutToCss(patch)
      if (viewport === "mobile") Object.assign(mobile, css)
      else {
        Object.assign(layout, css)
        // layout se renderiza antes que styles: se quita la propiedad duplicada
        // para que el ajuste del usuario no quede tapado por el valor previo.
        for (const key of Object.keys(css)) delete styles[key]
      }
    }
    const stylePatch = context.styles.get(node.id)
    if (stylePatch) {
      const css = previewStyleToCss(stylePatch, context.tokens)
      Object.assign(styles, css)
      for (const key of Object.keys(css)) delete layout[key]
    }
    for (const { viewport, offset } of context.offsets.get(node.id) ?? []) {
      const css = { transform: offsetToCss(offset) }
      if (viewport === "mobile") Object.assign(mobile, css)
      else Object.assign(styles, css)
    }
    if (Object.keys(layout).length) out.layout = layout; else delete out.layout
    if (Object.keys(mobile).length) out.mobileStyles = mobile; else delete out.mobileStyles
    if (Object.keys(styles).length) out.styles = styles; else delete out.styles
    if (node.kind === "container") out.children = node.children.map(child => mergeNode(child, context.index.get(child.id)))
    else delete out.children
    return out
  }
  const merged: NativeDocument = {
    ...base,
    version: 1,
    title: next.title,
    root: mergeNode(next.root, context.index.get(next.root.id)),
    preview: next,
    author,
  }
  if (next.screens) merged.screens = structuredClone(next.screens); else delete merged.screens
  return merged
}

function num(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10000) return value
  if (typeof value === "string") {
    const n = Number.parseFloat(value)
    if (Number.isFinite(n) && n >= 0 && n <= 10000) return n
  }
  return undefined
}

function cssToPreviewLayout(css: Record<string, string | number> | undefined): PreviewLayout {
  const layout: PreviewLayout = {}
  if (!css) return layout
  if (css.position === 'absolute' || css.position === 'relative') layout.position = css.position
  for (const key of ['left', 'top'] as const) {
    const value = Number(String(css[key] ?? '').replace(/px$/, ''))
    if (css[key] !== undefined && Number.isFinite(value) && Math.abs(value) <= 10000) layout[key] = value
  }
  if (css.display === "flex" || css.display === "grid") layout.display = css.display
  if (css.flexDirection === "row" || css.flexDirection === "column") layout.direction = css.flexDirection
  if (typeof css.gridTemplateColumns === "string") {
    const match = /repeat\((\d+)/.exec(css.gridTemplateColumns)
    if (match) layout.columns = Math.min(12, Math.max(1, Number(match[1])))
  }
  for (const key of ["gap", "padding", "width", "height"] as const) {
    const value = num(css[key]); if (value !== undefined) layout[key] = value
  }
  const align = css.alignItems
  if (align === "flex-start") layout.align = "start"
  else if (align === "flex-end") layout.align = "end"
  else if (align === "stretch" || align === "center" || align === "start" || align === "end") layout.align = align
  const justify = css.justifyContent
  if (justify === "flex-start") layout.justify = "start"
  else if (justify === "flex-end") layout.justify = "end"
  else if (justify === "start" || justify === "center" || justify === "end" || justify === "space-between") layout.justify = justify
  return layout
}

function cssToPreviewStyle(css: Record<string, string | number> | undefined): PreviewNode["style"] {
  if (!css) return undefined
  const style: NonNullable<PreviewNode["style"]> = {}
  if (typeof css.color === "string") style.color = css.color
  const background = css.background ?? css.backgroundColor
  if (typeof background === "string") style.background = background
  if (typeof css.borderColor === "string") style.borderColor = css.borderColor
  const radius = num(css.borderRadius); if (radius !== undefined) style.radius = radius
  if (typeof css.fontFamily === "string") style.fontFamily = css.fontFamily
  const fontSize = num(css.fontSize); if (fontSize !== undefined) style.fontSize = fontSize
  const fontWeight = num(css.fontWeight); if (fontWeight !== undefined) style.fontWeight = fontWeight
  return Object.keys(style).length ? style : undefined
}

const FRONTEND_KINDS = ["container", "heading", "text", "button", "image"] as const
function previewNodeKind(node: NativeNode): PreviewNode["kind"] {
  if ((FRONTEND_KINDS as readonly string[]).includes(node.previewKind ?? "")) return node.previewKind as PreviewNode["kind"]
  const kinds: Record<string, PreviewNode["kind"]> = { container: "container", text: "text", button: "button", image: "image" }
  return kinds[node.type] ?? "container"
}

function nativeNodeToPreviewNode(node: NativeNode): PreviewNode {
  const kind = previewNodeKind(node)
  const children = kind === "container" && Array.isArray(node.children) ? node.children.map(nativeNodeToPreviewNode) : []
  const result: PreviewNode = { id: node.id, kind, children, layout: cssToPreviewLayout(node.layout) }
  if (typeof node.text === "string") result.text = node.text
  if (typeof node.targetScreenId === 'string') result.targetScreenId = node.targetScreenId
  if (typeof node.placeholderFor === 'string') result.placeholderFor = node.placeholderFor
  if (node.mobileStyles) result.mobile = cssToPreviewLayout(node.mobileStyles)
  const offset = cssToOffset(node.styles); if (offset) result.offset = offset
  const mobileOffset = cssToOffset(node.mobileStyles); if (mobileOffset) result.mobileOffset = mobileOffset
  const style = cssToPreviewStyle(node.styles)
  if (style) result.style = style
  return result
}

/** Fallback para borradores del agente escritos con preview_apply solo en forma
 * nativa. Las aproximaciones quedan declaradas en theme.approximations. */
function deriveDocument(document: NativeDocument): PreviewDocument {
  const root: PreviewNode = document.root
    ? nativeNodeToPreviewNode(document.root)
    : { id: "root", kind: "container", children: [], layout: { display: "flex", direction: "column" } }
  const provenance = Array.isArray(document.theme?.provenance) ? document.theme!.provenance! : []
  const tokens: Record<string, string> = { ...(document.theme?.tokens ?? {}) }
  const sources = provenance.map(entry => ({ path: entry?.file ?? "", description: entry?.description ?? "Estilo del proyecto" }))
  for (const entry of provenance) {
    if (Array.isArray(entry?.tokens)) for (const token of entry.tokens!) {
      if (token && typeof token.name === "string" && typeof token.value === "string") tokens[token.name] = token.value
    }
  }
  const declared = Array.isArray(document.theme?.approximations) ? document.theme!.approximations! : []
  return {
    schemaVersion: 1,
    title: typeof document.title === "string" ? document.title : "Diseño",
    root,
    theme: {
      tokens,
      sources,
      approximations: [...new Set([...declared, ...PREVIEW_DERIVE_APPROXIMATIONS])],
    },
    resources: [],
    ...(document.screens ? { screens: structuredClone(document.screens) } : {}),
  }
}

export function fromNativeDocument(value: unknown): PreviewDocument {
  const document = (value && typeof value === "object" ? value : {}) as NativeDocument
  if (document.preview) {
    try { validateDocument(document.preview); return document.preview } catch { /* derive from root */ }
  }
  return deriveDocument(document)
}

export function fromNativeDesign(design: NativeDesign, identity: PreviewIdentity): PreviewState {
  const revisions: PreviewRevision[] = (design.revisions ?? []).map(revision => {
    const native = (revision.document && typeof revision.document === "object" ? revision.document : {}) as NativeDocument
    // Un documento sin `preview` fue escrito por una tool del agente; los que lo
    // tienen llevan el autor de la edición (change.author).
    const author: PreviewRevision["author"] = native.preview
      ? (native.author === "agent" ? "agent" : "user")
      : "agent"
    return {
      id: revision.id,
      parentId: revision.parentId ?? null,
      createdAt: revision.createdAt,
      document: fromNativeDocument(revision.document),
      html: revision.html,
      css: revision.css,
      author,
      summary: revision.notes ?? "",
    }
  })
  let approval: PreviewState["approval"] = null
  if (design.approvedRevisionId) {
    const match = [...(design.approvals ?? [])].reverse().find(entry => entry?.revisionId === design.approvedRevisionId)
    approval = {
      revisionId: design.approvedRevisionId,
      approvedAt: typeof match?.createdAt === "number" ? match.createdAt : 0,
      notes: typeof match?.notes === "string" ? match.notes : "",
    }
  }
  const status: PreviewState["status"] = (STATUSES as readonly string[]).includes(design.status)
    ? design.status as PreviewState["status"]
    : "draft"
  return {
    identity,
    designId: design.identity?.designId ?? DESIGN_ID,
    status,
    revisions,
    currentRevisionId: design.currentRevisionId ?? null,
    approval,
  }
}

export const previewClient: PreviewClient = {
  load: async identity => {
    const design = await call<NativeDesign>("preview_get", { identity: toNativeIdentity(identity) })
    if (!design || (design.choice === "pending" && !design.revisions?.length)) return null
    return fromNativeDesign(design, identity)
  },
  choose: async (identity, choice) => {
    const design = await call<NativeDesign>("preview_choose", {
      identity: toNativeIdentity(identity), baseRevisionId: null, choice,
    })
    return fromNativeDesign(design, identity)
  },
  change: async (identity, change) => {
    const design = await call<NativeDesign>("preview_get", { identity: toNativeIdentity(identity) })
    const base = (design.revisions ?? []).find(revision => revision.id === change.baseRevisionId)
    if (!base || design.currentRevisionId !== change.baseRevisionId) throw new PreviewConflictError()
    const next = applyOperations(fromNativeDocument(base.document), change.operations)
    const nativeBase = base.document && typeof base.document === "object" ? base.document as NativeDocument : null
    const result = await call<NativeDesign>("preview_apply", {
      identity: toNativeIdentity(identity),
      baseRevisionId: change.baseRevisionId,
      document: nativeBase
        ? mergeNativeDocument(nativeBase, next, change.operations, change.author)
        : toNativeDocument(next, change.author),
      notes: change.summary,
    })
    return fromNativeDesign(result, identity)
  },
  restore: async (identity, baseRevisionId, revisionId) => {
    const design = await call<NativeDesign>("preview_get", { identity: toNativeIdentity(identity) })
    const target = (design.revisions ?? []).find(revision => revision.id === revisionId)
    if (!target) throw new Error("La revisión a restaurar ya no existe")
    if (design.currentRevisionId !== baseRevisionId) throw new PreviewConflictError()
    const result = await call<NativeDesign>("preview_apply", {
      identity: toNativeIdentity(identity),
      baseRevisionId,
      document: target.document,
      notes: `Restaurar revisión ${revisionId}`,
    })
    return fromNativeDesign(result, identity)
  },
  approve: async (identity, revisionId, notes) => {
    const design = await call<NativeDesign>("preview_approve", {
      identity: toNativeIdentity(identity), baseRevisionId: revisionId, notes,
    })
    return fromNativeDesign(design, identity)
  },
}

/** Theme provenance from local CSS/SCSS, exposed for seeding a first draft. */
export function previewTheme(identity: PreviewIdentity): Promise<unknown> {
  return call<unknown>("preview_identity", { identity: toNativeIdentity(identity) })
}

type NativeCapture = {
  binding: { identity: PreviewReferenceIdentity; revisionId: string; viewport: PreviewViewport; width: number; height: number; origin: string }
  status: string; source: string; capturedAt: number
}

/** Read provenance from the persisted capture, never stamp the current draft on it. */
export async function previewImplementations(reference: PreviewReference): Promise<PreviewImplementation[]> {
  const captures = await call<NativeCapture[]>("preview_capture_list", { identity: reference.identity })
  return Promise.all(captures.map(async capture => {
    const base: PreviewImplementation = { ...capture.binding, source: capture.source, capturedAt: capture.capturedAt, status: "missing" }
    const rejection = implementationRejection(reference, base, base.viewport)
    if (rejection || capture.status !== "verified") return { ...base, reason: rejection ?? "La captura no está verificada." }
    try {
      const image = await call<{ mime: string; data: string }>("preview_capture_image", {
        identity: capture.binding.identity, revisionId: capture.binding.revisionId, viewport: capture.binding.viewport,
      })
      return { ...base, status: "captured", imageUrl: `data:${image.mime};base64,${image.data}` }
    } catch (error) {
      return { ...base, status: "failed", reason: error instanceof Error ? error.message : String(error) }
    }
  }))
}
