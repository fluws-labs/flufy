import { expect, test, type Page } from "@playwright/test"
import type { Team, TeamChatRecord, TeamRun, TeamStore } from "../../src/team/types"

/**
 * UI ONLY: simulated Tauri IPC and provider HTTP, as in teams.spec.ts.
 * QA-FALLBACK-* records exist only in this test process/browser context.
 * Reload preserves the simulated native store; it does NOT prove disk persistence.
 * No native scheduler, real credentials, quota requests or model inference runs here.
 *
 * Contracts read from src/state/fallback.ts, src/team/types.ts and
 * src/components/FallbackModels.tsx. Simulated state changes below are inputs
 * to UI assertions, never evidence of automatic native recovery.
 *
 * UI acceptance matrix:
 * 1. From quota and command palette open the same manager.
 * 2. Add secondary+tertiary, assert rows numbered 1/2, boundary arrows disabled;
 *    move second up, assert labels AND saved order; reject duplicate additions.
 * 3. Save, close/reopen and reload: same ordered list from simulated native state.
 * 4. Empty list + enable: manager opens; cancel keeps mode off, draft intact,
 *    and sends no task; saving a list enables mode without silently submitting.
 * 5. Configured + enabled: submit once; initial model stays primary, not row 1.
 * 6. Switch off with saved list: ordinary send unchanged; no fallback mutation.
 * 7. Inject native transition and team://changed: visible current model/reason;
 *    reload retains state; unrelated chat and historical attempts unchanged.
 * 8. Inject completed/restored state while primary quota is still 100%:
 *    global selector returns to original; refresh/reload retains restoration.
 *
 * Additional UI regressions: configured list disappears before send; explicit
 * resend after configuration; original reasoning variant restoration; another
 * chat in the same project; historical run; manual selection after restoration.
 * All are simulated IPC scenarios, including assertions of in-memory state.
 *
 * NATIVE integration/restart matrix (not run by this spec):
 * - confirmed provider quota/429/exhausted limit advances in configured order;
 *   generic task, auth and permission errors must not masquerade as quota.
 * - mode off preserves blocking behavior; stale/estimated quota never triggers
 *   an unsupported switch; unavailable/duplicate/exhausted candidates terminate.
 * - only interrupted work resumes; completed task/session/attempt IDs and tool
 *   side effects stay intact; simultaneous quota failures never double-switch.
 * - restart during recovery retains fallback progress without replaying tools.
 * - completion restores initial global model regardless of its quota; verify
 *   cancellation/failure semantics with T1 and protect other concurrent runs.
 * - save ordered config, restart native app, read it back; no account changes.
 * Preparation seam: tests/teams-engine.mjs uses the bundled engine + Rust
 * desktop-e2e harness; tests/teams-restart.mjs kills its own fixture processes
 * and checks session IDs plus once-only effects. Neither existing script has a
 * fallback-specific scenario. tests/fallback-native.mjs now drives the separate
 * prepare/resume/reopen contract in teams::integration::native_fallback_phase.
 * Its loopback inference exercises the real engine/scheduler/store, unlike the
 * simulated IPC below; report its actual execution result separately.
 */

const primary = { providerID: "openai", modelID: "qa-fallback-primary" }
const secondary = { providerID: "openai", modelID: "qa-fallback-secondary" }
const tertiary = { providerID: "openai", modelID: "qa-fallback-tertiary" }
const projectRoot = "C:/qa/QA-FALLBACK-synthetic"
const chatTitle = "QA-FALLBACK conversación sintética"
type Call = { command: string; args: Record<string, unknown> }

