import { useEffect, useMemo, useRef, useState } from "react"
import { speechNoteAudio, speechSegmentAudio, wavDurationMs, type VoiceNoteMeta } from "./api"
import { splitForSpeech } from "./stream-speech"
import { Icon } from "./ui"
import { enqueue, playbackToken, playNow, primeAudio, stop, useVoicePlayer } from "./voice-player"

function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

function barsFor(seed: string): number[] {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619)
  return Array.from({ length: 26 }, (_, i) => {
    hash = Math.imul(hash ^ (i + 17), 16777619)
    return 24 + (Math.abs(hash) % 68)
  })
}

export function VoiceNote({
  session,
  part,
  text,
  mine = false,
  meta,
  enabled,
}: {
  session: string
  part: string
  text?: string
  mine?: boolean
  meta?: VoiceNoteMeta
  enabled: boolean
}) {
  const player = useVoicePlayer()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [durations, setDurations] = useState<number[]>(meta?.durations ?? [])
  const [count, setCount] = useState(meta?.segments ?? 0)
  const run = useRef(0)
  const key = `${session}:${part}`
  const prefix = `${key}:`
  const playingKey = player.key ? (mine ? (player.key === key ? key : null) : player.key.startsWith(prefix) ? player.key : null) : null
  const playing = !!playingKey
  const index = !mine && playingKey ? Number(playingKey.slice(prefix.length)) : -1
  const total = mine ? (meta?.durationMs ?? player.durationMs) : durations.reduce((sum, value) => sum + (value || 0), 0)
  const position = mine
    ? playing
      ? player.positionMs
      : 0
    : index >= 0
      ? durations.slice(0, index).reduce((sum, value) => sum + (value || 0), 0) + Math.min(player.positionMs, durations[index] ?? player.durationMs)
      : 0
  const progress = total > 0 ? Math.min(1, position / total) : 0
  const loading = busy || (mine ? player.loadingKey === key : !!player.loadingKey?.startsWith(prefix))
  const bars = useMemo(() => barsFor(part), [part])

  useEffect(() => {
    if (!mine && meta) {
      setDurations(meta.durations ?? [])
      setCount(meta.segments ?? 0)
    }
  }, [mine, meta?.segments, meta?.durations])

  useEffect(() => {
    return () => {
      run.current += 1
    }
  }, [])

  if (!mine && !meta && !enabled) return null
  if (!mine && !meta && !text?.trim()) return null

  const playUserNote = async (token: number) => {
    const audio = await speechNoteAudio(session, part)
    if (run.current !== token) return
    const ms = await wavDurationMs(audio)
    if (ms > 0 && meta) {
      setDurations([ms])
      setCount(1)
    }
    await playNow(key, audio)
  }

  const playSegments = async (token: number) => {
    const items = splitForSpeech(text ?? "")
    const totalSegments = Math.max(count, items.length)
    if (!totalSegments) throw new Error("Este bloque no tiene texto para leer")
    // Se corta lo que estuviera sonando y se reconstruye la respuesta completa
    // segmento por segmento, reutilizando lo que ya está sintetizado.
    stop()
    const playback = playbackToken()
    const known = [...durations]
    for (let i = 0; i < totalSegments; i++) {
      if (run.current !== token || playbackToken() !== playback) return
      let audio: Blob
      try {
        audio = await speechSegmentAudio(session, part, i)
      } catch (e) {
        const fallback = items[i] ?? text
        if (!fallback) throw e
        audio = await speechSegmentAudio(session, part, i, fallback)
      }
      if (run.current !== token || playbackToken() !== playback) return
      const ms = await wavDurationMs(audio)
      if (ms > 0) {
        known[i] = ms
        setDurations([...known])
        setCount((current) => Math.max(current, i + 1))
      }
      enqueue(`${key}:${i}`, audio)
    }
  }

  const toggle = async () => {
    primeAudio()
    if (playing) {
      run.current += 1
      stop()
      return
    }
    const token = ++run.current
    setBusy(true)
    setError(null)
    try {
      if (mine) await playUserNote(token)
      else await playSegments(token)
    } catch (e) {
      if (run.current === token) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (run.current === token) setBusy(false)
    }
  }

  return (
    <div className={`voice-note${mine ? " mine" : ""}${playing ? " playing" : ""}`}>
      <button type="button" className="vn-play" onClick={() => void toggle()} disabled={loading} aria-label={playing ? "Detener audio" : "Reproducir audio"}>
        <Icon name={loading ? "loading" : playing ? "stop" : "play"} spin={loading} />
      </button>
      <button type="button" className="vn-bars" onClick={() => void toggle()} aria-label={playing ? "Detener audio" : "Reproducir audio"}>
        {bars.map((height, i) => (
          <span key={i} className={`vn-bar${(i + 1) / bars.length <= progress ? " on" : ""}`} style={{ height: `${height}%` }} />
        ))}
      </button>
      <span className="vn-time">{clock(playing ? position : total)}</span>
      {error && (
        <span className="vn-error" title={error}>
          <Icon name="warning" />
        </span>
      )}
    </div>
  )
}
