import type { PreviewDocument, PreviewLayout, PreviewNode, PreviewOffset, PreviewOperation } from "./types.ts"

export function findNode(root: PreviewNode, id: string): PreviewNode | undefined {
  if (root.id === id) return root
  for (const child of root.children) { const found = findNode(child, id); if (found) return found }
}
export function flattenNodes(root: PreviewNode): PreviewNode[] { return [root, ...root.children.flatMap(flattenNodes)] }
export function parentOf(root: PreviewNode, id: string): PreviewNode | undefined {
  for (const child of root.children) { if (child.id === id) return root; const found = parentOf(child, id); if (found) return found }
}
export function validateDocument(document: PreviewDocument): void {
  if (document.schemaVersion !== 1 || !document.root || !Array.isArray(document.resources)) throw new Error("Documento de previsualización inválido")
  const nodes = flattenNodes(document.root)
  if (nodes.length > 1000 || new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error("IDs duplicados o demasiados bloques")
  for (const node of nodes) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(node.id) || !["container", "heading", "text", "button", "image"].includes(node.kind)) throw new Error("Bloque inválido")
    if (node.kind !== "container" && node.children.length) throw new Error("Solo los contenedores admiten bloques")
    if (node.placeholderFor !== undefined && (!/^[a-zA-Z0-9_-]{1,100}$/.test(node.placeholderFor) || node.children.length || node.placeholderFor === node.id || !nodes.some(target => target.id === node.placeholderFor && !target.placeholderFor))) throw new Error('Reserva de espacio inválida')
    validateLayout(node.layout); if (node.mobile) validateLayout(node.mobile)
    validateOffset(node.offset); if (node.mobileOffset) validateOffset(node.mobileOffset)
    if (node.targetScreenId !== undefined && !(document.screens ?? [{ id: 'default' }]).some(screen => screen.id === node.targetScreenId)) throw new Error('La pantalla de destino no existe')
  }
  if (document.screens !== undefined) {
    if (!Array.isArray(document.screens) || document.screens.length < 1 || document.screens.length > 40) throw new Error("Se admiten entre 1 y 40 pantallas")
    const ids = new Set<string>(), roots = new Set<string>()
    for (const screen of document.screens) {
      const root = findNode(document.root, screen.nodeId)
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(screen.id) || typeof screen.name !== 'string' || !screen.name.trim() || screen.name.length > 120 || !root || root.kind !== 'container' || ids.has(screen.id) || roots.has(screen.nodeId)) throw new Error("Pantalla inválida o duplicada")
      ids.add(screen.id); roots.add(screen.nodeId)
    }
    for (const screen of document.screens) {
      if (flattenNodes(findNode(document.root, screen.nodeId)!).slice(1).some(node => roots.has(node.id))) throw new Error("Las pantallas no pueden anidarse")
    }
  }
}
function validateLayout(layout: PreviewLayout) {
  if (layout.position !== undefined && !["relative", "absolute"].includes(layout.position)) throw new Error("Posición inválida")
  validateOffset(layout.left !== undefined || layout.top !== undefined ? { x: layout.left ?? 0, y: layout.top ?? 0 } : undefined)
  for (const key of ["gap", "padding", "width", "height", "columns"] as const) {
    const n = layout[key]; if (n !== undefined && (!Number.isFinite(n) || n < 0 || n > 10000 || (key === "columns" && (n < 1 || n > 12 || !Number.isInteger(n))))) throw new Error("Dimensión inválida")
  }
  for (const [key, values] of Object.entries({ display: ["flex", "grid"], direction: ["row", "column"], align: ["stretch", "start", "center", "end"], justify: ["start", "center", "end", "space-between"] })) {
    const value = layout[key as keyof PreviewLayout]; if (value !== undefined && !values.includes(String(value))) throw new Error("Regla de layout inválida")
  }
}
function validateOffset(offset: PreviewOffset | undefined) {
  if (!offset) return
  for (const value of [offset.x, offset.y]) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || Math.abs(value) > 10000) throw new Error("Posición inválida")
  }
}
/** Pure transactional application: no operation mutates the caller's document. */
export function applyOperations(document: PreviewDocument, operations: PreviewOperation[]): PreviewDocument {
  const next = structuredClone(document)
  for (const op of operations) {
    if (op.type === 'screen-add') {
      if (findNode(next.root, op.nodeId) || findNode(next.root, op.boardId)) throw new Error('El identificador de pantalla ya existe')
      if (!next.screens?.length) {
        next.screens = [{ id: `screen-${next.root.id}`, name: next.title || 'Pantalla 1', nodeId: next.root.id }]
        for (const node of flattenNodes(next.root)) if (node.targetScreenId === 'default') node.targetScreenId = next.screens[0].id
      }
      if (next.screens.some(screen => screen.nodeId === next.root.id)) {
        const original = next.root
        next.root = { id: op.boardId, kind: 'container', layout: { display: 'flex', direction: 'row', gap: 48 }, children: [original] }
      }
      next.root.children.push({ id: op.nodeId, kind: 'container', layout: { display: 'flex', direction: 'column', gap: 20, padding: 32, width: 1280, height: 800 }, mobile: { width: 390, height: 844 }, style: { background: '#ffffff' }, children: [{ id: `${op.nodeId}-title`, kind: 'heading', text: op.name, layout: {}, style: { fontSize: 32, fontWeight: 700, color: '#172033' }, children: [] }] })
      next.screens.push({ id: op.screenId, name: op.name, nodeId: op.nodeId })
      continue
    }
    if (op.type === 'screen-rename') {
      const screen = next.screens?.find(item => item.id === op.screenId)
      if (!screen) throw new Error('La pantalla ya no existe')
      screen.name = op.name.trim()
      continue
    }
    const node = findNode(next.root, op.nodeId); if (!node) throw new Error("El bloque ya no existe")
    if (op.type === "text") { if (op.text.length > 20000) throw new Error("Texto demasiado largo"); node.text = op.text }
    if (op.type === "layout") { if (op.viewport === "mobile") node.mobile = { ...node.mobile, ...op.patch }; else node.layout = { ...node.layout, ...op.patch } }
    if (op.type === "offset") { if (op.viewport === "mobile") node.mobileOffset = { ...op.offset }; else node.offset = { ...op.offset } }
    if (op.type === "style") node.style = { ...node.style, ...op.patch }
    if (op.type === "link") {
      if (op.screenId !== null && !(next.screens ?? [{ id: 'default' }]).some(screen => screen.id === op.screenId)) throw new Error("La pantalla de destino no existe")
      if (op.screenId === null) delete node.targetScreenId; else node.targetScreenId = op.screenId
    }
    if (op.type === "detach") {
      const parent = parentOf(next.root, node.id), target = findNode(next.root, op.parentId)
      const screenRoots = next.screens?.map(screen => screen.nodeId) ?? [next.root.id]
      if (!parent || !target || !screenRoots.includes(target.id) || screenRoots.includes(node.id) || !findNode(target, node.id)) throw new Error("Solo se puede separar dentro de la misma pantalla")
      validateOffset({ x: op.x, y: op.y }); validateLayout({ width: op.width, height: op.height })
      const index = parent.children.findIndex(child => child.id === node.id)
      if (node.layout.position !== 'absolute') {
        let suffix = 0, slotId: string
        do { slotId = `slot-${node.id.slice(0, 80)}-${suffix++}` } while (findNode(next.root, slotId))
        // Reserve the original slot so removing a child from flex/grid never
        // collapses its parent or pulls its neighbours into the vacant space.
        parent.children.splice(index, 1, {
          id: slotId, kind: node.kind, placeholderFor: node.id, children: [],
          layout: { ...node.layout, width: op.width, height: op.height },
          ...(node.mobile ? { mobile: { ...node.mobile } } : {}),
        })
      } else parent.children.splice(index, 1)
      target.children.push(node)
      target.layout = { ...target.layout, position: 'relative' }
      node.layout = { ...node.layout, position: 'absolute', left: op.x, top: op.y, width: op.width, height: op.height }
      node.offset = { x: 0, y: 0 }; node.mobileOffset = { x: 0, y: 0 }
    }
    if (op.type === "move") {
      const parent = parentOf(next.root, node.id), target = findNode(next.root, op.parentId)
      if (!parent || !target || target.kind !== "container" || findNode(node, target.id)) throw new Error("Movimiento inválido: no se puede crear un ciclo")
      if (!Number.isInteger(op.index) || op.index < 0) throw new Error("Posición inválida")
      const removedBefore = target.children.slice(0, op.index).filter(child => child.placeholderFor === node.id).length
      for (const container of flattenNodes(next.root)) container.children = container.children.filter(child => child.placeholderFor !== node.id)
      parent.children = parent.children.filter(n => n.id !== node.id)
      target.children.splice(Math.min(Math.max(0, op.index - removedBefore), target.children.length), 0, node)
      if (node.layout.position === 'absolute') {
        node.layout = { ...node.layout, position: 'relative', left: 0, top: 0 }
        node.offset = { x: 0, y: 0 }; node.mobileOffset = { x: 0, y: 0 }
      }
    }
  }
  validateDocument(next); return next
}
export class PreviewConflictError extends Error {
  constructor() { super("El diseño cambió mientras llegaba esta respuesta. Se conservó la revisión vigente; volvé a aplicar el cambio sobre ella."); this.name = "PreviewConflictError" }
}
export function applyAtRevision(document: PreviewDocument, currentRevisionId: string, baseRevisionId: string, operations: PreviewOperation[]): PreviewDocument {
  if (currentRevisionId !== baseRevisionId) throw new PreviewConflictError()
  return applyOperations(document, operations)
}
