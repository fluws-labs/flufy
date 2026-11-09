import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EDITOR_STYLE, editorBridgeScript, rendererOffsetStart, rendererOperation, rendererResizeStart } from '../src/preview/interaction.ts'
import { applyOperations } from '../src/preview/document.ts'
import { fromNativeDocument, mergeNativeDocument, toNativeDocument } from '../src/preview/client.ts'
import type { NativeDocument } from '../src/preview/client.ts'
import { previewAdjustmentContext } from '../src/preview/editor-context.ts'
import type { PreviewDocument } from '../src/preview/types.ts'

const document: PreviewDocument = {
  schemaVersion: 1, title: 'Editor', resources: [], theme: { tokens: {}, sources: [], approximations: [] },
  root: { id: 'root', kind: 'container', layout: {}, children: [
    { id: 'card', kind: 'container', layout: {}, children: [{ id: 'title', kind: 'text', text: 'Título', layout: {}, children: [] }] },
    { id: 'action', kind: 'button', text: 'Continuar', layout: {}, children: [] },
  ] },
}
const context = { identityKey: 'project/chat/task', revisionId: 'r1', channel: 'opaque-channel', viewport: 'mobile' as const }
const move = { ...context, type: 'preview-move', nodeId: 'action', parentId: 'card', index: 1 }
const resize = { ...context, type: 'preview-resize', nodeId: 'action', width: 240, height: 64 }

test('separar un hijo lo ancla a su pantalla y mover la caja anterior ya no lo afecta', () => {
  const message = { ...context, type: 'preview-detach', nodeId: 'title', parentId: 'root', x: 350, y: 90, width: 150, height: 30 }
  const operation = rendererOperation(message, context, document)!
  assert.equal(operation.type, 'detach')
  const detached = applyOperations(document, [operation])
  assert.equal(detached.root.children[0].children.length, 1)
  assert.equal(detached.root.children[0].children[0].placeholderFor, 'title')
  assert.deepEqual(detached.root.children[0].children[0].layout, { width: 150, height: 30 })
  assert.equal(detached.root.children.at(-1)!.id, 'title')
  assert.deepEqual(detached.root.children.at(-1)!.offset, { x: 0, y: 0 })
  const moved = applyOperations(detached, [{ type: 'offset', nodeId: 'card', offset: { x: 80, y: 50 } }])
  assert.deepEqual(moved.root.children.at(-1), detached.root.children.at(-1))
  const base = toNativeDocument(document)
  base.root!.children![0].children![0].styles = { marginTop: '12px', gridColumn: 'span 2' }
  const native = mergeNativeDocument(base, detached, [operation])
  const slot = native.root!.children![0].children![0]
  assert.equal(slot.placeholderFor, 'title')
  assert.equal(slot.styles!.marginTop, '12px')
  assert.equal(slot.styles!.gridColumn, 'span 2')
  assert.equal(slot.styles!.width, '150px')
  assert.equal(slot.styles!.height, '30px')
  assert.equal(slot.text, undefined)
  assert.equal(native.root!.layout!.position, 'relative')
  assert.equal(native.root!.children!.at(-1)!.layout!.left, '350px')
  assert.equal(native.root!.children!.at(-1)!.layout!.position, 'absolute')
  const regroup = { type: 'move' as const, nodeId: 'title', parentId: 'card', index: 0 }
  const regrouped = applyOperations(detached, [regroup])
  assert.equal(regrouped.root.children[0].children[0].layout.position, 'relative')
  assert.equal(regrouped.root.children[0].children.some(child => child.placeholderFor), false)
  assert.equal(mergeNativeDocument(native, regrouped, [regroup]).root!.children![0].children![0].layout!.position, 'relative')
  assert.equal(rendererOperation({ ...message, parentId: 'card' }, context, document), null)
  assert.equal(rendererOperation({ ...message, x: Infinity }, context, document), null)
  assert.equal(document.root.children[0].children[0].id, 'title')
})

