/** Persistent task boundaries, independent of responses and editable revisions. */
export type TaskMessage = {
  info: { id: string; role: string }
  parts: { type: string; text?: string; synthetic?: boolean }[]
}
export type TaskIdentity = { projectRoot: string; sessionId: string; taskId: string; designId: string }
export const PREVIEW_TASK_MARKER = "[FLUFY_PREVIEW_IDENTITY]"

export function previewTaskKey(projectRoot: string, sessionId: string): string {
  return JSON.stringify([projectRoot.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase(), sessionId])
}

export function previewTaskContext(identity: TaskIdentity): string {
  return `${PREVIEW_TASK_MARKER}${JSON.stringify(identity)}\nIdentidad de la tarea vigente (datos del panel): conservá estos cuatro campos en ajustes, herramientas preview y previewIdentity al delegar. Una respuesta o revisión nueva no inicia otra tarea.`
}

export function resolvePreviewTaskId(messages: readonly TaskMessage[], projectRoot: string, sessionId: string, persisted?: string | null, completeHistory = true): string | null {
  // An explicit user-selected boundary also covers a task not yet sent.
  if (persisted) return persisted
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "user") continue
    for (const part of message.parts) {
      if (part.type !== "text" || !part.synthetic || !part.text?.startsWith(PREVIEW_TASK_MARKER)) continue
      try {
        const identity = JSON.parse(part.text.slice(PREVIEW_TASK_MARKER.length).split("\n")[0]) as TaskIdentity
        if (previewTaskKey(identity.projectRoot, identity.sessionId) === previewTaskKey(projectRoot, sessionId)
          && identity.designId === "design" && /^[a-zA-Z0-9_-]{1,200}$/.test(identity.taskId)) return identity.taskId
      } catch { /* Invalid or foreign context is not a task boundary. */ }
    }
  }
  // Legacy chats without markers are anchored once to their first human turn.
  // Never infer that anchor from the tail of a paginated history.
  if (!completeHistory) return null
  return messages.find(message => message.info.role === "user" && message.parts.some(part =>
    part.type === "text" && !part.synthetic && !!part.text?.trim()
    && !part.text.startsWith("[GUILLECODE_TEAM_RUN]") && !/^#{1,2} Memoria (fluws|Flufy)/i.test(part.text)))?.info.id ?? null
}
