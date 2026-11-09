import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { PreviewConversation } from "./PreviewConversation"
import type { PreviewEditorContext } from "../preview/types"
import {
  PreviewComparison,
  PreviewPanel,
  usePreview,
  previewIdentityKey,
  captureAttribution,
  isPreviewReference,
  sameReferenceIdentity,
  type PreviewIdentity,
  type PreviewImplementation,
  type PreviewReference,
} from "../preview"
import { previewImplementations, toNativeIdentity } from "../preview/client"
import { call, errorMessage } from "../lib/tauri"
import { readableTeamError } from "../lib/provider-error"
import { useTeams } from "../state/teams"
import { QuestionCard } from "./Interactions"
import type { QuestionRequest } from "../state/agent"
import { Icon } from "../components/ui"
import { PREVIEW_CHOICE_QUESTION } from "./preview-identity"
import "./preview-host.css"

const CREATE_LABEL = "Crear previsualización"
const SKIP_LABEL = "Omitir previsualización"

export function PreviewChoiceCard({ identity, onChosen }: { identity: PreviewIdentity; onChosen?: (choice: "create" | "skip") => void }) {
  const preview = usePreview(identity)
  const request: QuestionRequest = {
    id: `preview-choice:${previewIdentityKey(identity)}`,
    sessionID: identity.conversationId,
    questions: [{
      header: "Previsualización",
      question: PREVIEW_CHOICE_QUESTION,
      options: [
        { label: CREATE_LABEL, description: "Mirá y ajustá el diseño antes de tocar el código o de elegir cómo implementarlo." },
        { label: SKIP_LABEL, description: "Seguí con el flujo normal; no se genera un prototipo HTML para esta tarea." },
      ],
      multiple: false,
      custom: false,
    }],
  }
  if (preview.loading || preview.error || (preview.state && preview.state.status !== "pending")) return null
  const decide = async (answers: string[][]) => {
    const choice: "create" | "skip" = answers[0]?.[0] === SKIP_LABEL ? "skip" : "create"
    const next = await preview.choose(choice)
    if (next) onChosen?.(choice)
  }
  return <QuestionCard key={request.id} request={request} title="Previsualización" onAnswer={(answers) => void decide(answers)} onSkip={() => void decide([[SKIP_LABEL]])} />
}

