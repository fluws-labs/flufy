import { expect, test, type Page } from "@playwright/test"

async function boot(page: Page) {
  await page.addInitScript(() => {
    let id = 0
    const now = Date.now()
    const inbox = [
      {
        id: "decision-1",
        at: new Date(now).toISOString(),
        kind: "approval",
        title: "Aprobar envío a 5 locales",
        body: "El lote 1 está listo y espera tu decisión.",
        untrusted: false,
        missionId: "mision-1",
        cause: "Enviar el lote 1 de WhatsApp",
        options: ["Enviar los 5 mensajes", "No enviar"],
        recommendation: "Revisá el texto y aprobá solo si respeta el opt-out.",
        defaultAction: "park",
        expiresAt: new Date(now + 3_600_000).toISOString(),
        preview: "Hola, soy Guille de quiero.menu…",
      },
      {
        id: "result-1",
        at: new Date(now).toISOString(),
        kind: "result",
        title: "Medición del día",
        body: "13 altas en 30 días.",
        untrusted: false,
      },
    ]
    const mission = {
      version: 1,
      id: "mision-1",
      title: "Crecimiento Quiero Menú",
      goal: "Conseguir altas reales en Concepción del Uruguay",
      status: "waiting-approval",
      schedule: { kind: "daily", time: "08:30" },
      budget: { minutesPerRun: 15, runsPerDay: 2, tokensPerDay: 60000 },
      policy: { reads: "auto", drafts: "auto", commits: "approval" },
      grants: {
        read: "auto",
        writeRepo: "auto",
        merge: "approval",
        deploy: "approval",
        prodWrite: "approval",
        send: "approval",
        spend: "deny",
        sendPerWeek: 5,
        spendLimit: 0,
      },
      metric: "altas nuevas por semana",
      target: "3 altas en 30 días",
      activeBet: "Rotiserías de CdU",
      windowEnd: now + 86_400_000,
      windowOnly: false,
      template: "builder",
      autonomy: "alta",
      computer: { browser: "borrowed", desktop: false, files: true, terminal: true },
      state: {
        phase: "waiting",
        blockedReason: "Falta tu aprobación para enviar",
        runsToday: 1,
        tokensToday: 1234,
        runs: [
          {
            id: "run-1",
            startedAt: now - 60_000,
            finishedAt: now,
            status: "needs-approval",
            phase: "waiting",
            outcome: "waiting",
            durationMs: 60_000,
            tokens: 1234,
            summary: "Preparé el lote y pedí aprobación.",
          },
        ],
      },
      createdAt: now,
      updatedAt: now,
    }
    Object.assign(window, {
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
        transformCallback: () => ++id,
        unregisterCallback: () => undefined,
        invoke: async (command: string) => {
          if (command === "agent_profile_get") {
            return { profile: "# Flufy Bots\n\nAgente de crecimiento", firstRun: false, pulse: false }
          }
          if (command === "agent_log_list") return { entries: [] }
          if (command === "agent_inbox_state") return { items: inbox, count: 1 }
          if (command === "agent_missions_list") return [mission]
          if (command === "agent_pulse_get") return { enabled: false }
          if (command === "agent_absence_status") return { enabled: false, ready: false, checks: [] }
          if (command === "auth_entries") return []
          return null
        },
      },
    })
  })
  await page.route("**/test-native", (route) => route.fulfill({ json: [] }))
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) {
      return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    }
    if (path === "/config/providers") {
      return route.fulfill({
        json: {
          providers: [
            {
              id: "qa",
              name: "QA",
              source: "api",
              models: { qa: { id: "qa", name: "QA", cost: { input: 0, output: 0 }, limit: { context: 100000 } } },
            },
          ],
        },
      })
    }
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
  await page.waitForTimeout(1500)
}

async function openProfile(page: Page) {
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    const { useProject } = await import(/* @vite-ignore */ "/src/state/project.ts")
    const { useAgent } = await import(/* @vite-ignore */ "/src/state/agent.ts")
    useProject.setState({ root: "D:/qa/quiero-menu", ready: true })
    useAgent.setState({
      modelsLoaded: true,
      modelsError: null,
      models: [{ providerID: "qa", modelID: "qa", providerName: "QA", name: "QA", variants: [], contextLimit: 100000 }],
    })
    useLayout.getState().showView("profile", false)
  })
}

test("Flufy Bots muestra la decisión con causa, recomendación y deadline", async ({ page }) => {
  await boot(page)
  await openProfile(page)
  await expect(page.getByText("Aprobar envío a 5 locales")).toBeVisible()
  await expect(page.getByText("Causa: Enviar el lote 1 de WhatsApp")).toBeVisible()
  await expect(page.getByText("Recomendación: Revisá el texto y aprobá solo si respeta el opt-out.")).toBeVisible()
  await expect(page.getByText(/por defecto estacionar/)).toBeVisible()
  await expect(page.getByRole("button", { name: "Aprobar" }).first()).toBeVisible()
})

test("Flufy Bots muestra el contrato y la fase de la misión", async ({ page }) => {
  await boot(page)
  await openProfile(page)
  await expect(page.getByRole("heading", { name: "Crecimiento Quiero Menú" })).toBeVisible()
  const contract = page.locator(".mi-contract")
  await expect(contract.getByText("altas nuevas por semana")).toBeVisible()
  await expect(contract.getByText("3 altas en 30 días")).toBeVisible()
  await expect(contract.getByText("Rotiserías de CdU")).toBeVisible()
  await expect(contract.getByText("Falta tu aprobación para enviar")).toBeVisible()
})

test("Aprobar dispara la decisión de la bandeja y de la misión", async ({ page }) => {
  await boot(page)
  await openProfile(page)
  await page.evaluate(() => {
    const internals = (window as any).__TAURI_INTERNALS__
    const calls: Array<{ command: string; args: unknown }> = []
    const original = internals.invoke
    internals.invoke = async (command: string, args: unknown) => {
      calls.push({ command, args })
      return original(command, args)
    }
    ;(window as any).qaCalls = calls
  })
  await page.getByRole("button", { name: "Aprobar" }).first().click()
  const calls = await page.evaluate(() => (window as any).qaCalls)
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ command: "agent_inbox_decide", args: expect.objectContaining({ id: "decision-1", decision: "approved" }) }),
      expect.objectContaining({ command: "agent_mission_decide", args: expect.objectContaining({ id: "mision-1", decision: "approved" }) }),
    ]),
  )
})
