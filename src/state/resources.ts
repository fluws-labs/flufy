import { create } from "zustand"
import { call, errorMessage, isTauri, onEvent } from "../lib/tauri"
import { notify } from "./toasts"

export type ResourcePressure = "normal" | "tight" | "critical"

export type ResourceSnapshot = {
  totalMemoryMb: number
  availableMemoryMb: number
  commitLimitMb: number
  commitAvailableMb: number
  cpuPercent: number
  processCount: number
  otherFlufyInstances: number
  pressure: ResourcePressure
  updatedAt: number
}

export type ResourceConfig = {
  autoThrottle: boolean
  reserveCommitMb: number
  reserveMemoryMb: number
  perAgentMb: number
  maxAgents: number
}

type State = {
  status: ResourceSnapshot | null
  config: ResourceConfig | null
  loading: boolean
  saving: boolean
  error: string | null
}

export const useResources = create<State>(() => ({
  status: null,
  config: null,
  loading: false,
  saving: false,
  error: null,
}))

export async function loadResources(): Promise<void> {
  if (!isTauri) return
  useResources.setState({ loading: true })
  try {
    const [status, config] = await Promise.all([
      call<ResourceSnapshot>("resources_status"),
      call<ResourceConfig>("resources_config_get"),
    ])
    useResources.setState({ status, config, loading: false, error: null })
  } catch (e) {
    useResources.setState({ loading: false, error: errorMessage(e) })
  }
}

export async function saveResourceConfig(patch: Partial<ResourceConfig>): Promise<void> {
  const current = useResources.getState().config
  if (!current) return
  useResources.setState({ saving: true, error: null })
  try {
    const config = await call<ResourceConfig>("resources_config_set", { config: { ...current, ...patch } })
    useResources.setState({ config, saving: false })
    notify.success("Recursos actualizados", "Flufy ajusta la concurrencia según la memoria disponible.")
  } catch (e) {
    useResources.setState({ saving: false, error: errorMessage(e) })
    notify.error("No se pudo guardar", errorMessage(e))
  }
}

let started = false

export function startResources(): void {
  if (started || !isTauri) return
  started = true
  void loadResources()
  onEvent<ResourceSnapshot>("resources://changed", (status) => useResources.setState({ status }))
  window.setInterval(() => { if (document.visibilityState === "visible") void loadResources() }, 5_000)
}
