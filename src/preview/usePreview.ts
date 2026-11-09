import { useCallback, useEffect, useRef, useState } from "react"
import { errorMessage, onEvent } from "../lib/tauri"
import { previewClient } from "./client"
import type { PreviewChange, PreviewClient, PreviewIdentity, PreviewState } from "./types"
import { previewIdentityKey } from "./types"
import { assertIdentity, currentRevision } from "./state"
import { PreviewConflictError } from "./document"

export function usePreview(identity: PreviewIdentity, client: PreviewClient = previewClient) {
  const key = previewIdentityKey(identity)
  const active = useRef(key); active.current = key
  const generation = useRef(0), locked = useRef(false)
  const [snapshot, setSnapshot] = useState<{ key: string; value: PreviewState | null }>({ key, value: null })
  const state = snapshot.key === key ? snapshot.value : null
  const latest = useRef(state); latest.current = state
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(key)
  const refresh = useCallback(async () => {
    if (locked.current) return
    const ticket = ++generation.current
    setLoadingKey(key)
    try {
      const next = await client.load(identity)
      if (active.current === key && ticket === generation.current) { setSnapshot({ key, value: next ? assertIdentity(next, identity) : null }); setFailure(null) }
    } catch (e) { if (active.current === key && ticket === generation.current) setFailure({ key, message: errorMessage(e) }) }
    finally { if (active.current === key && ticket === generation.current) setLoadingKey(null) }
  }, [key, client]) // Identity values are represented by key.
  useEffect(() => {
    locked.current = false; setBusyKey(null); void refresh()
    // preview://changed carries the full persisted Design (with a canonicalized
    // projectRoot). Reload from the persistence authority instead of trusting
    // the payload; agent tool writes may also originate in a separate process.
    const unsubscribe = onEvent("preview://changed", () => { void refresh() })
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 4000)
    return () => { generation.current++; unsubscribe(); window.clearInterval(timer) }
  }, [key, refresh])
  const transact = useCallback(async (fn: () => Promise<PreviewState>) => {
    if (locked.current || active.current !== key) return null
    locked.current = true; const ticket = ++generation.current; setBusyKey(key); setFailure(null)
    try {
      const next = assertIdentity(await fn(), identity)
      if (active.current !== key || generation.current !== ticket) return null
      latest.current = next; setSnapshot({ key, value: next }); return next
    } catch (e) {
      if (active.current === key && generation.current === ticket) setFailure({ key, message: errorMessage(e) })
      return null
    } finally {
      if (active.current === key && generation.current === ticket) { locked.current = false; setBusyKey(null); setLoadingKey(null) }
    }
  }, [key, client])
  const change = useCallback((change: PreviewChange) => transact(() => {
    if (latest.current?.currentRevisionId !== change.baseRevisionId) throw new PreviewConflictError()
    return client.change(identity, change)
  }), [key, client, transact])
  return {
    state, revision: currentRevision(state), busy: busyKey === key, loading: loadingKey === key,
    error: failure?.key === key ? failure.message : "", refresh,
    choose: (choice: "create" | "skip") => transact(() => client.choose(identity, choice)),
    applyAgentChange: change, change,
    restore: (revisionId: string) => transact(() => {
      const base = latest.current?.currentRevisionId; if (!base) throw new Error("No hay revisión vigente")
      return client.restore(identity, base, revisionId)
    }),
    approve: (notes: string, visibleRevisionId = latest.current?.currentRevisionId) => transact(() => {
      const revisionId = visibleRevisionId; if (!revisionId) throw new Error("No hay revisión para aprobar")
      if (latest.current?.currentRevisionId !== revisionId) throw new PreviewConflictError()
      return client.approve(identity, revisionId, notes)
    }),
  }
}
