import type { ReactNode } from "react"
import { Icon } from "../components/ui"
import { selectTeamChat } from "../state/teams"
import { runStatusLabel } from "./types"
import type { TeamSessionGroup } from "./session-index"
import { teamChatActive } from "./chat-active"

export function TeamSessionHistory({ group, children }: { group: TeamSessionGroup; children: ReactNode }) {
  const working = !!group.chat && teamChatActive(group.chat)
  return <details className={`team-session-history${working ? " team-chat-working" : ""}`}>
    <summary><Icon name="organization" /><span>{group.title}</span>{working && <span className="team-execution-badge">En ejecución</span>}<small>{group.sessions.length} sesiones</small></summary>
    <div className="team-session-history-body">
      {group.chat && <div className="team-session-history-lead">
        <span>{runStatusLabel(group.chat.runs.at(-1)?.status ?? "") ?? "Listo para tu objetivo"}</span>
        <button type="button" className="btn btn-xs" onClick={() => selectTeamChat(group.chat!.id)}>Hablar con el Lead</button>
      </div>}
      {children}
    </div>
  </details>
}
