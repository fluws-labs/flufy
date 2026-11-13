import { expect, test, type Page } from "@playwright/test"

async function boot(page: Page, seed: Record<string, unknown> | null = null, keepStorage = false) {
  await page.addInitScript(({ seed, keepStorage }) => {
    // keepStorage permite recargar sin borrar lo que la prueba quiere verificar.
    if (!(keepStorage && sessionStorage.getItem("qa-layout-reload"))) {
      localStorage.clear()
      localStorage.setItem("guillecode:studio.mode", JSON.stringify("code"))
      if (seed) for (const [key, value] of Object.entries(seed)) localStorage.setItem(`guillecode:${key}`, JSON.stringify(value))
      sessionStorage.setItem("qa-layout-reload", "1")
    }
    let id = 0
    Object.assign(window, { __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++id,
      unregisterCallback: () => undefined,
      invoke: async () => null,
    } })
  }, { seed, keepStorage })
  await page.route("**/test-native", (route) => route.fulfill({ json: [] }))
  await page.route("**/test-oc/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/test-oc", "")
    if (path.endsWith("/event")) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"server.connected","properties":{}}\n\n' })
    return route.fulfill({ json: [] })
  })
  await page.goto("/")
}

async function prepare(page: Page) {
  await expect(page.getByRole("button", { name: "Continuar con Flufy" })).toBeVisible()
  await page.evaluate(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke
    ;(window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: unknown) => {
      if (command === "memory_overview") return { scope: "D:/qa/studio", slug: "studio", preferences: "", overview: "", notes: [], tasks: [] }
      if (command === "teams_state") return { schemaVersion: 1, teams: [], chats: [], skills: [] }
      return original(command, args)
    }
  })
  await page.evaluate(async () => {
    const { useAgent } = await import(/* @vite-ignore */ "/src/state/agent.ts")
    const { useProject } = await import(/* @vite-ignore */ "/src/state/project.ts")
    useProject.setState({ root: "D:/qa/studio", ready: true })
    useAgent.setState({ modelsLoaded: true, modelsError: null, models: [{ providerID: "qa", modelID: "qa", providerName: "QA", name: "QA", variants: [], contextLimit: 100000 }] })
  })
}

const readLayout = (page: Page) => page.evaluate(async () => {
  const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
  const s = useLayout.getState()
  return {
    mode: s.mode,
    sidebarVisible: s.sidebarVisible,
    sidebarWidth: s.sidebarWidth,
    effectiveSidebarWidth: s.sizes.sidebarWidth,
    effectiveAgentWidth: s.sizes.agentWidth,
    activeView: s.activeView,
    panelVisible: s.panelVisible,
    panelHeight: s.panelHeight,
    panelTab: s.panelTab,
    agentVisible: s.agentVisible,
    panelMaximized: s.panelMaximized,
    focusChat: s.focusChat,
  }
})


const width = (page: Page) =>
  page.evaluate(async () => (await import(/* @vite-ignore */ "/src/state/layout.ts")).useLayout.getState().agentWidth)

test("la barra lateral permanece montada en Diseñar, Equipo e Investigar y Código está disponible", async ({ page }) => {
  await boot(page)
  await expect(page.getByRole("button", { name: "Continuar con Flufy" })).toBeVisible()
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "memory_overview") return { scope: "D:/qa/studio", slug: "studio", preferences: "", overview: "", notes: [], tasks: [] }
      if (command === "teams_state") return { schemaVersion: 1, teams: [], chats: [], skills: [] }
      return original(command, args)
    }
  })
  await page.evaluate(async () => {
    // @ts-ignore imports served by Vite
    const { useLayout } = await import("/src/state/layout.ts")
    const { useAgent } = await import(/* @vite-ignore */ "/src/state/agent.ts")
    const { useProject } = await import(/* @vite-ignore */ "/src/state/project.ts")
    useProject.setState({ root: "D:/qa/studio", ready: true })
    useAgent.setState({ modelsLoaded: true, modelsError: null, models: [{ providerID: "qa", modelID: "qa", providerName: "QA", name: "QA", variants: [], contextLimit: 100000 }] })
    useLayout.setState({ sidebarVisible: true, focusChat: false, activeView: "explorer" })
  })
  const sidebar = page.locator(".side-bar-slot")
  await expect(sidebar).toBeVisible()
  await sidebar.evaluate(element => element.setAttribute("data-sidebar-persisted", "yes"))
  for (const mode of ["Diseñar", "Equipo", "Investigar"]) {
    await page.getByRole("button", { name: mode, exact: true }).click()
    await expect(page.locator(".studio-workspace")).toBeVisible()
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toHaveAttribute("data-sidebar-persisted", "yes")
    await expect(page.locator(".activity-bar")).toBeVisible()
    await expect(page.getByRole("button", { name: "Código", exact: true })).toBeVisible()
  }
})

