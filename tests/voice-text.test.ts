import assert from "node:assert/strict"
import { test } from "node:test"
import { assistantVoiceText, parseVoiceCommand, teamVoiceText } from "../src/lib/voice-text.ts"

test("/tts activa, desactiva o alterna sin mandar el texto al agente", () => {
  assert.equal(parseVoiceCommand("/tts"), "toggle")
  assert.equal(parseVoiceCommand("  /TTS  "), "toggle")
  assert.equal(parseVoiceCommand("/tts on"), "on")
  assert.equal(parseVoiceCommand("/tts sí"), "on")
  assert.equal(parseVoiceCommand("/tts off"), "off")
  assert.equal(parseVoiceCommand("/tts desactivar"), "off")
  assert.equal(parseVoiceCommand("/tts mañana"), "invalid")
  assert.equal(parseVoiceCommand("/ttsx"), null)
  assert.equal(parseVoiceCommand("leé esto /tts"), null)
})

test("lee la última respuesta del asistente y descarta partes sintéticas", () => {
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "Arreglá el login" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "Primera respuesta." }] },
    { info: { role: "assistant" }, parts: [{ type: "tool", text: "no se lee" }] },
    { info: { role: "assistant" }, parts: [
      { type: "text", text: "Listo: corregí la validación." },
      { type: "text", text: "Agregué una prueba.", synthetic: true },
      { type: "text", text: "Quedó probado." },
    ] },
  ]
  assert.equal(assistantVoiceText(messages), "Listo: corregí la validación.\n\nQuedó probado.")
  assert.equal(assistantVoiceText([]), "")
})

test("elige la respuesta más nueva aunque la lista venga al revés", () => {
  const messages = [
    { info: { role: "assistant", time: { created: 30 } }, parts: [{ type: "text", text: "La última respuesta." }] },
    { info: { role: "assistant", time: { created: 10 } }, parts: [{ type: "text", text: "La respuesta vieja." }] },
  ]
  assert.equal(assistantVoiceText(messages), "La última respuesta.")
})

test("el resumen del equipo nombra al equipo y lo que falta", () => {
  assert.equal(
    teamVoiceText("Revisión", { chatSummary: { done: "Corregimos el login.", tested: "Pasaron las pruebas.", pending: "Probar en el celular." } }),
    "Revisión: terminamos. Corregimos el login. Pasaron las pruebas. Falta: Probar en el celular.",
  )
  assert.equal(
    teamVoiceText("", { summary: "La ejecución se detuvo." }),
    "Equipo: terminamos. La ejecución se detuvo.",
  )
})
