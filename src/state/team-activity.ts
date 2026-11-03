import { create } from "zustand"
import { call, isTauri, onEvent } from "../lib/tauri"

export type TeamActivityKind = "tool" | "permission" | "status"

export type TeamActivityEvent = {
  seq: number
  at: number
  runId: string
  taskId: string | null
  attemptId: string | null
  agentId: string
  agentName: string
  sessionId: string
  kind: TeamActivityKind
  status: string
  tool: string | null
  label: string
  target: string | null
  callId: string | null
}

type State = { byRun: Record<string, TeamActivityEvent[]>; loaded: Record<string, boolean> }

const LIMIT = 400
const eventKey = (event: TeamActivityEvent) => `${event.at}:${event.seq}`
export const useTeamActivity = create<State>(() => ({ byRun: {}, loaded: {} }))

let listening = false
export function startTeamActivity() {
  if (listening || !isTauri) return
  listening = true
  onEvent<TeamActivityEvent>("team://activity", (event) => {
    useTeamActivity.setState((state) => {
      const previous = state.byRun[event.runId] ?? []
      if (previous.some((item) => eventKey(item) === eventKey(event))) return state
      return { ...state, byRun: { ...state.byRun, [event.runId]: [...previous, event].slice(-LIMIT) } }
    })
  })
}

export async function loadTeamActivity(runId: string) {
  if (!isTauri || useTeamActivity.getState().loaded[runId]) return
  try {
    const events = await call<TeamActivityEvent[]>("team_activity", { runId })
    useTeamActivity.setState((state) => {
      const live = state.byRun[runId] ?? []
      const merged = [...events, ...live.filter((event) => !events.some((item) => eventKey(item) === eventKey(event)))]
        .sort((a, b) => a.at - b.at || a.seq - b.seq)
        .slice(-LIMIT)
      return { ...state, byRun: { ...state.byRun, [runId]: merged }, loaded: { ...state.loaded, [runId]: true } }
    })
  } catch {
    // The activity feed is auxiliary: a failed read must not break the chat.
    useTeamActivity.setState((state) => ({ ...state, loaded: { ...state.loaded, [runId]: true } }))
  }
}
