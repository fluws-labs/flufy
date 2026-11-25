import { create } from "zustand"
import { call, errorMessage, isTauri, onEvent } from "../lib/tauri"

export type AgentLogEntry = { at: number; kind: string; text: string; session?: string }

export type AgentInboxItem = {
  id: string
  at: number
  kind: string
  title: string
  body: string
  session?: string
  directory?: string
  untrusted: boolean
  ackedAt?: number
  missionId?: string
  decision?: string
  expiresAt?: number
  preview?: string
  risk?: string
  cause?: string
  options?: string[]
  recommendation?: string
  defaultAction?: string
  scope?: string
  runId?: string
  dedupeKey?: string
}

export type AgentMissionSchedule =
  | { kind: "interval"; hours: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "continuous"; cooldownMinutes: number }

export type AgentMissionStep = {
  title: string
  status: string
}

export type AgentMissionProgress = {
  objective: string
  plan: AgentMissionStep[]
  done: string[]
  next: string
  blockers: string[]
  decisions: string[]
  artifacts: string[]
  advanced: boolean
  updatedAt: number
}

export type AgentMissionBrief = {
  headline: string
  summary: string
  findings: string[]
  decisions: string[]
  confidence?: string | null
  sources: string[]
  sessionId?: string | null
  createdAt: number
}

export type AgentMissionRun = {
  id: string
  previousRunId?: string | null
  sessionId?: string | null
  startedAt: number
  finishedAt: number
  status: string
  summary?: string | null
  error?: string | null
  progress?: AgentMissionProgress | null
  phase?: string | null
  outcome?: string | null
  blockedReason?: string | null
  durationMs?: number
  tokens?: number
}

export type AgentMissionGrants = {
  read: string
  writeRepo: string
  merge: string
  deploy: string
  prodWrite: string
  send: string
  spend: string
  sendPerWeek: number
  spendLimit: number
  updatedAt?: number
}

export type AgentMission = {
  version: number
  id: string
  title: string
  goal: string
  project?: string | null
  status: string
  playbook?: string | null
  model?: { providerID: string; modelID: string } | null
  autonomy?: string | null
  reviewModel?: { providerID: string; modelID: string } | null
  autoBrief?: boolean
  botId?: string | null
  originSessionId?: string | null
  originRoutineId?: string | null
  artifacts?: Array<{ kind?: string; title?: string; url?: string; path?: string; verified?: boolean }>
  schedule: AgentMissionSchedule
  budget: { minutesPerRun: number; runsPerDay: number; tokensPerDay: number; costPerDayCents?: number }
  policy: { reads: string; drafts: string; commits: string }
  grants?: AgentMissionGrants
  metric?: string
  target?: string
  activeBet?: string
  windowEnd?: number | null
  windowOnly?: boolean
  template?: string | null
  state: {
    nextRunAt?: number | null
    lastRunAt?: number | null
    lastStatus?: string | null
    lastError?: string | null
    phase?: string | null
    blockedReason?: string | null
    tokensToday?: number
    windowEndFired?: boolean
    brief?: AgentMissionBrief | null
    runs?: AgentMissionRun[]
    attempts: number
    sessionId?: string | null
    pendingInboxId?: string | null
    runsToday: number
    runsDate?: string | null
    progress?: AgentMissionProgress | null
    pausedByBot?: boolean
    stopRequested?: boolean
    noProgressRuns?: number
    failures?: number
  }
  createdAt: number
  updatedAt: number
}

export type AgentAbsenceCheck = {
  id: string
  status: "ok" | "warn" | "fail" | string
  detail: string
  fix?: string
}

export type AgentAbsence = {
  enabled: boolean
  startedAt?: number | null
  expiresAt?: number | null
  ready: boolean
  checks: AgentAbsenceCheck[]
  updated?: string | null
}

