import { create } from "zustand"
import { loadJson, saveJson } from "../lib/persist"

export type StudioMode = "design" | "team" | "research" | "code"
export type StudioLayout = { sidebarCollapsed: boolean; inspectorCollapsed: boolean; chatExpanded: boolean }

const MODES: StudioMode[] = ["design", "team", "research", "code"]
const saved = loadJson<StudioMode>("studio.mode", "research")
const savedLayouts = loadJson<Partial<Record<StudioMode, Partial<StudioLayout>>>>("studio.layouts", {})
const compact = typeof window !== "undefined" && window.innerWidth < 900

const layouts = Object.fromEntries(MODES.map(mode => [mode, {
  sidebarCollapsed: savedLayouts[mode]?.sidebarCollapsed ?? compact,
  inspectorCollapsed: savedLayouts[mode]?.inspectorCollapsed ?? false,
  chatExpanded: savedLayouts[mode]?.chatExpanded ?? false,
}])) as Record<StudioMode, StudioLayout>

export const useStudio = create<{
  mode: StudioMode
  readOnly: boolean
  teamRequest: { chatId: string } | null
  layouts: Record<StudioMode, StudioLayout>
  setMode: (mode: StudioMode) => void
  setReadOnly: (readOnly: boolean) => void
  setLayout: (mode: StudioMode, patch: Partial<StudioLayout>) => void
}>((set) => ({
  teamRequest: null,
  readOnly: loadJson<unknown>("studio.readOnly", false) === true,
  setReadOnly: readOnly => { saveJson("studio.readOnly", readOnly); set({ readOnly }) },
  mode: MODES.includes(saved) ? saved : "research",
  layouts,
  setMode: mode => { saveJson("studio.mode", mode); set({ mode }) },
  setLayout: (mode, patch) => set(state => {
    const layouts = { ...state.layouts, [mode]: { ...state.layouts[mode], ...patch } }
    saveJson("studio.layouts", layouts)
    return { layouts }
  }),
}))
