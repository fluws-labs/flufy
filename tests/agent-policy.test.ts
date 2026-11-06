import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { FlufyPolicy } from "../src-tauri/src/agent_policy.js"

async function withConfig(config, run) {
  const previous = process.env.OPENCODE_CONFIG_CONTENT
  try {
    if (config === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = config
    await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = previous
  }
}

const guillecodeConfig = JSON.stringify({ mcp: {
  terminal: { url: "http://127.0.0.1:12345/mcp/terminal" },
  worktrees: { url: "http://127.0.0.1:12345/mcp/worktrees" },
} })

test("las sesiones de equipos conservan su política específica", async () => {
  await withConfig(guillecodeConfig, async () => {
    const plugin = await FlufyPolicy()
    const output = { system: ["[GUILLECODE_TEAM_RUN] El Lead coordina tareas"] }
    await plugin["experimental.chat.system.transform"]({}, output)
    assert.equal(output.system.length, 1)
  })
})

test("la política global no altera motores ajenos a Flufy", async () => {
  for (const config of [undefined, "invalid", "null", "{}", JSON.stringify({ mcp: { terminal: { url: "https://example.com" } } })]) {
    await withConfig(config, async () => assert.deepEqual(await FlufyPolicy(), {}))
  }
})

test("inyecta una sola política sin depender de memoria ni modificar instrucciones existentes", async () => {
  await withConfig(guillecodeConfig, async () => {
    const first = await FlufyPolicy()
    const second = await FlufyPolicy()
    const output = { system: ["Instrucciones del modelo", "Requisitos del proyecto"] }
    await first["experimental.chat.system.transform"]({ sessionID: "session-with-memory-off" }, output)
    await second["experimental.chat.system.transform"]({ sessionID: "session-with-memory-off" }, output)
    assert.equal(output.system.length, 3)
    assert.deepEqual(output.system.slice(0, 2), ["Instrucciones del modelo", "Requisitos del proyecto"])
    assert.ok(output.system[2].startsWith("# Flufy: directo al objetivo"))
    assert.match(output.system[2], /Elegir cómo resolver el trabajo/)
    assert.match(output.system[2], /Con un equipo/)
    assert.match(output.system[2], /En este chat/)
    assert.match(output.system[2], /teams_delegate/)
    assertLocalExecution(output.system[2])

    const next = { system: ["Otro modelo"] }
    await first["experimental.chat.system.transform"]({}, next)
    assert.equal(next.system.length, 2)
  })
})

function assertLocalExecution(policy: string) {
  for (const requirement of [
    /prepará las dependencias y la configuración necesarias/,
    /flujo normal documentado del proyecto/,
    /terminal integrada para servidores y procesos persistentes/,
    /app o navegador y servicios necesarios/,
    /sin duplicar ni detener procesos del usuario/,
    /sistema aislado solo si el usuario lo pide explícitamente/,
    /worktree separa archivos de desarrollo, no exige aislar la ejecución/,
    /navegador interno de equipo mantiene su separación de sesiones/,
    /datos de prueba autorizados/,
  ]) assert.match(policy, requirement)
}

test("equipos reciben la ejecución local natural en todos los modos operativos sin ampliar permisos", () => {
  const capabilities = readFileSync(new URL("../src-tauri/src/teams/capabilities.rs", import.meta.url), "utf8")
  assertLocalExecution(capabilities)
  assert.match(capabilities, /let scope = format!\("\{\}\\n\{\}", scope, LOCAL_EXECUTION\)/)
  assert.match(capabilities, /trabajador con bash autorizado/)
  assert.match(capabilities, /sesiones de conversación, planificación y revisión conservan sus restricciones/)
  const runner = readFileSync(new URL("../src-tauri/src/teams/runner.rs", import.meta.url), "utf8")
  assert.match(runner, /super::capabilities::instructions\(mode\)/)
})
