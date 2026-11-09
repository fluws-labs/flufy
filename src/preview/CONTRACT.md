# Integración de previsualización

## Extensión del editor visual (2026-11-08)

- Regla de movimiento aislado: separar un bloque deja una reserva de espacio invisible (`placeholderFor`) en su posición de flujo anterior. Conserva tamaño medido y layout nativo (márgenes/flex/grid), para que sus vecinos y la caja no se reacomoden ni al soltar ni al reabrir. Las reservas no aparecen en capas/selector ni reciben interacción o foco; el render nativo las marca `data-preview-slot`/`aria-hidden`. Reagrupar explícitamente elimina la reserva correspondiente.

- Separación real: si el centro de un bloque se suelta fuera de su caja, el puente mide su rectángulo y emite `preview-detach`. La operación `detach` lo mueve a la raíz de **su misma pantalla** con `position:absolute`, coordenadas relativas a esa pantalla, tamaño medido y transform reiniciado. La raíz queda relativa; mover la caja anterior ya no afecta al bloque. «Separar de la caja» permite corregir también bloques desplazados en revisiones anteriores, sin cambiar el historial. Reagrupar desde capas vuelve a posicionamiento relativo. Las coordenadas y los destinos se validan antes de guardar una única revisión.
- Navegación interna: `PreviewNode.targetScreenId` y la operación `link` vinculan botones o textos a IDs de `screens` (no a sus nombres ni a URLs). El adaptador persiste el destino en el nodo nativo y el renderer Rust lo conserva como `data-target-screen`. Destinos inexistentes se rechazan. El inspector permite elegir/quitar destino y probarlo; doble clic en el lienzo también navega. «Enlaces de esta pantalla» indexa las conexiones de la pantalla activa. Probar un enlace cambia la pantalla visible sin generar una revisión ni ejecutar código del diseño.
- Inspector: distingue contenedor/elemento libre, muestra un nombre legible más el ID y separa navegación, contenido, organización, tamaño y colores. Las capas señalan elementos libres y enlaces.

- Biblioteca: el botón visible **Diseños** del panel del agente y del editor abre `PreviewLibrary`. `preview_list({projectRoot})` devuelve `{designs,unreadable}` con metadatos del diseño de cada tarea del proyecto autorizado por la ventana (sin cargar artefactos/HTML). Filtra por la identidad completa de cada fila persistida y conserva los registros ilegibles. La tarjeta muestra el tema de la conversación resuelto desde las sesiones cargadas (con la identidad guardada como `title` secundario); abrir una tarjeta sigue seleccionando la conversación y la tarea guardadas y usando el editor existente, con su autorización habitual. Reabrir el diseño minimizado lo restaura sin desmontar su edición.

- El alojamiento normal es ahora `PreviewFloatingEditor`: diálogo modal casi a pantalla completa, minimizable sin desmontar selección/borrador/viewport, chat plegable y controles de tamaño. El lienzo conserva 1280×800 / 390×844; el zoom escala su representación sin alterar la revisión.
- `document.screens?: {id,name,nodeId}[]` identifica frames contenedores no anidados (máximo 40). Sin metadatos, el diseño existente aparece como una sola pantalla. La UI permite añadir/renombrar pantallas y navegar sus capas. Las operaciones `screen-add`/`screen-rename` son de dominio; el IPC sigue persistiendo el documento completo con `baseRevisionId`.
- Al guardar desde UI, `screens` se mantiene en el documento nativo y en `document.preview`. El backend valida IDs, referencias, no anidación y coherencia de los dos metadatos. Los borradores nativos del agente pueden omitir `preview` y declarar `screens` directamente.
- El iframe editable sigue siendo opaco (`sandbox=allow-scripts`, sin same-origin). Su puente fijo usa punteros para selección, desplazamiento libre y tamaño. Arrastrar en el lienzo aplica `offset -> transform:translate(...)` sobre el bloque sin reordenarlo; el orden y la anidación se cambian arrastrando en Pantallas y capas (`preview-move`). Cada gesto se valida contra source/origin/canal/identidad/revisión/viewport y nodos vigentes antes de producir operaciones acotadas. El host termina el resize y el desplazamiento si el puntero sale del iframe; el código de la aplicación no se expone al documento.
  - Fluidez: el `pointermove` agrupa las escrituras de `transform` en un solo `requestAnimationFrame`, marca el bloque con `data-dragging` (`will-change:transform`, `touch-action:none`) y arranca a los 3 px. `selectedId` y `readOnly` ya **no** se incrustan en `srcDoc`: el host los envía con `postMessage` (`preview-state`, validado por canal/origen) al cargar y al cambiar. Seleccionar un bloque o iniciar un guardado ya no regenera el artefacto ni recarga el iframe, de modo que el bloque arrastrado no vuelve a su posición anterior entre el gesto y la persistencia. Solo un cambio real de revisión/artefacto recarga el frame.
