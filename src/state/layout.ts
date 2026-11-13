import { create } from "zustand"
import { loadJson, saveJson } from "../lib/persist"
import { isStudioMode, STUDIO_MODES, type StudioMode } from "./studioModes"

export type ViewId = "explorer" | "search" | "scm" | "agents" | "prs" | "routines" | "memory" | "teams"
export type PanelTab = "terminal" | "output"

/** Disposición que cada modo de trabajo recuerda por separado. */
export type LayoutProfile = {
  sidebarVisible: boolean
  sidebarWidth: number
  activeView: ViewId
  panelVisible: boolean
  panelHeight: number
  panelTab: PanelTab
  agentVisible: boolean
  agentWidth: number
  panelMaximized: boolean
}

type LayoutData = LayoutProfile & {
  focusChat: boolean
  /** Ancho del agente antes de entrar en foco-chat, para restaurarlo al salir. */
  agentWidthBeforeFocus: number | null
}

type Sizes = Pick<LayoutProfile, "sidebarWidth" | "agentWidth" | "panelHeight">

type LayoutState = LayoutData & {
  /** Modo cuya disposición se está mostrando. */
  mode: StudioMode
  profiles: Record<StudioMode, LayoutProfile>
  /** Tamaños efectivos, limitados por la ventana actual. */
  sizes: Sizes
  setModeLayout: (mode: StudioMode) => void
  toggleSidebar: () => void
  showView: (view: ViewId, toggle?: boolean) => void
  togglePanel: () => void
  showPanel: (tab: PanelTab) => void
  toggleAgent: (visible?: boolean) => void
  setSidebarWidth: (w: number) => void
  setPanelHeight: (h: number) => void
  setAgentWidth: (w: number) => void
  togglePanelMaximized: () => void
  toggleFocusChat: (on?: boolean) => void
  applyPreset: (preset: "balanced" | "agent" | "code" | "review") => void
  fitToViewport: () => void
}

const STORAGE_KEY = "layout.v3"
const LEGACY_KEY = "layout.v2"

const DEFAULT_PROFILE: LayoutProfile = {
  sidebarVisible: true,
  sidebarWidth: 270,
  activeView: "explorer",
  panelVisible: false,
  panelHeight: 260,
  panelTab: "terminal",
  agentVisible: true,
  agentWidth: 460,
  panelMaximized: false,
}

// El modo Código arranca con el agente oculto; los modos de estudio muestran su
// conversación dentro de la superficie y no usan el panel lateral del agente.
const MODE_DEFAULTS: Record<StudioMode, LayoutProfile> = {
  design: DEFAULT_PROFILE,
  team: DEFAULT_PROFILE,
  research: DEFAULT_PROFILE,
  code: { ...DEFAULT_PROFILE, agentVisible: false },
}

export const SIDEBAR_MIN = 180
export const SIDEBAR_MAX = 640
export const AGENT_MIN = 320
export const AGENT_MAX_RATIO = 0.72
export const PANEL_MIN = 120

const ACTIVITY_W = 48
const SASH_W = 4
export const CENTER_MIN = 300
const PANEL_VERTICAL_MARGIN = 200

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback)
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max))

// Un layout guardado con una vista que ya no existe (p. ej. "plane") dejaría
// el sidebar en blanco: se vuelve a la vista por defecto.
const KNOWN_VIEWS: readonly string[] = ["explorer", "search", "scm", "agents", "prs", "routines", "memory", "teams"]

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

function sanitizeProfile(raw: unknown, fallback: LayoutProfile): LayoutProfile {
  if (!isRecord(raw)) return { ...fallback }
  return {
    sidebarVisible: typeof raw.sidebarVisible === "boolean" ? raw.sidebarVisible : fallback.sidebarVisible,
    sidebarWidth: Math.round(clamp(num(raw.sidebarWidth, fallback.sidebarWidth), SIDEBAR_MIN, SIDEBAR_MAX)),
    activeView: typeof raw.activeView === "string" && KNOWN_VIEWS.includes(raw.activeView) ? (raw.activeView as ViewId) : fallback.activeView,
    panelVisible: typeof raw.panelVisible === "boolean" ? raw.panelVisible : fallback.panelVisible,
    panelHeight: Math.max(PANEL_MIN, Math.round(num(raw.panelHeight, fallback.panelHeight))),
    panelTab: raw.panelTab === "output" || raw.panelTab === "terminal" ? raw.panelTab : fallback.panelTab,
    agentVisible: typeof raw.agentVisible === "boolean" ? raw.agentVisible : fallback.agentVisible,
    agentWidth: Math.max(AGENT_MIN, Math.round(num(raw.agentWidth, fallback.agentWidth))),
    panelMaximized: typeof raw.panelMaximized === "boolean" ? raw.panelMaximized : fallback.panelMaximized,
  }
}

