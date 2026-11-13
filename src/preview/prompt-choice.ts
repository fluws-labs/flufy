import type { PreviewClient, PreviewIdentity } from "./types.ts"

/** The checkbox decides at send time; loading a chat must never ask or choose. */
export async function preparePreviewChoice(client: Pick<PreviewClient, "load" | "choose">, identity: PreviewIdentity, enabled: boolean): Promise<void> {
  try {
    const state = await client.load(identity)
    // A saved design and its approval remain attached to their original task.
    if (state?.currentRevisionId || state?.revisions.length) return
    if (enabled ? state?.status === "draft" : state?.status === "skipped") return
    await client.choose(identity, enabled ? "create" : "skip")
  } catch (error) {
    if (enabled) throw error
  }
}

export function previewPreferenceContext(enabled: boolean): string {
  return enabled
    ? "[FLUFY_PREVIEW_PREFERENCE] El usuario activó Previsualización en el compositor: prepará la previa antes de implementar los cambios visuales. No preguntes si quiere crearla u omitirla. Conservá la identidad de la tarea y esperá la aprobación del diseño antes de implementarlo."
    : "[FLUFY_PREVIEW_PREFERENCE] El usuario desactivó Previsualización en el compositor: seguí el flujo normal sin crear una previa para este mensaje. No preguntes si quiere crearla u omitirla. Conservá los diseños y las aprobaciones existentes."
}
