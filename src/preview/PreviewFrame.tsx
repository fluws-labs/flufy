import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { PreviewDocument, PreviewOperation, PreviewViewport } from "./types"
import { findNode, flattenNodes } from "./document"
import { isRendererSelection, renderEditorHtml, renderPreviewHtml } from "./renderer"
import { previewArtifactHtml, previewEditorArtifactHtml } from "./artifact"
import { rendererOffsetStart, rendererOperation, rendererResizeStart, type RendererOffsetStart, type RendererResizeStart } from "./interaction"

export function PreviewFrame({ document, artifactHtml, artifactCss, identityKey, revisionId, viewport, selectedId, onSelect, onOperation, readOnly = false, fit = true, screenNodeId, onNavigate, detachRequest }: {
  document: PreviewDocument; artifactHtml?: string; artifactCss?: string
  identityKey: string; revisionId: string; viewport: PreviewViewport; selectedId?: string; onSelect?: (id: string) => void
  onOperation?: (operation: PreviewOperation) => void; readOnly?: boolean; fit?: boolean
  screenNodeId?: string
  onNavigate?: (screenId: string) => void
  detachRequest?: { nodeId: string; requestId: number }
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const size = viewport === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 800 }
  useEffect(() => {
    if (!canvas.current) return
    const update = () => {
      const element = canvas.current
      if (element && element.clientWidth > 24 && element.clientHeight > 24) setScale(fit ? Math.max(.1, Math.min(1, (element.clientWidth - 24) / size.width, (element.clientHeight - 24) / size.height)) : 1)
    }
    const observer = new ResizeObserver(update)
    observer.observe(canvas.current)
    update()
    return () => observer.disconnect()
  }, [fit, size.width, size.height])
  const documentRef = useRef(document); documentRef.current = document
  // Stable channel: an unrelated state refresh (for example the 4 s reload from
  // persistence) must not rewrite srcDoc or desynchronize the parent listener
  // from the script already running in the sandboxed frame. A real click can
  // otherwise land while the frame reloads and its message is rejected.
  const channel = useRef<string>(crypto.randomUUID()).current
  const containerIds = useMemo(() => flattenNodes(document.root).filter(n => n.kind === "container" && !n.placeholderFor).map(n => n.id), [document])
  const screenNodeIds = useMemo(() => document.screens?.map(screen => screen.nodeId), [document])
  const links = useMemo(() => Object.fromEntries(flattenNodes(document.root).filter(node => node.targetScreenId).map(node => [node.id, node.targetScreenId!])), [document])
  // Selection and read-only state are delivered over postMessage, not embedded in
  // srcDoc: clicking a block or starting a save must not reload the iframe and
  // throw away the in-progress drag transform.
  const context = useMemo(() => ({ identityKey, revisionId, viewport, channel, rootId: document.root.id, containerIds, screenRootId: screenNodeId, screenNodeIds, links }), [identityKey, revisionId, viewport, channel, document.root.id, containerIds, screenNodeId, screenNodeIds, links])
  const stateRef = useRef({ selectedId, readOnly }); stateRef.current = { selectedId, readOnly }
  const postState = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: 'preview-state', channel, selectedId: stateRef.current.selectedId ?? null, readOnly: stateRef.current.readOnly }, '*')
  }, [channel])
  useEffect(() => { postState() }, [selectedId, readOnly, postState])
  useEffect(() => {
    if (detachRequest) frame.current?.contentWindow?.postMessage({ type: 'preview-detach-request', channel, nodeId: detachRequest.nodeId }, '*')
  }, [detachRequest, channel])
  const operationRef = useRef(onOperation); operationRef.current = onOperation
  const externalResize = useRef<(RendererResizeStart & { left: number; top: number; scale: number }) | null>(null)
  const externalOffset = useRef<(RendererOffsetStart & { left: number; top: number; scale: number }) | null>(null)
  const editable = !!onSelect
  const result = useMemo(() => {
    try {
      // Autoridad única: el artefacto congelado del backend (html/css), no un
      // segundo renderizador. Solo si falta hay fallback al render de dominio.
      if (artifactHtml) {
        const artifact = { html: artifactHtml, css: artifactCss ?? "" }
        return { html: editable ? previewEditorArtifactHtml(artifact, context) : previewArtifactHtml(artifact) }
      }
      return { html: editable ? renderEditorHtml(document, context) : renderPreviewHtml(document) }
    } catch (e) { return { error: e instanceof Error ? e.message : "No se pudo renderizar el diseño" } }
  }, [document, context, editable, artifactHtml, artifactCss])
  useEffect(() => {
    if (!onSelect) return
    const receive = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== "null") return
      const data = e.data
      if (data?.type === 'preview-gesture-end' && Object.keys(data).sort().join(',') === 'channel,identityKey,revisionId,type,viewport' && data.identityKey === context.identityKey && data.revisionId === context.revisionId && data.channel === context.channel && data.viewport === context.viewport) { externalResize.current = null; externalOffset.current = null }
      if (isRendererSelection(e.data, context) && findNode(documentRef.current.root, e.data.nodeId)) onSelect(e.data.nodeId)
      if (!readOnly && data?.type === 'preview-navigate' && Object.keys(data).sort().join(',') === 'channel,identityKey,nodeId,revisionId,type' && data.channel === channel && data.identityKey === identityKey && data.revisionId === revisionId) {
        const target = findNode(documentRef.current.root, data.nodeId)?.targetScreenId
        if (target && (documentRef.current.screens ?? [{ id: 'default' }]).some(screen => screen.id === target)) onNavigate?.(target)
      }
      if (!readOnly) {
        const start = rendererResizeStart(e.data, context, documentRef.current)
        const rect = frame.current?.getBoundingClientRect()
        if (start && rect) externalResize.current = { ...start, left: rect.left, top: rect.top, scale: rect.width / size.width }
        const offsetStart = rendererOffsetStart(e.data, context, documentRef.current)
        if (offsetStart && rect) externalOffset.current = { ...offsetStart, left: rect.left, top: rect.top, scale: rect.width / size.width }
        const operation = rendererOperation(e.data, context, documentRef.current)
        if (operation) { externalResize.current = null; externalOffset.current = null; operationRef.current?.(operation) }
      }
    }
    // The host receives pointerup when a resize leaves the opaque iframe. Finish
    // in host coordinates instead of dropping the gesture or saving stale size.
    const finishExternalResize = (event: PointerEvent) => {
      const start = externalResize.current
      externalResize.current = null
      if (!start || readOnly) return
      const bounded = (value: number) => Math.max(16, Math.min(10000, Math.round(value)))
      const operation = rendererOperation({ type: 'preview-resize', identityKey, revisionId, channel, viewport, nodeId: start.nodeId,
        width: bounded(start.width + (event.clientX - start.left) / start.scale - start.x),
        height: bounded(start.height + (event.clientY - start.top) / start.scale - start.y),
      }, context, documentRef.current)
      if (operation) operationRef.current?.(operation)
    }
    const finishExternalOffset = (event: PointerEvent) => {
      const start = externalOffset.current
      externalOffset.current = null
      if (!start || readOnly) return
      // Let the bridge measure the final bounds as well, so dropping outside the
      // frame also detaches a child instead of keeping a hidden parent relation.
      frame.current?.contentWindow?.postMessage({ type: 'preview-finish-offset', channel,
        x: (event.clientX - start.left) / start.scale, y: (event.clientY - start.top) / start.scale,
      }, '*')
    }
    const cancel = () => { externalResize.current = null; externalOffset.current = null }
    window.addEventListener("message", receive)
    window.addEventListener('pointerup', finishExternalResize)
    window.addEventListener('pointerup', finishExternalOffset)
    window.addEventListener('blur', cancel)
    return () => { window.removeEventListener("message", receive); window.removeEventListener('pointerup', finishExternalResize); window.removeEventListener('pointerup', finishExternalOffset); window.removeEventListener('blur', cancel); cancel() }
  }, [context, onSelect, readOnly, onNavigate])
  if (result.error) return <p role="alert">{result.error}</p>
  return <div ref={canvas} className="preview-canvas-scroll" data-scale={scale.toFixed(2)}><div className="preview-canvas-stage" style={{ width: size.width * scale, height: size.height * scale }}><iframe ref={frame} onLoad={postState} title={`Diseño ${revisionId} · ${viewport === "mobile" ? "móvil" : "escritorio"}`} sandbox={onSelect ? "allow-scripts" : ""} referrerPolicy="no-referrer" srcDoc={result.html} style={{ width: size.width, height: size.height, transform: `scale(${scale})`, transformOrigin: "top left" }} /></div></div>
}
