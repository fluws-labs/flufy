import assert from "node:assert/strict"
import { test } from "node:test"
import type { Session } from "@opencode-ai/sdk"
import type { TeamChatRecord } from "../src/team/types.ts"
import { groupTeamSessions, indexTeamSessions, isTeamSession } from "../src/team/session-index.ts"

const session = (id: string, title = id, parentID?: string) => ({ id, title, parentID } as Session)
const chat = (id: string) => ({ id, title: "Mismo nombre", messages: [{ sessionId: `${id}-conversation` }], runs: [{ planSessionId: `${id}-plan`, closingSessions: [`${id}-close`], coordination: [{ sessions: [`${id}-help`] }], tasks: [{ attempts: [{ sessionId: `${id}-worker`, reviewSessionId: `${id}-review` }, { sessionId: `${id}-retry`, reviewSessionId: null }] }] }] } as TeamChatRecord)

test("agrupa por identidad todas las sesiones e intentos aunque se renombren o compartan nombre", () => {
  const chats = [chat("one"), chat("two")]
  indexTeamSessions(chats)
  const one = ["conversation", "plan", "close", "help", "worker", "review", "retry"].map(name => session(`one-${name}`, "Renombrada"))
  const two = session("two-worker")
  const normal = session("normal", "Mi chat")
  const grouped = groupTeamSessions([normal, ...one, two], chats)
  assert.deepEqual(grouped.normal, [normal])
  assert.equal(grouped.groups.length, 2)
  assert.deepEqual(grouped.groups[0].sessions, one)
  assert.equal(grouped.groups[0].chat?.id, "one")
  assert.equal(grouped.groups[1].chat?.id, "two")
  assert.equal(isTeamSession("one-retry"), true)
  indexTeamSessions([])
  assert.equal(isTeamSession("one-retry"), false)
})

test("incluye descendientes con ancestros fuera del filtro y conserva sesiones normales y legadas", () => {
  const parent = session("one-worker")
  const child = session("child", "Nested", parent.id)
  const grandchild = session("grandchild", "Child", child.id)
  const normal = session("normal", "Equipo de ventas")
  const legacy = session("legacy", "Equipo 路 Viejo 路 plan")
  const cycle = session("cycle", "Normal", "cycle")
  const grouped = groupTeamSessions([grandchild, normal, legacy, cycle], [chat("one")], [parent, child, grandchild, normal, legacy, cycle])
  assert.deepEqual(grouped.normal, [normal, cycle])
  assert.deepEqual(grouped.groups.map(g => g.sessions.map(s => s.id)), [["grandchild"], ["legacy"]])
  assert.equal(grouped.groups[0].chat?.id, "one")
  assert.equal(grouped.groups[1].chat, undefined)
})

test("sesiones de Solucionador y Supervisor permanecen dentro del equipo",()=>{
  const record=chat("support")
  record.runs[0].supportReports=[{sessionId:"solver-session"},{sessionId:"supervisor-session"}] as NonNullable<TeamChatRecord["runs"][0]["supportReports"]>
  const grouped=groupTeamSessions([session("solver-session","Investigaci贸n"),session("supervisor-session","Revisi贸n"),session("normal")],[record])
  assert.deepEqual(grouped.normal.map(s=>s.id),["normal"])
  assert.equal(grouped.groups[0].sessions.length,2)
})

test("la conversaci髇 de origen del Lead sigue visible como sesi髇 normal", () => {
  const record = chat("lead")
  record.origin = { sessionId: "lead-plan", messageId: "m", title: "Conversaci髇", directory: "/repo", createdAt: 1 }
  indexTeamSessions([record])
  assert.equal(isTeamSession("lead-plan"), true, "permissions still treat the Lead as a team session")
  const grouped = groupTeamSessions([session("lead-plan", "Conversaci髇"), session("lead-worker")], [record])
  assert.deepEqual(grouped.normal.map(s => s.id), ["lead-plan"])
  assert.deepEqual(grouped.groups[0].sessions.map(s => s.id), ["lead-worker"])
})
