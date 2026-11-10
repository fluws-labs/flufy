import { expect, test, type Page } from "@playwright/test"

const root = "C:/qa/demo"
const now = Date.now()
const session = { id: "s1", title: "Investigación", directory: root, projectID: "qa", version: "1", time: { created: now - 60_000, updated: now - 30_000 } }
const messages = [
  {
    info: { id: "m-user", role: "user", time: { created: now - 50_000 }, modelID: "m", providerID: "openai" },
    parts: [{ type: "text", id: "p-user", text: "Quiero que un equipo implemente este plan", synthetic: false }],
  },
  {
    info: { id: "m-assistant", role: "assistant", time: { created: now - 40_000, completed: now - 39_000 }, modelID: "m", providerID: "openai", finish: "stop", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [
      { type: "text", id: "p-text", text: "Listo. El equipo tomó el plan acordado." },
      {
        type: "tool",
        id: "p-delegate",
        tool: "teams_delegate",
        callID: "call-delegate",
        state: {
          status: "completed",
          input: { title: "Filtro de consultas" },
          output: JSON.stringify({ teamChatId: "team-1", runId: "run-1", title: "Filtro de consultas", status: "planning", reused: false }),
          time: { start: now - 39_500, end: now - 39_200 },
        },
      },
    ],
  },
]
const store = {
  schemaVersion: 3,
  teams: [],
  skills: [],
  chats: [{
    id: "team-1",
    title: "Filtro de consultas",
    archived: false,
    createdAt: now,
    messages: [],
    runs: [],
    skills: [],
    team: {
      id: "team-1",
      name: "Modo equipo",
      projectRoot: root,
      allowedRepositories: [root],
      leadAgentId: "lead",
      members: [{ id: "lead", name: "Lead", role: "Lead", model: { providerID: "openai", modelID: "m" }, variant: null, skillRefs: [], instructions: "", tools: ["read"], maxConcurrentTasks: 1 }],
      maxParallelTasks: 2,
      maxRetriesPerTask: 1,
      updatedAt: now,
    },
    origin: { sessionId: "s1", messageId: "m-user", title: "Investigación", directory: root, createdAt: now },
  }],
}

async function setup(page: Page) {
  await page.addInitScript(({ root, store }) => {
    localStorage.setItem("guillecode:studio.mode", JSON.stringify("code"))
    localStorage.setItem("guillecode:agent.openSessions@c:/qa/demo", JSON.stringify(["s1"]))
    localStorage.setItem("guillecode:agent.activeSession@c:/qa/demo", JSON.stringify("s1"))
    let id = 0
    Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined } })
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++id,
      unregisterCallback: () => undefined,
      invoke: async (command: string) => {
        if (command === "plugin:event|listen") return ++id
        if (command === "plugin:app|version") return "0.5.0"
        if (command === "server_config" || command.endsWith("|server_config")) return { url: `${location.origin}/test-oc`, username: "qa", password: "qa", worktree: root }
        if (command === "teams_state" || command.endsWith("|teams_state")) return store
        if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions", "team_activity"].includes(command)) return []
        return null
      },
    } })
  }, { root, store })
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { m: { id: "m", name: "Modelo QA" } } }] } })
    if (path === "/session") return route.fulfill({ json: [session] })
    if (path === "/session/status") return route.fulfill({ json: {} })
    if (path === "/session/s1/message") return route.fulfill({ json: messages })
    if (path === "/permission") return route.fulfill({ json: [] })
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
}

test("un chat normal muestra el traspaso y permite abrir el equipo o volver al origen", async ({ page }) => {
  await setup(page)
  await expect(page.getByText("Pasó el plan a un equipo")).toBeVisible()
  await expect(page.getByText("El equipo tomó el plan", { exact: false })).toBeVisible()
  await page.getByRole("button", { name: "Abrir equipo", exact: true }).click()
  await expect(page.locator(".team-space")).toContainText("Filtro de consultas")
  await page.screenshot({ path: test.info().outputPath("chat-delega-equipo.png") })
  await page.getByRole("button", { name: "Código", exact: true }).click()
  const origin = page.getByRole("button", { name: /Investigación/ }).first()
  await expect(origin).toBeVisible()
  await origin.click()
  await expect(page.locator(".team-chat-header")).toHaveCount(0)
})
