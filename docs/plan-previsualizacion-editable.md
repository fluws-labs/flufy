# Previsualización editable antes de implementar

Estado: enfoque aprobado por el usuario el 2026-11-07; implementación integrada en Principal. Comprobaciones automatizadas actualizadas el 2026-11-08; cierre del recorrido nativo todavía bloqueado por acceso a la aplicación (ver `preview-verificacion.md`).

## Objetivo

Permitir que el usuario vea, ajuste y apruebe un diseño HTML dentro de Flufy antes de modificar el código de la aplicación o delegar su implementación a un equipo.

## Decisiones acordadas

Actualización solicitada por el usuario en este chat (2026-11-08): sustituir el panel lateral estrecho por un editor flotante casi a pantalla completa, con ajuste al espacio, propiedades plegables y edición por arrastre. Incluir conversación con el mismo agente dentro del editor y navegación de pantallas/capas jerárquicas. El chat del editor modifica solo el prototipo; la aprobación y la posterior implementación conservan su flujo explícito.

- Panel de previsualización integrado junto al chat.
- Pregunta inicial para tareas con cambios visuales: «¿Querés previsualizar cómo quedaría antes de implementarlo?», con crear previsualización o ir directo a implementar.
- La previsualización ocurre antes de elegir ejecución en el chat o con un equipo.
- Edición por conversación y manipulación directa tipo boxes sobre la misma versión.
- Respetar colores, tipografías, componentes y patrones del proyecto.
- Aprobar explícitamente una versión; esa versión es la fuente de verdad visual para el chat y los equipos.
- Conservar arquitectura, contratos y lógica del proyecto al implementar el diseño.
- Tareas puramente backend no requieren un HTML.

## Base técnica observada

Flufy usa React 19, TypeScript 6, Zustand y Tauri 2. El chat reside en `src/agent/`; el alojamiento del espacio de trabajo en `src/workbench/`. Ya existen un navegador integrado (`src/agent/BrowserWorkspace.tsx`), vistas de equipo (`src/team/`) y entrega/comparación de evidencias. La coordinación nativa está en `src-tauri/src/teams/`.

La política del chat normal en `src-tauri/src/agent_policy.js` no se aplica a sesiones de equipo. Por eso la referencia aprobada debe integrarse también en el contrato de delegación y en el contexto de ejecución del equipo; cambiar solo el prompt del chat no alcanza.

`docs/navegador-interno.md` describe vistas WebView2 con aislamiento por sesión. Antes de decidir el alojamiento concreto del prototipo, contrastar ese mecanismo con un iframe aislado para HTML local. Reutilizar el contenedor visual donde sirva, sin asumir que el navegador de equipos ya resuelve la edición ni el chat normal.

## Arquitectura propuesta

Un documento de diseño persistente representa la estructura editable y genera el HTML de previsualización. El editor y el agente producen cambios sobre ese documento; no mantienen versiones independientes del DOM. Cada revisión conserva HTML/CSS renderizado, recursos y decisiones necesarias para reproducirla.

Módulos propuestos: `src/preview/` para modelo, estado, panel, renderer y editor; `src-tauri/src/preview.rs` para persistencia y comandos locales. Son rutas nuevas propuestas, no componentes existentes. En la implementación se debe seguir la convención real de almacenamiento e IPC que se observe en el código cercano.

### Contrato del diseño

- Identidad: proyecto/espacio de trabajo, conversación, tarea y diseño.
- Revisión: identificador inmutable, revisión padre y fecha.
- Contenido: nodos con IDs estables, propiedades, layout, estilos, textos y recursos.
- Tema: tokens extraídos del proyecto, procedencia y excepciones solicitadas.
- Adaptación: reglas para escritorio y móvil; estados visuales acordados.
- Referencia: HTML/CSS de la revisión y capturas identificadas con esa revisión y viewport.
- Aprobación: ID de revisión aprobado y observaciones del usuario.

### Flujo de estados

`pendiente de elección → omitido | borrador → en revisión → aprobado → implementación`

La omisión permite continuar por el flujo habitual. Los cambios tras una aprobación crean un nuevo borrador y conservan la aprobación anterior como historial. Una implementación utiliza un ID aprobado explícito; cambiar de referencia durante la implementación requiere nueva aprobación y actualizar el contexto del ejecutor.

## Entregas y verificación

### 1. Flujo previo y persistencia

**Puntos de integración:** `src/agent/Composer.tsx`, `src/agent/Chat.tsx`, `src/agent/Interactions.tsx`, `src-tauri/src/agent_policy.js`, nuevos módulos de dominio/persistencia y registro IPC en `src-tauri/src/lib.rs` si corresponde.

1. Localizar el envío de mensajes, las preguntas al usuario y las herramientas de escritura/delegación para definir dónde se conserva la elección por tarea.
2. Implementar estados y comandos crear, leer, revisar y aprobar. Aprobar exige que la revisión presentada siga siendo la vigente.
3. Ofrecer la elección una vez por tarea visual antes de implementar o delegar; permitir leer el proyecto y generar artefactos del prototipo durante el borrador.
4. Conservar elección, revisiones y aprobación al reabrir el chat. No reutilizar una aprobación de otra tarea o espacio de trabajo.

**Aceptación:** se puede elegir previsualizar u omitir; reabrir conserva el estado; una revisión desactualizada no puede aprobarse por accidente. La generación del prototipo no modifica archivos de la aplicación destino.

### 2. Identidad del proyecto y generación HTML

**Puntos de integración:** nuevos módulos `src/preview/`, comandos de artefactos locales y acceso existente a archivos/contexto del agente.

