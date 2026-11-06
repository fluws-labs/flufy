import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"

// Render the actual forms with inert hooks and IPC, without opening or changing user data.
function form(file: string, exported: string, team?: Record<string, unknown>) {
  const calls: { command: string; args: any }[] = []
  const teamState = { teams: team ? [team] : [], skills: [] }
  const agentState = { models: [], model: { providerID: "test", modelID: "test" } }
  const useTeams = Object.assign((select: any) => select(teamState), { getState: () => teamState })
  const useAgent = Object.assign((select: any) => select(agentState), { getState: () => agentState })
  const mocks: Record<string, any> = {
    react: {
      useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
      useEffect: () => {}, useCallback: (fn: any) => fn,
    },
    "react/jsx-runtime": {
      jsx: (type: any, props: any) => ({ type, props }),
      jsxs: (type: any, props: any) => ({ type, props }),
    },
    "../state/teams": {
      useTeams,
      teamCall: async (command: string, args: any) => { calls.push({ command, args }); return null },
    },
    "../state/agent": { useAgent },
    "../lib/opencode": { modelKey: (model: any) => `${model.providerID}/${model.modelID}` },
    "../state/project": { useProject: { getState: () => ({ root: "fixture" }) } },
    "../state/features": { activeWorkspace: () => null },
    "../team/types": { latestSkills: () => [] },
    "../team/profiles": { profileSkills: () => [], skillProfiles: [] },
  }
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  const compiled = ts.transpileModule(`${source}\nexport { ${exported} as UnderTest }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const exports: any = {}
  new Function("require", "exports", compiled)((id: string) => mocks[id] ?? {}, exports)
  const tree = exports.UnderTest({ id: team?.id ?? "new", team: team ?? { members: [] }, chatId: "fixture", pending: false })
  const nodes: any[] = []
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) { node.forEach(visit); return }
    nodes.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  const input = nodes.find(node => node.type === "input" && node.props.type === "number")
  const button = nodes.find(node => node.type === "button" && node.props.children === (exported === "TeamEditorForm" ? "Guardar equipo" : "Guardar ruteo para próximos objetivos"))
  assert.ok(input)
  assert.ok(button)
  return { calls, input: input.props, save: async () => { button.props.onClick(); await new Promise(resolve => setImmediate(resolve)) } }
}

test("una plantilla nueva permite diez tareas sin fabricar integrantes", async () => {
  const view = form("src/editor/TeamEditor.tsx", "TeamEditorForm")
  assert.equal(view.input.value, 10)
  await view.save()
  assert.equal(view.calls[0].command, "teams_save")
  assert.equal(view.calls[0].args.team.maxParallelTasks, 10)
  assert.deepEqual(view.calls[0].args.team.members.map((member: any) => member.role), ["Lead", "QA", "Backend", "Frontend"])
})

test("abrir y guardar una plantilla conserva cada límite explícito y sus integrantes", async () => {
  for (const maxParallelTasks of [1, 3, 16]) {
    const team = { id: "fixture", name: "Prueba", members: [], allowedRepositories: ["fixture"], maxParallelTasks, maxRetriesPerTask: 1 }
    const view = form("src/editor/TeamEditor.tsx", "TeamEditorForm", team)
    assert.equal(view.input.value, maxParallelTasks)
    await view.save()
    assert.deepEqual(view.calls[0].args.team, team)
  }
})

test("el ruteo nuevo ofrece diez trabajadores por proveedor al guardar", async () => {
  const view = form("src/team/ModelRouting.tsx", "ModelRouting")
  assert.equal(view.input.value, 10)
  await view.save()
  assert.equal(view.calls[0].command, "team_chats_planner")
  assert.deepEqual(view.calls[0].args.config.routing, { enabled: false, routes: [], pinnedAgents: [], maxWorkersPerProvider: 10 })
})

test("abrir y guardar ruteo conserva límites y selecciones explícitos", async () => {
  for (const maxWorkersPerProvider of [1, 2, 16]) {
    const routing = { enabled: true, routes: [], pinnedAgents: ["manual"], maxWorkersPerProvider }
    const view = form("src/team/ModelRouting.tsx", "ModelRouting", { members: [], planV2: { enabled: true, reviewBeforeStart: true, routing } })
    assert.equal(view.input.value, maxWorkersPerProvider)
    await view.save()
    assert.deepEqual(view.calls[0].args.config, { enabled: true, reviewBeforeStart: true, routing })
  }
})
