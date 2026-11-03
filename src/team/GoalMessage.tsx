import { Icon } from "../components/ui"
import { Markdown } from "../agent/Markdown"

type Handoff = {
  goal?: string
  implementationPlan?: string
  researchContext?: string
  acceptanceCriteria?: string[]
  projectConstraints?: { decision: string; source: string }[]
  source?: { title?: string; userRequest?: string }
}

function parseHandoff(text: string): Handoff | null {
  const marker = text.indexOf("TRASPASO DEL CHAT DE ORIGEN")
  const start = text.indexOf("{", marker >= 0 ? marker : 0)
  if (start < 0) return null
  try {
    const value = JSON.parse(text.slice(start)) as Handoff
    return value && typeof value.goal === "string" ? value : null
  } catch {
    return null
  }
}

function short(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).replace(/\s+\S*$/, "")}…`
}

// A delegated goal carries a large research payload. Show the decision first and
// keep the evidence available without turning the conversation into raw JSON.
export function GoalMessage({ text }: { text: string }) {
  const handoff = parseHandoff(text)
  if (!handoff) {
    if (text.length <= 240) return <p className="selectable">{text}</p>
    return <details className="team-goal-details"><summary><span>{short(text, 140)}</span><small>Ver pedido completo</small></summary><div className="selectable"><Markdown text={text} /></div></details>
  }
  return <div className="team-goal">
    <div className="team-goal-summary"><Markdown text={handoff.goal ?? ""} /></div>
    {handoff.implementationPlan && <section>
      <h4>Plan acordado</h4>
      <div className="team-goal-prose"><Markdown text={handoff.implementationPlan} /></div>
    </section>}
    {!!handoff.acceptanceCriteria?.length && <section>
      <h4>Criterios de aceptación</h4>
      <ul className="team-goal-criteria">{handoff.acceptanceCriteria.map((criterion, index) => <li key={index}><Icon name="circle-outline" />{criterion}</li>)}</ul>
    </section>}
    {!!handoff.projectConstraints?.length && <details className="team-goal-fold">
      <summary>Decisiones y convenciones · {handoff.projectConstraints.length}</summary>
      <ul>{handoff.projectConstraints.map((item, index) => <li key={index}><strong>{item.decision}</strong><small>{item.source}</small></li>)}</ul>
    </details>}
    {handoff.researchContext && <details className="team-goal-fold">
      <summary>Contexto investigado</summary>
      <div className="team-goal-prose selectable"><Markdown text={handoff.researchContext} /></div>
    </details>}
    {handoff.source?.userRequest && <details className="team-goal-fold">
      <summary>Pedido original{handoff.source.title ? ` · ${handoff.source.title}` : ""}</summary>
      <div className="team-goal-prose selectable"><Markdown text={handoff.source.userRequest} /></div>
    </details>}
  </div>
}
