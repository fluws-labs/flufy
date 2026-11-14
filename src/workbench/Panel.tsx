import { useEffect, useRef, useState } from "react"
import { useLayout } from "../state/layout"
import {
  attachTerminal,
  clearTerminal,
  closeTerminalSearch,
  createTerminal,
  ensureShells,
  focusTerminal,
  getInstance,
  openTerminalSearch,
  searchTerminal,
  shouldAutoFocus,
  terminalTitle,
  killTerminal,
  setActiveTerminal,
  setDefaultShell,
  useTerminals,
} from "../state/terminals"
import { useOutput } from "../state/output"
import { openMenuAt } from "../components/ContextMenu"
import { addTerminalContext, type ContextItem } from "../state/agent"
import { Icon, IconButton } from "../components/ui"
import { clockTime } from "../lib/time"

type TerminalSelectionSnapshot = Extract<ContextItem, { kind: "terminal" }>

function terminalSelectionSnapshot(id: string, text: string): TerminalSelectionSnapshot | null {
  const state = useTerminals.getState()
  const info = state.terminals.find((t) => t.id === id)
  if (!info || !text.trim()) return null
  return { kind: "terminal", terminalId: id, title: terminalTitle(info, state.shells), cwd: info.cwd, text }
}

function addSelectionToChat(id: string, text: string, consult: boolean): void {
  const snapshot = terminalSelectionSnapshot(id, text)
  if (!snapshot) return
  useLayout.getState().toggleAgent(true)
  addTerminalContext(snapshot, consult)
}

function TerminalSurface({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [floating, setFloating] = useState<{ x: number; y: number; text: string } | null>(null)
  const selection = useTerminals((s) => s.selections[id] ?? "")
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const detach = attachTerminal(id, el)
    if (shouldAutoFocus(id)) requestAnimationFrame(() => {
      if (!useTerminals.getState().searches[id]?.open) focusTerminal(id)
    })
    return detach
  }, [id])
  useEffect(() => {
    if (!selection.trim()) setFloating(null)
  }, [selection])
  useEffect(() => {
    if (!floating) return
    const hide = () => setFloating(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      hide()
    }
    window.addEventListener("resize", hide)
    window.addEventListener("wheel", hide, { passive: true, capture: true })
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("resize", hide)
      window.removeEventListener("wheel", hide, { capture: true })
      window.removeEventListener("keydown", onKey, true)
    }
  }, [floating])
  return <div ref={ref} className="terminal-surface"
    onMouseDownCapture={e => {
      // Keep right-click from moving xterm's selection or reporting a mouse
      // event to the shell. Left-click/drag selection and copying stay native.
      if (e.button === 2) { e.preventDefault(); e.stopPropagation() }
    }}
    onMouseUp={e => {
      if (e.button !== 0) return
      const text = getInstance(id)?.term.getSelection() ?? ""
      if (!text.trim()) { setFloating(null); return }
      const rect = e.currentTarget.getBoundingClientRect()
      const x = Math.min(Math.max(8, e.clientX - rect.left + 8), Math.max(8, rect.width - 200))
      const y = Math.min(Math.max(8, e.clientY - rect.top + 8), Math.max(8, rect.height - 44))
      setFloating({ x, y, text })
    }}>
    {floating && (
      <div className="terminal-selection-actions" role="toolbar" aria-label="Acciones de la selección"
        style={{ left: floating.x, top: floating.y }} onMouseUp={e => e.stopPropagation()}>
        <button type="button" onMouseDown={e => { e.preventDefault(); e.stopPropagation() }} onClick={() => {
          addSelectionToChat(id, floating.text, false)
          setFloating(null)
        }}>
          <Icon name="sparkle" /><span>Agregar al chat</span>
        </button>
        <button type="button" onMouseDown={e => { e.preventDefault(); e.stopPropagation() }} onClick={() => {
          addSelectionToChat(id, floating.text, true)
          setFloating(null)
        }}>
          <Icon name="comment-discussion" /><span>Consultar este error</span>
        </button>
      </div>
    )}
  </div>
}