async function setup(page: Page) {
  const team: Team = {
    id: "QA-FALLBACK-team", name: chatTitle, autonomous: true, projectRoot,
    allowedRepositories: [projectRoot], leadAgentId: "lead", maxParallelTasks: 1,
    maxRetriesPerTask: 1, updatedAt: 1,
    members: [{ id: "lead", name: "Lead", role: "Lead", model: primary, variant: null,
      instructions: "Datos sintéticos; no ejecutar herramientas reales", tools: [],
      skillRefs: [], maxConcurrentTasks: 1 }],
  }
  const chat: TeamChatRecord = {
    id: "QA-FALLBACK-chat", title: chatTitle, team, skills: [], archived: false,
    createdAt: 1, messages: [], runs: [],
  }
  const store: TeamStore = { schemaVersion: 1, teams: [], skills: [], chats: [chat], fallbackModels: [] }
  const calls: Call[] = []
  await page.addInitScript(() => {
    // Fresh context per test; do not clear localStorage on reload.
    let next = 0
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++next, unregisterCallback: () => undefined,
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "plugin:event|listen") return ++next
        if (command === "server_config") return {
          url: `${location.origin}/qa-fallback-oc`, username: "qa-synthetic", password: "qa-synthetic",
          worktree: "C:/qa/QA-FALLBACK-synthetic",
        }
        if (command.startsWith("plugin:")) return null
        const response = await fetch("/qa-fallback-native", { method: "POST", body: JSON.stringify({ command, args }) })
        if (!response.ok) throw new Error(await response.text())
        return response.json()
      },
    }, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined } })
  })
  await page.route("**/qa-fallback-native", async route => {
    const { command, args } = route.request().postDataJSON() as Call
    calls.push({ command, args })
    let result: unknown = null
    if (["recent_projects", "routines_list", "auth_entries", "live_busy_sessions", "fs_read_dir", "fs_list_files", "term_shells", "windows_list", "git_subrepos", "team_activity"].includes(command)) result = []
    if (command === "teams_state") result = store
    if (command === "team_fallback_models_set") {
      store.fallbackModels = structuredClone(args.models as NonNullable<TeamStore["fallbackModels"]>)
      result = true
    }
    if (command === "team_chats_continuous") {
      expect(args.chatId).toBe(chat.id)
      chat.continuousMode = args.enabled === true
      result = true
    }
    if (command === "chatgpt_usage") result = {
      plan: "QA-SYNTHETIC", windows: [{ usedPercent: 100, windowSeconds: 86400, resetsAt: null }],
      limitReached: true, resetsAvailable: 0, measuredAt: 1,
    }
    if (command === "chatgpt_resets") result = { credits: [], available: 0, measuredAt: 1 }
    if (command === "team_chat_send") {
      expect(args.chatId).toBe(chat.id)
      chat.messages!.push({ id: `QA-FALLBACK-message-${chat.messages!.length}`, role: "user",
        text: String(args.text), status: "complete", createdAt: 2, runId: null, sessionId: null })
      chat.runs.push({ id: `QA-FALLBACK-run-${chat.runs.length}`, goal: String(args.text),
        team: structuredClone(team), skills: [], status: "blocked", startedAt: 2, finishedAt: null,
        planSessionId: null, tasks: [], summary: "", error: "The usage limit has been reached",
        evidenceDir: "", artifacts: [], notified: false })
      result = "reply"
    }
    if (/fallback|continuous/i.test(command) && !["team_fallback_models_set", "team_chats_continuous"].includes(command)) {
      await route.fulfill({ status: 501, body: `QA fixture needs the agreed IPC contract: ${command}` })
      return
    }
    await route.fulfill({ json: result })
  })
  await page.route("**/qa-fallback-oc/**", route => {
    const path = new URL(route.request().url()).pathname.replace("/qa-fallback-oc", "")
    if (path === "/event") return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    if (path === "/config/providers") return route.fulfill({ json: { providers: [{
      id: "openai", name: "ChatGPT", source: "api", options: { apiKey: "qa-synthetic-not-a-key" },
      models: Object.fromEntries(["primary", "secondary", "tertiary"].map(name => [
         `qa-fallback-${name}`, { id: `qa-fallback-${name}`, name: `QA-FALLBACK ${name}`,
           variants: { high: {}, low: {} } },
      ])),
    }] } })
    return route.fulfill({ json: path === "/session/status" ? {} : [] })
  })
  await page.goto("/")
  await openChat(page)
  return { store, chat, calls }
}

async function openChat(page: Page) {
  await expect(page.getByTitle("Equipos IA", { exact: true })).toBeVisible()
  const restored = page.getByRole("button", { name: `Equipo · ${chatTitle}` })
  if (await restored.first().isVisible()) {
    await restored.first().click()
    await expect(page.getByLabel("Mensaje para el equipo")).toBeVisible()
    return
  }
  if (!await page.getByRole("heading", { name: "Historial de Team Chats" }).isVisible()) {
    await page.getByTitle("Equipos IA", { exact: true }).click()
  }
  await page.locator(".team-sidebar-card").getByRole("button", { name: chatTitle, exact: true }).click()
  await expect(page.getByLabel("Mensaje para el equipo")).toBeVisible()
}

