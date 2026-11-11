import { useEffect, useMemo, useRef } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { readBase64 } from "../lib/fs"
import { imageDataUrl, isImagePath } from "../lib/files"
import { openFile } from "../state/editors"
import { notify } from "../state/toasts"
import { errorMessage } from "../lib/tauri"
import { markdownTarget, renderMarkdown } from "./markdownRender"

export function MarkdownPreview({ path, text }: { path: string; text: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const html = useMemo(() => renderMarkdown(text, path), [text, path])
  useEffect(() => {
    let cancelled = false
    for (const img of rootRef.current?.querySelectorAll<HTMLImageElement>("img[data-markdown-image]") ?? []) {
      const imagePath = img.getAttribute("data-markdown-image")!
      if (!isImagePath(imagePath)) {
        img.title = "Formato de imagen local no compatible"
        continue
      }
      void readBase64(imagePath).then(base64 => {
        if (!cancelled) img.src = imageDataUrl(imagePath, base64)
      }).catch(() => {
        if (!cancelled) img.title = "No se pudo cargar la imagen"
      })
    }
    return () => { cancelled = true }
  }, [html])

  return (
    <div
      ref={rootRef}
      className="markdown-preview"
      role="region"
      aria-label="Vista previa Markdown"
      tabIndex={0}
      onClick={e => {
        const link = (e.target as HTMLElement).closest("a")
        if (!link) return
        e.preventDefault()
        const target = markdownTarget(path, link.getAttribute("href") ?? "")
        if (target?.kind === "external") void openUrl(target.value).catch(error => notify.error("No se pudo abrir el enlace", errorMessage(error)))
        else if (target?.kind === "file") openFile(target.value)
        else if (target?.kind === "anchor") {
          const heading = [...(rootRef.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? [])].find(el =>
            el.textContent?.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-") === target.value)
          heading?.scrollIntoView({ block: "start" })
        }
      }}
    >
      <article className="md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
