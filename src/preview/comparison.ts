import type { PreviewImplementation, PreviewReference, PreviewReferenceIdentity, PreviewViewport } from "./types.ts"

export const PREVIEW_VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } } as const

export function sameReferenceIdentity(a: PreviewReferenceIdentity | undefined, b: PreviewReferenceIdentity | undefined): boolean {
  return !!a && !!b && ["projectRoot", "sessionId", "taskId", "designId"].every(key => {
    const field = key as keyof PreviewReferenceIdentity
    return typeof a[field] === "string" && !!a[field] && a[field] === b[field]
  })
}

/** Validate the transferred shape without consulting the mutable design store. */
export function isPreviewReference(value: unknown): value is PreviewReference {
  if (!value || typeof value !== "object") return false
  const reference = value as PreviewReference
  const revision = reference.revision
  return sameReferenceIdentity(reference.identity, reference.identity) && !!revision
    && typeof revision.id === "string" && !!revision.id
    && typeof revision.html === "string" && !!revision.html
    && typeof revision.css === "string" && !!revision.document && typeof revision.document === "object"
}

export function implementationRejection(reference: PreviewReference, capture: PreviewImplementation, viewport: PreviewViewport): string | null {
  if (!sameReferenceIdentity(reference.identity, capture.identity)) return "La captura no acredita el proyecto, conversación, tarea y diseño de esta referencia."
  if (capture.revisionId !== reference.revision.id) return "La captura pertenece a otra revisión."
  if (capture.viewport !== viewport) return "La captura no acredita el viewport seleccionado."
  if (!Number.isInteger(capture.width) || !Number.isInteger(capture.height) || capture.width <= 0 || capture.height <= 0) return "La captura no acredita dimensiones válidas."
  return null
}

export function equivalentDimensions(capture: PreviewImplementation, viewport: PreviewViewport): boolean {
  const expected = PREVIEW_VIEWPORTS[viewport]
  return capture.width === expected.width && capture.height === expected.height
}

export function safeCaptureImage(url: string | undefined): boolean {
  return !!url && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)
}

export type CaptureAttribution = { identity: PreviewReferenceIdentity; revisionId: string; viewport: PreviewViewport }
/**
 * Attribution is read from the capture record itself. A capture without an
 * explicit project/session/task/design, revision and viewport is not attributed:
 * viewers never label it with the reference they expect nor infer the viewport.
 * Expected capture details: previewIdentity {projectRoot, sessionId, taskId,
 * designId}, previewRevisionId and viewport ("desktop" | "mobile").
 */
export function captureAttribution(details: unknown): CaptureAttribution | null {
  if (!details || typeof details !== "object") return null
  const value = details as { previewIdentity?: unknown; previewRevisionId?: unknown; viewport?: unknown }
  const identity = value.previewIdentity as PreviewReferenceIdentity | undefined
  if (!sameReferenceIdentity(identity, identity)) return null
  const revisionId = typeof value.previewRevisionId === "string" ? value.previewRevisionId : ""
  const viewport = value.viewport === "desktop" || value.viewport === "mobile" ? value.viewport : null
  if (!revisionId || !viewport) return null
  return { identity: identity!, revisionId, viewport }
}