// El backend guarda las fechas como ISO 8601; la vista trabaja con epoch ms.
type RawLogEntry = { at?: string | number; kind?: string; text?: string; session?: string | null }
type RawInboxItem = {
  id?: string
  at?: string | number
  kind?: string
  title?: string
  body?: string
  session?: string | null
  directory?: string | null
  untrusted?: boolean
  ackedAt?: string | number | null
  missionId?: string | null
  decision?: string | null
  expiresAt?: string | number | null
  preview?: string | null
  risk?: string | null
  cause?: string | null
  options?: string[] | null
  recommendation?: string | null
  defaultAction?: string | null
  scope?: string | null
  runId?: string | null
  dedupeKey?: string | null
}

function epoch(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "string") {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? ms : 0
  }
  return 0
}

function toLogEntry(raw: RawLogEntry): AgentLogEntry {
  return {
    at: epoch(raw.at),
    kind: raw.kind?.trim() || "done",
    text: raw.text ?? "",
    session: raw.session ?? undefined,
  }
}

function toInboxItem(raw: RawInboxItem): AgentInboxItem {
  return {
    id: raw.id ?? "",
    at: epoch(raw.at),
    kind: raw.kind ?? "insight",
    title: raw.title ?? "",
    body: raw.body ?? "",
    session: raw.session ?? undefined,
    directory: raw.directory ?? undefined,
    untrusted: !!raw.untrusted,
    ackedAt: raw.ackedAt == null ? undefined : epoch(raw.ackedAt),
    missionId: raw.missionId ?? undefined,
    decision: raw.decision ?? undefined,
    expiresAt: raw.expiresAt == null ? undefined : epoch(raw.expiresAt),
    preview: raw.preview ?? undefined,
    risk: raw.risk ?? undefined,
    cause: raw.cause ?? undefined,
    options: Array.isArray(raw.options) ? raw.options : undefined,
    recommendation: raw.recommendation ?? undefined,
    defaultAction: raw.defaultAction ?? undefined,
    scope: raw.scope ?? undefined,
    runId: raw.runId ?? undefined,
    dedupeKey: raw.dedupeKey ?? undefined,
  }
}

type AgentProfileState = {
  profile: string
  firstRun: boolean
  log: AgentLogEntry[]
  inbox: AgentInboxItem[]
  pulse: boolean
  missions: AgentMission[]
  absence: AgentAbsence | null
  loaded: boolean
  error: string | null
  inboxError: string | null
  pulseError: string | null
  missionsError: string | null
  absenceError: string | null
  saving: boolean
  savedAt: number | null
  dismissing: string | null
  busyMission: string | null
  preparingAbsence: boolean
}

export const useAgentProfile = create<AgentProfileState>(() => ({
  profile: "",
  firstRun: false,
  log: [],
  inbox: [],
  pulse: false,
  missions: [],
  absence: null,
  loaded: false,
  error: null,
  inboxError: null,
  pulseError: null,
  missionsError: null,
  absenceError: null,
  saving: false,
  savedAt: null,
  dismissing: null,
  busyMission: null,
  preparingAbsence: false,
}))

let startVersion = 0
let started = false
let timer: ReturnType<typeof setInterval> | null = null

export async function loadAgentProfile(): Promise<void> {
  if (!isTauri) return
  const version = ++startVersion
  try {
    const [data, log] = await Promise.all([
      call<{ profile: string; firstRun: boolean }>("agent_profile_get"),
      call<{ entries: RawLogEntry[] }>("agent_log_list", { limit: 20 }),
    ])
    if (version !== startVersion) return
    useAgentProfile.setState({
      profile: data.profile ?? "",
      firstRun: !!data.firstRun,
      log: Array.isArray(log?.entries) ? log.entries.map(toLogEntry) : [],
      loaded: true,
      error: null,
    })
  } catch (e) {
    if (version === startVersion) useAgentProfile.setState({ loaded: true, error: errorMessage(e) })
  }
}

