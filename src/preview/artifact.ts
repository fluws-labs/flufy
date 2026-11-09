import type { RendererContext } from "./renderer.ts"
import { EDITOR_STYLE, editorBridgeScript } from "./interaction.ts"

export type PreviewArtifact = { html: string; css: string }

const STATIC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

function isFullDocument(html: string): boolean {
  return /^\s*(<!doctype html>|<html[\s>])/i.test(html)
}

/**
 * La referencia aprobada se congela como documento HTML completo producido por
 * render() del backend (Revision.html). La comparación lo muestra EXACTAMENTE
 * igual y reference_context() entrega ese mismo artefacto a chat/equipo: un solo
 * render, no dos. Un fragmento (p. ej. fixtures de dominio) se envuelve con la
 * misma CSP estricta y su CSS sin alterar el marcado.
 */
export function previewArtifactHtml(artifact: PreviewArtifact): string {
  const html = artifact.html ?? ""
  if (isFullDocument(html)) return html
  const css = artifact.css ?? ""
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${html}</body></html>`
}

/**
 * Editor: el MISMO artefacto congelado más el puente fijo de selección,
 * arrastre y tamaño. Se relaja la CSP para permitir el script en línea y se agregan
 * estilos de edición; el marcado y el CSS persistidos permanecen idénticos al
 * artefacto aprobado. El puente valida ventana/origen/identidad/revisión/canal
 * mediante isRendererSelection en PreviewFrame. Sin allow-same-origin.
 */
export function previewEditorArtifactHtml(artifact: PreviewArtifact, context: RendererContext): string {
  const full = previewArtifactHtml(artifact)
  const script = editorBridgeScript(context)
  const editorCsp = `${STATIC_CSP}; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'`
  const style = `<style>${EDITOR_STYLE}</style>`
  let out = full
  const csp = /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/i
  if (csp.test(out)) out = out.replace(csp, `$1$2; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'$3`)
  else if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, m => `${m}<meta http-equiv="Content-Security-Policy" content="${editorCsp}">`)
  else out = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${editorCsp}"></head><body>${out}</body></html>`
  const inject = `${style}<script>${script}</script>`
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${inject}</body>`) : out + inject
  return out
}
