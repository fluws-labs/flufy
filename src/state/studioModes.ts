export type StudioMode = "design" | "team" | "research" | "code"

export const STUDIO_MODES: readonly StudioMode[] = ["design", "team", "research", "code"]

export const isStudioMode = (value: unknown): value is StudioMode =>
  typeof value === "string" && (STUDIO_MODES as readonly string[]).includes(value)
