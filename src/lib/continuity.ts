// A continuation is a new turn, never a replay of the original instruction.
export const CONTINUITY_MARKER = "[FLUFY_CONTINUIDAD_INTERNA]"
export const CONTINUITY_PROMPT = `${CONTINUITY_MARKER}
La respuesta anterior indica que el trabajo encargado quedó sin completar. Revisá el pedido y el historial: si hay trabajo independiente autorizado y no existe un bloqueo real, continuá ejecutándolo ahora hasta completarlo y verificarlo. No repitas acciones ya realizadas ni operaciones de resultado incierto; comprobá su estado primero. Si necesitás una decisión, un permiso o hay un bloqueo real, explicalo y esperá. No continúes si el usuario canceló o cambió el objetivo.`

type Entry = { info: { id: string; role: string; parentID?: string; error?: unknown; finish?: string; time?: { created?: number; completed?: number } }; parts: { type: string; text?: string; tool?: string }[] }

// Deliberately require an explicit admission of non-completion, not just an
// old todo list: pending todos can belong to a previous request or a question.
export function prematureCompletion(messages: Entry[], todos: { status: string }[] = []): { answer: string; parent: string } | null {
  const last = messages.at(-1)
  if (!last || last.info.role !== "assistant" || last.info.error || !last.info.time?.completed || !["stop", "end_turn"].includes(last.info.finish ?? "")) return null
  const text = last.parts.filter(p => p.type === "text").map(p => p.text ?? "").join(" ").trim()
  if (!text || /[?¿]/.test(text)) return null
  const blockerText = text.replace(/(?:no (?:encontr[eé]|hay|existe|tengo) (?:ning[uú]n |un )?bloqueo)/gi, "")
  if (/(?:bloqueo|bloquead[oa]|sin acceso|sin (?:credenciales|permisos)|falta (?:acceso|permiso|autorizaci[oó]n|informaci[oó]n|credenciales)|necesito (?:que|tu|una? (?:decisi[oó]n|permiso|autorizaci[oó]n))|no puedo (?:acceder|continuar)|esper(?:o|ando) (?:tu|una? respuesta)|cancelad[oa]|blocked|need (?:your|permission))/i.test(blockerText)) return null
  const admitted = /(?:no (?:la |lo |se )?(?:implement[eé]|complet[eé]|termin[eé]|hice|realic[eé])|(?:trabajo|encargo|tarea|implementaci[oó]n) (?:queda|qued[oó]|est[aá]|sigue) (?:incomplet[oa]|pendiente|sin (?:completar|implementar))|no (?:he |se ha )?(?:implemented|completed|finished)|(?:task|work) (?:is|remains) incomplete)(?![\p{L}])/iu.test(text)
  let parentIndex = messages.findIndex(m => m.info.id === last.info.parentID && m.info.role === "user")
  if (parentIndex < 0) return null
  let retries = 0
  while (parentIndex >= 0 && messages[parentIndex].parts.some(p => p.type === "text" && p.text?.startsWith(CONTINUITY_MARKER))) {
    retries++
    parentIndex = messages.slice(0, parentIndex).findLastIndex(m => m.info.role === "user")
  }
  if (parentIndex < 0 || retries >= 2) return null
  // Never resume a turn that asked for input, including a rejected question.
  const current = messages.slice(parentIndex + 1)
  if (current.some(m => m.parts.some(p => p.type === "tool" && /^(?:question|permission)(?:_|$)/i.test(p.tool ?? "")))) return null
  // An old list alone is not proof: the current request must have updated it.
  const updatedPlan = current.some(m => m.parts.some(p => p.type === "tool" && /(?:^|_)todowrite$/i.test(p.tool ?? "")))
  if (!admitted && !(updatedPlan && todos.some(t => t.status === "pending" || t.status === "in_progress"))) return null
  return { answer: last.info.id, parent: last.info.parentID ?? "" }
}