1. Extraer del proyecto objetivo tokens y patrones relevantes con sus archivos de origen, incluyendo fuentes y componentes existentes.
2. Definir operaciones de creación/actualización del documento con IDs estables y reglas de layout; generar HTML/CSS desde ese modelo.
3. Resolver recursos locales dentro del proyecto autorizado y declarar como aproximaciones las fuentes o recursos que no puedan cargarse.
4. Para pantallas existentes, basar la propuesta en la estructura y estilo observados; usar datos de ejemplo identificables cuando hagan falta.

**Aceptación:** una propuesta utiliza la paleta y tipografía del proyecto objetivo, no las de Flufy; se puede renderizar de nuevo desde la revisión guardada.

### 3. Panel integrado

**Puntos de integración:** nuevos `src/preview/PreviewPanel.tsx` y renderer; `src/workbench/Workbench.tsx`, `src/agent/AgentPanel.tsx` y `src/agent/BrowserWorkspace.tsx` como puntos a evaluar para alojamiento.

1. Mantener el chat accesible junto al prototipo y permitir cambiar entre escritorio y móvil.
2. Renderizar HTML aislado sin acceso al IPC privilegiado, al DOM de Flufy ni a navegación arbitraria del host. Validar mensajes del renderer por origen/contexto y revisión.
3. Mostrar borrador, revisión visible, cambios pendientes, errores de render y acción de aprobación.

**Aceptación:** se conversa y se observa la misma revisión; cambiar de conversación muestra su diseño correspondiente; el prototipo no puede invocar comandos nativos de Flufy.

### 4. Editor tipo boxes y sincronización

**Puntos de integración:** nuevos módulos de selección, operaciones e historial en `src/preview/`; integración con solicitudes del chat.

1. Seleccionar nodos, resaltar contornos y mostrar propiedades editables.
2. Implementar reordenamiento y movimiento entre contenedores, redimensionado, separación, alineación y edición de textos.
3. Traducir movimientos a reglas de layout flex/grid según el contenedor; evitar posiciones absolutas como solución general.
4. Añadir deshacer/rehacer sobre operaciones del documento, incluidas las realizadas por el agente.
5. Exigir revisión base para aplicar cambios: una respuesta tardía del agente no puede sobrescribir movimientos manuales posteriores. Reaplicar sobre la revisión actual o informar el conflicto.

**Aceptación:** mover y redimensionar un bloque persiste al recargar; deshacer/rehacer recupera estados coherentes; el agente continúa sobre el último diseño; escritorio y móvil conservan el orden y la adaptación acordados.

### 5. Aprobación y transferencia al ejecutor

**Puntos de integración:** contrato de delegación y llamadas existentes en `src-tauri/src/teams/handoff.rs`, `conversation.rs`, `runner.rs`, `domain.rs` y tipos en `src/team/types.ts`, tras localizar sus responsabilidades concretas.

1. Congelar al aprobar el documento, HTML/CSS, recursos, observaciones y capturas de referencia con su revisión.
2. Mostrar después la elección de implementar en chat o con equipo, reutilizando el flujo existente sin duplicar preguntas.
3. Transferir referencia aprobada, restricciones del proyecto y criterios de aceptación al ejecutor; garantizar lectura desde el espacio de trabajo que realmente implemente.
4. Mantener la referencia en reanudaciones del chat/equipo. Informar si el artefacto falta o no corresponde al proyecto, en lugar de sustituirlo silenciosamente.

**Aceptación:** chat y equipo reciben el mismo ID y contenido aprobado; una revisión posterior no altera la referencia entregada; una desviación visual necesaria se plantea al usuario antes de cambiar lo acordado.

### 6. Comparación y entrega

**Puntos de integración:** `src/team/EvidenceComparison.tsx`, `DeliveryReview.tsx`, `DeliveryResults.tsx` y equivalentes de acceso desde el chat normal.

1. Presentar diseño aprobado y resultado implementado con revisión, viewport y estado visibles.
2. Comprobar distribución, dimensiones, tipografía, colores y comportamiento adaptable contra el diseño.
3. Identificar diferencias pendientes y conservar la referencia para la revisión manual del usuario.

**Aceptación:** se puede recorrer pedido → borrador → cambios manuales y por chat → aprobación → implementación → comparación, tanto con ejecución en chat como con equipo.

## Comprobaciones para la implementación

- Añadir pruebas de dominio focalizadas: transiciones, aprobación de revisión vigente, aislamiento por tarea, conflictos de revisión y deshacer/rehacer. Propuesta: `tests/preview-state.test.ts`; ejecutar `node --experimental-strip-types --test tests/preview-state.test.ts`, con cero fallos.
- Añadir prueba de persistencia y contrato de delegación en los módulos nativos que se modifiquen. Si se agrupan bajo `preview`, ejecutar `cargo test --manifest-path src-tauri/Cargo.toml preview`, comprobando que se ejecuten las pruebas nuevas y no solo un filtro vacío.
- Propuesta E2E: `tests/preview.spec.ts`; ejecutar `npx playwright test tests/preview.spec.ts` para el flujo visual, los cambios y la aprobación. Seguir la configuración real del proyecto al preparar el escenario.
- Recorrer el panel real y revisar capturas en escritorio y móvil. Una prueba DOM no acredita fidelidad visual ni alojamiento WebView2 nativo.
- Verificar tipos con `npx tsc -b --pretty false` al integrar las interfaces TypeScript; salida esperada: sin errores.

Estos comandos son pasos futuros del plan: no se han ejecutado ni acreditan una implementación existente.

## Condición de cierre

El usuario puede elegir previsualizar antes de implementar, ajustar el prototipo por chat y con boxes sin perder cambios, aprobar una revisión coherente con el proyecto y usarla como referencia verificable en una implementación de chat o equipo. La identidad visual y la referencia aprobada se conservan al reabrir o reanudar.