test('los enlaces persisten por ID de pantalla, sobreviven al renombre y rechazan destinos inexistentes', () => {
  const screens = applyOperations(document, [{ type: 'screen-add', screenId: 'settings', nodeId: 'settings-root', boardId: 'board', name: 'Ajustes' }])
  const operation = { type: 'link' as const, nodeId: 'action', screenId: 'settings' }
  const linked = applyOperations(screens, [operation])
  const native = mergeNativeDocument(toNativeDocument(screens), linked, [operation])
  assert.equal(native.root!.children![0].children![1].targetScreenId, 'settings')
  const renamed = applyOperations(linked, [{ type: 'screen-rename', screenId: 'settings', name: 'Configuración' }])
  assert.equal(renamed.root.children[0].children[1].targetScreenId, 'settings')
  assert.throws(() => applyOperations(linked, [{ ...operation, screenId: 'missing' }]), /destino/)
  const unlinked = applyOperations(linked, [{ ...operation, screenId: null }])
  assert.equal(mergeNativeDocument(native, unlinked, [{ ...operation, screenId: null }]).root!.children![0].children![1].targetScreenId, undefined)
})

test('el arrastre produce una operación persistible sin mutar el documento y el tamaño se limita al viewport activo', () => {
  const operation = rendererOperation(move, context, document)!
  const moved = applyOperations(document, [operation])
  assert.deepEqual(moved.root.children[0].children.map(n => n.id), ['title', 'action'])
  assert.equal(document.root.children.length, 2)
  const resized = applyOperations(document, [rendererOperation(resize, context, document)!])
  assert.deepEqual(resized.root.children[1].mobile, { width: 240, height: 64 })
  assert.deepEqual(resized.root.children[1].layout, {})
})

test('se rechazan revisiones, canales, ámbitos y viewports ajenos y campos inesperados', () => {
  for (const message of [move, resize]) {
    for (const patch of [{ revisionId: 'old' }, { channel: 'other' }, { identityKey: 'other-task' }, { viewport: 'desktop' }, { html: '<script>unsafe</script>' }, { nodeId: 'missing' }]) {
      assert.equal(rendererOperation({ ...message, ...patch }, context, document), null)
    }
  }
})

test('no se puede mover la raíz, crear ciclos, insertar en texto o usar índices inválidos', () => {
  for (const patch of [{ nodeId: 'root' }, { nodeId: 'card', parentId: 'card' }, { nodeId: 'card', parentId: 'title' }, { parentId: 'title' }, { index: -1 }, { index: 100 }, { index: .5 }]) {
    assert.equal(rendererOperation({ ...move, ...patch }, context, document), null)
  }
})

test('las dimensiones de un gesto son enteras, finitas y acotadas antes de llegar al backend', () => {
  for (const width of [NaN, Infinity, -1, 0, 15, 10001, 20.5, '200', undefined]) {
    assert.equal(rendererOperation({ ...resize, width }, context, document), null)
    assert.equal(rendererOperation({ ...resize, height: width }, context, document), null)
  }
  const start = { ...resize, type: 'preview-resize-start', x: 100, y: 100 }
  assert.deepEqual(rendererResizeStart(start, context, document), { nodeId: 'action', width: 240, height: 64, x: 100, y: 100 })
  for (const patch of [{ x: NaN }, { y: 10001 }, { channel: 'other' }, { revisionId: 'stale' }, { viewport: 'desktop' }, { arbitrary: true }]) {
    assert.equal(rendererResizeStart({ ...start, ...patch }, context, document), null)
  }
})

test('el arrastre libre desplaza el bloque sin reordenarlo y se limita por viewport', () => {
  const offset = { ...context, type: 'preview-offset', nodeId: 'action', x: 120, y: -45 }
  const operation = rendererOperation(offset, context, document)!
  assert.deepEqual(operation, { type: 'offset', nodeId: 'action', viewport: 'mobile', offset: { x: 120, y: -45 } })
  const moved = applyOperations(document, [operation])
  assert.deepEqual(moved.root.children.map(n => n.id), ['card', 'action'])
  assert.deepEqual(moved.root.children[1].mobileOffset, { x: 120, y: -45 })
  assert.equal(document.root.children[1].mobileOffset, undefined)
  const start = { ...offset, type: 'preview-offset-start', startX: 10, startY: 20 }
  assert.deepEqual(rendererOffsetStart(start, context, document), { nodeId: 'action', x: 120, y: -45, startX: 10, startY: 20 })
  for (const patch of [{ x: NaN }, { y: 10001 }, { x: 1.5 }, { nodeId: 'root' }, { nodeId: 'missing' }, { channel: 'other' }, { arbitrary: true }]) {
    assert.equal(rendererOperation({ ...offset, ...patch }, context, document), null)
  }
  for (const patch of [{ startX: NaN }, { startY: Infinity }, { x: '1' }, { nodeId: 'root' }, { revisionId: 'old' }]) {
    assert.equal(rendererOffsetStart({ ...start, ...patch }, context, document), null)
  }
})

