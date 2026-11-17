import { api } from "../lib/opencode"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { isMainWindow } from "../lib/windows"
import { isTeamSession } from "../team/session-index"
import type { TeamChatRecord } from "../team/types"
import { splitForSpeech } from "../pwa/stream-speech"
import { enqueue, primeAudio, stop } from "../pwa/voice-player"
import { assistantVoiceText, teamVoiceText, type VoiceCommand } from "../lib/voice-text"
import { subscribeSessionFinished, useAgent, type ChatMessage } from "./agent"
import { openEditor } from "./editors"
import { patchSessionRuntime, sessionRuntime } from "./session-runtime"
import { notify } from "./toasts"

type SpeechView = {
  available: boolean
  ready: boolean
  enabled: boolean
  voice: string
  speed: number
  worker: boolean
}

let started = false
let generation = 0

export function startAutoSpeech(): void {
  if (started || !isTauri) return
  started = true
  // La lectura corre solo en la ventana principal: las demás comparten el
  // mismo motor y leerían la misma respuesta por duplicado.
  subscribeSessionFinished((sessionID) => {
    void speakSession(sessionID)
  })
}

export function autoSpeechOn(key: string): boolean {
  return sessionRuntime(key).autoSpeech === true
}

export async function applyVoiceCommand(key: string, command: VoiceCommand): Promise<boolean> {
  if (command === "invalid") {
    notify.info("Comando /tts", "Usá /tts para activar o desactivar, /tts on o /tts off.")
    return false
  }
  const next = command === "toggle" ? !autoSpeechOn(key) : command === "on"
  return setAutoSpeech(key, next)
}

export async function setAutoSpeech(key: string, next: boolean): Promise<boolean> {
  if (!next) {
    patchSessionRuntime(key, { autoSpeech: false })
    generation += 1
    stop()
    return true
  }
  try {
    const view = await call<SpeechView>("speech_get")
    if (!view.available) {
      notify.error("El motor de voz no está instalado", "Actualizá Flufy para incluir Piper y volvé a intentar.")
      return false
    }
    if (!view.ready) {
      openEditor({ kind: "remote" })
      notify.info("Falta descargar la voz", "En «Voz y audios» elegí una voz y descargala; después volvé a tocar Voz.")
      return false
    }
    if (!view.enabled) {
      await call("speech_set", { enabled: true, voice: view.voice, speed: view.speed, worker: view.worker })
    }
    // El click es el gesto que habilita el audio del WebView para la lectura
    // que va a empezar más tarde, cuando el agente termine.
    primeAudio()
    patchSessionRuntime(key, { autoSpeech: true })
    return true
  } catch (e) {
    notify.error("No se pudo activar la voz", errorMessage(e))
    return false
  }
}

async function speakSession(sessionID: string): Promise<void> {
  if (!isMainWindow() || isTeamSession(sessionID) || !autoSpeechOn(sessionID)) return
  const text = await lastAssistantText(sessionID)
  if (text) await speak(`session:${sessionID}`, text)
}

/** Se llama cuando el Lead cierra una ejecución de equipo. */
export async function speakTeamRun(chat: TeamChatRecord, runId: string): Promise<void> {
  if (!isMainWindow() || !autoSpeechOn(`team:${chat.id}`)) return
  const run = chat.runs.find((item) => item.id === runId) ?? chat.runs.at(-1)
  if (!run) return
  await speak(`team:${chat.id}:${run.id}`, teamVoiceText(chat.team.name, run))
}

async function lastAssistantText(sessionID: string): Promise<string> {
  // `session.idle` puede adelantarse al último delta y al commit del motor.
  // La vista ya tiene el texto del stream; se le da un turno para asentarse.
  await new Promise((resolve) => setTimeout(resolve, 150))
  const view = useAgent.getState().views[sessionID]
  const fromView = view ? assistantVoiceText(view.messages) : ""
  if (fromView) return fromView
  // Si la conversación no está abierta, se consulta la API.
  try {
    const messages = await api<ChatMessage[]>("GET", `/session/${sessionID}/message`, undefined, { limit: "12" })
    return assistantVoiceText(messages)
  } catch {
    return ""
  }
}

async function speak(key: string, text: string): Promise<void> {
  const segments = splitForSpeech(text).map((segment) => segment.trim()).filter(Boolean)
  if (!segments.length) return
  // Una lectura nueva reemplaza a la anterior; los segmentos que ya estaban en
  // camino dejan de encolarse para no mezclar dos respuestas.
  const token = ++generation
  stop()
  for (let index = 0; index < segments.length; index += 1) {
    if (token !== generation) return
    try {
      const encoded = await call<string>("speech_test", { text: segments[index] })
      if (token !== generation) return
      enqueue(`auto:${key}:${index}`, wavBlob(encoded))
    } catch (e) {
      if (token === generation) notify.error("No se pudo leer la respuesta", errorMessage(e))
      return
    }
  }
}

function wavBlob(encoded: string): Blob {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: "audio/wav" })
}
