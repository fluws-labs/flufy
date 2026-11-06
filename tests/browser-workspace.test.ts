import { test } from "node:test"
import assert from "node:assert/strict"
import { rm } from "node:fs/promises"
import { fixtureDirectory } from "./fixture-directory.mjs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Workspaces, install } from "../src-tauri/src/desktop/browser_workspace.mjs"

function page(id: number, windowId: number, target = `t${id}`) {
  return { id, pptrPage: { url: () => `https://test/${id}`,
    createCDPSession: async () => ({ send: async (name: string) => name === "Target.getTargetInfo" ? { targetInfo: { targetId: target } } : { windowId }, detach: async () => {} }) } }
}

test("Chrome assignment scopes tabs per window, allows sharing and rejects recycled window IDs", async () => {
  const dir = await fixtureDirectory("browser-workspace-")
  try {
    const file = pathToFileURL(join(dir, "workspaces.json"))
    const first = page(1, 100), second = page(2, 100), foreign = page(3, 200)
    let pages = [first, second, foreign]
    const context = { createPagesSnapshot: async () => {}, getPages: () => pages, selectPage: () => {} }
    const ws = new Workspaces(file)
    await ws.scope(context, { session: "a", action: "assign", pageId: 1 })
    const shared = { session: "b", action: "assign", pageId: 2 } as Record<string, unknown> & { state?: { windowId: number | null } }
    await ws.scope(context, shared)
    assert.equal(shared.state?.windowId, 100)
    const sharedScope = await ws.scope(context, { session: "b" })
    assert.deepEqual(sharedScope.getPages(), [first, second])
    const scoped = await ws.scope(context, { session: "a" })
    assert.deepEqual(scoped.getPages(), [first, second])
    assert.throws(() => scoped.getPageById(3), /no pertenece/)
    scoped.selectPage(second)
    assert.equal(scoped.getSelectedMcpPage(), second)
    await assert.rejects(scoped.newPage(true, "isolated"), /compartido/)
    pages = [first, foreign]
    await scoped.createPagesSnapshot()
    await assert.rejects(scoped.closePage(1), /última pestaña/)
    pages = [page(4, 100, "recycled-window"), foreign]
    await assert.rejects(scoped.createPagesSnapshot(), /cerró/)
    await assert.rejects(ws.scope(context, { session: "a" }), /sin ventana asignada/)
    // Reconnection/restart also refuses to bind a recycled ID automatically.
    await assert.rejects(new Workspaces(file).scope(context, { session: "a" }), /sin ventana asignada/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("the Chrome adapter fails closed when given the application class instead of the SDK", async () => {
  class WrongServer {}
  class Handler { unknownArgumentNames() { return [] } }
  await assert.rejects(install({ McpServer: WrongServer, ToolHandler: Handler }, new URL("file:///unused")), /contrato de registro/)
})

test("team agents retain independent selected tabs after reconnect and serialize only tab creation", async () => {
  const dir = await fixtureDirectory("team-workspace-")
  try {
    const file = pathToFileURL(join(dir, "workspaces.json"))
    const first = page(1, 100), second = page(2, 100)
    const context = { createPagesSnapshot: async () => {}, getPages: () => [first, second], selectPage: () => {} }
    const ws = new Workspaces(file)
    await ws.scope(context, { session: "team:one", action: "assign", pageId: 1 })
    const backend = await ws.scope(context, { session: "team:one", actor: "backend-session" })
    const frontend = await ws.scope(context, { session: "team:one", actor: "frontend-session" })
    backend.selectPage(first); frontend.selectPage(second)
    assert.equal(backend.getSelectedMcpPage(), first)
    assert.equal(frontend.getSelectedMcpPage(), second)
    await ws.save()
    const reopened = new Workspaces(file)
    assert.equal((await reopened.scope(context, { session: "team:one", actor: "backend-session" })).getSelectedMcpPage(), first)
    assert.equal((await reopened.scope(context, { session: "team:one", actor: "frontend-session" })).getSelectedMcpPage(), second)
    const events: string[] = []
    await Promise.all([1, 2].map(id => ws.createTab("team:one", async () => {
      events.push(`start-${id}`)
      await new Promise(resolve => setTimeout(resolve, 10))
      events.push(`end-${id}`)
    })))
    assert.deepEqual(events, ["start-1", "end-1", "start-2", "end-2"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("internal pages require an actor claim and retain ownership after reconnect and replacement", async () => {
  const dir = await fixtureDirectory("internal-actors-")
  try {
    const file = pathToFileURL(join(dir, "workspaces.json"))
    const first = page(1, 0), second = page(2, 0)
    let pages = [first, second]
    const context = { createPagesSnapshot: async () => {}, getPages: () => pages, selectPage() {} }
    const ws = new Workspaces(file)
    const scope = (actor: string, claimUrl?: string) => ws.scope(context, { session: "team:synthetic", actor, isolated: true, claimUrl })
    assert.deepEqual((await scope("unclaimed")).getPages(), [])
    const backend = await scope("backend", "https://test/1")
    const frontend = await scope("frontend", "https://test/2")
    assert.deepEqual(backend.getPages(), [first])
    assert.deepEqual(frontend.getPages(), [second])
    assert.throws(() => backend.getPageById(2), /no pertenece/)
    assert.throws(() => frontend.selectPage(first), /no pertenece/)
    await assert.rejects(scope("frontend", "https://test/1"), /otro agente/)
    const reopened = new Workspaces(file)
    assert.equal((await reopened.scope(context, { session: "team:synthetic", actor: "backend", isolated: true })).getSelectedMcpPage(), first)
    pages = [second]
    assert.deepEqual((await scope("backend")).getPages(), [], "closing a page never borrows another actor's page")
    const replacement = page(3, 0)
    pages.push(replacement)
    assert.deepEqual((await scope("backend")).getPages(), [], "new targets are not implicitly owned")
    assert.equal((await scope("backend", "https://test/3")).getSelectedMcpPage(), replacement)
    assert.equal((await scope("frontend")).getSelectedMcpPage(), second)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("independent internal profile inventories do not leak pages between conversations", async () => {
  const dir = await fixtureDirectory("internal-sessions-")
  try {
    const ws = new Workspaces(pathToFileURL(join(dir, "workspaces.json")))
    const first = page(1, 0), second = page(2, 0)
    const context = (entry: ReturnType<typeof page>) => ({ createPagesSnapshot: async () => {}, getPages: () => [entry], selectPage() {} })
    const a = await ws.scope(context(first), { session: "team:first", actor: "qa", isolated: true, claimUrl: "https://test/1" })
    const b = await ws.scope(context(second), { session: "team:second", actor: "qa", isolated: true, claimUrl: "https://test/2" })
    assert.deepEqual(a.getPages(), [first])
    assert.deepEqual(b.getPages(), [second])
    assert.throws(() => a.getPageById(2), /no pertenece/)
    assert.throws(() => b.getPageById(1), /no pertenece/)
    await a.createPagesSnapshot()
    assert.equal(a.getSelectedMcpPage(), first)
    assert.equal(b.getSelectedMcpPage(), second)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
