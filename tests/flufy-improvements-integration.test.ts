import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { FlufyPolicy } from "../src-tauri/src/agent_policy.js"
import { groupTeamSessions, indexTeamSessions, isTeamSession } from "../src/team/session-index.ts"
import { teamChatActive } from "../src/team/chat-active.ts"
import { latestSkills, runActive } from "../src/team/types.ts"
import type { Skill, TeamChatRecord } from "../src/team/types.ts"
import type { Session } from "@opencode-ai/sdk"

test("un mismo motor alterna chat normal, equipo y chat normal sin contaminar sus políticas", async () => {
  const previous = process.env.OPENCODE_CONFIG_CONTENT
  try {
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: {
      terminal: { url: "http://127.0.0.1:12345/mcp/terminal" },
      worktrees: { url: "http://127.0.0.1:12345/mcp/worktrees" },
    } })
    const plugin = await FlufyPolicy()
    const transform = plugin["experimental.chat.system.transform"]!
    const normal = { system: ["Decisión del proyecto: conservar datos"] }
    const team = { system: ["[GUILLECODE_TEAM_RUN] Política específica del equipo"] }
    await transform({ sessionID: "qa-normal" }, normal)
    const normalPolicy = normal.system[1]
    assert.ok(normalPolicy)
    await transform({ sessionID: "qa-team" }, team)
    assert.deepEqual(team.system, ["[GUILLECODE_TEAM_RUN] Política específica del equipo"])
    const resumed = { system: [...normal.system] }
    await transform({ sessionID: "qa-normal" }, resumed)
    assert.deepEqual(resumed.system, normal.system)
    const fresh = { system: ["Otro proyecto"] }
    await transform({ sessionID: "qa-fresh" }, fresh)
    assert.deepEqual(fresh.system, ["Otro proyecto", normalPolicy])
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = previous
  }
})

test("finalizar un equipo cambia su actividad sin perder la identidad de sus sesiones", () => {
  const record = {
    id: "qa-improvements", title: "QA · mejoras", messages: [],
    runs: [{ id: "qa-run", status: "planning", planSessionId: "qa-plan", tasks: [] }],
  } as unknown as TeamChatRecord
  const sessions = [{ id: "qa-plan", title: "Sesión renombrada" }, { id: "qa-personal", title: "Normal" }] as Session[]
  indexTeamSessions([record])
  assert.equal(runActive(record.runs[0].status), true)
  assert.equal(teamChatActive(groupTeamSessions(sessions, [record]).groups[0].chat!), true)
  record.runs[0].status = "paused"
  assert.equal(runActive(record.runs[0].status), true, "un equipo reanudable no equivale a ejecución activa")
  assert.equal(teamChatActive(record), false)
  record.runs[0].status = "completed"
  assert.equal(runActive(record.runs[0].status), false)
  assert.equal(teamChatActive(record), false)
  assert.equal(isTeamSession("qa-plan"), true)
  const grouped = groupTeamSessions(sessions, [record])
  assert.deepEqual(grouped.normal.map(session => session.id), ["qa-personal"])
  assert.deepEqual(grouped.groups.map(group => group.id), [record.id])
  assert.equal(grouped.groups[0].chat?.runs[0].status, "completed")
  indexTeamSessions([])
})

test("el catálogo actualizable ofrece versiones nuevas sin mutar selecciones ni snapshots históricos", async () => {
  const definitions = JSON.parse(await readFile(new URL("../.opencode/skills/catalog.json", import.meta.url), "utf8"))
  const definition = definitions.find((skill: { id: string }) => skill.id === "qa")
  assert.ok(definition, "se conserva la skill QA del catálogo existente")
  const old: Skill = { ...definition, version: 1, instructions: "Instrucciones históricas personalizadas" }
  const current: Skill = { ...definition, version: old.version + 1, instructions: "Nueva versión disponible" }
  const optional: Skill = { ...current, id: "qa-optional", name: "Solo bajo selección explícita" }
  const chatSnapshot = structuredClone({ skills: [old], member: { skillRefs: [{ id: old.id, version: old.version }] } })
  const before = JSON.stringify(chatSnapshot)
  const catalog = [old, current, optional]
  assert.deepEqual(latestSkills(catalog).map(skill => [skill.id, skill.version]), [[current.id, current.version], [optional.id, optional.version]])
  const resolved = chatSnapshot.member.skillRefs.map(ref => catalog.find(skill => skill.id === ref.id && skill.version === ref.version))
  assert.deepEqual(resolved, [old])
  assert.equal(JSON.stringify(chatSnapshot), before)
  assert.equal(chatSnapshot.skills.some(skill => skill.id === optional.id), false)
  assert.deepEqual(catalog, [old, current, optional])
})