function TerminalSearch({ id }: { id: string }) {
  const search = useTerminals(s => s.searches[id])
  const input = useRef<HTMLInputElement>(null)
  const open = !!search?.open
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    searchTerminal(id, useTerminals.getState().searches[id]?.query ?? "", "next", true)
    return () => { /* Keep each terminal's query; remove hidden search highlights. */
      getInstance(id)?.search.clearDecorations()
    }
  }, [id, open])
  if (!open) return null
  return <div className="terminal-search" role="search" aria-label="Búsqueda en la terminal">
    <input ref={input} className="input" aria-label="Buscar en esta terminal" placeholder="Buscar en esta terminal" value={search.query}
      onChange={e => searchTerminal(id, e.target.value, "next", true)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === "Enter") { e.preventDefault(); searchTerminal(id, search.query, e.shiftKey ? "previous" : "next") }
        else if (e.key === "Escape") { e.preventDefault(); closeTerminalSearch(id) }
      }} />
    <span role="status" aria-live="polite">{!search.query ? "" : search.resultCount === 0 ? "Sin resultados" : search.resultIndex < 0 ? `${search.resultCount} coincidencias` : `${search.resultIndex + 1} de ${search.resultCount}`}</span>
    <IconButton icon="arrow-up" title="Coincidencia anterior" disabled={!search.query} onClick={() => searchTerminal(id, search.query, "previous")} />
    <IconButton icon="arrow-down" title="Coincidencia siguiente" disabled={!search.query} onClick={() => searchTerminal(id, search.query)} />
    <IconButton icon="close" title="Cerrar búsqueda" onClick={() => closeTerminalSearch(id)} />
  </div>
}

