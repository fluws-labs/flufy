import { findNode, parentOf } from "./document.ts"
import type { RendererContext } from "./renderer.ts"
import type { PreviewDocument, PreviewOperation } from "./types.ts"

/** Only bounded structural/layout operations can cross the opaque iframe. */
export function rendererOperation(data: unknown, context: RendererContext, document: PreviewDocument): PreviewOperation | null {
  if (!data || typeof data !== "object") return null
  const v = data as Record<string, unknown>
  if (v.identityKey !== context.identityKey || v.revisionId !== context.revisionId || v.channel !== context.channel || v.viewport !== context.viewport || typeof v.nodeId !== "string") return null
  const node = findNode(document.root, v.nodeId)
  if (!node || node.placeholderFor) return null
  const keys = Object.keys(v).sort().join(",")
  if (v.type === 'preview-detach' && keys === 'channel,height,identityKey,nodeId,parentId,revisionId,type,viewport,width,x,y') {
    const roots = document.screens?.map(screen => screen.nodeId) ?? [document.root.id]
    const target = typeof v.parentId === 'string' ? findNode(document.root, v.parentId) : undefined
    if (!target || !roots.includes(target.id) || roots.includes(node.id) || !findNode(target, node.id)) return null
    if (![v.x, v.y].every(n => typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= 10000) || ![v.width, v.height].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 10000)) return null
    return { type: 'detach', nodeId: node.id, parentId: target.id, x: v.x as number, y: v.y as number, width: v.width as number, height: v.height as number }
  }
  if (v.type === "preview-move" && keys === "channel,identityKey,index,nodeId,parentId,revisionId,type,viewport") {
    if (typeof v.parentId !== "string" || typeof v.index !== "number" || !Number.isInteger(v.index)) return null
    const target = findNode(document.root, v.parentId)
    if (!parentOf(document.root, node.id) || !target || target.kind !== "container" || findNode(node, target.id)) return null
    if (v.index < 0 || v.index > target.children.filter(child => child.id !== node.id).length) return null
    return { type: "move", nodeId: node.id, parentId: target.id, index: v.index }
  }
  if (v.type === "preview-resize" && keys === "channel,height,identityKey,nodeId,revisionId,type,viewport,width") {
    if (![v.width, v.height].every(n => typeof n === "number" && Number.isInteger(n) && n >= 16 && n <= 10000)) return null
    return { type: "layout", nodeId: node.id, viewport: context.viewport, patch: { width: v.width as number, height: v.height as number } }
  }
  if (v.type === "preview-offset" && keys === "channel,identityKey,nodeId,revisionId,type,viewport,x,y") {
    if (![v.x, v.y].every(n => typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= 10000)) return null
    if (node.id === context.rootId || (context.screenNodeIds ?? []).includes(node.id) || !parentOf(document.root, node.id)) return null
    return { type: "offset", nodeId: node.id, viewport: context.viewport, offset: { x: v.x as number, y: v.y as number } }
  }
  return null
}

export type RendererResizeStart = { nodeId: string; width: number; height: number; x: number; y: number }
export function rendererResizeStart(data: unknown, context: RendererContext, document: PreviewDocument): RendererResizeStart | null {
  if (!data || typeof data !== 'object') return null
  const v = data as Record<string, unknown>
  if (v.type !== 'preview-resize-start' || Object.keys(v).sort().join(',') !== 'channel,height,identityKey,nodeId,revisionId,type,viewport,width,x,y') return null
  if (![v.x, v.y].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000)) return null
  const { x, y, ...rest } = v
  if (!rendererOperation({ ...rest, type: 'preview-resize' }, context, document)) return null
  return { nodeId: v.nodeId as string, width: v.width as number, height: v.height as number, x: x as number, y: y as number }
}

export type RendererOffsetStart = { nodeId: string; x: number; y: number; startX: number; startY: number }
export function rendererOffsetStart(data: unknown, context: RendererContext, document: PreviewDocument): RendererOffsetStart | null {
  if (!data || typeof data !== 'object') return null
  const v = data as Record<string, unknown>
  if (v.type !== 'preview-offset-start' || Object.keys(v).sort().join(',') !== 'channel,identityKey,nodeId,revisionId,startX,startY,type,viewport,x,y') return null
  if (v.identityKey !== context.identityKey || v.revisionId !== context.revisionId || v.channel !== context.channel || v.viewport !== context.viewport || typeof v.nodeId !== 'string') return null
  if (![v.x, v.y, v.startX, v.startY].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10000)) return null
  const node = findNode(document.root, v.nodeId)
  if (!node || node.id === context.rootId || (context.screenNodeIds ?? []).includes(node.id) || !parentOf(document.root, node.id)) return null
  return { nodeId: node.id, x: v.x as number, y: v.y as number, startX: v.startX as number, startY: v.startY as number }
}

