import type { PreviewIdentity, PreviewViewport } from './types.ts'

export type PreviewAdjustment = {
  identity: PreviewIdentity; revisionId?: string; nodeId?: string; screenId?: string; viewport?: PreviewViewport
}

export function previewAdjustmentContext(adjustment: PreviewAdjustment): string {
  return `[FLUFY_PREVIEW_ADJUSTMENT]${JSON.stringify(adjustment)}
El usuario está conversando dentro del editor visual con el mismo agente encargado del diseño. Ajustá únicamente la previsualización de esta tarea mediante preview_get y preview_apply; no implementes archivos ni delegues a un equipo. Leé primero la revisión vigente: la revisión y selección adjuntas describen lo que veía el usuario, no autorizan sobrescribir ediciones posteriores. Conservá sus cambios manuales y las otras pantallas. Si cambió la revisión, reconciliá el pedido sobre la vigente. No apruebes en nombre del usuario.
Para varias pantallas, conservá document.screens como lista de {id,name,nodeId}, donde nodeId referencia un contenedor del árbol. Cada pantalla es un frame separado y sus descendientes son sus capas. Conservá IDs estables al modificar pantallas y capas. No confundas tarjetas o secciones con pantallas nuevas.`
}
