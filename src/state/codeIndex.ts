import { create } from "zustand"
import { call, errorMessage, isTauri } from "../lib/tauri"
import { notify } from "./toasts"

export type CodeIndexConfig = {
  enabled: boolean
  refreshMinutes: number
  maxFiles: number
  maxFileBytes: number
  include: string
  exclude: string
}

export type CodeIndexStatus = {
  enabled: boolean
  root: string
  files: number
  symbols: number
  chunks: number
  updated: number
  busy: boolean
}

export type CodeSearchHit = {
  path: string
  startLine: number
  endLine: number
  score: number
  reason: string
  snippet: string
  symbols: string[]
}

type State = {
  config: CodeIndexConfig | null
  status: CodeIndexStatus | null
  loading: boolean
  saving: boolean
  rebuilding: boolean
  error: string | null
  query: string
  hits: CodeSearchHit[]
  searching: boolean
}

export const useCodeIndex = create<State>(() => ({
  config: null,
  status: null,
  loading: false,
  saving: false,
  rebuilding: false,
  error: null,
  query: "",
  hits: [],
  searching: false,
}))

export async function loadCodeIndex(): Promise<void> {
  if (!isTauri) return
  useCodeIndex.setState({ loading: true, error: null })
  try {
    const [config, status] = await Promise.all([call<CodeIndexConfig>("code_index_get"), call<CodeIndexStatus>("code_index_status")])
    useCodeIndex.setState({ config, status, loading: false })
  } catch (e) {
    useCodeIndex.setState({ loading: false, error: errorMessage(e) })
  }
}

export async function saveCodeIndex(patch: Partial<CodeIndexConfig>): Promise<void> {
  const current = useCodeIndex.getState().config
  if (!current) return
  useCodeIndex.setState({ saving: true, error: null })
  try {
    const config = await call<CodeIndexConfig>("code_index_set", { config: { ...current, ...patch } })
    useCodeIndex.setState({ config })
    notify.success("Índice actualizado", "La próxima búsqueda del agente usa esta configuración.")
    const status = await call<CodeIndexStatus>("code_index_status").catch(() => null)
    useCodeIndex.setState({ status })
  } catch (e) {
    useCodeIndex.setState({ error: errorMessage(e) })
    notify.error("No se pudo guardar el índice", errorMessage(e))
  } finally {
    useCodeIndex.setState({ saving: false })
  }
}

export async function rebuildCodeIndex(): Promise<void> {
  useCodeIndex.setState({ rebuilding: true, error: null })
  try {
    const status = await call<CodeIndexStatus>("code_index_rebuild")
    useCodeIndex.setState({ status })
    notify.success("Índice reconstruido", `${status.files} archivos, ${status.symbols} símbolos.`)
  } catch (e) {
    useCodeIndex.setState({ error: errorMessage(e) })
    notify.error("No se pudo reconstruir el índice", errorMessage(e))
  } finally {
    useCodeIndex.setState({ rebuilding: false })
  }
}

export async function searchCodeIndex(query: string): Promise<void> {
  const value = query.trim()
  if (!value) {
    useCodeIndex.setState({ hits: [] })
    return
  }
  useCodeIndex.setState({ searching: true, error: null, query: value })
  try {
    const hits = await call<CodeSearchHit[]>("code_index_search", { query: value, limit: 12 })
    useCodeIndex.setState({ hits, searching: false })
  } catch (e) {
    useCodeIndex.setState({ searching: false, error: errorMessage(e), hits: [] })
  }
}
