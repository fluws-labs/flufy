import { create } from "zustand"
import { loadJson, saveJson } from "../lib/persist"

export type StudioMode = "design" | "team" | "research" | "code"
const saved = loadJson<StudioMode>("studio.mode", "research")
export const useStudio = create<{ mode: StudioMode; teamRequest: { chatId: string } | null; setMode: (mode: StudioMode) => void }>((set) => ({
  teamRequest: null,
  mode: ["design", "team", "research", "code"].includes(saved) ? saved : "research",
  setMode: mode => { saveJson("studio.mode", mode); set({ mode }) },
}))
