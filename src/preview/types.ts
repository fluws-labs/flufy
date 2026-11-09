/** Shared wire contract. Identity always includes the task, never just a session. */
export type PreviewIdentity = { project: string; conversationId: string; taskId: string }
export type PreviewViewport = "desktop" | "mobile"
export type PreviewEditorContext = { revisionId?: string; nodeId?: string; screenId?: string; viewport?: PreviewViewport; saving: boolean }
export type PreviewLayout = {
  position?: "relative" | "absolute"; left?: number; top?: number
  display?: "flex" | "grid"; direction?: "row" | "column"; columns?: number
  gap?: number; padding?: number; width?: number; height?: number
  align?: "stretch" | "start" | "center" | "end"; justify?: "start" | "center" | "end" | "space-between"
}
export type PreviewOffset = { x: number; y: number }
export type PreviewNode = {
  id: string; kind: "container" | "heading" | "text" | "button" | "image"
  text?: string; resourceId?: string; children: PreviewNode[]
  layout: PreviewLayout; mobile?: PreviewLayout
  offset?: PreviewOffset; mobileOffset?: PreviewOffset
  targetScreenId?: string
  /** Invisible layout reservation left behind by a detached block. */
  placeholderFor?: string
  style?: { color?: string; background?: string; borderColor?: string; radius?: number; fontSize?: number; fontWeight?: number }
}
export type PreviewTheme = {
  tokens: Record<string, string>
  sources: { path: string; description: string }[]
  approximations: string[]
}
export type PreviewScreen = { id: string; name: string; nodeId: string }
export type PreviewDocument = {
  screens?: PreviewScreen[]
  schemaVersion: 1; title: string; root: PreviewNode; theme: PreviewTheme
  resources: { id: string; mime: "image/png" | "image/jpeg" | "image/webp"; data: string; source: string }[]
}
export type PreviewRevision = {
  id: string; parentId: string | null; createdAt: number; document: PreviewDocument
  html: string; css: string; author: "user" | "agent"; summary: string
}
export type PreviewApproval = { revisionId: string; approvedAt: number; notes: string }
export type PreviewState = {
  identity: PreviewIdentity; designId: string; status: "pending" | "skipped" | "draft" | "review" | "approved" | "implementation"
  revisions: PreviewRevision[]; currentRevisionId: string | null; approval: PreviewApproval | null
}
export type PreviewOperation =
  | { type: "screen-add"; nodeId: string; screenId: string; boardId: string; name: string }
  | { type: "screen-rename"; screenId: string; name: string }
  | { type: "text"; nodeId: string; text: string }
  | { type: "layout"; nodeId: string; viewport?: PreviewViewport; patch: PreviewLayout }
  | { type: "offset"; nodeId: string; viewport?: PreviewViewport; offset: PreviewOffset }
  | { type: "detach"; nodeId: string; parentId: string; x: number; y: number; width: number; height: number }
  | { type: "link"; nodeId: string; screenId: string | null }
  | { type: "style"; nodeId: string; patch: NonNullable<PreviewNode["style"]> }
  | { type: "move"; nodeId: string; parentId: string; index: number }
export type PreviewChange = { baseRevisionId: string; operations: PreviewOperation[]; author: "user" | "agent"; summary: string }
/** Backend adapters must atomically compare baseRevisionId, render and persist a new immutable revision. */
export interface PreviewClient {
  load(identity: PreviewIdentity): Promise<PreviewState | null>
  choose(identity: PreviewIdentity, choice: "create" | "skip"): Promise<PreviewState>
  change(identity: PreviewIdentity, change: PreviewChange): Promise<PreviewState>
  restore(identity: PreviewIdentity, baseRevisionId: string, revisionId: string): Promise<PreviewState>
  approve(identity: PreviewIdentity, revisionId: string, notes: string): Promise<PreviewState>
}
export type PreviewImplementation = {
  /** Capture provenance, supplied by the capturing backend, never by the viewer. */
  identity?: PreviewReferenceIdentity
  revisionId: string; viewport: PreviewViewport; width: number; height: number
  status: "captured" | "missing" | "failed"; imageUrl?: string; source: string; capturedAt?: number; reason?: string
}
export type PreviewReferenceIdentity = { projectRoot: string; sessionId: string; taskId: string; designId: string }
/** The native Reference transferred to the executor, independent of the current draft. */
export type PreviewReference = {
  identity: PreviewReferenceIdentity
  revision: { id: string; parentId: string | null; createdAt: number; document: unknown; html: string; css: string; assets?: unknown[]; notes?: string }
}
export function previewIdentityKey(identity: PreviewIdentity): string {
  return JSON.stringify([identity.project, identity.conversationId, identity.taskId])
}