- Panel lateral de propiedades: botón **Paleta de colores** con selector de destino (fondo, texto o borde), selector nativo de color, campo hexadecimal (`#FAFAFA`, acepta 3 o 6 dígitos, normaliza a mayúsculas), validación visible y muestras rápidas (tokens de color del tema más presets). Aplica la operación de dominio `style` con `patch: {color|background|borderColor}`; el color se valida como hex antes de persistir y el compromiso se agrupa 160 ms para no crear una revisión por cada movimiento del selector. Los colores admitidos siguen la allowlist segura del backend (`resolveSafeColor` / `properties()`).
- `PreviewConversation` reutiliza historial, agente, modelo, permisos/preguntas y sesión existentes. `sendPrompt` recibe opcionalmente `PreviewAdjustment` y agrega contexto sintético con revisión/pantalla/capa. Rechaza editor de otro proyecto/sesión/tarea y solicita leer la revisión vigente antes de aplicar ajustes. No crea un agente ni una conversación paralela.

Estado: **contrato real confirmado contra `src-tauri/src/preview.rs`** (comandos registrados en `src-tauri/src/lib.rs`, herramientas del canal Teams en `src-tauri/src/desktop/mod.rs`). Ya no hay contrato propuesto ni `preview_restore`. El backend es la autoridad de persistencia **y de render**: `Design`/`Reference` y `Revision.html`/`css` viven en SQLite transaccional; el adaptador (`client.ts`) es el único lugar que traduce las formas de documento y la identidad al modelo en memoria.

## Comandos nativos (firmas reales)

Todos reciben `identity` con **cuatro campos** (`serde rename_all = "camelCase"`, `deny_unknown_fields`):

```
identity: { projectRoot, sessionId, taskId, designId }
```

| Comando | Argumentos JS (camelCase) | Respuesta |
| --- | --- | --- |
| `preview_get` | `{ identity }` | `Design` (nunca null; `empty()` devuelve `choice:"pending"`) |
| `preview_choose` | `{ identity, baseRevisionId, choice }` | `Design` |
| `preview_apply` | `{ identity, baseRevisionId, document, notes }` | `Design` |
| `preview_approve` | `{ identity, baseRevisionId, notes }` | `Design` |
| `preview_identity` | `{ identity }` | `Value` (provenance/aproximaciones de CSS/SCSS locales) |

- `choice`: `"create" | "skip"` (una sola vez por tarea; `choose` rechaza cambiar una elección ya tomada).
- `baseRevisionId`: `string | null`. El servidor lo compara de forma atómica con `current_revision_id`; `null` solo vale para el primer borrador / la elección inicial. Un valor desactualizado produce `PREVIEW_CONFLICT` sin alterar el estado.
- `document`: JSON con forma nativa `{ version:1, root:Node, theme, ... }`; `Node` usa `{ id, type, text?, layout?, styles?, mobileStyles?, children }` con `type ∈ container|text|button|image` y mapas de propiedades CSS. `preview_apply` lo renderiza a `html`/`css` y crea una revisión **append-only**. El backend lee solo `root` (y `mobileStyles`) al renderizar; los campos extra se conservan en `Revision.document` pero no alteran el artefacto.
- `notes`: resumen/observaciones (≤ 8000). No hay campo `operations`, `author` ni `revisionId` en los comandos.
- `Design` (autoridad de persistencia): `{ identity, choice, status, currentRevisionId, approvedRevisionId, revisions[], approvals[] }`. `approved_revision_id` congela la referencia; `reference()` exige que siga siendo la revisión vigente antes de delegar.
- `preview_approve` **no** recibe `revisionId`: aprueba la revisión vigente y usa `baseRevisionId` como guarda de frescura.
- **`preview_restore` no existe.** No hay comando para reescribir el historial.

### Evento

