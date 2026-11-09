import type { PreviewDocument, PreviewLayout, PreviewNode, PreviewOffset, PreviewViewport } from "./types.ts"
import { validateDocument } from "./document.ts"
import { EDITOR_STYLE, editorBridgeScript } from "./interaction.ts"

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
function color(value: string | undefined, tokens: Record<string, string>): string | undefined {
  if (!value) return
  const resolved = value.startsWith("$") ? tokens[value.slice(1)] : value
  return resolved && /^(#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\)|[a-z]{1,24})$/i.test(resolved) ? resolved : undefined
}
function offsetCss(offset: PreviewOffset): string {
  return `transform:translate(${offset.x}px,${offset.y}px)`
}
function layoutCss(l: PreviewLayout): string {
  const css: string[] = []
  if (l.position) css.push(`position:${l.position}`)
  for (const key of ['left', 'top'] as const) if (l[key] !== undefined) css.push(`${key}:${l[key]}px`)
  if (l.position === 'absolute') css.push('margin:0')
  if (l.display) css.push(`display:${l.display}`)
  if (l.direction) css.push(`flex-direction:${l.direction}`)
  if (l.columns) css.push(`grid-template-columns:repeat(${l.columns},minmax(0,1fr))`)
  for (const key of ["gap", "padding", "width", "height"] as const) if (l[key] !== undefined) css.push(`${key}:${l[key]}px`)
  if (l.align) css.push(`align-items:${l.align === "start" || l.align === "end" ? `flex-${l.align}` : l.align}`)
  if (l.justify) css.push(`justify-content:${l.justify === "start" || l.justify === "end" ? `flex-${l.justify}` : l.justify}`)
  return css.join(";")
}
export function renderPreview(document: PreviewDocument): { html: string; css: string } {
  validateDocument(document)
  const tokens = document.theme.tokens
  const font = (tokens.fontFamily ?? "sans-serif").replace(/[^a-zA-Z0-9 ,_-]/g, "") || "sans-serif"
  const rules = [`*{box-sizing:border-box}body{margin:0;font-family:${font};background:${color(tokens.background, tokens) ?? "white"};color:${color(tokens.text, tokens) ?? "black"}}[data-node]{min-width:0;max-width:100%;overflow-wrap:anywhere}img{object-fit:contain}button{font:inherit}h2,p{margin:0}button{cursor:default}`]
  const mobile: string[] = []
  const render = (node: PreviewNode): string => {
    const declarations = [layoutCss(node.layout)]
    if (node.placeholderFor) declarations.push('visibility:hidden!important', 'pointer-events:none', 'flex-grow:0', 'flex-shrink:0')
    if (node.offset) declarations.push(offsetCss(node.offset))
    for (const key of ["color", "background", "borderColor"] as const) {
      const c = color(node.style?.[key], tokens); if (c) declarations.push(`${key === "borderColor" ? "border:1px solid" : key}:${c}`.replace("solid:", "solid "))
    }
    for (const [key, cssKey] of [["radius", "border-radius"], ["fontSize", "font-size"], ["fontWeight", "font-weight"]] as const) {
      const v = node.style?.[key]; if (v !== undefined && Number.isFinite(v) && v >= 0 && v <= 1000) declarations.push(`${cssKey}:${v}${key === "fontWeight" ? "" : "px"}`)
    }
    rules.push(`[data-node="${node.id}"]{${declarations.join(";")}}`)
    if (node.mobile || node.mobileOffset) mobile.push(`[data-node="${node.id}"]{${layoutCss(node.mobile ?? {})}${node.mobileOffset ? `;${offsetCss(node.mobileOffset)}` : ""}}`)
    const attrs = `data-node="${node.id}"${node.placeholderFor ? ' data-preview-slot aria-hidden="true"' : ' tabindex="0"'}${node.targetScreenId ? ` data-target-screen="${escape(node.targetScreenId)}"` : ''}`
    const text = escape(node.text ?? "")
    if (node.kind === "image") {
      const resource = document.resources.find(r => r.id === node.resourceId)
      const valid = resource && ["image/png", "image/jpeg", "image/webp"].includes(resource.mime) && /^[A-Za-z0-9+/=]+$/.test(resource.data)
      return valid ? `<img ${attrs} alt="${text}" src="data:${resource.mime};base64,${resource.data}">` : `<div ${attrs} role="img" aria-label="${text}">Recurso no disponible</div>`
    }
    const tag = { container: "section", heading: "h2", text: "p", button: "button" }[node.kind]
    return `<${tag} ${attrs}${tag === "button" ? ' type="button"' : ""}>${text}${node.children.map(render).join("")}</${tag}>`
  }
  const html = render(document.root)
  const css = `${rules.join("\n")}\n@media(max-width:600px){${mobile.join("\n")}}`
  return { html, css }
}
/** Persistable artifact: no scripts, links, remote URLs or native capabilities. */
export function renderPreviewHtml(document: PreviewDocument): string {
  const { html, css } = renderPreview(document)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(document.title)}</title><style>${css}</style></head><body>${html}</body></html>`
}
export type RendererContext = { identityKey: string; revisionId: string; channel: string; selectedId?: string; viewport: PreviewViewport; rootId?: string; containerIds?: string[]; readOnly?: boolean; screenRootId?: string; screenNodeIds?: string[]; links?: Record<string, string> }
/** Only this fixed bridge executes; document text is always escaped, never evaluated. */
export function renderEditorHtml(document: PreviewDocument, context: RendererContext): string {
  const { html, css } = renderPreview(document)
  const script = editorBridgeScript(context)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${EDITOR_STYLE}</style></head><body>${html}<script>${script}</script></body></html>`
}
export function isRendererSelection(data: unknown, context: RendererContext): data is { nodeId: string } {
  if (!data || typeof data !== "object") return false
  const v = data as Record<string, unknown>
  return Object.keys(v).sort().join(",") === "channel,identityKey,nodeId,revisionId,type" && v.type === "preview-select" && v.identityKey === context.identityKey && v.revisionId === context.revisionId && v.channel === context.channel && typeof v.nodeId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v.nodeId)
}