function loadProfiles(): Record<StudioMode, LayoutProfile> {
  const stored = loadJson<unknown>(STORAGE_KEY, null)
  const storedProfiles = isRecord(stored) && isRecord(stored.profiles) ? stored.profiles : null
  const legacy = loadJson<unknown>(LEGACY_KEY, null)
  const seedLegacy = isRecord(legacy) && Object.keys(legacy).length > 0
  const profiles = {} as Record<StudioMode, LayoutProfile>
  for (const mode of STUDIO_MODES) {
    // Una única disposición compartida se copia a los cuatro modos para que el
    // primer arranque con perfiles no cambie lo que el usuario ya tenía.
    const seeded = seedLegacy ? sanitizeProfile(legacy, MODE_DEFAULTS[mode]) : MODE_DEFAULTS[mode]
    profiles[mode] = sanitizeProfile(storedProfiles?.[mode], seeded)
  }
  return profiles
}

// Rango permitido del ancho del agente. En foco-chat el centro no se renderiza,
// así que el chat puede ocupar todo lo que sobra a la derecha del sidebar; su
// mínimo baja si la ventana es angosta, dejando siempre margen para moverlo.
function agentRange(s: Pick<LayoutData, "focusChat" | "sidebarVisible" | "sidebarWidth">, winW: number): [number, number] {
  const chrome = ACTIVITY_W + (s.sidebarVisible ? SASH_W : 0) + SASH_W
  const avail = winW - chrome - (s.sidebarVisible ? s.sidebarWidth : 0)
  if (s.focusChat) {
    const max = Math.max(160, avail)
    const min = Math.min(AGENT_MIN, Math.max(160, avail - 40))
    return [Math.min(min, max), max]
  }
  return [AGENT_MIN, Math.max(AGENT_MIN, Math.min(winW * AGENT_MAX_RATIO, avail - CENTER_MIN))]
}

