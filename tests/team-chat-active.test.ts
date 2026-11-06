import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { teamChatActive } from "../src/team/chat-active.ts"
import type { RunStatus, TeamChatRecord, TeamRun } from "../src/team/types.ts"

const run = (status: RunStatus, extra: Partial<TeamRun> = {}) => ({ status, finishedAt: null, tasks: [], ...extra } as TeamRun)
const chat = (...runs: TeamRun[]) => ({ runs, messages: [] } as unknown as TeamChatRecord)
const worker = (status = "running", finishedAt: number | null = null) => ({
  status, attempts: [{ status, finishedAt, sessionId: "worker", reviewSessionId: null }],
} as TeamRun["tasks"][number])

test("planificar, guardar y detener sesiones son ejecución; otros estados no se confunden con actividad", () => {
  for (const status of ["planning", "delivering", "cancelling"] as RunStatus[]) {
    assert.equal(teamChatActive(chat(run(status))), true, status)
    assert.equal(teamChatActive(chat(run(status, { finishedAt: 42 }))), false, `${status} finalizado`)
  }
  for (const status of ["plan_ready", "planning_blocked", "completed", "awaiting_manual_qa", "qa_approved", "cancelled", "failed"] as RunStatus[]) {
    assert.equal(teamChatActive(chat(run(status, { tasks: [worker()] }))), false, status)
  }
  assert.equal(teamChatActive(chat()), false)
  assert.equal(teamChatActive(chat(run("running"))), false, "Sin sesiones no hay actividad efectiva")
})

test("pausar el despacho o bloquear el run no oculta sesiones que siguen ejecutándose", () => {
  // Native control('pause') only updates the run status; it does not cancel
  // existing sessions. Orange represents session activity, not dispatch state.
  for (const status of ["paused", "blocked"] as RunStatus[]) {
    assert.equal(teamChatActive(chat(run(status))), false, `${status} sin sesiones`)
    const record = chat(run(status, { tasks: [worker()] }))
    assert.equal(teamChatActive(record), true, `${status} con trabajador activo`)
    record.runs[0].tasks[0].attempts[0].finishedAt = 42
    assert.equal(teamChatActive(record), false, `${status} con trabajador finalizado`)
  }
})

test("trabajador y revisión activos se apagan al terminar, interrumpir o esperar dependencias", () => {
  const record = chat(run("running", { tasks: [worker()] }))
  assert.equal(teamChatActive(record), true)
  record.runs[0].tasks[0] = worker("verifying")
  assert.equal(teamChatActive(record), true)
  record.runs[0].tasks[0].attempts[0].finishedAt = 42
  assert.equal(teamChatActive(record), false)
  for (const status of ["completed", "interrupted", "waiting_dependency", "pending", "blocked"]) {
    record.runs[0].tasks[0] = worker(status)
    assert.equal(teamChatActive(record), false, status)
  }
  record.runs[0].tasks[0] = worker()
  record.runs[0].tasks[0].attempts[0].sessionId = null
  assert.equal(teamChatActive(record), false, "Una tarea sin sesión no prueba ejecución")
  record.runs[0].tasks[0].attempts[0].reviewSessionId = "review"
  assert.equal(teamChatActive(record), true)
  record.runs.push(run("completed", { finishedAt: 99 }))
  assert.equal(teamChatActive(record), false, "No usa ejecución histórica")
})

test("respuestas del Lead y soporte en curso cuentan; mensajes y reportes terminados no", () => {
  const record = chat(run("blocked"))
  record.messages = [{ role: "user", status: "pending" }] as TeamChatRecord["messages"]
  assert.equal(teamChatActive(record), false)
  record.messages![0].role = "assistant"
  assert.equal(teamChatActive(record), true)
  for (const status of ["completed", "interrupted", "error"]) {
    record.messages![0].status = status
    assert.equal(teamChatActive(record), false)
  }
  record.runs[0].supportReports = [{ status: "running", finishedAt: null }] as TeamRun["supportReports"]
  assert.equal(teamChatActive(record), true)
  record.runs[0].supportReports![0].finishedAt = 42
  assert.equal(teamChatActive(record), false)
  record.runs[0].coordination = [{ status: "checking" }] as TeamRun["coordination"]
  assert.equal(teamChatActive(record), true)
  for (const status of ["pending", "waiting", "blocked", "resolved"]) {
    record.runs[0].coordination![0].status = status
    assert.equal(teamChatActive(record), false)
  }
})

test("las tres superficies usan la misma clasificación y señal textual; la selección es independiente", () => {
  for (const file of ["src/agent/SessionTabs.tsx", "src/views/TeamsView.tsx", "src/team/TeamSessionHistory.tsx"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    assert.match(source, /teamChatActive\(/, file)
    assert.match(source, /team-chat-working/, file)
    assert.match(source, /En ejecución/, file)
  }
  const tabs = readFileSync(new URL("../src/agent/SessionTabs.tsx", import.meta.url), "utf8")
  assert.match(tabs, /aria-pressed=\{selected\}/)
  assert.match(tabs, /aria-label=\{`Equipo/)
  const css = readFileSync(new URL("../src/styles/agent.css", import.meta.url), "utf8")
  assert.match(css, /\.agent-tab\.team-chat-working \.agent-tab-icon/)
})
