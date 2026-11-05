import { useEffect, useState } from "react"
import {
  deleteSpeechVoice,
  downloadSpeechVoice,
  errorText,
  speechStatus,
  speechTest,
  speechUpdate,
  type SpeechStatus,
} from "./api"
import { Icon, Sheet, usePoll } from "./ui"
import { playNow, primeAudio } from "./voice-player"

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(bytes > 100_000_000 ? 0 : 1)} MB`
}

export function SpeechPanel({
  status,
  onStatus,
  auto,
  onAuto,
  onClose,
}: {
  status: SpeechStatus | null
  onStatus: (next: SpeechStatus) => void
  auto: boolean
  onAuto: (next: boolean) => void
  onClose: () => void
}) {
  const [speed, setSpeed] = useState(status?.speed ?? 1)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status) setSpeed(status.speed)
  }, [status?.speed])

  const downloading = !!status?.voices.some((v) => v.downloading)
  const refresh = async () => {
    try {
      onStatus(await speechStatus())
    } catch {
      /* el poll siguiente reintenta */
    }
  }
  usePoll(refresh, downloading ? 900 : null)

  useEffect(() => {
    if (status) return
    let alive = true
    const load = () => {
      speechStatus()
        .then((next) => {
          if (alive) onStatus(next)
        })
        .catch(() => undefined)
    }
    load()
    const id = window.setInterval(load, 1500)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [status, onStatus])

  const run = async (id: string, action: () => Promise<SpeechStatus>) => {
    setBusy(id)
    setError(null)
    try {
      onStatus(await action())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy("test")
    setError(null)
    try {
      primeAudio()
      await playNow(`test:${Date.now()}`, await speechTest())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const changeSpeed = (value: number) => {
    setSpeed(value)
    if (!status) return
    void speechUpdate({ speed: value }).then(onStatus).catch((e) => setError(errorText(e)))
  }

  return (
    <Sheet title="Voz de las respuestas" onClose={onClose}>
      <p className="speech-intro">
        El agente te contesta con audios que se generan en tu PC y se reproducen solos al llegar. Podés volver a escucharlos tocando la burbuja.
      </p>
      {!status ? (
        <div className="loading">
          <Icon name="loading" spin /> Leyendo la configuración…
        </div>
      ) : !status.available ? (
        <div className="alert">El motor de voz todavía no está instalado en esta PC. Actualizá Flufy y volvé a entrar.</div>
      ) : (
        <>
          <div className="speech-row">
            <span className="card-text">
              <strong>Responder con audio</strong>
              <small>{status.ready ? "Listo: hay una voz descargada" : "Elegí y descargá una voz para empezar"}</small>
            </span>
            <button
              type="button"
              className={`switch${status.enabled ? " on" : ""}`}
              aria-pressed={status.enabled}
              onClick={() => void run("enabled", () => speechUpdate({ enabled: !status.enabled }))}
            >
              <span />
            </button>
          </div>
          <div className="speech-row">
            <span className="card-text">
              <strong>Reproducir solo</strong>
              <small>Cuando llega una respuesta nueva</small>
            </span>
            <button type="button" className={`switch${auto ? " on" : ""}`} aria-pressed={auto} onClick={() => onAuto(!auto)}>
              <span />
            </button>
          </div>
          <h3 className="pick-title">Voz</h3>
          {status.voices.map((voice) => {
            const selected = voice.id === status.voice
            const percent = voice.totalBytes ? Math.min(100, (voice.bytes / voice.totalBytes) * 100) : 0
            return (
              <div key={voice.id} className={`speech-voice${selected ? " on" : ""}`}>
                <button
                  type="button"
                  className="card-main"
                  disabled={!voice.present || busy !== null}
                  onClick={() => void run(voice.id, () => speechUpdate({ voice: voice.id }))}
                >
                  <span className="card-text">
                    <strong>
                      {voice.label}
                      {selected && <Icon name="check" />}
                    </strong>
                    <small>
                      {voice.note} · {megabytes(voice.totalBytes)}
                    </small>
                    {voice.downloading && (
                      <span className="speech-progress">
                        <span className="speech-progress-track">
                          <span className="speech-progress-bar" style={{ width: `${percent}%` }} />
                        </span>
                        <small>
                          {megabytes(voice.bytes)} de {megabytes(voice.totalBytes)}
                        </small>
                      </span>
                    )}
                    {voice.error && <small className="warn-text">{voice.error}</small>}
                  </span>
                </button>
                {voice.present ? (
                  <button
                    type="button"
                    className="chip"
                    disabled={busy !== null}
                    aria-label={`Eliminar ${voice.label}`}
                    onClick={() => void run(voice.id, () => deleteSpeechVoice(voice.id))}
                  >
                    <Icon name="trash" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="chip"
                    disabled={voice.downloading || busy !== null}
                    aria-label={`Descargar ${voice.label}`}
                    onClick={() =>
                      void run(voice.id, async () => {
                        await downloadSpeechVoice(voice.id)
                        return speechUpdate({ voice: voice.id })
                      })
                    }
                  >
                    <Icon name={voice.downloading ? "loading" : "cloud-download"} spin={voice.downloading} />
                  </button>
                )}
              </div>
            )
          })}
          <span className="speech-label">Velocidad · {speed.toFixed(2)}×</span>
          <input
            className="speech-range"
            type="range"
            min={0.7}
            max={1.4}
            step={0.05}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            onPointerUp={(e) => changeSpeed(Number(e.currentTarget.value))}
            onKeyUp={(e) => changeSpeed(Number(e.currentTarget.value))}
          />
          {error && <div className="alert">{error}</div>}
          <button type="button" className="btn" disabled={!status.ready || busy !== null} onClick={() => void test()}>
            <Icon name={busy === "test" ? "loading" : "play"} spin={busy === "test"} /> Probar esta voz
          </button>
        </>
      )}
    </Sheet>
  )
}
