import { useEffect } from "react"
import { rememberPreviewTask, useAgent } from "../state/agent"
import { useProject } from "../state/project"
import { previewTaskKey, resolvePreviewTaskId } from "../preview/task-identity"
import type { PreviewIdentity } from "../preview"

export const PREVIEW_CHOICE_QUESTION = "¿Querés previsualizar cómo quedaría antes de implementarlo?"

export function previewIdentityFor(project: string | null, conversationId: string | null, taskId: string): PreviewIdentity | null {
  if (!project || !conversationId) return null
  return { project, conversationId, taskId }
}

export function usePreviewTaskId(conversationId: string | null): string | null {
  const project = useProject(s => s.root)
  const taskId = useAgent(s => {
    if (!project || !conversationId) return null
    const view = s.views[conversationId]
    return resolvePreviewTaskId(view?.messages ?? [], project, conversationId,
      s.previewTasks[previewTaskKey(project, conversationId)], !!view && !view.hasMore)
  })
  useEffect(() => {
    if (project && conversationId && taskId) rememberPreviewTask(project, conversationId, taskId)
  }, [project, conversationId, taskId])
  return taskId
}
