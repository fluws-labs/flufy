import type { ChatSummary } from "./team-response"

export type VoiceCommand = "toggle" | "on" | "off" | "invalid"

const ON = new Set(["on", "si", "sí", "true", "activar", "activá", "activarla"])
const OFF = new Set(["off", "no", "false", "desactivar", "desactivá", "silenciar"])

/** Interpreta el comando /tts sin mandarlo al agente. */
export function parseVoiceCommand(text: string): VoiceCommand | null {
  const match = text.trim().match(/^\/tts(?:\s+(.+))?$/i)
  if (!match) return null
  const arg = match[1]?.trim().toLowerCase()
  if (!arg) return "toggle"
  if (ON.has(arg)) return "on"
  if (OFF.has(arg)) return "off"
  return "invalid"
}

type SpeechPart = { type?: string; text?: string; synthetic?: boolean }
type SpeechMessage = { info?: { role?: string; time?: { created?: number } }; parts?: SpeechPart[] }

/** Texto de la última respuesta del asistente, sin partes sintéticas. */
export function assistantVoiceText(messages: SpeechMessage[]): string {
  const ordered = [...messages].sort(
    (a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0),
  )
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index]
    if (message?.info?.role !== "assistant") continue
    const text = (message.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string" && !part.synthetic)
      .map((part) => (part.text ?? "").trim())
      .filter(Boolean)
      .join("\n\n")
    if (text) return text
  }
  return ""
}

type TeamRunLike = {
  status?: string
  chatSummary?: ChatSummary | null
  summary?: string | null
}

/** Resumen hablado cuando termina una ejecución de equipo. */
export function teamVoiceText(teamName: string, run: TeamRunLike): string {
  const summary = run.chatSummary
  const body = [summary?.done, summary?.tested, summary?.pending ? `Falta: ${summary.pending}` : ""]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .trim()
  const fallback = (run.summary ?? "").trim() || "La entrega está lista para revisar."
  return `${teamName.trim() || "Equipo"}: terminamos. ${body || fallback}`
}