`preview://changed` (no `preview-changed`). El servidor emite el `Design` completo tras cada mutación (`emit`). `usePreview` escucha ese nombre y **recarga desde la persistencia** en lugar de confiar en el payload: el `projectRoot` del evento viene canonicalizado y puede no coincidir con `identity.project`. El sondeo cada 4 s cubre escrituras del agente en otro proceso. Limitación documentada (H6, no bloqueante): el evento es global y `usePreview` no lo filtra por identidad, por lo que cada mutación dispara un `preview_get`+`authorize()` en todos los paneles abiertos; `assertIdentity` y el gate de peticiones preservan el aislamiento (solo añade carga). Filtrar por `sessionId`/`taskId`/`designId` queda como optimización coordinada por el Lead.

### Herramientas del canal Teams

`preview::tools()` expone `preview_get`, `preview_identity` y `preview_apply` (con `identity` de cuatro campos, `baseRevisionId` explícito, `document`, `notes`). La elección y la aprobación son exclusivas del usuario; el despacho `preview_*` valida que la sesión del equipo coincida con `sessionId`.

### Identidad por tarea (coordinación)

`toNativeIdentity` mapea los tres campos del dominio a los cuatro nativos (`projectRoot ← project`, `sessionId ← conversationId`, `taskId ← taskId`, `designId` constante `"design"`). La PK es `(project, session, task, design)`: **T3 debe hacer variar `taskId` por tarea visual** (`src/agent/preview-identity.ts`) para que dos tareas del mismo chat no compartan elección/aprobación; y **T1 debe filtrar `session_reference()` por tarea/vigencia** (hoy `ORDER BY rowid DESC` sin filtro) para no devolver un diseño arbitrario. La identidad del `Design` devuelto **no** se reconstruye a la inversa porque `projectRoot` está canonicalizado.

### Continuación T1: identidad estable (contrato para T2/T3/T4)

- `src/preview/task-identity.ts` publica `previewTaskKey`, `resolvePreviewTaskId`, `previewTaskContext` y el marcador `[FLUFY_PREVIEW_IDENTITY]`. El marcador contiene JSON `{projectRoot,sessionId,taskId,designId:"design"}` en la primera línea de una parte **synthetic** del usuario. Se adjunta en cada envío normal; el agente recibe la identidad exacta sin inferirla del último mensaje. Las tools y `previewIdentity` de delegación usan esos mismos cuatro campos. El adaptador nativo no cambia.
- `useAgent.previewTasks` conserva la tarea elegida por proyecto/sesión en la persistencia habitual de Flufy. Correcciones, mensajes del agente, cambios de revisión y reapertura no cambian ese ID. El panel y el dock usan el mismo hook. «Nueva tarea en este chat» es el límite explícito: crea UUID y vuelve a ofrecer elección sin copiar documento ni aprobación de la tarea anterior.
- Al recuperar un chat sin selección local se usa el último marcador válido del historial; se rechazan marcadores ajenos o no sintéticos. En chats antiguos sin marcador se ancla una vez al primer turno humano, solo si el historial está completo. Un historial paginado sin marcador no se trata como completo; el usuario puede iniciar explícitamente una tarea nueva.
- T4 puede importar el resolver puro sin cargar React/Zustand. Casos esperados: corrección y respuesta mantienen ID; marcador permite reconstruir tras reapertura; dos límites explícitos generan IDs distintos; proyecto/sesión y contexto sintético se validan; un historial parcial no elige su primer mensaje como tarea original.

## Adaptador (`client.ts`) y suposición de traducción

Suposición explícita: **el backend es la autoridad de persistencia y de render, y la traducción de formas de documento vive en el adaptador**. El dominio (`document.ts`, `renderer.ts`, `state.ts`) y sus 9 pruebas no se reescriben y operan sobre `PreviewDocument`/`PreviewState`/`PreviewIdentity` (tres campos: `project`, `conversationId`, `taskId`).

El adaptador realiza, y solo él:

