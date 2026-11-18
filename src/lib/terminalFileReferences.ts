export type TerminalFileReference = { path: string; line: number; column?: number; start: number; end: number }

const unsafeText = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/
const pathPattern = String.raw`(?:"[^"\r\n]+"|'[^'\r\n]+'|[A-Za-z]:[\\/][^"'<>|():\r\n]*?|[^\s"'<>|():,]+)`
const locations = new RegExp(String.raw`(^|[\s("'<>])(${pathPattern})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))(?!\d|:\d)`, "g")
const python = /\bFile (["'])([^"'\r\n]+)\1, line (\d+)(?!\d)/g

function safeCandidate(path: string): boolean {
  const normal = path.replaceAll("\\", "/")
  if (unsafeText.test(path) || normal.startsWith("//") || normal.startsWith("\\")) return false
  if (path.startsWith("\\")) return false
  if (normal.includes(":")) {
    if (!/^[A-Za-z]:\//.test(normal) || normal.slice(2).includes(":")) return false
  }
  return /[/.\\]/.test(path)
}

export function terminalFileReferences(text: string): TerminalFileReference[] {
  if (text.length > 32768 || unsafeText.test(text)) return []
  const result: TerminalFileReference[] = []
  const add = (path: string, lineText: string, columnText: string | undefined, start: number, end: number) => {
    const line = Number(lineText), column = columnText === undefined ? undefined : Number(columnText)
    if (!safeCandidate(path) || !Number.isSafeInteger(line) || line < 1 || line > 2147483647 ||
      (column !== undefined && (!Number.isSafeInteger(column) || column < 1 || column > 2147483647))) return
    if (result.some(r => start < r.end && end > r.start)) return
    result.push({ path, line, column, start, end })
  }
  for (const match of text.matchAll(python)) {
    add(match[2], match[3], undefined, match.index + 5, match.index + match[0].length)
  }
  for (const match of text.matchAll(locations)) {
    const quoted = /^["']/.test(match[2])
    const path = quoted ? match[2].slice(1, -1) : match[2]
    add(path, match[3] ?? match[5], match[4] ?? match[6], match.index + match[1].length, match.index + match[0].length)
  }
  return result.sort((a, b) => a.start - b.start)
}