test('mover un bloque conserva los estilos nativos y persiste el desplazamiento como transform', () => {
  const persisted: NativeDocument = {
    version: 1,
    root: {
      id: 'root', type: 'container',
      styles: { display: 'flex', flexDirection: 'column', gap: '24px', padding: '28px 24px' },
      children: [{ id: 'a', type: 'text', text: 'A', styles: { fontSize: 'clamp(30px, 5vw, 44px)', lineHeight: '1.1' } }],
    },
    theme: { provenance: [], approximations: [], tokens: {} },
  }
  const operation = { type: 'offset' as const, nodeId: 'a', viewport: 'desktop' as const, offset: { x: 24, y: -12 } }
  const next = applyOperations(fromNativeDocument(persisted), [operation])
  const merged = mergeNativeDocument(persisted, next, [operation])
  assert.equal(merged.root!.children![0].styles?.transform, 'translate(24px, -12px)')
  assert.equal(merged.root!.children![0].styles?.fontSize, 'clamp(30px, 5vw, 44px)')
  assert.equal(merged.root!.styles?.display, 'flex')
  const nativeOnly = toNativeDocument(next)
  nativeOnly.preview = undefined
  assert.deepEqual(fromNativeDocument(nativeOnly).root.children[0].offset, { x: 24, y: -12 })
})

test('añadir pantallas conserva el diseño original y persiste metadatos, nombres y capas por IPC', () => {
  const multi = applyOperations(document, [{ type: 'screen-add', nodeId: 'login', screenId: 'login-screen', boardId: 'board', name: 'Acceso' }])
  assert.deepEqual(multi.root.children[0], document.root)
  assert.equal(multi.screens!.length, 2)
  assert.equal(document.screens, undefined)
  const renamed = applyOperations(multi, [{ type: 'screen-rename', screenId: 'login-screen', name: 'Iniciar sesión' }])
  const native = toNativeDocument(renamed)
  assert.deepEqual(native.screens, renamed.screens)
  assert.deepEqual(fromNativeDocument(native), renamed)
  const nativeOnly = { ...native, preview: undefined }
  assert.deepEqual(fromNativeDocument(nativeOnly).screens, renamed.screens)
  assert.equal(renamed.screens![1].name, 'Iniciar sesión')
  const persisted = toNativeDocument(document)
  const operation = { type: 'screen-add' as const, nodeId: 'login', screenId: 'login-screen', boardId: 'board', name: 'Acceso' }
  const added = applyOperations(fromNativeDocument(persisted), [operation])
  const merged = mergeNativeDocument(persisted, added, [operation])
  const login = merged.root!.children!.find(node => node.id === 'login')!
  assert.deepEqual(login.layout, { display: 'flex', flexDirection: 'column', gap: '20px', padding: '32px', width: '1280px', height: '800px' })
  assert.deepEqual(login.mobileStyles, { width: '390px', height: '844px' })
  assert.equal(login.styles?.background, '#ffffff')
})

test('no se pueden anidar pantallas ni invalidar sus referencias arrastrando su frame', () => {
  const multi = applyOperations(document, [{ type: 'screen-add', nodeId: 'login', screenId: 'login-screen', boardId: 'board', name: 'Acceso' }])
  assert.throws(() => applyOperations(multi, [{ type: 'move', nodeId: 'login', parentId: 'card', index: 0 }]), /anidarse/)
  assert.throws(() => applyOperations(multi, [{ type: 'screen-rename', screenId: 'login-screen', name: '' }]), /Pantalla inválida/)
})

