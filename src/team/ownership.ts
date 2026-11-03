// A block is the user's only when the team cannot resolve it alone. This mirrors
// the engine's classification so the interface never asks for a decision that
// the Lead can take by itself.
const USER_NEEDLES = [
  "usage_limit", "usage limit", "límite de uso", "quota", "insufficient credits",
  "facturación", "falta de saldo", "payment required", "http 402", "invalid_api_key",
  "unauthorized", "authentication", "volver a conectarse", "reconectá la cuenta",
  "reasigná el modelo", "variante no disponible", "restringido a la aplicación opencode",
  "cuenta conectada no tiene permiso", "no está disponible para esta cuenta",
  "modelo elegido no está disponible", "modelo no está disponible", "espera un permiso",
  "permission denied", "permiso denegado", "falta autorización", "requiere autorización",
  "necesito tu autorización", "control está apagado", "control de pc está apagado",
  "elegir navegador", "ventana elegida", "fuera de la carpeta autorizada",
  "carpeta no autorizada", "presupuesto de la ejecución", "cancelación", "cancelado",
  "blocked by policy", "proveedor bloqueó",
]

const EXHAUSTED = /El Lead (revisó este mismo bloqueo|agotó)/i

export function needsUserDecision(reason: string): boolean {
  const text = reason.toLowerCase()
  return USER_NEEDLES.some(needle => text.includes(needle))
}

export function recoveredAutomatically(reason: string): boolean {
  return !needsUserDecision(reason) && !EXHAUSTED.test(reason)
}