// Nunca dejamos que los anchos persistidos (o el preset "Foco en el agente")
// achiquen la columna del editor por debajo de CENTER_MIN: con el chat y la
// terminal abiertos esa columna es la que colapsaba y rompía la UI.
function clampToViewport(s: Pick<LayoutData, "focusChat" | "sidebarVisible" | "sidebarWidth" | "agentVisible" | "agentWidth" | "panelHeight">): Sizes {
  const winW = window.innerWidth || 1280
  const winH = window.innerHeight || 800
  let sidebar = num(s.sidebarWidth, DEFAULT_PROFILE.sidebarWidth)
  let agent = num(s.agentWidth, DEFAULT_PROFILE.agentWidth)
  if (s.sidebarVisible) sidebar = clamp(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  if (s.focusChat && s.sidebarVisible) {
    // En foco el sidebar cede espacio para que el chat quepa sin desbordar.
    const total = winW - (ACTIVITY_W + SASH_W + SASH_W)
    sidebar = Math.min(sidebar, Math.max(SIDEBAR_MIN, total - AGENT_MIN))
  }
  if (s.agentVisible) {
    const [lo, hi] = agentRange({ ...s, sidebarWidth: sidebar }, winW)
    agent = clamp(agent, lo, hi)
  }
  const panelHeight = clamp(num(s.panelHeight, DEFAULT_PROFILE.panelHeight), PANEL_MIN, winH - PANEL_VERTICAL_MARGIN)
  if (s.focusChat) return { sidebarWidth: Math.round(sidebar), agentWidth: Math.round(agent), panelHeight }
  const chrome = ACTIVITY_W + (s.sidebarVisible ? SASH_W : 0) + (s.agentVisible ? SASH_W : 0)
  const avail = winW - chrome - CENTER_MIN
  if (s.sidebarVisible && s.agentVisible && sidebar + agent > avail) {
    const over = sidebar + agent - avail
    const agentCut = Math.min(over, agent - AGENT_MIN)
    agent -= agentCut
    const rest = over - agentCut
    if (rest > 0) sidebar = Math.max(SIDEBAR_MIN, sidebar - rest)
  } else if (s.sidebarVisible && !s.agentVisible) {
    sidebar = Math.min(sidebar, Math.max(SIDEBAR_MIN, avail))
  } else if (s.agentVisible && !s.sidebarVisible) {
    agent = Math.min(agent, Math.max(AGENT_MIN, avail))
  }
  return { sidebarWidth: Math.round(sidebar), agentWidth: Math.round(agent), panelHeight }
}

function profileOf(s: Pick<LayoutState, keyof LayoutProfile | "focusChat" | "agentWidthBeforeFocus">): LayoutProfile {
  return {
    sidebarVisible: s.sidebarVisible,
    sidebarWidth: s.sidebarWidth,
    activeView: s.activeView,
    panelVisible: s.panelVisible,
    panelHeight: s.panelHeight,
    panelTab: s.panelTab,
    agentVisible: s.agentVisible,
    // En foco-chat el ancho mostrado es el expandido; el modo guarda el normal.
    agentWidth: s.focusChat ? (s.agentWidthBeforeFocus ?? s.agentWidth) : s.agentWidth,
    panelMaximized: s.panelMaximized,
  }
}

const PROFILES = loadProfiles()
const STORED_MODE = loadJson<unknown>("studio.mode", "research")
const INITIAL_MODE: StudioMode = isStudioMode(STORED_MODE) ? STORED_MODE : "research"
const INITIAL: LayoutData = { ...PROFILES[INITIAL_MODE], focusChat: false, agentWidthBeforeFocus: null }

export const useLayout = create<LayoutState>((set, get) => ({
  ...INITIAL,
  mode: INITIAL_MODE,
  profiles: PROFILES,
  sizes: clampToViewport(INITIAL),
  setModeLayout: (mode) => {
    const s = get()
    if (s.mode === mode) return
    const profiles = { ...s.profiles, [s.mode]: profileOf(s) }
    const next = profiles[mode] ?? MODE_DEFAULTS[mode]
    set({
      ...next,
      mode,
      profiles,
      focusChat: false,
      agentWidthBeforeFocus: null,
      sizes: clampToViewport({ ...next, focusChat: false }),
    })
  },
  toggleSidebar: () => {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }))
    get().fitToViewport()
  },
  showView: (view, toggle = true) => {
    const s = get()
    if (toggle && s.sidebarVisible && s.activeView === view) set({ sidebarVisible: false })
    else set({ activeView: view, sidebarVisible: true })
    get().fitToViewport()
  },
  togglePanel: () => {
    set((s) => ({
      panelVisible: !s.panelVisible,
      panelMaximized: s.panelVisible ? false : s.panelMaximized,
      ...(s.panelVisible ? {} : { focusChat: false, agentWidth: s.agentWidthBeforeFocus ?? s.agentWidth, agentWidthBeforeFocus: null }),
    }))
    get().fitToViewport()
  },
  showPanel: (tab) => {
    set((s) => ({ panelVisible: true, panelTab: tab, focusChat: false, agentWidth: s.agentWidthBeforeFocus ?? s.agentWidth, agentWidthBeforeFocus: null }))
    get().fitToViewport()
  },
  toggleAgent: (visible) => {
    set((s) => {
      const next = visible ?? !s.agentVisible
      const focusChat = next ? s.focusChat : false
      const restore = s.focusChat && !focusChat ? { agentWidth: s.agentWidthBeforeFocus ?? s.agentWidth, agentWidthBeforeFocus: null } : {}
      return { agentVisible: next, focusChat, ...restore }
    })
    get().fitToViewport()
  },
  setSidebarWidth: (w) => {
    const s = get()
    const chrome = ACTIVITY_W + (s.agentVisible ? SASH_W : 0) + SASH_W
    const avail = window.innerWidth - chrome - (s.agentVisible ? s.sizes.agentWidth : 0) - CENTER_MIN
    set({ sidebarWidth: Math.round(clamp(w, SIDEBAR_MIN, Math.min(SIDEBAR_MAX, avail))) })
    get().fitToViewport()
  },
  setPanelHeight: (h) => {
    set({ panelHeight: Math.round(clamp(h, PANEL_MIN, window.innerHeight - PANEL_VERTICAL_MARGIN)) })
    get().fitToViewport()
  },
  setAgentWidth: (w) => {
    const s = get()
    const [lo, hi] = agentRange({ ...s, sidebarWidth: s.sizes.sidebarWidth }, window.innerWidth)
    set({ agentWidth: Math.round(clamp(w, lo, hi)) })
    get().fitToViewport()
  },
  togglePanelMaximized: () => set((s) => ({ panelMaximized: !s.panelMaximized, panelVisible: true })),
  toggleFocusChat: (on) => {
    set((s) => {
      const next = on ?? !s.focusChat
      if (next === s.focusChat) return {}
      if (next) {
        return {
          focusChat: true,
          agentVisible: true,
          agentWidthBeforeFocus: s.agentWidth,
          agentWidth: Math.round(agentRange({ ...s, sidebarWidth: s.sizes.sidebarWidth, focusChat: true }, window.innerWidth)[1]),
        }
      }
      return { focusChat: false, agentWidth: s.agentWidthBeforeFocus ?? s.agentWidth, agentWidthBeforeFocus: null }
    })
    get().fitToViewport()
  },
  applyPreset: (preset) => {
    const width = window.innerWidth
    if (preset === "agent") set({ agentVisible: true, sidebarVisible: false, agentWidth: Math.round(width * 0.62), focusChat: false, agentWidthBeforeFocus: null })
    else if (preset === "code") set({ agentVisible: false, sidebarVisible: true, focusChat: false, agentWidthBeforeFocus: null })
    else if (preset === "review") set({ agentVisible: true, sidebarVisible: true, activeView: "scm", agentWidth: 400, focusChat: false, agentWidthBeforeFocus: null })
    else set({ agentVisible: true, sidebarVisible: true, agentWidth: DEFAULT_PROFILE.agentWidth, sidebarWidth: DEFAULT_PROFILE.sidebarWidth, focusChat: false, agentWidthBeforeFocus: null })
    get().fitToViewport()
  },
  fitToViewport: () => set({ sizes: clampToViewport(get()) }),
}))

useLayout.subscribe((s) => {
  saveJson(STORAGE_KEY, { version: 3, profiles: { ...s.profiles, [s.mode]: profileOf(s) } })
})
