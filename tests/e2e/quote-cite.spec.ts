import { expect, test, type Page } from "@playwright/test"

const root = "C:/qa/quote"
const now = Date.now()
const sessionID = "s1"
const text = "El Lead recibe el resumen real y puede consultar teams_board para responder en la conversación."

const session = { id: sessionID, title: "Citas", directory: root, projectID: "qa", version: "1", time: { created: now - 60000, updated: now - 30000 } }

async function setup(page: Page) {
  await page.addInitScript(({ root, sessionID }) => {
    const key = root.toLowerCase()
    localStorage.setItem("guillecode:studio.mode", JSON.stringify("code"))
    localStorage.setItem(`guillecode:agent.openSessions@${key}`, JSON.stringify([sessionID]))
    localStorage.setItem(`guillecode:agent.activeSession@${key}`, JSON.stringify(sessionID))
    let id = 0
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++id,
        unregisterCallback: () => undefined,
        invoke: async (command: string) => {
          if (command === "plugin:event|listen") return ++id
          if (command === "plugin:app|version") return "0.6.0"
          if (command === "server_config") return { url: `${location.origin}/test-oc`, username: "qa", password: "qa", worktree: root }
          if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions", "fs_list_files"].includes(command)) return []
          return null
        },
      },
    })
    Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined } })
  }, { root, sessionID })
  const messages = [
    {
      info: { id: "m-user", sessionID, role: "user", time: { created: now - 2000 }, agent: "build", model: { providerID: "openai", modelID: "qa" } },
      parts: [{ id: "p-user", sessionID, messageID: "m-user", type: "text", text: "Contame del Lead." }],
    },
    {
      info: {
        id: "m-assistant", sessionID, role: "assistant", parentID: "m-user", time: { created: now - 1000, completed: now },
        providerID: "openai", modelID: "qa", agent: "build", mode: "build", path: { cwd: root, root }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: "p-assistant", sessionID, messageID: "m-assistant", type: "text", text }],
    },
  ]
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) {
      return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n` })
    }
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{ id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "test" }, models: { qa: { id: "qa", name: "Modelo QA" } } }] } })
    if (path === "/session") return route.fulfill({ json: [session] })
    if (path === "/session/status") return route.fulfill({ json: {} })
    if (path === `/session/${sessionID}`) return route.fulfill({ json: session })
    if (path.startsWith(`/session/${sessionID}/message`)) return route.fulfill({ json: messages })
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
}

async function select(page: Page, from: number, to: number) {
  await page.evaluate(({ from, to }) => {
    const paragraph = document.querySelector(".msg-assistant .md p")!
    const node = paragraph.firstChild!
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, to)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.querySelector(".chat-scroll")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
  }, { from, to })
}

test("cita un pasaje del agente en el composer", async ({ page }) => {
  await setup(page)
  await expect(page.locator(".msg-assistant .md p").first()).toBeVisible()

  await select(page, 0, 10)
  const button = page.locator(".chat-quote-btn")
  await expect(button).toBeVisible()
  await expect(button).toContainText("Citar")

  await button.click()
  const composer = page.locator(".agent-panel textarea").first()
  await expect(composer).toHaveValue("> El Lead re\n\n")
  await expect(button).toHaveCount(0)
  expect(await page.evaluate(() => CSS.highlights.has("quote-source"))).toBe(true)

  await composer.pressSequentially("Comentario uno")
  await select(page, 16, 42)
  await expect(page.locator(".chat-quote-btn")).toBeVisible()
  await page.locator(".chat-quote-btn").click()
  await expect(composer).toHaveValue("> El Lead re\n\nComentario uno\n\n> " + text.slice(16, 42) + "\n\n")
})
