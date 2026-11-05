// Reproductor de notas de voz del PWA. Web Audio permite arrancar el audio
// después de un gesto (el tap del micrófono), encadenar notas y medir el
// progreso sin depender de las reglas de autoplay de <audio> en iOS.

import { useEffect, useState } from "react"

export type PlayerSnapshot = {
  key: string | null
  playing: boolean
  positionMs: number
  durationMs: number
  loadingKey: string | null
}

type QueueItem = { key: string; blob: Blob }

type Active = { key: string; startedAt: number; duration: number; rate: number }

const listeners = new Set<() => void>()
const buffers = new Map<string, AudioBuffer>()
const MAX_BUFFERS = 40

let ctx: AudioContext | null = null
let source: AudioBufferSourceNode | null = null
let active: Active | null = null
let loadingKey: string | null = null
let queue: QueueItem[] = []
let generation = 0
// Cambia cuando una persona toma el control (stop o replay manual); permite
// que un bucle de segmentos viejo deje de encolar audio.
let playback = 0
let ticker: ReturnType<typeof setInterval> | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function context(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor()
  return ctx
}

function stopTicker(): void {
  if (ticker) window.clearInterval(ticker)
  ticker = null
}

function startTicker(): void {
  stopTicker()
  ticker = window.setInterval(emit, 200)
}

export function primeAudio(): void {
  const audio = context()
  if (!audio) return
  if (audio.state === "suspended") void audio.resume().catch(() => undefined)
  try {
    const silent = audio.createBuffer(1, 1, audio.sampleRate)
    const node = audio.createBufferSource()
    node.buffer = silent
    node.connect(audio.destination)
    node.start()
  } catch {
    /* sin audio disponible */
  }
}

async function decode(key: string, blob: Blob, audio: AudioContext): Promise<AudioBuffer> {
  const cached = buffers.get(key)
  if (cached) return cached
  const decoded = await audio.decodeAudioData(await blob.arrayBuffer())
  buffers.set(key, decoded)
  if (buffers.size > MAX_BUFFERS) {
    const oldest = buffers.keys().next().value
    if (oldest !== undefined) buffers.delete(oldest)
  }
  return decoded
}

function stopSource(): void {
  if (source) {
    source.onended = null
    try {
      source.stop()
    } catch {
      /* ya terminó */
    }
    source.disconnect()
    source = null
  }
}

async function play(key: string, blob: Blob, rate = 1): Promise<void> {
  const audio = context()
  if (!audio) throw new Error("Este navegador no puede reproducir audio")
  generation += 1
  const token = generation
  stopSource()
  active = null
  loadingKey = key
  emit()
  try {
    if (audio.state === "suspended") await audio.resume()
    const buffer = await decode(key, blob, audio)
    if (token !== generation) return
    const node = audio.createBufferSource()
    node.buffer = buffer
    node.playbackRate.value = rate
    node.connect(audio.destination)
    node.onended = () => {
      if (token !== generation) return
      source = null
      active = null
      stopTicker()
      emit()
      void next()
    }
    source = node
    active = { key, startedAt: audio.currentTime, duration: buffer.duration, rate }
    loadingKey = null
    node.start()
    startTicker()
    emit()
  } catch (e) {
    if (token === generation) {
      loadingKey = null
      emit()
    }
    throw e
  }
}

async function next(): Promise<void> {
  if (active || loadingKey) return
  const item = queue.shift()
  if (!item) return
  try {
    await play(item.key, item.blob)
  } catch {
    loadingKey = null
    emit()
    void next()
  }
}

export function enqueue(key: string, blob: Blob): void {
  queue.push({ key, blob })
  if (!active && !loadingKey) void next()
}

export function playNow(key: string, blob: Blob): Promise<void> {
  playback += 1
  queue = []
  return play(key, blob)
}

export function playbackToken(): number {
  return playback
}

export function stop(): void {
  playback += 1
  generation += 1
  queue = []
  stopSource()
  active = null
  loadingKey = null
  stopTicker()
  emit()
}

export function isPlaying(key: string): boolean {
  return active?.key === key
}

export function snapshot(): PlayerSnapshot {
  const audio = ctx
  const position = active && audio ? Math.min(active.duration, Math.max(0, audio.currentTime - active.startedAt) * active.rate) : 0
  return {
    key: active?.key ?? null,
    playing: !!active,
    positionMs: Math.round(position * 1000),
    durationMs: Math.round((active?.duration ?? 0) * 1000),
    loadingKey,
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useVoicePlayer(): PlayerSnapshot {
  const [state, setState] = useState<PlayerSnapshot>(() => snapshot())
  useEffect(() => {
    setState(snapshot())
    return subscribe(() => setState(snapshot()))
  }, [])
  return state
}