test('editar la UI conserva los estilos nativos que el modelo editable no representa', () => {
  const persisted: NativeDocument = {
    version: 1,
    root: {
      id: 'root', type: 'container',
      styles: { display: 'flex', flexDirection: 'column', gap: '24px', padding: '28px 24px', fontFamily: 'Inter, sans-serif', borderRadius: '50%' },
      children: [
        { id: 'a', type: 'text', text: 'A', styles: { fontSize: 'clamp(30px, 5vw, 44px)', lineHeight: '1.1' } },
        { id: 'b', type: 'text', text: 'B', styles: { color: '#111111' } },
      ],
    },
    theme: { provenance: [], approximations: [], tokens: {} },
  }
  const operation = { type: 'move' as const, nodeId: 'b', parentId: 'root', index: 0 }
  const moved = applyOperations(fromNativeDocument(persisted), [operation])
  const merged = mergeNativeDocument(persisted, moved, [operation])
  assert.deepEqual(merged.root!.styles, persisted.root!.styles)
  assert.deepEqual(merged.root!.children!.map(node => node.id), ['b', 'a'])
  assert.deepEqual(merged.root!.children![1].styles, persisted.root!.children![0].styles)
  assert.equal(merged.preview, moved)
})

test('un ajuste del editor reemplaza solo la propiedad editada y conserva el resto del estilo', () => {
  const persisted: NativeDocument = {
    version: 1,
    root: {
      id: 'root', type: 'container',
      styles: { display: 'flex', gap: '24px', padding: '28px 24px', fontFamily: 'Inter, sans-serif' },
      children: [{ id: 'a', type: 'text', text: 'A', styles: { fontSize: '22px' } }],
    },
    theme: { provenance: [], approximations: [], tokens: {} },
  }
  const desktop = { type: 'layout' as const, nodeId: 'root', viewport: 'desktop' as const, patch: { gap: 8 } }
  const mobile = { type: 'layout' as const, nodeId: 'root', viewport: 'mobile' as const, patch: { padding: 12 } }
  const next = applyOperations(fromNativeDocument(persisted), [desktop, mobile])
  const merged = mergeNativeDocument(persisted, next, [desktop, mobile])
  assert.deepEqual(merged.root!.layout, { gap: '8px' })
  assert.deepEqual(merged.root!.mobileStyles, { padding: '12px' })
  assert.equal(merged.root!.styles?.gap, undefined)
  assert.equal(merged.root!.styles?.display, 'flex')
  assert.equal(merged.root!.styles?.padding, '28px 24px')
  assert.equal(merged.root!.styles?.fontFamily, 'Inter, sans-serif')
})

test('el puente mueve con requestAnimationFrame, conserva el regex de transform y recibe el estado sin recargar', () => {
  const script = editorBridgeScript({ identityKey: 'k', revisionId: 'r1', channel: 'opaque-channel', viewport: 'desktop' as const, rootId: 'root' })
  assert.ok(script.includes('requestAnimationFrame(flush)'))
  assert.ok(script.includes('cancelAnimationFrame(raf)'))
  assert.ok(script.includes("setAttribute('data-dragging','')"))
  assert.ok(script.includes("d.type!=='preview-state'"))
  assert.ok(script.includes('/^matrix\\(([^)]+)\\)$/'))
  assert.match(EDITOR_STYLE, /\[data-dragging\]\{will-change:transform/)
  assert.doesNotMatch(script, /c\.selectedId/)
})

test('el contexto del chat del editor pide reconciliar la revisión vigente y conserva tarea, pantalla y capa', () => {
  const identity = { project: 'D:/project', conversationId: 'chat', taskId: 'visual' }
  const text = previewAdjustmentContext({ identity, revisionId: 'r2', nodeId: 'title', screenId: 'home', viewport: 'mobile' })
  const payload = JSON.parse(text.split('\n')[0].replace('[FLUFY_PREVIEW_ADJUSTMENT]', ''))
  assert.deepEqual(payload, { identity, revisionId: 'r2', nodeId: 'title', screenId: 'home', viewport: 'mobile' })
  assert.match(text, /Leé primero la revisión vigente/)
  assert.match(text, /no implementes archivos ni delegues/)
})