export function PreviewPane({ identity, onClose, onContextChange }: { identity: PreviewIdentity; onClose: () => void; onContextChange?: (context: PreviewEditorContext) => void }) {
  const [mode, setMode] = useState<"edit" | "compare">("edit")
  const key = previewIdentityKey(identity)
  const nativeIdentity = useMemo(() => toNativeIdentity(identity), [identity.project, identity.conversationId, identity.taskId])
  const [transfer, setTransfer] = useState<{ key: string; reference: PreviewReference | null; problem: string; loading: boolean }>({ key: "", reference: null, problem: "", loading: false })
  useEffect(() => {
    if (mode !== "compare") return
    let disposed = false
    setTransfer({ key, reference: null, problem: "", loading: true })
    void call<PreviewReference | null>("preview_transfer", { identity: nativeIdentity }).then((value) => {
      if (disposed) return
      if (value === null || isPreviewReference(value)) setTransfer({ key, reference: value, problem: "", loading: false })
      else setTransfer({ key, reference: null, problem: "La referencia transferida no tiene la forma esperada.", loading: false })
    }).catch((e) => { if (!disposed) setTransfer({ key, reference: null, problem: errorMessage(e), loading: false }) })
    return () => { disposed = true }
  }, [mode, key, nativeIdentity])
  const active = transfer.key === key ? transfer : null
  const chats = useTeams((s) => s.chats)
  const reference = active?.reference ?? null
  const [nativeResult, setNativeResult] = useState<{ reference: PreviewReference; items: PreviewImplementation[]; error?: string; loading: boolean } | null>(null)
  useEffect(() => {
    if (mode !== "compare" || !reference) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    setNativeResult({ reference, items: [], loading: true })
    const refresh = async () => {
      try {
        const items = await previewImplementations(reference)
        if (!disposed) setNativeResult({ reference, items, loading: false })
      } catch (e) {
        if (!disposed) setNativeResult({ reference, items: [], loading: false, error: errorMessage(e) })
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 4000)
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [mode, reference])
  // A delegated team keeps the run evidence in its own chat. The origin chat
  // reuses those captures only when their origin records this same frozen
  // reference; it never adopts a run from another task.
  const run = useMemo(() => {
    if (!reference) return null
    const chat = chats.find((c) => c.origin?.sessionId === identity.conversationId
      && c.origin.previewReference
      && sameReferenceIdentity(c.origin.previewReference.identity, nativeIdentity)
      && c.origin.previewReference.revision.id === reference.revision.id)
    return chat?.runs.filter((r) => r.observations?.some((o) => o.phase === "after")).at(-1) ?? null
  }, [chats, identity.conversationId, nativeIdentity, reference])
  const resultKey = `${key}:${reference?.revision.id ?? ""}:${run?.id ?? ""}:${(run?.observations ?? []).map((o) => `${o.id}:${o.status}`).join("|")}`
  const [result, setResult] = useState<{ key: string; items: PreviewImplementation[] }>({ key: "", items: [] })
  useEffect(() => {
    let disposed = false
    setResult({ key: resultKey, items: [] })
    if (!run) return
    const attributed = (run.observations ?? []).flatMap((observation) => {
      const attribution = observation.phase === "after" ? captureAttribution(observation.details) : null
      return attribution ? [{ observation, attribution }] : []
    })
    if (attributed.length === 0) return
    void Promise.all(attributed.map(async ({ observation, attribution }): Promise<PreviewImplementation> => {
      const base: PreviewImplementation = {
        identity: attribution.identity, revisionId: attribution.revisionId, viewport: attribution.viewport,
        width: observation.details.width ?? 0, height: observation.details.height ?? 0, status: "missing",
        source: observation.details.source ?? "Evidencia del equipo", capturedAt: observation.capturedAt,
        reason: observation.details.reason ?? "No hay una captura verificada de la implementación.",
      }
      if (observation.status !== "captured" || !observation.artifactPath) return base
      try {
        const image = await call<{ mime: string; data: string }>("team_evidence_image", { runId: run.id, path: observation.artifactPath })
        return { ...base, status: "captured", imageUrl: `data:${image.mime};base64,${image.data}` }
      } catch (e) {
        return { ...base, status: "failed", reason: readableTeamError(errorMessage(e)) }
      }
    })).then((items) => { if (!disposed) setResult({ key: resultKey, items }) })
    return () => { disposed = true }
  }, [resultKey, run])
  const native = nativeResult?.reference === reference ? nativeResult : null
  const implementations = [...(result.key === resultKey ? result.items : []), ...(native?.items ?? [])]
  return <div className="preview-pane">
    <div className="preview-pane-modes" role="tablist" aria-label="Vista de la previsualización">
      <button type="button" role="tab" aria-selected={mode === "edit"} className={`btn btn-xs ${mode === "edit" ? "btn-primary" : ""}`} onClick={() => setMode("edit")}><Icon name="edit" /> Editar diseño</button>
      <button type="button" role="tab" aria-selected={mode === "compare"} className={`btn btn-xs ${mode === "compare" ? "btn-primary" : ""}`} onClick={() => setMode("compare")}><Icon name="diff-multiple" /> Comparar con lo implementado</button>
    </div>
    {mode === "edit"
      ? <PreviewPanel identity={identity} onClose={onClose} onContextChange={onContextChange} />
      : <PreviewComparison
          reference={active ? active.reference : undefined}
          implementations={implementations}
          loading={(active?.loading ?? true) || (native?.loading ?? false)}
          error={active?.problem || native?.error || undefined}
        />}
  </div>
}

/** Keep the editor mounted when minimized: draft fields, selection and viewport survive. */
export function PreviewFloatingEditor({ identity, onClose, onBrowseDesigns, openRequest = 0 }: { identity: PreviewIdentity; onClose: () => void; onBrowseDesigns?: () => void; openRequest?: number }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [minimized, setMinimized] = useState(false)
  useEffect(() => { setMinimized(false) }, [openRequest])
  const [maximized, setMaximized] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)
  const [editorContext, setEditorContext] = useState<PreviewEditorContext>({ saving: true })
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (!minimized && !element.open) element.showModal()
    if (minimized && element.open) element.close()
    return () => { if (element.open) element.close() }
  }, [minimized])
  return createPortal(<>
    {minimized && <button className="btn btn-primary preview-restore" onClick={() => setMinimized(false)}><Icon name="paintcan" /> Volver al diseño</button>}
    <dialog ref={dialog} className={`preview-floating-editor${maximized ? " maximized" : ""}`} aria-label="Editor visual de previsualización" onCancel={event => { event.preventDefault(); setMinimized(true) }}>
      <header className="preview-floating-title"><strong><Icon name="paintcan" /> Editor visual</strong><span>Arrastrá, ajustá y aprobá tu diseño</span><div>
        {onBrowseDesigns && <button type="button" className="btn btn-sm" onClick={onBrowseDesigns}>Diseños</button>}
        <button type="button" className="btn btn-sm" aria-pressed={chatOpen} onClick={() => setChatOpen(value => !value)}>Chat del diseño</button>
        <button type="button" className="btn btn-sm" onClick={() => setMinimized(true)} title="Volver al chat sin perder la edición">Minimizar editor</button>
        <button type="button" className="btn btn-sm" aria-pressed={maximized} onClick={() => setMaximized(value => !value)}>{maximized ? "Restaurar tamaño" : "Pantalla completa"}</button>
        <button type="button" className="btn btn-sm" aria-label="Cerrar editor visual" onClick={onClose}><Icon name="close" /></button>
      </div></header>
      <div className={`preview-floating-body${chatOpen ? " with-chat" : ""}`}>
        <PreviewPane identity={identity} onClose={() => setMinimized(true)} onContextChange={setEditorContext} />
        <div className="preview-conversation-slot" hidden={!chatOpen}><PreviewConversation identity={identity} context={editorContext} /></div>
      </div>
    </dialog>
  </>, document.body)
}
