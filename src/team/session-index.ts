import type { Session } from "@opencode-ai/sdk"
import type { TeamChatRecord } from "./types.ts"

// Kept independent of React/UI imports so permission checks also work in the
// lightweight event/attention consumers. Native code remains authoritative.
let sessions = new Set<string>()

export function teamSessionOwners(chats: TeamChatRecord[]) {
  const owners = new Map<string, TeamChatRecord>()
  for (const chat of chats) {
    const add = (id: string | null | undefined) => { if (id) owners.set(id, chat) }
    for (const message of chat.messages ?? []) add(message.sessionId)
    for (const run of chat.runs) {
      for (const report of run.supportReports ?? []) add(report.sessionId)
      add(run.planSessionId)
      for (const id of run.closingSessions ?? []) add(id)
      for (const request of run.coordination ?? []) for (const id of request.sessions) add(id)
      for (const task of run.tasks) for (const attempt of task.attempts) {
        add(attempt.sessionId)
        add(attempt.reviewSessionId)
      }
    }
  }
  return owners
}

export function indexTeamSessions(chats: TeamChatRecord[]) {
  sessions = new Set(teamSessionOwners(chats).keys())
}

export const isTeamSession = (id: string) => sessions.has(id)

export function memberSession(chat: TeamChatRecord, memberId: string, run = chat.runs.at(-1)): { id: string; directory: string } | null {
  if (!run) return null
  for (let taskIndex = run.tasks.length - 1; taskIndex >= 0; taskIndex -= 1) {
    const task = run.tasks[taskIndex]
    if (task.assignedAgentId !== memberId) continue
    const attempt = task.attempts.findLast(item => item.sessionId)
    if (attempt?.sessionId) return { id: attempt.sessionId, directory: task.repository || chat.team.projectRoot }
  }
  const report = (run.supportReports ?? []).findLast(item => item.agent.id === memberId)
  if (report) return { id: report.sessionId, directory: report.repository || chat.team.projectRoot }
  if (memberId !== run.team.leadAgentId) return null
  const message = (chat.messages ?? []).findLast(item => item.sessionId)
  if (message?.sessionId) return { id: message.sessionId, directory: chat.team.projectRoot }
  const reviewSessionId = run.tasks.flatMap(task => task.attempts).findLast(attempt => attempt.reviewSessionId)?.reviewSessionId
  if (reviewSessionId) return { id: reviewSessionId, directory: chat.team.projectRoot }
  if (run.planSessionId) return { id: run.planSessionId, directory: chat.team.projectRoot }
  return null
}

export type TeamSessionGroup = { id: string; title: string; chat?: TeamChatRecord; sessions: Session[] }

// Registry IDs survive renames. Walk ancestors so nested engine sessions stay
// with their team even when the parent is outside the current filtered list.
export function groupTeamSessions(visible: Session[], chats: TeamChatRecord[], all: Session[] = visible) {
  const owners = teamSessionOwners(chats)
  // The source conversation is the Lead, not an auxiliary team session. It
  // stays in the normal chat list even though it plans and coordinates.
  for (const chat of chats) {
    if (chat.origin?.sessionId) owners.delete(chat.origin.sessionId)
  }
  const byId = new Map([...all, ...visible].map(s => [s.id, s]))
  const groups = new Map<string, TeamSessionGroup>()
  const normal: Session[] = []
  for (const session of visible) {
    let current: Session | undefined = session
    let owner: TeamChatRecord | undefined
    let internal = false
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      owner = owners.get(current.id)
      internal ||= current.title?.startsWith("Equipo · ") ?? false
      if (owner) break
      current = current.parentID ? byId.get(current.parentID) : undefined
    }
    if (!owner && !internal) { normal.push(session); continue }
    // Unregistered/legacy sessions remain inspectable in a separate folded
    // group; never guess between chats with identical team names.
    const id = owner?.id ?? "legacy-team-sessions"
    let group = groups.get(id)
    if (!group) {
      group = { id, title: owner?.title ?? "Otras sesiones de equipos", chat: owner, sessions: [] }
      groups.set(id, group)
    }
    group.sessions.push(session)
  }
  return { normal, groups: [...groups.values()] }
}
