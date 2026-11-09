import { create } from "zustand"
import { call, errorMessage } from "../lib/tauri"
import { refreshTeams, useTeams } from "./teams"
import { notify } from "./toasts"

type Request = { resolve: (saved: boolean) => void }
export const useFallbackDialog = create<{ request: Request | null }>(() => ({ request: null }))

export function openFallbackModels(): Promise<boolean> {
  if (useFallbackDialog.getState().request) return Promise.resolve(false)
  return new Promise(resolve => useFallbackDialog.setState({ request: { resolve } }))
}

export function closeFallbackModels(saved: boolean) {
  const request = useFallbackDialog.getState().request
  useFallbackDialog.setState({ request: null })
  request?.resolve(saved)
}

export async function setContinuousMode(chatId: string, enabled: boolean) {
  await refreshTeams()
  if (useTeams.getState().error) { notify.error("Modo continuo", useTeams.getState().error!); return }
  if (enabled && !useTeams.getState().fallbackModels?.length) {
    if (!await openFallbackModels() || !useTeams.getState().fallbackModels?.length) return
  }
  try {
    await call("team_chats_continuous", { chatId, enabled })
    await refreshTeams()
  } catch (e) { notify.error("Modo continuo", errorMessage(e)) }
}

// Configuration never resumes a pending send: the user explicitly sends again.
export async function validateContinuousSend(chatId: string): Promise<boolean> {
  const chat = useTeams.getState().chats.find(chat => chat.id === chatId)
  if (!chat || chat.archived) return false
  if (!chat.continuousMode) return true
  await refreshTeams()
  const state = useTeams.getState()
  if (state.error) { notify.error("Modo continuo", state.error); return false }
  const current = state.chats.find(chat => chat.id === chatId)
  if (!current || current.archived) return false
  if (!current.continuousMode) return true
  if (state.fallbackModels?.length) return true
  if (await openFallbackModels()) notify.info("Modelos Fallback guardados", "Tu borrador se conserva. Volvé a presionar Enviar cuando quieras continuar.")
  return false
}
