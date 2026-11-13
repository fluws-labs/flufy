import type { StudioMode } from "./studioModes"

export type ModePresetId =
  | "balanced"
  | "agent"
  | "code"
  | "review"
  | "design-chat"
  | "design-canvas"
  | "team-context"
  | "team-board"
  | "research-sources"
  | "research-chat"

export type ModePreset = { id: ModePresetId; label: string; icon: string }

export const MODE_PRESETS: Record<StudioMode, ModePreset[]> = {
  code: [
    { id: "balanced", label: "Equilibrado: código + agente", icon: "layout" },
    { id: "agent", label: "Foco en el agente", icon: "hubot" },
    { id: "code", label: "Foco en el código", icon: "code" },
    { id: "review", label: "Revisión (git + agente)", icon: "diff-multiple" },
  ],
  design: [
    { id: "design-chat", label: "Lienzo + chat", icon: "comment-discussion" },
    { id: "design-canvas", label: "Solo lienzo", icon: "paintcan" },
  ],
  team: [
    { id: "team-context", label: "Tablero + contexto", icon: "layout" },
    { id: "team-board", label: "Solo tablero", icon: "checklist" },
  ],
  research: [
    { id: "research-sources", label: "Chat + fuentes", icon: "comment-discussion" },
    { id: "research-chat", label: "Solo conversación", icon: "screen-full" },
  ],
}

const CODE_PRESETS: readonly ModePresetId[] = ["balanced", "agent", "code", "review"]

export const isCodePreset = (id: ModePresetId): id is "balanced" | "agent" | "code" | "review" => CODE_PRESETS.includes(id)