export const EDITOR_STYLE = `[data-selected]{outline:2px solid #8b80ff!important;outline-offset:-2px}[data-node]:focus-visible,[data-preview-id]:focus-visible{outline:2px dashed #8b80ff}[draggable=true]{cursor:grab;touch-action:none}[data-dragging]{will-change:transform;cursor:grabbing!important;user-select:none}#preview-resize-handle{position:fixed;width:14px;height:14px;min-width:0;padding:0;border:2px solid white;border-radius:3px;background:#7668f5;z-index:2147483647;cursor:nwse-resize;touch-action:none;box-sizing:border-box}#preview-resize-label{position:fixed;z-index:2147483647;background:#28233e;color:white;padding:3px 6px;border-radius:4px;font:12px sans-serif;pointer-events:none}`

/** Fixed editor code; no script or CSS from user messages is evaluated here. */
export function editorBridgeScript(context: RendererContext): string {
  const data = JSON.stringify(context).replace(/</g, "\\u003c")
  return `(()=>{
const c=${data}, selector='[data-preview-id],[data-node]';
const id=n=>n&&(n.getAttribute('data-preview-id')||n.getAttribute('data-node'));
const nodes=()=>Array.from(document.querySelectorAll(selector)).filter(n=>!n.hasAttribute('data-preview-slot'));
const byId=value=>nodes().find(n=>id(n)===value);
const send=(type,extra)=>parent.postMessage(Object.assign({type,identityKey:c.identityKey,revisionId:c.revisionId,channel:c.channel},extra),'*');
let selected=null, candidate=null, dragging=null, resize=null, suppressClick=false, readOnly=!!c.readOnly;
let pending=null, raf=0;
const draggableFor=n=>!readOnly&&id(n)!==c.rootId&&!(c.screenNodeIds||[]).includes(id(n));
const handle=document.createElement('button');handle.id='preview-resize-handle';handle.type='button';handle.setAttribute('aria-label','Redimensionar bloque');handle.title='Arrastrá para cambiar el tamaño';handle.hidden=true;
const label=document.createElement('span');label.id='preview-resize-label';label.hidden=true;document.body.append(handle,label);
function position(){const n=byId(selected);if(!n||readOnly){handle.hidden=true;return}const r=n.getBoundingClientRect();handle.hidden=false;handle.style.left=Math.max(0,Math.min(innerWidth-16,r.right-8))+'px';handle.style.top=Math.max(0,Math.min(innerHeight-16,r.bottom-8))+'px';label.style.left=Math.max(0,Math.min(innerWidth-110,r.right-100))+'px';label.style.top=Math.max(0,r.bottom-34)+'px'}
function applySelection(n){selected=id(n);nodes().forEach(x=>{if(x===n)x.setAttribute('data-selected','true');else x.removeAttribute('data-selected')});position()}
function select(n){applySelection(n);send('preview-select',{nodeId:selected})}
nodes().forEach(n=>{n.setAttribute('tabindex','0');n.draggable=draggableFor(n);if(c.screenRootId&&(c.screenNodeIds||[]).includes(id(n))&&id(n)!==c.screenRootId)n.style.setProperty('display','none','important')});
position();
addEventListener('resize',position);addEventListener('scroll',position,true);new ResizeObserver(position).observe(document.body);
// Selection and read-only state arrive over postMessage so a click or a save never
// regenerates srcDoc; only a real artifact change reloads the frame.
addEventListener('message',e=>{const d=e.data;if(!d||d.channel!==c.channel||(e.source&&e.source!==parent))return;if(d.type==='preview-detach-request'&&!readOnly){const n=byId(d.nodeId),placement=n&&detachedPlacement(n,true);if(placement)send('preview-detach',placement);return}if(d.type==='preview-finish-offset'&&!readOnly&&Number.isFinite(d.x)&&Number.isFinite(d.y)){finishDrag({clientX:d.x,clientY:d.y});return}if(d.type!=='preview-state')return;if(typeof d.readOnly==='boolean'){readOnly=d.readOnly;nodes().forEach(n=>n.draggable=draggableFor(n));if(readOnly&&dragging)cancelDrag();position()}if('selectedId' in d){const n=d.selectedId?byId(d.selectedId):null;if(n)applySelection(n);else{selected=null;nodes().forEach(x=>x.removeAttribute('data-selected'));position()}}});
document.addEventListener('click',e=>{if(suppressClick){suppressClick=false;e.preventDefault();return}const n=e.target.closest(selector);if(n){e.preventDefault();e.stopPropagation();select(n)}});
function translated(n){const t=getComputedStyle(n).transform;if(!t||t==='none')return{x:0,y:0};const m=/^matrix\\(([^)]+)\\)$/.exec(t);if(m){const p=m[1].split(',').map(Number);return{x:p[4]||0,y:p[5]||0}}const m3=/^matrix3d\\(([^)]+)\\)$/.exec(t);if(m3){const p=m3[1].split(',').map(Number);return{x:p[12]||0,y:p[13]||0}}return{x:0,y:0}}
function moveTo(n,x,y){n.style.transform='translate('+x+'px, '+y+'px)'}
function detachedPlacement(n,force=false){const p=n.parentElement&&n.parentElement.closest(selector),root=byId(c.screenRootId||c.rootId);if(!p||!root||p===root||id(n)===c.rootId||(c.screenNodeIds||[]).includes(id(n)))return null;const r=n.getBoundingClientRect(),b=p.getBoundingClientRect(),s=root.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;if(!force&&cx>=b.left&&cx<=b.right&&cy>=b.top&&cy<=b.bottom)return null;return{nodeId:id(n),parentId:id(root),x:Math.round(r.left-s.left-root.clientLeft+root.scrollLeft),y:Math.round(r.top-s.top-root.clientTop+root.scrollTop),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height)),viewport:c.viewport}}
function flush(){raf=0;if(!dragging||!pending)return;moveTo(dragging.node,pending.x,pending.y);pending=null}
function schedule(x,y){pending={x,y};if(!raf)raf=requestAnimationFrame(flush)}
function clearPending(){if(raf){cancelAnimationFrame(raf);raf=0}pending=null}
function cancelDrag(){clearPending();if(dragging){moveTo(dragging.node,dragging.base.x,dragging.base.y);dragging.node.removeAttribute('data-dragging')}dragging=null;candidate=null;send('preview-gesture-end',{viewport:c.viewport})}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(dragging)cancelDrag();else if(resize)cancelResize();candidate=null;return}if(e.key==='Enter'||e.key===' '){const n=e.target.closest(selector);if(n){e.preventDefault();select(n)}}});
document.addEventListener('submit',e=>e.preventDefault());
// Pointer dragging moves the block freely; the layer panel still reorders it.
// Native HTML drag-and-drop may stop routing events across a sandbox boundary.
document.addEventListener('dragstart',e=>e.preventDefault());
document.addEventListener('pointerdown',e=>{const n=e.target.closest(selector);if(!n||readOnly||id(n)===c.rootId||(c.screenNodeIds||[]).includes(id(n)))return;e.preventDefault();candidate={node:n,x:e.clientX,y:e.clientY,base:translated(n)};n.setPointerCapture(e.pointerId)});
document.addEventListener('pointermove',e=>{if(!candidate)return;const dx=e.clientX-candidate.x,dy=e.clientY-candidate.y;if(!dragging){if(Math.hypot(dx,dy)<=3)return;dragging=candidate;dragging.node.setAttribute('data-dragging','');send('preview-offset-start',{nodeId:id(candidate.node),x:candidate.base.x,y:candidate.base.y,startX:candidate.x,startY:candidate.y,viewport:c.viewport})}e.preventDefault();schedule(Math.round(dragging.base.x+dx),Math.round(dragging.base.y+dy))});
function finishDrag(e){if(!candidate)return;if(dragging){clearPending();const bounded=n=>Math.max(-10000,Math.min(10000,Math.round(n))),x=bounded(dragging.base.x+e.clientX-dragging.x),y=bounded(dragging.base.y+e.clientY-dragging.y);moveTo(dragging.node,x,y);dragging.node.removeAttribute('data-dragging');const placement=detachedPlacement(dragging.node);if(placement)send('preview-detach',placement);else send('preview-offset',{nodeId:id(dragging.node),x,y,viewport:c.viewport})}else select(candidate.node);suppressClick=true;dragging=null;candidate=null}
document.addEventListener('pointerup',finishDrag);
document.addEventListener('dblclick',e=>{const n=e.target.closest(selector);if(n&&c.links&&c.links[id(n)]){e.preventDefault();send('preview-navigate',{nodeId:id(n)})}});
document.addEventListener('pointercancel',()=>{if(dragging)cancelDrag();else{clearPending();dragging=null;candidate=null}});
function cancelResize(){if(!resize)return;resize.node.style.width=resize.originalWidth;resize.node.style.height=resize.originalHeight;resize=null;label.hidden=true;position();send('preview-gesture-end',{viewport:c.viewport})}
handle.addEventListener('pointerdown',e=>{if(readOnly)return;const n=byId(selected);if(!n)return;e.preventDefault();e.stopPropagation();const r=n.getBoundingClientRect();resize={node:n,x:e.clientX,y:e.clientY,width:r.width,height:r.height,originalWidth:n.style.width,originalHeight:n.style.height};handle.setPointerCapture(e.pointerId);send('preview-resize-start',{nodeId:id(n),width:Math.round(r.width),height:Math.round(r.height),x:e.clientX,y:e.clientY,viewport:c.viewport})});
handle.addEventListener('pointermove',e=>{if(!resize)return;const w=Math.max(16,Math.min(10000,Math.round(resize.width+e.clientX-resize.x))),h=Math.max(16,Math.min(10000,Math.round(resize.height+e.clientY-resize.y)));resize.node.style.width=w+'px';resize.node.style.height=h+'px';resize.result={nodeId:id(resize.node),width:w,height:h,viewport:c.viewport};label.textContent=w+' × '+h;label.hidden=false;position()});
handle.addEventListener('pointerup',()=>{if(!resize)return;const result=resize.result;cancelResize();suppressClick=true;if(result)send('preview-resize',result)});
handle.addEventListener('pointercancel',cancelResize);
})()`
}