test("el chat en foco se puede redimensionar y vuelve a su ancho al salir", async ({ page }) => {
  await boot(page)
  const before = await width(page)
  expect(before).toBeGreaterThan(0)

  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().toggleFocusChat(true)
  })
  const focus = await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    return { width: useLayout.getState().agentWidth, win: window.innerWidth, on: useLayout.getState().focusChat }
  })
  expect(focus.on).toBe(true)
  // En foco-chat el chat puede ocupar más que el tope del modo normal (0.72 del ancho).
  expect(focus.width).toBeGreaterThan(Math.round(focus.win * 0.72))

  // Se puede achicar a mano (antes quedaba fijo).
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().setAgentWidth(420)
  })
  expect(await width(page)).toBe(420)

  // Al salir del foco vuelve al ancho previo, no al ancho expandido.
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().toggleFocusChat(false)
  })
  expect(await width(page)).toBe(before)
})

test("abrir el panel inferior cancela el foco y restaura el ancho", async ({ page }) => {
  await boot(page)
  const before = await width(page)
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().toggleFocusChat(true)
    useLayout.getState().togglePanel()
  })
  const state = await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    return { on: useLayout.getState().focusChat, width: useLayout.getState().agentWidth }
  })
  expect(state.on).toBe(false)
  expect(state.width).toBe(before)
})

test("en foco-chat con ventana angosta el ancho igual se puede mover", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 })
  await boot(page)
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().toggleFocusChat(true)
  })
  const range = await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().setAgentWidth(99999)
    const hi = useLayout.getState().agentWidth
    useLayout.getState().setAgentWidth(1)
    const lo = useLayout.getState().agentWidth
    return { hi, lo, focus: useLayout.getState().focusChat }
  })
  expect(range.focus).toBe(true)
  // Debe haber margen para agrandar y achicar (antes quedaba trabado con min == max).
  expect(range.hi).toBeGreaterThan(range.lo)
})

test("Código conserva el panel del agente al volver de Investigar", async ({ page }) => {
  await boot(page)
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    const { useProject } = await import(/* @vite-ignore */ "/src/state/project.ts")
    useProject.setState({ root: "D:/qa/studio", ready: true })
    useLayout.setState({ agentVisible: true, panelVisible: true, activeView: "scm" })
  })
  await page.getByRole("button", { name: "Investigar", exact: true }).click()
  await page.getByRole("button", { name: "Código", exact: true }).click()
  const layout = await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    const state = useLayout.getState()
    return { agentVisible: state.agentVisible, panelVisible: state.panelVisible, activeView: state.activeView }
  })
  expect(layout).toEqual({ agentVisible: true, panelVisible: true, activeView: "scm" })
})

test("cada modo recuerda su propia disposición y no contamina a los demás", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await boot(page)
  await prepare(page)

  // Código: lateral en Control de código y ancho propio.
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    const l = useLayout.getState()
    l.setSidebarWidth(300)
    l.showView("scm", false)
  })
  expect(await readLayout(page)).toMatchObject({ mode: "code", sidebarWidth: 300, activeView: "scm" })

  // Investigar: otro lateral, otra pestaña del panel y otra altura.
  await page.getByRole("button", { name: "Investigar", exact: true }).click()
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    const l = useLayout.getState()
    l.setSidebarWidth(220)
    l.showView("search", false)
    l.showPanel("output")
    l.setPanelHeight(320)
  })
  expect(await readLayout(page)).toMatchObject({ mode: "research", sidebarWidth: 220, activeView: "search", panelVisible: true, panelHeight: 320, panelTab: "output" })

  // Diseñar: un tercer lateral distinto.
  await page.getByRole("button", { name: "Diseñar", exact: true }).click()
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().setSidebarWidth(400)
    useLayout.getState().showView("prs", false)
  })
  expect(await readLayout(page)).toMatchObject({ mode: "design", sidebarWidth: 400, activeView: "prs" })

  // Al volver, cada espacio restaura lo suyo.
  await page.getByRole("button", { name: "Código", exact: true }).click()
  expect(await readLayout(page)).toMatchObject({ mode: "code", sidebarWidth: 300, activeView: "scm", panelVisible: false, panelHeight: 260, panelTab: "terminal" })
  await page.getByRole("button", { name: "Investigar", exact: true }).click()
  expect(await readLayout(page)).toMatchObject({ mode: "research", sidebarWidth: 220, activeView: "search", panelVisible: true, panelHeight: 320, panelTab: "output" })
  await page.getByRole("button", { name: "Diseñar", exact: true }).click()
  expect(await readLayout(page)).toMatchObject({ mode: "design", sidebarWidth: 400, activeView: "prs" })

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("guillecode:layout.v3") ?? "{}"))
  expect(stored.version).toBe(3)
  expect(stored.profiles.code.sidebarWidth).toBe(300)
  expect(stored.profiles.research.sidebarWidth).toBe(220)
  expect(stored.profiles.design.sidebarWidth).toBe(400)
})

