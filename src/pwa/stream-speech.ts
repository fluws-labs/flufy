// Divide una respuesta que todavía se está generando en frases listas para
// sintetizar. La idea es que el audio arranque con la primera frase mientras el
// modelo sigue escribiendo, en vez de esperar el bloque completo.
//
// El filtro de bloques de código vive acá porque los deltas pueden cortar un
// ``` al medio: si se mandara el texto crudo, el sanitizador del servidor
// podría leer media cerca de código como si fuera prosa.

export type SpeechSegment = { index: number; text: string }

const MIN_CHARS = 24
const MAX_CHARS = 320
const IDLE_MS = 1100

const ABBREVIATIONS = new Set([
  "sr",
  "sra",
  "srta",
  "dr",
  "dra",
  "lic",
  "ing",
  "prof",
  "etc",
  "vs",
  "nro",
  "núm",
  "av",
  "p",
  "ej",
  "uds",
  "ud",
  "ee",
  "uu",
  "aprox",
  "pág",
])

export class SpeechStream {
  private raw = ""
  private prose = ""
  private fenced = false
  private index = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly onSegment: (segment: SpeechSegment) => void

  constructor(onSegment: (segment: SpeechSegment) => void) {
    this.onSegment = onSegment
  }

  push(delta: string): void {
    if (this.closed || !delta) return
    this.raw += delta
    this.clean(false)
    this.drain()
    this.arm()
  }

  /** Cierra la parte: emite lo que quedó pendiente, aunque sea corto. */
  flush(): void {
    if (this.closed) return
    this.disarm()
    this.clean(true)
    this.emitTail()
    this.closed = true
  }

  stop(): void {
    this.closed = true
    this.disarm()
    this.raw = ""
    this.prose = ""
  }

  private arm(): void {
    this.disarm()
    this.timer = globalThis.setTimeout(() => {
      this.timer = null
      if (this.closed) return
      // Una pausa del modelo no debe dejar al usuario en silencio: se manda lo
      // que haya aunque no termine en puntuación.
      const text = this.prose
      this.prose = ""
      this.emit(text)
    }, IDLE_MS) as ReturnType<typeof setTimeout>
  }

  private disarm(): void {
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private clean(final: boolean): void {
    for (;;) {
      if (this.fenced) {
        const close = this.raw.indexOf("```")
        if (close < 0) {
          if (final) {
            this.raw = ""
          } else {
            // Conservar un posible cierre partido entre dos deltas.
            this.raw = this.raw.slice(-2)
          }
          return
        }
        this.raw = this.raw.slice(close + 3)
        this.fenced = false
        continue
      }
      const open = this.raw.indexOf("```")
      if (open < 0) {
        const hold = final ? "" : (this.raw.match(/`{1,2}$/)?.[0] ?? "")
        this.prose += this.raw.slice(0, this.raw.length - hold.length)
        this.raw = hold
        return
      }
      this.prose += this.raw.slice(0, open)
      this.raw = this.raw.slice(open + 3)
      this.fenced = true
    }
  }

  private drain(): void {
    for (;;) {
      const cut = this.boundary(this.prose, false)
      if (cut <= 0) return
      const text = this.prose.slice(0, cut)
      this.prose = this.prose.slice(cut)
      this.emit(text)
    }
  }

  private emitTail(): void {
    let text = this.prose
    this.prose = ""
    while (text.trim()) {
      if (text.length <= MAX_CHARS) {
        this.emit(text)
        return
      }
      const cut = this.splitPoint(text, MAX_CHARS)
      this.emit(text.slice(0, cut))
      text = text.slice(cut)
    }
  }

  private boundary(text: string, final: boolean): number {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (ch === "\n" && text[i + 1] === "\n") return i + 2
      if (!".!?…".includes(ch)) continue
      const next = text[i + 1]
      if (next && !/\s/.test(next)) continue
      if (ch === "." && this.abbreviation(text.slice(0, i))) continue
      if (i + 1 < MIN_CHARS && !final) continue
      return i + 1
    }
    if (text.length > MAX_CHARS) return this.splitPoint(text, MAX_CHARS)
    return -1
  }

  private splitPoint(text: string, max: number): number {
    const window = text.slice(0, max)
    const at = Math.max(window.lastIndexOf(". "), window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" "))
    return at > max / 2 ? at + 1 : max
  }

  private abbreviation(prefix: string): boolean {
    const word = prefix.match(/([\p{L}.]+)$/u)?.[1]?.replace(/\.$/, "").toLowerCase()
    return !!word && ABBREVIATIONS.has(word)
  }

  private emit(text: string): void {
    const clean = text.replace(/\s+/g, " ").trim()
    if (!clean) return
    this.onSegment({ index: this.index++, text: clean })
  }
}

/** Divide un texto completo con las mismas reglas del streaming. */
export function splitForSpeech(text: string): string[] {
  const segments: string[] = []
  const stream = new SpeechStream((segment) => segments.push(segment.text))
  stream.push(text)
  stream.flush()
  return segments
}
