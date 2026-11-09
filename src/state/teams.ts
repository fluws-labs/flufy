import { create } from "zustand"
import { call, errorMessage, isTauri, onEvent } from "../lib/tauri"
import { loadJson, saveJson } from "../lib/persist"
import { openEditor } from "./editors"
import { useProject } from "./project"
import { useLayout } from "./layout"
import { selectedVariant, setModel, setVariant, useAgent } from "./agent"
import { modelKey } from "../lib/opencode"
import { samePath } from "../lib/paths"
import { promptInput } from "./quickinput"
import { confirmAction } from "../components/Dialog"
import { notify } from "./toasts"
import type { Skill, Team, TeamChatRecord, TeamStore } from "../team/types"
import { chatFallback } from "../team/types"
import { indexTeamSessions } from "../team/session-index"
import { readableTeamError } from "../lib/provider-error"
import { startTeamActivity } from "./team-activity"

type State = TeamStore & { loaded: boolean; error: string | null; activeChatId: string | null; openChatIds: string[]; selectedRunIds: Record<string,string|null> }
export const useTeams = create<State>(() => ({ schemaVersion: 1, teams: [], skills: [], chats: [], fallbackModels: [], loaded: false, error: null, activeChatId: null, openChatIds: loadJson<string[]>("team.tabs", []), selectedRunIds:{} }))

// A selector is owned only while this conversation is visible. Native snapshots
// remain the source of truth; an acknowledgement in localStorage must never turn
// a historical completion into a new selector change after reloading.
let fallbackSelector: { chatId: string; runId: string; signature: string; released: boolean } | null = null
const releasedFallbackSelectors = new Set<string>()
let applyingFallbackSelector = false
const selectorSignature = () => {
  const state = useAgent.getState()
  return JSON.stringify([modelKey(state.model), state.variants[modelKey(state.model)] || null])
}

function syncFallbackModel(data: TeamStore, previous: State) {
  const { activeChatId, selectedRunIds } = useTeams.getState()
  const root = useProject.getState().root
  const chat = data.chats.find(chat => chat.id === activeChatId)
  const run = chat?.runs.at(-1)
  const source = chat ? chatFallback(chat) : null
  const fallback = source?.state
  if (!useLayout.getState().agentVisible || !root || !chat || !samePath(chat.team.projectRoot, root) || !source || !fallback
      || (selectedRunIds[chat.id] && selectedRunIds[chat.id] !== run?.id)) {
    fallbackSelector = null
    return
  }
  const ownerKey = JSON.stringify([chat.id, source.id])
  if (releasedFallbackSelectors.has(ownerKey)) return
  const owner = fallbackSelector?.chatId === chat.id && fallbackSelector.runId === source.id ? fallbackSelector : null
  if (owner?.released) return
  if (owner && owner.signature !== selectorSignature()) { owner.released = true; return }
  if (!owner) {
    // Restored snapshots are history, including on the first refresh after a
    // reload. An ongoing run may reclaim only its already-current selection;
    // loading an old transition must not overwrite a more recent choice.
    if (!fallback.enabled || fallback.restored || source.finished) return
    const current = useAgent.getState()
    const key = modelKey(current.model)
    const previousChat = previous.chats.find(item => item.id === chat.id)
    const previousSource = previousChat ? chatFallback(previousChat) : null
    const newLiveSource = previous.loaded && previousSource?.id !== source.id
    if (key !== modelKey(fallback.currentModel) && !(newLiveSource && key === modelKey(fallback.originalModel))) return
    const variant = current.variants[key] || null
    const expectedVariant = key === modelKey(fallback.originalModel) ? fallback.originalVariant : null
    if (variant !== expectedVariant) return
  }
  if (!fallback.enabled && !fallback.restored) return
  const model = fallback.restored ? fallback.originalModel : fallback.currentModel
  const variant = fallback.restored || modelKey(model) === modelKey(fallback.originalModel) ? fallback.originalVariant : null
  const signature = JSON.stringify([modelKey(model), variant])
  fallbackSelector = { chatId: chat.id, runId: source.id, signature, released: false }
  if (signature === selectorSignature()) return
  applyingFallbackSelector = true
  try { setModel(model, null); setVariant(model, variant, null) }
  finally { applyingFallbackSelector = false }
}

useAgent.subscribe((state, previous) => {
  if (!fallbackSelector || applyingFallbackSelector) return
  // Also respect explicit re-selection of the same model or variant.
  if (state.model !== previous.model || state.variants !== previous.variants) {
    fallbackSelector.released = true
    releasedFallbackSelectors.add(JSON.stringify([fallbackSelector.chatId, fallbackSelector.runId]))
  }
  if (state.activeSessionId !== previous.activeSessionId || state.composerFocus !== previous.composerFocus) fallbackSelector = null
})
useTeams.subscribe((state, previous) => {
  if (state.activeChatId !== previous.activeChatId
      || state.selectedRunIds[state.activeChatId ?? ""] !== previous.selectedRunIds[previous.activeChatId ?? ""]) {
    fallbackSelector = null
    // Opening a live conversation after reload may acquire its current model
    // without replaying a transition. Bind before the next completion arrives.
    syncFallbackModel(state, state)
  }
})
useLayout.subscribe((state, previous) => {
  if (state.agentVisible === previous.agentVisible) return
  fallbackSelector = null
  // Hiding the panel releases ownership immediately, before another refresh.
  // Showing it can bind the current live selection, never replay hidden history.
  if (state.agentVisible) syncFallbackModel(useTeams.getState(), useTeams.getState())
})
useProject.subscribe((state, previous) => { if (state.root !== previous.root) fallbackSelector = null })

