import { create } from "zustand"
import { extname, normalizePath } from "../lib/paths.ts"
import { loadJson, projectKey, saveJson } from "../lib/persist.ts"

export type MarkdownView = "preview" | "code"
type Choices = Record<string, MarkdownView>

export const useMarkdownViews = create<{ projects: Record<string, Choices> }>(() => ({ projects: {} }))

export function isMarkdown(path: string): boolean {
  return ["md", "markdown"].includes(extname(path))
}

function storageKey(project: string | null): string {
  return projectKey(project ? normalizePath(project) : null, "markdown-views")
}

function choicesFor(key: string): Choices {
  const stored = useMarkdownViews.getState().projects[key] ?? loadJson<Choices>(key, {})
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}
}

export function markdownView(project: string | null, path: string): MarkdownView {
  if (!isMarkdown(path)) return "code"
  return choicesFor(storageKey(project))[normalizePath(path).toLowerCase()] === "preview" ? "preview" : "code"
}

export function setMarkdownView(project: string | null, path: string, view: MarkdownView): void {
  if (!isMarkdown(path)) return
  const key = storageKey(project)
  const choices = { ...choicesFor(key), [normalizePath(path).toLowerCase()]: view }
  saveJson(key, choices)
  useMarkdownViews.setState(s => ({ projects: { ...s.projects, [key]: choices } }))
}