function TerminalsPanel() {
  const terminals = useTerminals((s) => s.terminals)
  const activeId = useTerminals((s) => s.activeId)
  const shells = useTerminals((s) => s.shells)
  const defaultShell = useTerminals((s) => s.defaultShell)
  const searchOpen = useTerminals(s => !!(s.activeId && s.searches[s.activeId]?.open))
  const selection = useTerminals(s => (s.activeId ? s.selections[s.activeId] ?? "" : ""))

  useEffect(() => {
    let cancelled = false
    void ensureShells().then(() => {
      if (!cancelled && useTerminals.getState().terminals.length === 0) createTerminal({ show: false })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const defaultId = shells.some((sh) => sh.id === defaultShell) ? defaultShell : null
  const defaultName = shells.find((sh) => sh.id === defaultId)?.name

  // Elegir un shell en el menú lo deja como predeterminado y abre una terminal:
  // el botón + (y Ctrl+Shift+`) pasan a abrir siempre el predeterminado.
  const newMenu = (el: HTMLElement) =>
    openMenuAt(
      el,
      shells.map((sh) => ({
        label: sh.name,
        icon: sh.id === defaultId ? "check" : sh.id === "cmd" ? "terminal-cmd" : sh.id === "bash" ? "terminal-bash" : "terminal-powershell",
        run: () => {
          setDefaultShell(sh.id)
          createTerminal({ shell: sh.id })
        },
      })),
    )

  return (
    <div className="terminals">
      <div className="terminal-main">{activeId && <><TerminalSearch key={`search-${activeId}`} id={activeId} /><TerminalSurface key={activeId} id={activeId} /></>}</div>
      {terminals.length > 0 && (
        <div className="terminal-list">
          <div className="terminal-list-actions">
            <IconButton icon="search" title="Buscar en esta terminal" active={searchOpen} disabled={!activeId} onClick={() => {
              if (activeId) {
                if (searchOpen) closeTerminalSearch(activeId)
                else openTerminalSearch(activeId)
              }
            }} />
            <IconButton icon="sparkle" title="Acciones de la selección" disabled={!selection.trim()} onClick={(e) => {
              const state = useTerminals.getState()
              const id = state.activeId
              const text = id ? state.selections[id] ?? "" : ""
              if (!id || !text.trim()) return
              openMenuAt(e.currentTarget, [
                { label: "Agregar al chat", icon: "sparkle", run: () => addSelectionToChat(id, text, false) },
                { label: "Consultar este error", icon: "comment-discussion", run: () => addSelectionToChat(id, text, true) },
              ])
            }} />
            <IconButton icon="add" title={defaultName ? `Nueva terminal (${defaultName})` : "Nueva terminal"} onClick={() => createTerminal()} />
            <IconButton icon="chevron-down" title="Elegir shell predeterminado" onClick={(e) => newMenu(e.currentTarget)} />
            <IconButton icon="clear-all" title="Limpiar" onClick={() => clearTerminal(activeId)} />
          </div>
          {terminals.map((t) => (
            <div
              key={t.id}
              className={`terminal-item${t.id === activeId ? " active" : ""}${t.exited ? " exited" : ""}`}
              onClick={() => setActiveTerminal(t.id)}
              title={t.agent ? `Abierta por el agente · ${t.cwd}` : t.cwd}
            >
              <Icon name={t.agent ? "hubot" : "terminal"} />
              <span>{terminalTitle(t, shells)}</span>
              <button
                type="button"
                className="terminal-kill"
                title="Cerrar terminal"
                onClick={(e) => {
                  e.stopPropagation()
                  void killTerminal(t.id)
                }}
              >
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function OutputPanel() {
  const entries = useOutput((s) => s.entries)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    useOutput.getState().markSeen()
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])
  return (
    <div className="output" ref={ref}>
      {entries.length === 0 && <div className="view-note">Acá aparece cada comando de git y gh que corre Flufy, con su resultado.</div>}
      {entries.map((e) => (
        <div key={e.id} className={`output-entry${e.ok ? "" : " failed"}`}>
          <div className="output-head">
            <span className="output-time">{clockTime(e.time)}</span>
            <Icon name={e.ok ? "pass" : "error"} />
            <code>
              {e.tool} {e.args.filter((a) => !a.startsWith("core.quotepath") && !a.startsWith("color.ui") && a !== "-c").join(" ")}
            </code>
            <span className="output-ms">{e.ms} ms</span>
          </div>
          {e.output && <pre>{e.output}</pre>}
        </div>
      ))}
    </div>
  )
}

export function Panel() {
  const tab = useLayout((s) => s.panelTab)
  const maximized = useLayout((s) => s.panelMaximized)
  const unseen = useOutput((s) => s.unseenErrors)
  const layout = useLayout.getState()
  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-tabs">
          <button type="button" className={tab === "terminal" ? "active" : ""} onClick={() => layout.showPanel("terminal")}>
            Terminal
          </button>
          <button type="button" className={tab === "output" ? "active" : ""} onClick={() => layout.showPanel("output")}>
            Salida git/gh {unseen > 0 && tab !== "output" && <span className="badge-dot error">{unseen}</span>}
          </button>
        </div>
        <span className="panel-actions">
          {tab === "output" && <IconButton icon="clear-all" title="Limpiar salida" onClick={() => useOutput.getState().clear()} />}
          <IconButton
            icon={maximized ? "chevron-down" : "chevron-up"}
            title={maximized ? "Restaurar tamaño" : "Maximizar panel"}
            onClick={() => useLayout.getState().togglePanelMaximized()}
          />
          <IconButton icon="close" title="Ocultar panel (Ctrl+J)" onClick={() => useLayout.getState().togglePanel()} />
        </span>
      </div>
      <div className="panel-body">{tab === "terminal" ? <TerminalsPanel /> : <OutputPanel />}</div>
    </section>
  )
}