export async function saveAgentProfile(profile: string): Promise<boolean> {
  if (!isTauri) return false
  useAgentProfile.setState({ saving: true, error: null })
  try {
    await call<{ ok: boolean }>("agent_profile_set", { profile })
    // Descarta lecturas en vuelo que traerían el perfil anterior.
    startVersion++
    useAgentProfile.setState({ profile, firstRun: false, saving: false, savedAt: Date.now() })
    return true
  } catch (e) {
    useAgentProfile.setState({ saving: false, error: errorMessage(e) })
    return false
  }
}

export async function loadAgentInbox(): Promise<void> {
  if (!isTauri) return
  try {
    const data = await call<{ items: RawInboxItem[]; count: number }>("agent_inbox_state")
    useAgentProfile.setState({
      inbox: Array.isArray(data?.items) ? data.items.map(toInboxItem).filter((item) => item.id && item.title) : [],
      inboxError: null,
    })
  } catch (e) {
    useAgentProfile.setState({ inboxError: errorMessage(e) })
  }
}

export async function dismissAgentInboxItem(id: string): Promise<void> {
  if (!isTauri) return
  useAgentProfile.setState({ dismissing: id, inboxError: null })
  try {
    await call<{ ok: boolean }>("agent_inbox_ack", { id })
    await loadAgentInbox()
  } catch (e) {
    useAgentProfile.setState({ inboxError: errorMessage(e) })
  } finally {
    useAgentProfile.setState({ dismissing: null })
  }
}

export async function decideAgentInboxItem(item: AgentInboxItem, decision: "approved" | "rejected" | "resume"): Promise<void> {
  if (!isTauri) return
  useAgentProfile.setState({ dismissing: item.id, inboxError: null })
  try {
    await call("agent_inbox_decide", { id: item.id, decision })
    if (item.missionId) {
      await call("agent_mission_decide", { id: item.missionId, decision, ...(decision === "resume" ? {} : { title: item.title }) }).catch(() => undefined)
    }
    await loadAgentInbox()
    await loadAgentMissions()
  } catch (e) {
    useAgentProfile.setState({ inboxError: errorMessage(e) })
  } finally {
    useAgentProfile.setState({ dismissing: null })
  }
}
export async function loadAgentPulse(): Promise<void> {
  if (!isTauri) return
  try {
    const data = await call<{ enabled: boolean }>("agent_pulse_get")
    useAgentProfile.setState({ pulse: !!data?.enabled, pulseError: null })
  } catch (e) {
    useAgentProfile.setState({ pulseError: errorMessage(e) })
  }
}

export async function setAgentPulse(enabled: boolean): Promise<void> {
  if (!isTauri) return
  useAgentProfile.setState({ pulseError: null })
  try {
    const data = await call<{ enabled: boolean }>("agent_pulse_set", { enabled })
    useAgentProfile.setState({ pulse: !!data?.enabled })
  } catch (e) {
    useAgentProfile.setState({ pulseError: errorMessage(e) })
  }
}

export function pendingInboxCount(items: AgentInboxItem[]): number {
  return items.reduce((total, item) => total + (item.ackedAt == null ? 1 : 0), 0)
}

export async function loadAgentMissions(): Promise<void> {
  if (!isTauri) return
  try {
    const data = await call<AgentMission[]>("agent_missions_list")
    useAgentProfile.setState({ missions: Array.isArray(data) ? data : [], missionsError: null })
  } catch (e) {
    useAgentProfile.setState({ missionsError: errorMessage(e) })
  }
}

export async function saveAgentMission(mission: Record<string, unknown>): Promise<AgentMission | null> {
  if (!isTauri) return null
  try {
    const saved = await call<AgentMission>("agent_mission_save", { mission })
    await loadAgentMissions()
    return saved
  } catch (e) {
    useAgentProfile.setState({ missionsError: errorMessage(e) })
    return null
  }
}