let refreshRequested = 0
let refreshApplied = 0
export async function refreshTeams() {
  if (!isTauri) return
  const request = ++refreshRequested
  try {
    const data = await call<TeamStore | null>("teams_state")
    // Older test hosts do not implement this command. Never invent native data.
    if (data && request >= refreshApplied) {
      const current = useTeams.getState()
      for (const chat of data.chats) chat.runs = chat.runs.map(run => {
        const previous = current.chats.find(c => c.id === chat.id)?.runs.find(r => r.id === run.id)
        return previous && (previous.planV2?.sequence ?? 0) > (run.planV2?.sequence ?? 0) ? previous : run
      })
      refreshApplied = request
      indexTeamSessions(data.chats); useTeams.setState({ ...data, fallbackModels: data.fallbackModels ?? [], loaded: true, error: null })
      syncFallbackModel(data, current)
    }
  } catch (e) { if (request >= refreshApplied) useTeams.setState({ loaded: true, error: errorMessage(e) }) }
}

let listening = false
export function startTeams() {
  if (listening || !isTauri) return
  listening = true
  startTeamActivity()
  void refreshTeams()
  let timer: ReturnType<typeof setTimeout> | null = null
  onEvent("team://changed", () => { if (!timer) timer = setTimeout(() => { timer = null; void refreshTeams() }, 100) })
  onEvent<{ runId: string }>("team://run-completed", ({ runId }) => {
    void refreshTeams().then(() => {
      const chat = useTeams.getState().chats.find((c) => c.runs.some((r) => r.id === runId))
      if (chat) notify.success(`${chat.team.name}: Terminamos`, "Trabajo y pruebas terminados. Revisá la entrega: podés aceptarla o pedir mejoras.")
    })
  })
  useProject.subscribe((s, prev) => { if (s.root !== prev.root) useTeams.setState({ activeChatId: null }) })
  useAgent.subscribe((s, prev) => { if (s.activeSessionId !== prev.activeSessionId || s.composerFocus !== prev.composerFocus) useTeams.setState({ activeChatId: null }) })
  // Refresh after foregrounding: covers a lost IPC event without running a UI scheduler.
  window.addEventListener("focus", () => void refreshTeams())
}

export async function teamCall<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  try { const result = await call<T>(command, args); await refreshTeams(); return result }
  catch (e) {
    if (/REVISION_CONFLICT/.test(errorMessage(e))) {
      await refreshTeams()
      notify.error("El plan cambió", "Actualicé el tablero. Revisá el estado vigente antes de volver a aplicar el cambio.")
    } else notify.error("Equipos IA", readableTeamError(e))
    return null
  }
}

export function openTeam(id = `new:${crypto.randomUUID()}`) { openEditor({ kind: "team", id }) }
export function selectTeamChat(id: string, runId?: string) {
  useTeams.setState((s) => ({ activeChatId: id, openChatIds: [...new Set([...s.openChatIds, id])],...(runId ? {selectedRunIds:{...s.selectedRunIds,[id]:runId}} : {}) }))
  saveJson("team.tabs", useTeams.getState().openChatIds)
  useLayout.getState().toggleAgent(true)
}
export function closeTeamChat(id: string) {
  useTeams.setState((s) => ({ openChatIds: s.openChatIds.filter((v) => v !== id), activeChatId: s.activeChatId === id ? null : s.activeChatId }))
  saveJson("team.tabs", useTeams.getState().openChatIds)
}
export async function newTeamChat(teamId?: string) {
  if (!teamId) {
    const root = useProject.getState().root
    if (!root) { notify.info("Abrí una carpeta para usar el modo equipo"); return }
    const state = useAgent.getState()
    const { model } = state
    const variant = selectedVariant(state) ?? null
    const chat = await teamCall<TeamChatRecord>("team_chats_auto", { projectRoot: root, model: { ...model }, variant })
    if (chat) selectTeamChat(chat.id)
    return
  }
  const chat = await teamCall<TeamChatRecord>("team_chats_create", { teamId })
  if (chat) selectTeamChat(chat.id)
}
export async function deleteTeam(team: Team) {
  if (await confirmAction("Eliminar equipo", `Se elimina la plantilla «${team.name}». Sus chats y evidencias se conservan.`, "Eliminar", true)) await teamCall("teams_delete", { id: team.id })
}
export async function duplicateTeam(team: Team) {
  const name = await promptInput({ title: "Duplicar equipo", value: `${team.name} · copia` })
  if (name?.trim()) {
    const saved = await teamCall<Team>("teams_save", { team: { ...team, id: "", name } })
    if (saved) openTeam(saved.id)
  }
}
export async function renameChat(chat: TeamChatRecord) {
  const title = await promptInput({ title: "Renombrar chat de equipo", value: chat.title })
  if (title?.trim()) await teamCall("team_chats_edit", { id: chat.id, title, archived: chat.archived })
}
export async function saveSkill(skill: Skill) { return teamCall<Skill>("team_skills_save", { skill }) }
