export const MISSION_DRAFT_PROMPT = `Quiero convertir esta conversación en una misión de Flufy Bots.

Analizá lo que hablamos y proponé una misión recurrente. Si falta el horario o el objetivo, preguntame antes de proponerla.

Cuando esté claro, respondé SOLO con un bloque de código:

\`\`\`mission-draft
{"kind":"mission-draft","title":"...","goal":"...","schedule":{"kind":"daily","time":"08:30"},"model":null,"autonomy":"alta","notes":"..."}
\`\`\`

No ejecutes la misión, no crees nada y no agregues texto después del bloque.`