- `toNativeIdentity`: mapea los tres campos a los cuatro nativos. Chat y equipo, al pasar la misma identidad, resuelven el mismo registro y por tanto la misma referencia aprobada.
- `toNativeDocument(document, author)` / `fromNativeDocument`: convierten entre `PreviewDocument` (`kind`, `layout`, `mobile`, `style`, `theme.sources/tokens/approximations`, `resources`) y la forma nativa (`type`, mapas CSS). El `root` nativo es el que renderiza el backend. El documento nativo lleva además un campo `preview` con el `PreviewDocument` verbatim (ida y vuelta **sin pérdida del modelo editable**), `previewKind` por nodo (recupera `heading`) y `author` (`change.author`); el backend ignora estos campos al renderizar, por lo que `reference_context()` sigue verificando `render(document) == html/css`.
- **Inyección de tema (criterio #6):** `themeRootStyles` resuelve `tokens.fontFamily/background/text` (incluidas referencias `$token`) y los valida contra `properties()` del backend, y `toNativeDocument` los agrega como `fontFamily/background/color` en `styles` del nodo raíz (todas propiedades permitidas). Así el artefacto congelado que produce `render()` —y que recibe el ejecutor— lleva la paleta y la tipografía del proyecto objetivo, no un render sin estilo. Los estilos explícitos del nodo raíz tienen prioridad sobre el tema.
- `deriveDocument`: fallback **solo** para borradores del agente escritos con `preview_apply` sin campo `preview`. Recupera `kind` vía `previewKind`, declara sus aproximaciones en `theme.approximations` y deja `resources: []`. Ver «Aproximaciones declaradas».
- `fromNativeDesign`: transforma `Design` en `PreviewState` (revisiones con `html`/`css` congelados del backend, `summary ← notes`, `approval` desde `approvedRevisionId` + `approvals`, `status`, `currentRevisionId`). El `author` del historial se reconstruye: revisiones con `preview` usan el `author` embebido; las escritas por tools (sin `preview`) se marcan `"agent"`. `load` devuelve `null` solo para el estado inicial pendiente sin revisiones.
- `change`: aplica `applyOperations` del dominio sobre el documento de `baseRevisionId`, pero **no reconstruye el documento nativo desde el modelo editable**. `mergeNativeDocument` parte del documento nativo persistido y aplica solo los campos que la operación cambió (texto, layout, tamaño, orden, desplazamiento, pantallas); el desplazamiento se guarda como `styles.transform` (o `mobileStyles.transform`) y se recupera como `PreviewNode.offset`/`mobileOffset`. Así conserva las propiedades CSS que `PreviewNode` no modela (`display`, `gap`, `padding`, `fontFamily`, `lineHeight`, `boxShadow`, `borderRadius: 50%`, etc.) y el diseño mantiene su apariencia original. El `preview` editable se actualiza en paralelo y el guarda de `baseRevisionId` del backend conserva la detección de conflictos por respuesta tardía.
- `restore` en `PreviewClient` se **resuelve sobre las revisiones persistidas**: lee el `document` nativo de la revisión objetivo y lo reaplica con `preview_apply`, creando una revisión nueva (append-only), nunca reescribiendo el historial. Al reaplicar el mismo documento, `render()` reproduce el mismo `html`/`css` congelado: deshacer/rehacer es visualmente coherente.
- `approve` mapea `revisionId → baseRevisionId`; una revisión desactualizada es rechazada por el backend sin cambiar el estado.

## Un solo artefacto renderizado (resuelve el doble renderizador)

Decisión: **`Revision.html`/`css`, producidos por `render()` del backend, son el único artefacto visual**. `reference_context()` (`preview.rs`) entrega exactamente ese artefacto a chat/equipo y verifica `render(revision.document) == revision.html/css`. Por eso la UI **ya no genera un segundo render del diseño**:

- `artifact.ts::previewArtifactHtml(revision)` devuelve `revision.html` **sin modificar** cuando ya es un documento completo (caso real del backend). La comparación y la referencia aprobada (`PreviewComparison` → `PreviewFrame`) muestran ese HTML congelado en un `iframe` sandbox. Un fragmento (fixtures de dominio) se envuelve con la misma CSP estricta y su `css`, sin alterar el marcado.
- `artifact.ts::previewEditorArtifactHtml(revision, context)` usa el **mismo** artefacto congelado para el editor y agrega únicamente el puente fijo de selección: relaja la CSP a `script-src 'unsafe-inline'` (mantiene `default-src 'none'`, sin red, sin marcos, sin formularios), inyecta estilos de selección y el script que emite `preview-select`. El marcado y el CSS del diseño permanecen idénticos al artefacto aprobado: **lo que el usuario aprueba, lo que ve la comparación y lo que recibe el ejecutor es el mismo artefacto** (mismo ID y contenido).
- `PreviewFrame` usa `artifactHtml`/`artifactCss` cuando existen (flujo real) y conserva `renderEditorHtml`/`renderPreviewHtml` (`renderer.ts`, sin cambios) solo como fallback si un estado no trae artefacto. No se reescribe el dominio ni sus 9 pruebas.
- Prueba del invariante: `previewArtifactHtml({html:r.html,css:r.css}) === r.html` (frente al HTML congelado), y el HTML del editor conserva íntegros el `<body>` y el `<style>` del artefacto. Ver `artifact.test.mjs`.

## Aproximaciones declaradas (criterio #6, H2)

El camino con `preview` (todo documento creado por el adaptador) es sin pérdida. El fallback `deriveDocument` (borrador de tool sin `preview`) declara explícitamente, en `PREVIEW_DERIVE_APPROXIMATIONS` y en `theme.approximations` visibles en el panel:

1. `resources: []`: la forma nativa no modela `PreviewDocument.resources`; el iframe muestra el artefacto congelado, así que no hay pérdida visual.
2. El backend no tiene tipo `heading`: `previewKind` recupera el bloque **editable**, pero el artefacto renderiza `<p>` (autoridad del backend, coherente con el ejecutor).
3. Propiedades CSS nativas no modeladas por `PreviewNode.style` (`fontFamily`, `lineHeight`, `boxShadow`, `opacity`, `textAlign`, `objectFit`, `flex`, `minWidth`, ...) permanecen **solo en el artefacto congelado mostrado**, no en el modelo editable; una nueva edición sobre ese borrador las reemite desde el modelo. Para evitarlo, las tools deberían escribir también el campo `preview` (recomendación a T1/T3); no es obligatorio para la visualización.
4. La identidad visual del tema se aplica al **nodo raíz** del artefacto nativo (el backend no expone `body`), no al `body` del renderizador de dominio: es una aproximación visual declarada.

Limitación documentada: el contrato nativo no tiene campo `author` por revisión; el adaptador lo transporta dentro de `document` y lo reconstruye (tool → `agent`, edición → `change.author`). `restore` reaplica el documento objetivo verbatim, por lo que una restauración conserva el autor original de esa revisión.

## API pública (sin cambios para front-2)

`index.ts` publica, sin modificaciones:

- `PreviewPanel({ identity, client?, onApproved?, onStateChange?, onClose? })` — `identity` sigue siendo `PreviewIdentity` de tres campos; `client` es `PreviewClient` (por defecto `previewClient`).
- `PreviewComparison({ state, implementation?, implementations? })` — usa `PreviewState`.
- `usePreview(identity, client?)`, `previewClient` y los tipos de `types.ts` (incluye `PreviewImplementation`/`PreviewViewport`).

`types.ts` no se modifica: `PreviewClient` conserva `load/choose/change/restore/approve` y `types.ts` sigue definiendo `PreviewState`, `PreviewDocument`, `PreviewIdentity`, `previewIdentityKey`. `index.ts` queda byte-idéntico; los helpers nuevos viven en `artifact.ts` y se importan por ruta directa desde las pruebas.

## Renderer aislado

Se mantiene: `iframe` con `sandbox` **sin `allow-same-origin`** (`allow-scripts` solo en modo editor), CSP estricta que niega red, marcos, bases y formularios, puente fijo de selección y validación de mensajes por ventana emisora, origen opaco (`"null"`), identidad, revisión, canal aleatorio y esquema exacto (`isRendererSelection`). El editor sobre el artefacto congelado usa `[data-preview-id]` y el mismo validador; el fallback de dominio (`renderer.ts:53,61`) usa `[data-node]` con la misma CSP y el mismo `isRendererSelection`. Imágenes solo PNG/JPEG/WebP embebidos, sin SVG ni URLs. Desktop 1280×800 y móvil 390×844 con layout flex/grid estructural y `@media(max-width:600px)` del artefacto. `renderPreviewHtml`/`renderEditorHtml` son deterministas y sin capacidades nativas.

## Verificación

- `artifact.test.mjs` (propiedad de T2, ejecutable con `node --experimental-strip-types --test src/preview/artifact.test.mjs`): identidad de cuatro campos, round-trip sin pérdida con `preview`, inyección de tema, recuperación de `heading` vía `previewKind`, autor por tool/edición, HTML congelado idéntico al mostrado y cuerpo/CSS conservados en el editor.
- Comprobaciones del plan (ejecuta T5): `node --experimental-strip-types --test tests/preview-state.test.ts`, `cargo test --manifest-path src-tauri/Cargo.toml preview`, `npx tsc -b --pretty false`, `npx playwright test tests/e2e/preview.spec.ts`. Las pruebas con IPC simulado no sustituyen el recorrido nativo y visual real (T6).
- Coordinación sugerida a T4/T5: plegar la aserción `previewArtifactHtml(frozen) === frozen.html` en `tests/preview-state.test.ts` (fuera de la propiedad de escritura de T2).
