import { useState } from "react"
import type { PreviewImplementation, PreviewReference, PreviewState, PreviewViewport } from "./types"
import { previewIdentityKey } from "./types"
import { approvedRevision } from "./state"
import { PreviewFrame } from "./PreviewFrame"
import { fromNativeDocument, toNativeIdentity } from "./client"
import { equivalentDimensions, implementationRejection, isPreviewReference, safeCaptureImage } from "./comparison"
import "./preview.css"

export type PreviewComparisonProps = { reference?: PreviewReference | null; state?: PreviewState; implementation?: PreviewImplementation; implementations?: PreviewImplementation[]; loading?: boolean; error?: string }
/** A real captured result is required. A missing implementation is never replaced by the draft. */
export function PreviewComparison({ reference: transferred, state, implementation, implementations = [], loading = false, error }: PreviewComparisonProps) {
  const [viewport, setViewport] = useState<PreviewViewport>("desktop")
  // `state` remains an adapter for callers holding an explicit snapshot. Production
  // chat/team callers supply the transferred Reference and never reload a draft here.
  const snapshot = state ? approvedRevision(state) : null
  const reference = transferred === undefined && state && snapshot
    ? { identity: toNativeIdentity(state.identity), revision: snapshot }
    : transferred
  if (!isPreviewReference(reference)) return <section className="preview-panel" aria-label="Comparación de diseño"><h3>Referencia aprobada / implementación</h3><p role="status">{error ?? (loading ? "Consultando la referencia transferida…" : "No hay una referencia aprobada transferida válida para esta tarea.")}</p></section>
  const revision = reference.revision
  const candidates = [implementation, ...implementations].filter((item): item is PreviewImplementation => !!item)
  const result = candidates.filter(item => !implementationRejection(reference, item, viewport)).at(-1)
  const rejected = candidates.filter(item => implementationRejection(reference, item, item.viewport))
  const safeImage = safeCaptureImage(result?.imageUrl)
  const identityKey = previewIdentityKey({ project: reference.identity.projectRoot, conversationId: reference.identity.sessionId, taskId: reference.identity.taskId })
  return <section className="preview-panel" aria-label="Comparación de diseño">
    <header><h3>Referencia aprobada / implementación</h3><p>Revisión {revision.id} · referencia aprobada congelada</p></header>
    <div className="preview-actions"><button className={`btn btn-sm ${viewport === "desktop" ? "btn-primary" : ""}`} aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")}>Escritorio · 1280 × 800</button><button className={`btn btn-sm ${viewport === "mobile" ? "btn-primary" : ""}`} aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")}>Móvil · 390 × 844</button></div>
    <div className="preview-comparison-pair">
      <figure><figcaption>Diseño aprobado · {revision.id} · {viewport} · referencia congelada</figcaption><PreviewFrame document={fromNativeDocument(revision.document)} artifactHtml={revision.html} artifactCss={revision.css} identityKey={identityKey} revisionId={revision.id} viewport={viewport} /></figure>
      <figure><figcaption>Resultado real · {result?.revisionId ?? "sin captura"} · {viewport} · {result ? (result.status === "captured" ? "capturada" : result.status === "failed" ? "error" : "ausente") : "sin captura"}</figcaption>
        {result?.status === "captured" && safeImage ? <><div className="preview-result-scroll"><img src={result.imageUrl} alt={`Implementación real de ${revision.id}, ${viewport}, ${result.width} por ${result.height}`} /></div><p>{result.width} × {result.height} · {result.source}{result.capturedAt ? ` · ${new Date(result.capturedAt).toLocaleString()}` : ""}</p>{!equivalentDimensions(result, viewport) && <p role="status">Los viewports no coinciden. La comparación de dimensiones no es equivalente.</p>}</> : <p role="status">{error ?? (loading ? "Consultando capturas reales…" : result?.status === "captured" && !safeImage ? "La imagen de la captura no tiene un formato permitido." : result?.reason ?? "No hay una captura real verificada de la implementación para esta revisión y viewport.")}</p>}
      </figure>
    </div>
    {rejected.length > 0 && <p role="status">Se rechazaron {rejected.length} capturas sin atribución compatible con esta referencia. {implementationRejection(reference, rejected[0], rejected[0].viewport)}</p>}
    <p className="preview-note">El diseño aprobado muestra el artefacto HTML/CSS congelado por el backend: es el mismo ID y contenido que reciben el chat y el equipo. Revisá distribución, dimensiones, tipografía y colores; la referencia permanece congelada aunque exista un borrador posterior.</p>
  </section>
}
