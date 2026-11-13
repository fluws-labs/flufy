/** Local models at 12B or more get the full agent (tools, memory, teams). */
export function localModelUsesAgent(modelID: string): boolean {
  const match = modelID.toLowerCase().match(/(\d+(?:\.\d+)?)b/)
  if (!match) return false
  return Number(match[1]) >= 12
}
