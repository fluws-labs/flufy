import { useEffect, useMemo, useState } from "react"
import { Icon, IconButton } from "../components/ui"
import { openContextMenu } from "../components/ContextMenu"
import { useProject } from "../state/project"
import { samePath } from "../lib/paths"
import { deleteTeam, duplicateTeam, newTeamChat, openTeam, selectTeamChat, startTeams, teamCall, useTeams } from "../state/teams"
import { selectSession } from "../state/agent"
import { rememberSessionDirectory } from "../lib/opencode"
import { runStatusLabel } from "../team/types"
import { teamChatActive } from "../team/chat-active"
import { formatDateTime } from "../lib/time"

export function TeamsView() {
  const { teams, chats, loaded, error, activeChatId } = useTeams()
  const root = useProject((s) => s.root)
  const [templates, setTemplates] = useState(false)
  useEffect(() => startTeams(), [])
  const mine = teams.filter((team) => root && samePath(team.projectRoot, root))
  const returnToChat = (chat: (typeof chats)[number]) => {
    if (!chat.origin) return
    rememberSessionDirectory(chat.origin.sessionId, chat.origin.directory)
    useTeams.setState({ activeChatId: null })
    selectSession(chat.origin.sessionId)
  }
  const works = useMemo(() => chats
    .filter((chat) => root && samePath(chat.team.projectRoot, root))
    .flatMap((chat) => chat.runs.map((run) => ({ chat, run })))
    .sort((a, b) => b.run.startedAt - a.run.startedAt), [chats, root])
  const conversations = useMemo(() => chats
    .filter((chat) => root && samePath(chat.team.projectRoot, root) && !chat.runs.length && !chat.archived)
    .sort((a, b) => b.createdAt - a.createdAt), [chats, root])

  return <div className="view teams-view">
    <div className="view-header">
      <span className="view-title">Trabajos</span>
      <div className="view-actions">
        <IconButton icon="settings-gear" title="Plantillas de equipo" active={templates} onClick={() => setTemplates((value) => !value)} />
      </div>
    </div>
    {error && <p className="team-error">{error}</p>}
    {!root ? <p className="team-note">Abrí un proyecto para ver sus trabajos.</p> : <div className="team-sidebar-list">
      <button className="btn btn-primary" onClick={() => void newTeamChat()}><Icon name="organization" /> Modo equipo</button>
      {templates && <section className="team-templates" aria-label="Plantillas de equipo">
        <div className="team-templates-title"><strong>Plantillas de equipo</strong><button className="btn btn-xs" onClick={() => openTeam()}><Icon name="add" /> Nueva plantilla</button></div>
        <p className="team-note">Solo para equipos manuales avanzados. El flujo normal crea el equipo desde la conversación.</p>
        {!mine.length && <p className="team-note">No hay plantillas en este proyecto.</p>}
        {mine.map((team) => <article key={team.id} className="team-sidebar-card" onContextMenu={(e) => openContextMenu(e, [
          { label: "Editar / renombrar", icon: "edit", run: () => openTeam(team.id) },
          { label: "Duplicar", icon: "copy", run: () => void duplicateTeam(team) },
          { label: "Eliminar plantilla", icon: "trash", danger: true, run: () => void deleteTeam(team) },
        ])}>
          <button className="team-link" onClick={() => openTeam(team.id)}><Icon name="organization" /> <strong>{team.name}</strong></button>
          <p>{team.members.length} integrantes · {team.members.map((member) => member.role).join(", ")}</p>
          <div className="team-actions"><button className="btn btn-xs" onClick={() => void newTeamChat(team.id)}>Abrir chat</button><button className="btn btn-xs" onClick={() => openTeam(team.id)}>Configurar</button></div>
        </article>)}
      </section>}
      <h3>Trabajos</h3>
      {!works.length && <p className="team-note">{loaded ? "Todavía no hay trabajos. Pedile al Lead que implemente algo en una conversación." : "Cargando trabajos…"}</p>}
      {works.map(({ chat, run }) => {
        const tasks = run.tasks.filter((task) => task.taskKind !== "group")
        const done = tasks.filter((task) => task.status === "completed").length
        const conversationLead = !!run.planV2?.conversationLead
        return <article key={`${chat.id}:${run.id}`} className={`team-sidebar-card${teamChatActive(chat) ? " team-chat-working" : ""}${activeChatId === chat.id ? " active" : ""}`}>
          <button className="team-link" aria-pressed={activeChatId === chat.id} onClick={() => selectTeamChat(chat.id, run.id)}>
            <Icon name={chat.archived ? "archive" : conversationLead ? "comment-discussion" : "organization"} />
            {chat.origin?.title || chat.title}
            {teamChatActive(chat) && <span className="team-execution-badge">En ejecución</span>}
          </button>
          <p>
            {runStatusLabel(run.status)}
            {tasks.length > 0 && ` · ${done}/${tasks.length} tareas`}
            {` · ${formatDateTime(run.startedAt)}`}
          </p>
          <p className="team-note">{conversationLead ? "Conversación con el Lead" : "Equipo manual"}</p>
          <p className="team-note">{run.goal.slice(0, 160)}</p>
          <div className="team-actions">
            <button className="btn btn-xs" onClick={() => selectTeamChat(chat.id, run.id)}>Ver tablero</button>
            {chat.origin && <button className="btn btn-xs" onClick={() => returnToChat(chat)}>Volver al chat</button>}
            {chat.archived && <button className="btn btn-xs" onClick={() => void teamCall("team_chats_edit", { id: chat.id, title: chat.title, archived: false })}>Restaurar historial</button>}
          </div>
        </article>
      })}
      {conversations.length > 0 && <section aria-label="Conversaciones de equipo">
        <h3>Conversaciones</h3>
        {conversations.map((chat) => <article key={chat.id} className={`team-sidebar-card${activeChatId === chat.id ? " active" : ""}`}>
          <button className="team-link" aria-pressed={activeChatId === chat.id} onClick={() => selectTeamChat(chat.id)}>
            <Icon name="organization" /> {chat.title}
          </button>
          <p className="team-note">{chat.messages?.length ? "Sin trabajo todavía" : "Sin objetivo todavía"}</p>
          <div className="team-actions">
            <button className="btn btn-xs" onClick={() => selectTeamChat(chat.id)}>Abrir chat</button>
            <button className="btn btn-xs" onClick={() => void teamCall("team_chats_edit", { id: chat.id, title: chat.title, archived: true })}>Archivar</button>
          </div>
        </article>)}
      </section>}
    </div>}
  </div>
}
