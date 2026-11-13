import type { IBufferCellPosition, ILink, ITerminalAddon, Terminal } from "@xterm/xterm"
import { terminalFileReferences, type TerminalFileReference } from "./terminalFileReferences"

type Options = {
  cwd: string
  resolve: (path: string) => Promise<string>
  open: (reference: TerminalFileReference) => void
}

/** Links are derived only from visible cells, never from OSC 8 destinations. */
export class TerminalFileLinksAddon implements ITerminalAddon {
  private cleanup: (() => void) | undefined
  private options: Options

  constructor(options: Options) { this.options = options }

  activate(term: Terminal): void {
    let hovered: { link: ILink; ref: TerminalFileReference; x: number; y: number; checked: boolean } | undefined
    let ctrl = false
    let alive = true
    const tooltip = document.createElement("div")
    tooltip.className = "terminal-file-tooltip xterm-hover"
    tooltip.setAttribute("role", "tooltip")
    const leave = () => { hovered = undefined; tooltip.remove() }
    const update = () => {
      if (!hovered) return
      const current = hovered
      current.link.decorations = { pointerCursor: ctrl, underline: ctrl }
      if (!tooltip.isConnected) {
        tooltip.textContent = `Ctrl+clic · Abrir en el editor\nReferencia: ${current.ref.path}\nBase inicial: ${this.options.cwd}`
        document.body.appendChild(tooltip)
        tooltip.style.left = `${Math.max(4, Math.min(current.x, window.innerWidth - tooltip.offsetWidth - 4))}px`
        tooltip.style.top = `${Math.max(4, Math.min(current.y + 20, window.innerHeight - tooltip.offsetHeight - 4))}px`
      }
      if (!ctrl || current.checked) return
      current.checked = true
      void this.options.resolve(current.ref.path).then(path => {
        if (alive && hovered === current) tooltip.textContent = `Ctrl+clic · Abrir en el editor\n${path}:${current.ref.line}${current.ref.column ? `:${current.ref.column}` : ""}\nBase inicial: ${this.options.cwd}`
      }).catch(() => {
        if (alive && hovered === current) tooltip.textContent = `No se puede abrir esta referencia dentro del espacio de trabajo\n${current.ref.path}\nBase inicial: ${this.options.cwd}`
      })
    }
    const key = (event: KeyboardEvent) => { ctrl = event.ctrlKey; update() }
    const move = (event: MouseEvent) => {
      if (!hovered) return
      if (!term.element?.contains(event.target as Node)) { leave(); return }
      ctrl = event.ctrlKey
      update()
    }
    const blur = () => { ctrl = false; leave() }
    window.addEventListener("keydown", key)
    window.addEventListener("keyup", key)
    window.addEventListener("mousemove", move)
    window.addEventListener("blur", blur)
    // Consume OSC 8 metadata so hidden destinations cannot override visible paths.
    const osc = term.parser.registerOscHandler(8, () => true)
    const provider = term.registerLinkProvider({ provideLinks: (row, callback) => {
      const buffer = term.buffer.active
      let first = row - 1, last = first
      while (first > 0 && buffer.getLine(first)?.isWrapped && last - first < 64) first--
      while (buffer.getLine(last + 1)?.isWrapped && last - first < 64) last++
      if (last - first >= 64) { callback(undefined); return }
      let text = ""
      const positions: IBufferCellPosition[] = []
      for (let y = first; y <= last; y++) {
        const line = buffer.getLine(y)
        if (!line) continue
        for (let x = 0; x < term.cols; x++) {
          const cell = line.getCell(x)
          if (!cell || cell.getWidth() === 0) continue
          const chars = cell.getChars() || " "
          for (let i = 0; i < chars.length; i++) positions.push({ x: x + 1, y: y + 1 })
          text += chars
        }
      }
      const links: ILink[] = terminalFileReferences(text).map(ref => {
        const link: ILink = {
          text: text.slice(ref.start, ref.end),
          range: { start: positions[ref.start], end: positions[ref.end - 1] },
          decorations: { pointerCursor: false, underline: false },
          activate: event => {
            if (!event.ctrlKey || event.button !== 0) return
            event.preventDefault()
            this.options.open(ref)
          },
          hover: event => {
            ctrl = event.ctrlKey
            hovered = { link, ref, x: event.clientX, y: event.clientY, checked: false }
            update()
          },
          leave,
          dispose: () => { if (hovered?.link === link) leave() },
        }
        return link
      })
      callback(links.length ? links : undefined)
    } })
    this.cleanup = () => {
      alive = false
      leave()
      provider.dispose()
      osc.dispose()
      window.removeEventListener("keydown", key)
      window.removeEventListener("keyup", key)
      window.removeEventListener("mousemove", move)
      window.removeEventListener("blur", blur)
    }
  }

  dispose(): void { this.cleanup?.(); this.cleanup = undefined }
}