test("los presets solo cambian el modo activo", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await boot(page)
  await prepare(page)

  await page.getByRole("button", { name: "Investigar", exact: true }).click()
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().applyPreset("agent")
  })
  expect(await readLayout(page)).toMatchObject({ mode: "research", sidebarVisible: false, agentVisible: true })

  await page.getByRole("button", { name: "Código", exact: true }).click()
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().toggleAgent(true)
    useLayout.getState().applyPreset("code")
  })
  expect(await readLayout(page)).toMatchObject({ mode: "code", sidebarVisible: true, agentVisible: false })

  await page.getByRole("button", { name: "Investigar", exact: true }).click()
  expect(await readLayout(page)).toMatchObject({ mode: "research", sidebarVisible: false, agentVisible: true })

  await page.getByRole("button", { name: "Diseñar", exact: true }).click()
  expect(await readLayout(page)).toMatchObject({ mode: "design", sidebarVisible: true, agentVisible: true })
})

test("migra layout.v2 a cada modo sin perder la disposición existente", async ({ page }) => {
  await boot(page, {
    "layout.v2": { sidebarVisible: true, sidebarWidth: 321, activeView: "scm", panelVisible: true, panelHeight: 333, panelTab: "output", agentVisible: false, agentWidth: 480, panelMaximized: true },
  })
  const read = await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    const s = useLayout.getState()
    return {
      mode: s.mode,
      profiles: s.profiles as Record<string, Record<string, unknown>>,
      active: { sidebarWidth: s.sidebarWidth, activeView: s.activeView, panelVisible: s.panelVisible },
    }
  })
  expect(read.mode).toBe("code")
  for (const mode of ["design", "team", "research", "code"]) {
    expect(read.profiles[mode]).toMatchObject({ sidebarWidth: 321, activeView: "scm", panelVisible: true, panelHeight: 333, panelTab: "output", agentVisible: false, agentWidth: 480, panelMaximized: true })
  }
  expect(read.active).toMatchObject({ sidebarWidth: 321, activeView: "scm", panelVisible: true })
})

test("una disposición guardada inválida cae en valores seguros", async ({ page }) => {
  await boot(page, {
    "layout.v3": { version: 3, profiles: { code: { sidebarWidth: "ancho", sidebarVisible: "sí", activeView: "fantasma", panelHeight: -5, panelTab: "otra", agentWidth: null } } },
  })
  const read = await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    const l = useLayout.getState()
    return { mode: l.mode, profile: { sidebarVisible: l.sidebarVisible, sidebarWidth: l.sidebarWidth, activeView: l.activeView, panelHeight: l.panelHeight, panelTab: l.panelTab, agentWidth: l.agentWidth, agentVisible: l.agentVisible } }
  })
  expect(read.mode).toBe("code")
  expect(read.profile).toEqual({ sidebarVisible: true, sidebarWidth: 270, activeView: "explorer", panelHeight: 120, panelTab: "terminal", agentWidth: 460, agentVisible: false })
})

test("las disposiciones por modo se conservan al recargar la app", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await boot(page, null, true)
  await prepare(page)
  await page.getByRole("button", { name: "Investigar", exact: true }).click()
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    const l = useLayout.getState()
    l.setSidebarWidth(233)
    l.showView("search", false)
    l.showPanel("terminal")
    l.setPanelHeight(300)
  })
  await page.reload()
  expect(await readLayout(page)).toMatchObject({ mode: "research", sidebarWidth: 233, activeView: "search", panelVisible: true, panelHeight: 300, panelTab: "terminal" })
})

test("achicar la ventana no destruye los anchos preferidos", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await boot(page)
  await prepare(page)
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().setSidebarWidth(520)
  })
  expect((await readLayout(page)).sidebarWidth).toBe(520)

  await page.setViewportSize({ width: 620, height: 800 })
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().fitToViewport()
  })
  const small = await readLayout(page)
  expect(small.sidebarWidth).toBe(520)
  expect(small.effectiveSidebarWidth).toBeLessThan(520)

  await page.setViewportSize({ width: 1400, height: 900 })
  await page.evaluate(async () => {
    const { useLayout } = await import(/* @vite-ignore */ "/src/state/layout.ts")
    useLayout.getState().fitToViewport()
  })
  const large = await readLayout(page)
  expect(large.sidebarWidth).toBe(520)
  expect(large.effectiveSidebarWidth).toBe(520)
})
