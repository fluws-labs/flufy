import { create } from "zustand"
import { call, errorMessage, isTauri, onEvent } from "../lib/tauri"
import { loadAgentMissions } from "./agentProfile"

export type BotCapabilities = {
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
  control: string
  color?: string | null
  createdAt: number
  updatedAt: number
}

export type BotControlAction = "play" | "pause" | "resume" | "off"

type BotsState = {
  bots: Bot[]
  loaded: boolean
  loading: boolean
  error: string | null
  saving: string | null
  controlling: string | null
  load: () => Promise<void>
  save: (bot: Partial<Bot>) => Promise<Bot | null>
  control: (id: string, action: BotControlAction) => Promise<Bot | null>
}

let started = false

export const useBots = create<BotsState>((set, get) => ({
  bots: [],
  loaded: false,
  loading: false,
  error: null,
  saving: null,
  controlling: null,
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
  control: async (id, action) => {
    if (!isTauri) return null
    set({ controlling: id, error: null })
    try {
      const saved = await call<Bot>("agent_bot_control", { id, action })
      await Promise.all([get().load(), loadAgentMissions()])
      set({ controlling: null })
      return saved
    } catch (error) {
      set({ controlling: null, error: errorMessage(error) })
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