test.describe("fallback · IPC simulado", () => {
  test("base: sin activar el modo conserva envío único y bloqueo por cuota", async ({ page }) => {
    const { chat, calls } = await setup(page)
    await page.getByLabel("Mensaje para el equipo").fill("QA-FALLBACK objetivo sin efectos reales")
    await page.getByRole("button", { name: "Enviar", exact: true }).click()
    await expect(page.getByRole("region", { name: "Bloqueos del equipo" })).toContainText("alcanzó su límite de uso")
    await expect(page.getByRole("button", { name: "Cambiar modelo", exact: true })).toBeVisible()
    expect(calls.filter(call => call.command === "team_chat_send")).toHaveLength(1)
    expect(calls.filter(call => ["team_runs_start", "team_runs_control", "team_runs_model"].includes(call.command))).toEqual([])
    expect(chat.runs).toHaveLength(1)
    expect(chat.runs[0].team.members[0].model).toEqual(primary)
    await page.reload()
    await openChat(page)
    await expect(page.getByRole("region", { name: "Bloqueos del equipo" })).toContainText("alcanzó su límite de uso")
    expect(calls.filter(call => call.command === "team_chat_send")).toHaveLength(1)
  })

  test("base: cuota agotada es visible sin iniciar trabajo", async ({ page }) => {
    const { chat, calls } = await setup(page)
    await page.getByRole("button", { name: /ChatGPT 100\s*%/ }).click()
    const quota = page.getByRole("dialog", { name: "Cuotas de proveedores" })
    await expect(quota).toBeVisible()
    await expect(quota.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100")
    await page.keyboard.press("Escape")
    await expect(quota).not.toBeVisible()
    expect(chat.runs).toHaveLength(0)
    expect(calls.filter(call => call.command === "team_chat_send")).toEqual([])
  })

  test("acceso desde cuotas ofrece Modelos Fallback", async ({ page }) => {
    await setup(page)
    await page.getByRole("button", { name: /ChatGPT 100\s*%/ }).click()
    await page.getByRole("dialog", { name: "Cuotas de proveedores" })
      .getByRole("button", { name: "Modelos Fallback", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Modelos Fallback", exact: true })).toBeVisible()
  })

  test("acceso desde comandos ofrece Modelos Fallback", async ({ page }) => {
    await setup(page)
    await page.locator(".command-center").click()
    await page.locator(".quick-input input").fill(">Modelos Fallback")
    await expect(page.locator(".quick-input")).toContainText("Modelos Fallback")
    await page.keyboard.press("Enter")
    await expect(page.getByRole("dialog", { name: "Modelos Fallback", exact: true })).toBeVisible()
  })

  test("lista numerada: reordena, evita duplicados y persiste al recargar la UI", async ({ page }) => {
    const { store, calls } = await setup(page)
    await openManager(page)
    const dialog = manager(page)
    const rows = dialog.getByRole("list", { name: "Orden de modelos fallback" }).getByRole("listitem")
    for (const model of [secondary, tertiary]) {
      await dialog.getByLabel("Modelo fallback disponible").selectOption(`${model.providerID}/${model.modelID}`)
      await dialog.getByRole("button", { name: "Agregar modelo", exact: true }).click()
    }
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText("QA-FALLBACK secondary")
    await expect(rows.nth(1)).toContainText("QA-FALLBACK tertiary")
    await expect(rows.nth(0).locator(".fallback-model-number")).toHaveText("1")
    await expect(rows.nth(1).locator(".fallback-model-number")).toHaveText("2")
    await expect(rows.nth(0).getByRole("button", { name: /^Subir/ })).toBeDisabled()
    await expect(rows.nth(1).getByRole("button", { name: /^Bajar/ })).toBeDisabled()
    await expect(dialog.getByLabel("Modelo fallback disponible").locator("option")).toHaveCount(2)
    await rows.nth(1).getByRole("button", { name: /^Subir/ }).click()
    await expect(rows.nth(0)).toContainText("QA-FALLBACK tertiary")
    await expect(rows.nth(1)).toContainText("QA-FALLBACK secondary")
    await dialog.getByRole("button", { name: "Guardar", exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect(store.fallbackModels).toEqual([tertiary, secondary])
    expect(calls.filter(call => call.command === "team_fallback_models_set")).toHaveLength(1)
    await page.reload()
    await openManager(page)
    await expect(rows.nth(0)).toContainText("QA-FALLBACK tertiary")
    await expect(rows.nth(1)).toContainText("QA-FALLBACK secondary")
    await rows.nth(0).getByRole("button", { name: /^Quitar/ }).click()
    await dialog.getByRole("button", { name: "Cancelar", exact: true }).click()
    await openManager(page)
    await expect(rows).toHaveCount(2)
    expect(store.fallbackModels).toEqual([tertiary, secondary])
  })

  test("lista vacía: cancelar activación conserva modo apagado y borrador", async ({ page }) => {
    const { chat, calls } = await setup(page)
    const draft = "QA-FALLBACK borrador que no debe enviarse"
    await page.getByLabel("Mensaje para el equipo").fill(draft)
    const toggle = page.getByRole("switch", { name: /Modo continuo/ })
    await expect(page.locator('.team-composer-options > .composer-pill + [role="switch"]')).toHaveCount(1)
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await toggle.click()
    await expect(manager(page)).toContainText("Todavía no hay modelos fallback")
    await manager(page).getByRole("button", { name: "Cancelar", exact: true }).click()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    await expect(page.getByLabel("Mensaje para el equipo")).toHaveValue(draft)
    expect(chat.runs).toHaveLength(0)
    expect(calls.filter(call => ["team_chat_send", "team_chats_continuous"].includes(call.command))).toEqual([])
  })

  test("guardar lista habilita modo sin enviar; apagar conserva la lista", async ({ page }) => {
    const { store, calls } = await setup(page)
    const draft = "QA-FALLBACK configurar no debe enviar ni perder este borrador"
    await page.getByLabel("Mensaje para el equipo").fill(draft)
    const toggle = page.getByRole("switch", { name: /Modo continuo/ })
    await toggle.click()
    await manager(page).getByLabel("Modelo fallback disponible").selectOption("openai/qa-fallback-secondary")
    await manager(page).getByRole("button", { name: "Agregar modelo", exact: true }).click()
    await manager(page).getByRole("button", { name: "Guardar", exact: true }).click()
    await expect(toggle).toHaveAttribute("aria-checked", "true")
    await expect(page.getByLabel("Mensaje para el equipo")).toHaveValue(draft)
    expect(calls.filter(call => call.command === "team_chat_send")).toEqual([])
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-checked", "false")
    expect(store.fallbackModels).toEqual([secondary])
    await page.getByLabel("Mensaje para el equipo").fill("QA-FALLBACK modo apagado con lista")
    await page.getByRole("button", { name: "Enviar", exact: true }).click()
    await expect(page.getByRole("region", { name: "Bloqueos del equipo" })).toBeVisible()
    expect(calls.filter(call => call.command === "team_chat_send")).toHaveLength(1)
    expect(store.chats[0].runs[0].team.members[0].model).toEqual(primary)
  })

  test("lista retirada antes del envío: configurar conserva borrador y exige envío explícito", async ({ page }) => {
    const { chat, store, calls } = await setup(page)
    chat.continuousMode = true
    store.fallbackModels = []
    await refresh(page)
    const draft = "QA-FALLBACK lista vacía al enviar; conservar exactamente"
    await page.getByLabel("Mensaje para el equipo").fill(draft)
    await page.getByRole("button", { name: "Enviar", exact: true }).click()
    await expect(manager(page)).toBeVisible()
    await expect(page.getByLabel("Mensaje para el equipo")).toHaveValue(draft)
    expect(calls.filter(call => call.command === "team_chat_send")).toEqual([])
    await manager(page).getByLabel("Modelo fallback disponible").selectOption("openai/qa-fallback-secondary")
    await manager(page).getByRole("button", { name: "Agregar modelo", exact: true }).click()
    await manager(page).getByRole("button", { name: "Guardar", exact: true }).click()
    await expect(manager(page)).not.toBeVisible()
    await expect(page.getByLabel("Mensaje para el equipo")).toHaveValue(draft)
    expect(chat.runs).toEqual([])
    expect(calls.filter(call => call.command === "team_chat_send")).toEqual([])
    await page.getByRole("button", { name: "Enviar", exact: true }).click()
    await expect.poll(() => calls.filter(call => call.command === "team_chat_send").length).toBe(1)
    expect(calls.find(call => call.command === "team_chat_send")?.args.text).toBe(draft)
    expect(chat.runs[0].team.members[0].model).toEqual(primary)
  })

  test("selector: restaura modelo y variante originales sin cambiar la variante de otro modelo", async ({ page }) => {
    const { chat, calls } = await setup(page)
    await chooseModel(page, tertiary, "low")
    await chooseModel(page, primary, "high")
    const run = simulatedRun(chat, "QA-FALLBACK-variant", 2)
    chat.runs.push(run)
    await refresh(page)
    run.continuousFallback!.currentModel = secondary
    run.continuousFallback!.nextIndex = 1
    await refresh(page)
    await expectSelector(page, "secondary")
    run.status = "completed"; run.finishedAt = 3
    run.continuousFallback!.restored = true
    run.continuousFallback!.currentModel = primary
    await refresh(page)
    await expectSelector(page, "primary")
    expect(await selectorState(page)).toEqual({ model: primary, variant: "high", tertiaryVariant: "low" })
    expect(calls.filter(call => ["team_chat_send", "team_runs_start"].includes(call.command))).toEqual([])
  })

  test("selector: conversación ajena del mismo proyecto no cambia la selección activa", async ({ page }) => {
    const { chat, store } = await setup(page)
    await chooseModel(page, primary, "high")
    const other = structuredClone(chat)
    other.id = "QA-FALLBACK-other-chat"; other.title = "QA-FALLBACK conversación ajena"
    other.runs = [simulatedRun(other, "QA-FALLBACK-other-run", 100)]
    other.runs[0].continuousFallback!.currentModel = secondary
    store.chats.push(other)
    await refresh(page)
    await expectSelector(page, "primary")
    expect((await selectorState(page)).variant).toBe("high")
  })

  test("selector: ocultar el panel evita transiciones y mostrarlas después no reproduce cambios ocultos", async ({ page }) => {
    const { chat } = await setup(page)
    await chooseModel(page, primary, "high")
    const run = simulatedRun(chat, "QA-FALLBACK-hidden-panel", 2)
    chat.runs.push(run)
    await refresh(page)
    await page.evaluate(async () => {
      const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
      useLayout.getState().toggleAgent(false)
    })
    await expect(page.getByLabel("Mensaje para el equipo")).not.toBeVisible()
    run.continuousFallback!.currentModel = secondary
    run.continuousFallback!.nextIndex = 1
    await refresh(page)
    await expectSelector(page, "primary")
    expect((await selectorState(page)).variant).toBe("high")
    await page.evaluate(async () => {
      const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
      useLayout.getState().toggleAgent(true)
    })
    await expect(page.getByLabel("Mensaje para el equipo")).toBeVisible()
    await expect(page.locator(".team-fallback-status")).toContainText("Modelo alternativo: QA-FALLBACK secondary")
    await refresh(page)
    await expectSelector(page, "primary")
    expect((await selectorState(page)).variant).toBe("high")
  })

  test("selector: cambiar la ejecución seleccionada de otro chat conserva restauración del propietario visible", async ({ page }) => {
    const { chat, store } = await setup(page)
    await chooseModel(page, primary, "high")
    const other = structuredClone(chat)
    other.id = "QA-FALLBACK-selected-other"; other.title = "QA-FALLBACK selección ajena"
    other.runs = [simulatedRun(other, "QA-FALLBACK-other-history", 1), simulatedRun(other, "QA-FALLBACK-other-current", 2)]
    other.runs[0].status = "completed"; other.runs[0].finishedAt = 2
    other.runs[0].continuousFallback!.restored = true
    store.chats.push(other)
    const run = simulatedRun(chat, "QA-FALLBACK-visible-owner", 3)
    chat.runs.push(run)
    await refresh(page)
    run.continuousFallback!.currentModel = secondary
    run.continuousFallback!.nextIndex = 1
    await refresh(page)
    await expectSelector(page, "secondary")
    await page.evaluate(async ({ chatId, runId }) => {
      const { useTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts")
      useTeams.setState(state => ({ selectedRunIds: { ...state.selectedRunIds, [chatId]: runId } }))
    }, { chatId: other.id, runId: other.runs[0].id })
    await expectSelector(page, "secondary")
    run.status = "completed"; run.finishedAt = 4
    run.continuousFallback!.restored = true
    run.continuousFallback!.currentModel = primary
    await refresh(page)
    await expectSelector(page, "primary")
    expect((await selectorState(page)).variant).toBe("high")
    expect(await page.evaluate(async () => {
      const { useTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts")
      return useTeams.getState().activeChatId
    })).toBe(chat.id)
  })

  test("selector: una ejecución histórica terminada no reemplaza una elección posterior", async ({ page }) => {
    const { chat } = await setup(page)
    await chooseModel(page, tertiary, "low")
    const run = simulatedRun(chat, "QA-FALLBACK-history", 1)
    run.status = "completed"; run.finishedAt = 2
    run.continuousFallback!.restored = true
    run.continuousFallback!.currentModel = primary
    chat.runs.push(run)
    await refresh(page)
    await expectSelector(page, "tertiary")
    expect((await selectorState(page)).variant).toBe("low")
  })

  test("selector: ver una ejecución histórica no aplica la transición de la actual", async ({ page }) => {
    const { chat } = await setup(page)
    await chooseModel(page, primary, "high")
    const historical = simulatedRun(chat, "QA-FALLBACK-selected-history", 1)
    historical.status = "completed"; historical.finishedAt = 2
    historical.continuousFallback!.restored = true
    const current = simulatedRun(chat, "QA-FALLBACK-current", 3)
    chat.runs.push(historical, current)
    await refresh(page)
    await page.getByLabel("Entrega / ejecución").selectOption(historical.id)
    await chooseModel(page, tertiary, "low")
    current.continuousFallback!.currentModel = secondary
    current.continuousFallback!.nextIndex = 1
    await refresh(page)
    await expectSelector(page, "tertiary")
    await expect(page.getByLabel("Entrega / ejecución")).toHaveValue(historical.id)
  })

  test("selector: elegir manualmente durante fallback impide que el cierre sobrescriba la elección", async ({ page }) => {
    const { chat } = await setup(page)
    await chooseModel(page, primary, "high")
    const run = simulatedRun(chat, "QA-FALLBACK-live-manual-choice", 2)
    chat.runs.push(run)
    await refresh(page)
    run.continuousFallback!.currentModel = secondary
    run.continuousFallback!.nextIndex = 1
    await refresh(page)
    await expectSelector(page, "secondary")
    await chooseModel(page, tertiary, "low")
    run.status = "completed"; run.finishedAt = 3
    run.continuousFallback!.restored = true
    run.continuousFallback!.currentModel = primary
    await refresh(page)
    await expectSelector(page, "tertiary")
    expect((await selectorState(page)).variant).toBe("low")
  })

  test("selector: después de restaurar respeta una elección manual incluso al recargar", async ({ page }) => {
    const { chat } = await setup(page)
    await chooseModel(page, primary, "high")
    const run = simulatedRun(chat, "QA-FALLBACK-manual-choice", 2)
    chat.runs.push(run)
    await refresh(page)
    run.continuousFallback!.currentModel = secondary
    run.continuousFallback!.nextIndex = 1
    await refresh(page)
    await expectSelector(page, "secondary")
    run.status = "completed"; run.finishedAt = 3
    run.continuousFallback!.restored = true
    run.continuousFallback!.currentModel = primary
    await refresh(page)
    await expectSelector(page, "primary")
    await chooseModel(page, tertiary, "low")
    await refresh(page)
    await expectSelector(page, "tertiary")
    await page.reload()
    await openChat(page)
    await expectSelector(page, "tertiary")
    expect((await selectorState(page)).variant).toBe("low")
  })

  test("estado nativo simulado muestra alternativo y restaura selector tras refrescar", async ({ page }) => {
    const { store, chat, calls } = await setup(page)
    store.fallbackModels = [secondary, tertiary]
    await refresh(page)
    await page.getByRole("switch", { name: /Modo continuo/ }).click()
    await expect(page.getByRole("switch", { name: /Modo continuo/ })).toHaveAttribute("aria-checked", "true")
    await page.getByLabel("Mensaje para el equipo").fill("QA-FALLBACK transición simulada")
    await page.getByRole("button", { name: "Enviar", exact: true }).click()
    await expect.poll(() => chat.runs.length).toBe(1)
    const run = chat.runs[0]
    run.status = "running"; run.error = null
    run.continuousFallback = { enabled: true, originalModel: primary, originalVariant: null,
      currentModel: primary, candidates: [secondary, tertiary], nextIndex: 0, restored: false }
    await refresh(page)
    await expect(page.locator(".team-fallback-status")).toContainText("Modelo inicial: QA-FALLBACK primary")
    run.continuousFallback.currentModel = secondary; run.continuousFallback.nextIndex = 1
    await refresh(page)
    await expect(page.locator(".team-fallback-status")).toContainText("Modelo alternativo: QA-FALLBACK secondary")
    await expect(page.getByRole("contentinfo").getByRole("button", { name: "QA-FALLBACK secondary", exact: true })).toBeVisible()
    await page.reload()
    await openChat(page)
    await expect(page.locator(".team-fallback-status")).toContainText("Modelo alternativo: QA-FALLBACK secondary")
    run.status = "completed"; run.finishedAt = 3
    run.continuousFallback.restored = true
    run.continuousFallback.currentModel = primary
    await refresh(page)
    await expect(page.locator(".team-fallback-status")).toContainText("Modelo inicial restaurado: QA-FALLBACK primary")
    await expect(page.getByRole("contentinfo").getByRole("button", { name: "QA-FALLBACK primary", exact: true })).toBeVisible()
    await page.reload()
    await openChat(page)
    await expect(page.locator(".team-fallback-status")).toContainText("Modelo inicial restaurado: QA-FALLBACK primary")
    await expect(page.getByRole("contentinfo").getByRole("button", { name: "QA-FALLBACK primary", exact: true })).toBeVisible()
    expect(calls.filter(call => call.command === "team_chat_send")).toHaveLength(1)
  })
})

const manager = (page: Page) => page.getByRole("dialog", { name: "Modelos Fallback", exact: true })
// Injected input only: this helper never runs native quota detection or recovery.
function simulatedRun(chat: TeamChatRecord, id: string, startedAt: number): TeamRun {
  return { id, goal: id, team: structuredClone(chat.team), skills: [], status: "running",
    startedAt, finishedAt: null, planSessionId: null, tasks: [], summary: "", error: null,
    evidenceDir: "", artifacts: [], notified: false,
    continuousFallback: { enabled: true, originalModel: primary, originalVariant: "high",
      currentModel: primary, candidates: [secondary, tertiary], nextIndex: 0, restored: false } }
}
async function chooseModel(page: Page, model: typeof primary, variant: string) {
  await page.evaluate(async ({ model, variant }) => {
    const { setModel, setVariant } = await import(/* @vite-ignore */ "/src/state/agent.ts")
    setModel(model, null)
    setVariant(model, variant, null)
  }, { model, variant })
}
async function selectorState(page: Page) {
  return page.evaluate(async () => {
    const { useAgent, selectedVariant } = await import(/* @vite-ignore */ "/src/state/agent.ts")
    const state = useAgent.getState()
    return { model: state.model, variant: selectedVariant(state), tertiaryVariant: state.variants["openai/qa-fallback-tertiary"] }
  })
}
async function expectSelector(page: Page, model: string) {
  await expect(page.getByRole("contentinfo").getByRole("button", { name: `QA-FALLBACK ${model}`, exact: true })).toBeVisible()
}
async function openManager(page: Page) {
  await page.locator(".command-center").click()
  await page.locator(".quick-input input").fill(">Modelos Fallback")
  await page.keyboard.press("Enter")
  await expect(manager(page).getByLabel("Modelo fallback disponible")).toBeVisible()
}
async function refresh(page: Page) {
  // Same explicit UI refresh seam used in teams.spec.ts; not a native event test.
  await page.evaluate(async () => {
    const { refreshTeams } = await import(/* @vite-ignore */ "/src/state/teams.ts")
    await refreshTeams()
  })
}
