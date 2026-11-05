import assert from "node:assert/strict"
import { test } from "node:test"
import { SpeechStream, splitForSpeech } from "../src/pwa/stream-speech.ts"

function collect(chunks: string[]): string[] {
  const out: string[] = []
  const stream = new SpeechStream((segment) => out.push(segment.text))
  for (const chunk of chunks) stream.push(chunk)
  stream.flush()
  return out
}

test("divide respuestas largas en frases listas para sintetizar", () => {
  const out = collect([
    "Ya delegué la revisión completa del proyecto a un subagente. ",
    "Te aviso cuando termine y te cuento cómo quedó. ",
    "Mientras tanto, dejé el detalle técnico en pantalla.",
  ])
  assert.deepEqual(out, [
    "Ya delegué la revisión completa del proyecto a un subagente.",
    "Te aviso cuando termine y te cuento cómo quedó.",
    "Mientras tanto, dejé el detalle técnico en pantalla.",
  ])
})

test("descarta bloques de código aunque lleguen partidos", () => {
  const out = collect(["Listo. ```js\nconst x", " = 1\n``` Quedó corregido y probado."])
  assert.equal(out.join(" ").includes("const x"), false)
  assert.equal(out.join(" ").includes("```"), false)
  assert.equal(out.join(" ").includes("Quedó corregido y probado."), true)
})

test("no corta abreviaturas ni decimales", () => {
  assert.deepEqual(collect(["El Dr. Pérez revisó el proyecto completo y quedó listo."]), ["El Dr. Pérez revisó el proyecto completo y quedó listo."])
  assert.deepEqual(collect(["La versión 3.14 quedó lista y probada."]), ["La versión 3.14 quedó lista y probada."])
})

test("parte un texto sin puntuación que supera el máximo", () => {
  const out = splitForSpeech("palabra ".repeat(120))
  assert.ok(out.length > 1, `debería dividir: ${out.length}`)
  assert.ok(out.every((part) => part.length <= 340), "ningún segmento debería ser enorme")
  assert.equal(out.join(" ").includes("palabra palabra"), true)
})

test("flush emite el final corto", () => {
  assert.deepEqual(collect(["Un cierre corto"]), ["Un cierre corto"])
})
