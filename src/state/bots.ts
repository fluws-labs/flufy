import { create } from "zustand"
import { call, errorMessage, isTauri, onEvent } from "../lib/tauri"

export type BotCapabilities = {
  browser: string
  desktop: boolean
  files: boolean
  terminal: boolean
}

export type Bot = {
  id: string
  name: string
  role: string
  instructions: string
  model?: { providerID: string; modelID: string } | null
  fallbackModel?: { providerID: string; modelID: string } | null
  autonomy: string
  capabilities: BotCapabilities
  enabled: boolean
  color?: string | null
  createdAt: number
  updatedAt: number
}

type BotsState = {
  bots: Bot[]
  loaded: boolean
  loading: boolean
  error: string | null
  saving: string | null
  load: () => Promise<void>
  save: (bot: Partial<Bot>) => Promise<Bot | null>
}

let started = false

export const useBots = create<BotsState>((set, get) => ({
  bots: [],
  loaded: false,
  loading: false,
  error: null,
  saving: null,
  load: async () => {
    if (!isTauri) return
    set({ loading: true, error: null })
    try {
      const bots = await call<Bot[]>("agent_bots_list")
      set({ bots: Array.isArray(bots) ? bots : [], loaded: true, loading: false })
    } catch (error) {
      set({ loading: false, error: errorMessage(error) })
    }
  },
  save: async (bot) => {
    if (!isTauri) return null
    set({ saving: bot.id ?? "new", error: null })
    try {
      const saved = await call<Bot>("agent_bot_save", { bot })
      await get().load()
      set({ saving: null })
      return saved
    } catch (error) {
      set({ saving: null, error: errorMessage(error) })
      return null
    }
  },
}))

export function startBots(): void {
  if (started || !isTauri) return
  started = true
  void useBots.getState().load()
  onEvent("agent://bots-changed", () => void useBots.getState().load())
}
