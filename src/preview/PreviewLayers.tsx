import { useRef, useState } from 'react'
import { findNode, flattenNodes, parentOf } from './document'
import type { PreviewDocument, PreviewNode, PreviewOperation, PreviewScreen } from './types'

export function PreviewLayers({ document, screens, activeScreen, selected, disabled, onScreen, onSelect, onOperation }: {
  document: PreviewDocument; screens: PreviewScreen[]; activeScreen: PreviewScreen; selected?: string; disabled: boolean
  onScreen: (screen: PreviewScreen) => void; onSelect: (id: string) => void; onOperation: (operation: PreviewOperation) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const dragged = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [screenName, setScreenName] = useState<{ id: string; value: string } | null>(null)
  const root = findNode(document.root, activeScreen.nodeId) ?? document.root
  const connections = flattenNodes(root).filter(node => node.targetScreenId)
  const row = (node: PreviewNode) => node.placeholderFor ? null : <li key={node.id}>
    <div className={`preview-layer-row${selected === node.id ? ' selected' : ''}${dropTarget === node.id ? ' drop-target' : ''}`}
      draggable={!disabled && node.id !== document.root.id && !screens.some(screen => screen.nodeId === node.id)}
      onDragStart={event => { event.stopPropagation(); dragged.current = node.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', node.id) }}
      onDragEnd={() => { dragged.current = null; setDropTarget(null) }}
      onDragOver={event => { if (!disabled && dragged.current && dragged.current !== node.id) { event.preventDefault(); event.stopPropagation(); setDropTarget(node.id) } }}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation(); setDropTarget(null)
        const source = dragged.current; dragged.current = null
        if (disabled || !source || source === node.id) return
        const parent = node.kind === 'container' ? node : parentOf(document.root, node.id)
        const moving = findNode(document.root, source)
        if (!parent || !moving || findNode(moving, parent.id)) return
        const siblings = parent.children.filter(child => child.id !== source)
        const index = node.kind === 'container' ? siblings.length : siblings.findIndex(child => child.id === node.id)
        onOperation({ type: 'move', nodeId: source, parentId: parent.id, index })
      }}>
      {node.children.length > 0 ? <button type="button" className="preview-layer-fold" aria-label={`${collapsed.has(node.id) ? 'Expandir' : 'Plegar'} ${node.id}`} aria-expanded={!collapsed.has(node.id)} onClick={() => setCollapsed(current => { const next = new Set(current); next.has(node.id) ? next.delete(node.id) : next.add(node.id); return next })}>{collapsed.has(node.id) ? '▸' : '▾'}</button> : <span className="preview-layer-leaf" />}
      <button type="button" className="preview-layer-name" aria-label={`Seleccionar capa ${node.id}`} aria-pressed={selected === node.id} onClick={() => onSelect(node.id)} title={node.id}><span aria-hidden="true">{node.kind === 'container' ? '▣' : node.kind === 'image' ? '◩' : 'T'}</span><span>{node.text?.trim().slice(0, 40) || node.id}</span></button>
      {node.layout.position === 'absolute' && <span className="preview-layer-badge" title="Independiente del contenedor anterior">Libre</span>}
      {node.targetScreenId && <span className="preview-layer-badge" title={`Lleva a ${screens.find(screen => screen.id === node.targetScreenId)?.name ?? node.targetScreenId}`}>↗</span>}
    </div>
    {!collapsed.has(node.id) && node.children.length > 0 && <ul>{node.children.map(row)}</ul>}
  </li>
  return <aside className="preview-layers" aria-label="Pantallas y capas">
    <header><strong>Pantallas</strong><button type="button" className="btn btn-xs" disabled={disabled || screens.length >= 40} onClick={() => onOperation({ type: 'screen-add', nodeId: `frame-${crypto.randomUUID()}`, boardId: `board-${crypto.randomUUID()}`, screenId: `screen-${crypto.randomUUID()}`, name: `Pantalla ${screens.length + 1}` })}>+ Pantalla</button></header>
    <nav aria-label="Pantallas del diseño">{screens.map(screen => <button type="button" key={screen.id} disabled={disabled} className={activeScreen.id === screen.id ? 'selected' : ''} aria-current={activeScreen.id === screen.id ? 'page' : undefined} onClick={() => onScreen(screen)}>▣ <span>{screen.name}</span></button>)}</nav>
    {document.screens && <label className="preview-screen-name">Nombre de pantalla<input aria-label="Nombre de pantalla" maxLength={120} disabled={disabled} value={screenName?.id === activeScreen.id ? screenName.value : activeScreen.name} onChange={event => setScreenName({ id: activeScreen.id, value: event.target.value })} onBlur={() => {
      if (screenName?.id === activeScreen.id && screenName.value.trim() && screenName.value.trim() !== activeScreen.name) onOperation({ type: 'screen-rename', screenId: activeScreen.id, name: screenName.value.trim() })
      setScreenName(null)
    }} /></label>}
    <details className="preview-screen-links" open><summary>Enlaces de esta pantalla · {connections.length}</summary>{connections.length ? connections.map(node => <button type="button" key={node.id} disabled={disabled} onClick={() => { const target = screens.find(screen => screen.id === node.targetScreenId); if (target) onScreen(target) }}><span>{node.text || node.id}</span><small>→ {screens.find(screen => screen.id === node.targetScreenId)?.name}</small></button>) : <p>Seleccioná un botón y elegí su pantalla de destino en el inspector.</p>}</details>
    <h3>Capas</h3><p>Dentro de una caja: se mueven juntos. «Libre»: posición independiente. Arrastrá acá para agrupar o cambiar el orden.</p>
    <ul className="preview-layer-tree" aria-label="Capas de la pantalla">{row(root)}</ul>
  </aside>
}
