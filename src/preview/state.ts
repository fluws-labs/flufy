import type { PreviewIdentity, PreviewState } from "./types.ts"
import { previewIdentityKey } from "./types.ts"

export function currentRevision(state: PreviewState | null) { return state?.revisions.find(r => r.id === state.currentRevisionId) }
export function approvedRevision(state: PreviewState | null) { return state?.revisions.find(r => r.id === state.approval?.revisionId) }
export function assertIdentity(state: PreviewState, identity: PreviewIdentity): PreviewState {
  if (previewIdentityKey(state.identity) !== previewIdentityKey(identity)) throw new Error("El diseño recibido pertenece a otra conversación o tarea")
  return state
}
/** Request epochs isolate identity changes AND out-of-order loads for the same identity. */
export class PreviewRequestGate {
  private generation = 0
  private identity = ""
  begin(identity: PreviewIdentity) { this.identity = previewIdentityKey(identity); return { generation: ++this.generation, key: this.identity } }
  accepts(ticket: { generation: number; key: string }) { return ticket.generation === this.generation && ticket.key === this.identity }
  invalidate() { this.generation++ }
}
