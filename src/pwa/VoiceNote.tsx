import { useEffect, useMemo, useState } from "react"
import { speechNoteAudio, wavDurationMs, type VoiceNoteMeta } from "./api"
import { Icon } from "./ui"
import { playNow, primeAudio, stop, useVoicePlayer } from "./voice-player"

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
  onMeta,
}: {
  session: string
  part: string
  text?: string
  mine?: boolean
  meta?: VoiceNoteMeta
  enabled: boolean
  onMeta?: (part: string, durationMs: number) => void
}) {
  const player = useVoicePlayer()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duration, setDuration] = useState(meta?.durationMs ?? 0)
  const key = `${session}:${part}`
  const current = player.key === key
  const playing = current && player.playing
  const loading = busy || player.loadingKey === key
  const progress = current && player.durationMs > 0 ? Math.min(1, player.positionMs / player.durationMs) : 0
  const bars = useMemo(() => barsFor(part), [part])

  useEffect(() => {
    setDuration(meta?.durationMs ?? 0)
  }, [meta?.durationMs])

  if (!mine && !meta && !enabled) return null
  if (!mine && !meta && !text?.trim()) return null

  const load = async (): Promise<Blob> => {
    if (meta || mine) {
      try {
        return await speechNoteAudio(session, part)
      } catch (e) {
        if (mine || !text?.trim()) throw e
      }
    }
    return speechNoteAudio(session, part, text)
  }

  const toggle = async () => {
    primeAudio()
    if (playing) {
      stop()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const audio = await load()
      const ms = await wavDurationMs(audio)
      if (ms > 0) {
        setDuration(ms)
        onMeta?.(part, ms)
      }
      await playNow(key, audio)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`voice-note${mine ? " mine" : ""}${current ? " playing" : ""}`}>
      <button type="button" className="vn-play" onClick={() => void toggle()} disabled={loading} aria-label={playing ? "Detener audio" : "Reproducir audio"}>
        <Icon name={loading ? "loading" : playing ? "stop" : "play"} spin={loading} />
      </button>
      <button type="button" className="vn-bars" onClick={() => void toggle()} aria-label={playing ? "Detener audio" : "Reproducir audio"}>
        {bars.map((height, i) => (
          <span key={i} className={`vn-bar${(i + 1) / bars.length <= progress ? " on" : ""}`} style={{ height: `${height}%` }} />
        ))}
      </button>
      <span className="vn-time">{clock(playing ? player.positionMs : duration)}</span>
      {error && (
        <span className="vn-error" title={error}>
          <Icon name="warning" />
        </span>
      )}
    </div>
  )
}
