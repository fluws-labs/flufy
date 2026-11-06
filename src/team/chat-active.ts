import type { TeamChatRecord } from "./types"

/** Execution, not selection or a run that merely remains resumable/reviewable. */
export function teamChatActive(chat: TeamChatRecord): boolean {
  if (chat.messages?.some(message => message.role === "assistant" && message.status === "pending")) return true
  const run = chat.runs.at(-1)
  if (!run || run.finishedAt != null) return false
  if (["planning", "delivering", "cancelling"].includes(run.status)) return true
  // Pause stops dispatch, not sessions already running. A blocked run may
  // likewise still have independent workers settling; use their own status.
  if (!["running", "paused", "blocked"].includes(run.status)) return false
  if (run.supportReports?.some(report => report.status === "running" && report.finishedAt == null)) return true
  if (run.coordination?.some(request => request.status === "checking")) return true
  return run.tasks.some(task =>
    ["running", "verifying"].includes(task.status) && task.attempts.some(attempt =>
      attempt.finishedAt == null && ["running", "verifying"].includes(attempt.status)
      && !!(attempt.sessionId || attempt.reviewSessionId)))
}
