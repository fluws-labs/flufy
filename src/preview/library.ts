import { call } from '../lib/tauri.ts'
import type { PreviewReferenceIdentity } from './types.ts'

export type SavedPreview = {
  identity: PreviewReferenceIdentity; title: string; status: string
  currentRevisionId: string; approvedRevisionId: string | null
  revisionCount: number; screenCount: number; updatedAt: number
}
export type PreviewLibraryResult = { designs: SavedPreview[]; unreadable: number }
export function loadPreviewLibrary(projectRoot: string): Promise<PreviewLibraryResult> {
  return call<PreviewLibraryResult>('preview_list', { projectRoot })
}