export async function deleteAgentMission(id: string): Promise<void> {
  if (!isTauri) return
  try {
    await call("agent_mission_delete", { id })
    await loadAgentMissions()
  } catch (e) {
    useAgentProfile.setState({ missionsError: errorMessage(e) })
  }
}

export async function runAgentMission(id: string): Promise<void> {
  if (!isTauri) return
  useAgentProfile.setState({ busyMission: id, missionsError: null })
  try {
    await call("agent_mission_run", { id })
    await loadAgentMissions()
  } catch (e) {
    useAgentProfile.setState({ missionsError: errorMessage(e) })
  } finally {
    useAgentProfile.setState({ busyMission: null })
  }
}

export async function resumeAgentMission(id: string, note?: string): Promise<void> {
  if (!isTauri) return
  useAgentProfile.setState({ busyMission: id, missionsError: null })
  try {
    await call("agent_mission_decide", { id, decision: "resume", ...(note?.trim() ? { title: note.trim() } : {}) })
    await loadAgentMissions()
    await loadAgentInbox()
  } catch (e) {
    useAgentProfile.setState({ missionsError: errorMessage(e) })
  } finally {
    useAgentProfile.setState({ busyMission: null })
  }
}

export async function generateAgentMissionBrief(id: string): Promise<AgentMissionBrief | null> {
  if (!isTauri) return null
  useAgentProfile.setState({ busyMission: id, missionsError: null })
  try {
    const brief = await call<AgentMissionBrief>("agent_mission_brief", { id })
    await loadAgentMissions()
    await loadAgentInbox()
    return brief
  } catch (e) {
    useAgentProfile.setState({ missionsError: errorMessage(e) })
    return null
  } finally {
    useAgentProfile.setState({ busyMission: null })
  }
}
export async function loadAgentAbsence(): Promise<void> {
  if (!isTauri) return
  try {
    const data = await call<AgentAbsence>("agent_absence_status")
    useAgentProfile.setState({ absence: data ?? null, absenceError: null })
  } catch (e) {
    useAgentProfile.setState({ absenceError: errorMessage(e) })
  }
}

export async function prepareAgentAbsence(): Promise<void> {
  if (!isTauri) return
  useAgentProfile.setState({ preparingAbsence: true, absenceError: null })
  try {
    const data = await call<AgentAbsence>("agent_absence_prepare")
    useAgentProfile.setState({ absence: data ?? null })
    await loadAgentMissions()
  } catch (e) {
    useAgentProfile.setState({ absenceError: errorMessage(e) })
  } finally {
    useAgentProfile.setState({ preparingAbsence: false })
  }
}

export async function stopAgentAbsence(): Promise<void> {
  if (!isTauri) return
  useAgentProfile.setState({ preparingAbsence: true, absenceError: null })
  try {
    const data = await call<AgentAbsence>("agent_absence_stop")
    useAgentProfile.setState({ absence: data ?? null })
  } catch (e) {
    useAgentProfile.setState({ absenceError: errorMessage(e) })
  } finally {
    useAgentProfile.setState({ preparingAbsence: false })
  }
}

// Arranca el refresco de la bandeja: cada 15 s y cuando el agente publica un
// cambio. El contador de la barra lateral vive fuera de la vista, por eso se
// inicia con el workbench y no solo al abrir Flufy Bots.
export function startAgentProfile(): void {
  if (started || !isTauri) return
  started = true
  void loadAgentProfile()
  void loadAgentInbox()
  void loadAgentPulse()
  void loadAgentMissions()
  void loadAgentAbsence()
  timer = setInterval(() => {
    void loadAgentProfile()
    void loadAgentInbox()
    void loadAgentMissions()
    void loadAgentAbsence()
  }, 15000)
  onEvent("agent://inbox-changed", () => void loadAgentInbox())
  onEvent("agent://missions-changed", () => void loadAgentMissions())
}

export function stopAgentProfile(): void {
  if (timer) clearInterval(timer)
  timer = null
  started = false
}
