# Verificación de la previsualización editable

## Mantener fijos los otros bloques al mover — 2026-11-08

- Reproducción antes del arreglo: al separar un texto, su caja reducía su altura de 142 a 90 px y sus vecinos subían 52 px al guardar; durante el arrastre permanecían fijos.
- Corrección: se reserva el espacio original del bloque separado, conservando dimensiones y layout nativo. La reserva es invisible, no interactiva y no aparece en el inspector/capas. Reagrupar la elimina.
- Regresión E2E: compara posición y tamaño de la caja, un vecino interno y otro externo antes, durante el gesto, después de persistir y después de recargar. Falló antes del cambio y pasó después.
- Verificación final: TypeScript exit 0; Node **46/46**; Playwright **32/32** con IPC simulado; Rust `preview_renderer` **2/2**, incluyendo reserva invisible en HTML nativo. No se atribuye QA manual nativo a estas pruebas.

## Separación de cajas, inspector y destinos de pantalla — 2026-11-08

- Causa comprobada: `offset` solo desplazaba visualmente al hijo; su padre estructural seguía siendo la caja. Se agregó separación real hacia la raíz de la misma pantalla, con rectángulo medido y posición absoluta. También hay una acción explícita para diseños anteriores. Reagrupar restaura la dependencia del nuevo contenedor.
- El inspector distingue elementos agrupados/libres y organiza contenido, navegación, posición, tamaños y colores. Las capas muestran estado libre y conexiones por nombre de pantalla.
- Los enlaces se guardan por ID, sobreviven a renombres y se validan tanto en dominio como en render nativo. Doble clic o «Probar enlace» cambia de pantalla sin guardar otra revisión.
- TypeScript: `tsc -b --pretty false`, exit 0.
- Node: **46/46** en interacción, estado, identidad, comparación y artefacto. Incluye separación sin mutación, persistencia nativa, reagrupar y enlaces/renombre/destinos inválidos.
- Playwright: **31/31**, cliente real con IPC simulado. Se verifica con coordenadas de DOM que sacar un texto y mover luego la caja no lo desplaza; también separación explícita de un diseño guardado y navegación por doble clic.
- Rust: `cargo test --manifest-path src-tauri/Cargo.toml --lib preview_renderer`, **2/2**. Incluye posición libre, atributo del destino y rechazo de pantalla ausente.
- Captura examinada con estilos de Flufy y prototipo ficticio: `test-results/playwright/preview-un-botón-conserva--dc6c8-la-vinculada-con-doble-clic/inspector-pantallas.png`. No representa un recorrido manual del diseño real ni sustituye QA nativo.
- Instancia dev relanzada tras Cargo; se comprobó `Running target/debug/app.exe`.

## Alcance y fuente

Escenarios derivados de `docs/plan-previsualizacion-editable.md` (enfoque aprobado el 2026-11-07). La ejecución pertenece al equipo en Principal; este documento no acredita una aprobación manual del usuario.

## Antes observado (2026-11-07)

- `src/preview/` todavía no existía al iniciar la lectura de QA. No se puede reconstruir una captura retrospectiva del panel. Motivo: `feature_not_existing` en ese momento; otros agentes trabajan en paralelo.
- `playwright.config.ts` descubre exclusivamente `tests/e2e/`, usa Edge y `http://127.0.0.1:5188`, y reutiliza un servidor existente. La propuesta original `tests/preview.spec.ts` no sería descubierta por esa configuración.
- Las pruebas actuales de interfaz, por ejemplo `tests/e2e/delegation.spec.ts`, sustituyen IPC y servicios mediante `addInitScript` y rutas Playwright. Son pruebas controladas de integración web, no evidencia de persistencia nativa o WebView2.
- No se creó ningún diseño ni se envió ningún mensaje del usuario durante esta inspección.

## Entorno y arranque normal descubiertos

Fuentes: `README.md:55-86`, `run.ps1`, `vite.config.ts`, `src-tauri/tauri.conf.json` y `src-tauri/src/lib.rs`.

1. Dependencias normales: `npm ci` cuando sea necesario; Node 22.18+ y toolchain Rust/C++ de Windows. `node_modules/@playwright/test` existe en la inspección inicial.
2. Node y npm no están en el PATH del shell del agente. `C:\Program Files\nodejs\node.exe --version` devuelve `v26.13.0`; se puede anteponer esa carpeta al PATH del proceso de terminal, sin cambiar preferencias del sistema.
3. Desarrollo web: `npm run dev` sirve el frontend en 5173; `/oc` apunta por defecto a `http://localhost:4096`. El runner E2E usa el mismo frontend en 5188 y servicios controlados conforme a las convenciones existentes.
4. Desarrollo nativo: `npx tauri dev` usa `beforeDevCommand: npm run dev` y `devUrl: http://localhost:5173`. `run.ps1` compila Rust, prepara recursos y lanza el binario, pero también detiene procesos del directorio de compilación e inicia Vite en segundo plano: no se ejecutó ese script durante QA para preservar procesos existentes y el requisito de terminal visible.
5. Instancia existente observada: `E:\Fluffy\flufy\app.exe`, PID 28044. No es el binario de desarrollo de este árbol. No se detuvo ni reemplazó.
6. La app registra `tauri_plugin_single_instance` con el mismo identificador `com.guillecode.desktop`. Abrir otro binario no acredita cargar el código nuevo: puede enfocar la instancia anterior y terminar. Hace falta coordinar una ventana de prueba autorizada para el binario compilado, sin cerrar la app que aloja al equipo.
7. La consulta inicial de listeners no devolvió puertos 5173, 5188 o 4096. Esto no acredita que falte el motor de la app instalada, que puede usar otro puerto. No se inspeccionaron credenciales ni se reutilizaron cuentas para pruebas automáticas.

Los servidores persistentes deben arrancarse en la terminal integrada, reutilizando primero servicios ya disponibles. No se arrancó una segunda instancia nativa durante esta preparación.

## Datos de ejemplo y conservación

- Suite controlada: proyecto lógico `D:/qa/preview-example`, conversación `preview-qa-chat`, tareas diferenciadas para crear/omitir/backend y textos identificables «Ejemplo QA previsualización». No usar datos personales.
- El proyecto lógico solo sirve para contratos controlados; no afirmar que sus recursos fueron extraídos de un proyecto real ni que es un entorno nativo.
- Recorrido nativo: usar un proyecto de ejemplo real autorizado, con paleta, tipografía y componentes existentes; registrar su ubicación y los diseños creados antes de escribir. Pendiente asignación de esos datos y acceso a la versión actualizada.
- Conservar diseños de prueba y aprobación hasta revisión; no borrar datos previos del usuario. Las pruebas web solo pueden limpiar el almacenamiento de su contexto Playwright propio.

## Matriz de escenarios

| ID | Precondición / entrada | Pasos y resultado observable requerido | Nivel | Estado inicial |
| --- | --- | --- | --- | --- |
| P01 | Nueva tarea visual | Ofrecer crear u omitir antes de edición/delegación; elegir crear; volver a cargar y no repetir elección | Dominio + web + nativo | Pendiente contrato |
| P02 | Otra tarea visual | Omitir; reabrir; continuar flujo normal sin volver a preguntar; no heredar elección en tercera tarea | Dominio + web | Pendiente contrato |
| P03 | Tarea backend pura | Continuar sin imponer prototipo HTML | Web + nativo | Pendiente integración |
| P04 | Borrador con revisión A | Editar a B; intentar aprobar A: rechazar sin cambiar aprobación/estado vigente | Dominio + nativo | Pendiente contrato |
| P05 | Mismos IDs en otro proyecto/conversación/tarea | Leer/actualizar/aprobar con ámbito incorrecto: no revelar ni alterar el documento original | Dominio + nativo | Pendiente contrato |
| P06 | Agente tiene base A | Usuario modifica a B; respuesta del agente basada en A: conflicto explícito; preservar B e historial | Dominio + web | Pendiente contrato |
| P07 | Contenedor con hermanos y otro contenedor | Reordenar, mover entre contenedores; rechazar ciclos/IDs inexistentes sin mutación parcial | Dominio + web | Pendiente contrato |
| P08 | Bloque seleccionado | Cambiar ancho/alto, separación, alineación y texto; renderizar escritorio/móvil sin convertir todo a posiciones absolutas | Dominio + web + nativo | Pendiente contrato |
| P09 | Ediciones manuales y del agente | Deshacer/rehacer ambos orígenes; nueva edición tras deshacer invalida redo; conservar estructura coherente | Dominio + web | Pendiente contrato |
| P10 | Revisión vigente en revisión | Aprobar; conservar ID, documento, HTML/CSS y recursos; crear otro borrador sin alterar referencia congelada | Dominio + persistencia | Pendiente contrato |
| P11 | Revisión aprobada | Ejecutar en chat y equipo; ambos reciben mismo ID/contenido; reanudar conserva esa referencia | Nativo + transferencia | Pendiente integración |
| P12 | Tema del proyecto real | Comprobar tokens/fuentes con procedencia y aproximaciones explícitas; reconstruir HTML de revisión guardada | Dominio + nativo | Pendiente contrato |
| P13 | Renderer con contenido hostil | Sin IPC ni DOM del host; rechazar mensajes de otro frame/contexto/revisión; bloquear navegación del host | Web + nativo | Pendiente renderer |
| P14 | Diseño aprobado y resultado | Comparación identifica revisión, viewport y estado; captura de escritorio y móvil con imagen examinada | Web + nativo | Pendiente integración |

## Condición para cerrar verificación

Ejecutar las pruebas de dominio contra los exports reales acordados con T1/T2; no inventar un adaptador que reproduzca la implementación. Preparar `tests/e2e/preview.spec.ts` con los selectores/IPC reales de T2/T3 y ejecutarlo mediante la configuración existente. Comprobar también persistencia y transferencia nativas, tipos y recorrido real de ambos modos.

Para cada recorrido real registrar preparación, URL, pasos, página/contexto, revisión, viewport, snapshot y screenshot de la misma página. Examinar jerarquía, legibilidad, acción principal, feedback y coherencia con el proyecto. Ninguna prueba con IPC simulado se considerará sustituto del recorrido nativo.

## Resultados actuales

Se completó inspección del plan, convenciones y entorno. Tras aparecer los exports reales de T2 en `src/preview/{types,document}.ts`, se creó `tests/preview-state.test.ts` y se ejecutó:

```powershell
& "C:\Program Files\nodejs\node.exe" --experimental-strip-types --test tests/preview-state.test.ts
```

Resultado observado: 6 pruebas, 6 aprobadas, 0 fallos, 0 omitidas. Cubren separación de claves por ámbito (no autorización de persistencia), movimiento/reordenamiento con inmutabilidad de entrada, atomicidad ante lotes inválidos, rechazo de ciclos, propiedades adaptables y conflicto entre revisión manual y respuesta tardía. No acreditan todavía aprobación, persistencia, elección por tarea o deshacer/rehacer.

La consulta inicial `node --version; npm --version; ...` falló por PATH; se identificó después el ejecutable existente de Node sin instalar ni modificar el sistema. Las pruebas E2E y capturas posteriores todavía no se ejecutaron; faltan los contratos finales de cliente, historial y panel para prepararlas sin simular una API inexistente.

### Continuación independiente solicitada por el Lead

```powershell
& "C:\Program Files\nodejs\node.exe" node_modules/typescript/bin/tsc -b --pretty false
```

Resultado observado: terminó satisfactoriamente, sin diagnósticos. Corresponde al árbol disponible en ese instante, con cinco archivos publicados en `src/preview/` y sin el panel integrado; no prueba interfaces que se agreguen después.

Se ampliaron las pruebas contra `renderer.ts` real: reconstrucción determinista tras serializar con tokens y reglas móviles, contenido hostil escapado y recursos/estilos externos descartados, y rechazo de mensajes con tarea/revisión/canal/forma inválidos. Se volvió a ejecutar el comando de `preview-state.test.ts`: **9 pruebas, 9 aprobadas, 0 fallos y 0 omitidas**. La procedencia del tema es un dato de ejemplo en esta suite; no se acreditó extracción de un proyecto real. El chequeo puro de mensajes no acredita las restricciones de origen/ventana del iframe ni el aislamiento de IPC nativo.

Pendiente de contratos: transiciones y elección persistida, aprobación vigente e inmutabilidad de referencia aprobada, historial deshacer/rehacer y E2E integrado. Se mantiene pendiente el recorrido nativo y visual real; esta ampliación no cambia esos estados.

## Continuación QA en paralelo — 2026-11-07 (T3)

Esta sección agrega observaciones de la continuación; las cifras anteriores son históricas. El árbol sigue recibiendo cambios de Frontend y Backend: estos resultados no equivalen a la validación integrada final T4 ni al recorrido T5.

### Preparación real y procesos conservados

- Se observaron Vite existentes de este proyecto en `127.0.0.1:5173` (PID 30840) y `[::1]:5173` (PID 40952). Sus líneas de comando apuntan a `D:\flufy\node_modules\vite\bin\vite.js`. Se conservaron ambos; no se iniciaron duplicados en ese puerto.
- No había listener en 5188 ni 4096 en esa consulta. `node_modules`, `dist-pwa/pwa.html` y el recurso `src-tauri/binaries/whisper/whisper-server.exe` existen. Se reutilizaron las dependencias instaladas: Vite, TypeScript, Playwright/Edge y las pruebas realmente arrancaron; no se ejecutó una instalación innecesaria.
- Se inició el servidor que exige la configuración E2E en la **terminal integrada** `agent-29720a1cf50b`, con el comando siguiente. Vite 8.3.0 informó disponibilidad en 241 ms y permanece como proceso visible; esto es preparación, no una prueba terminada con código cero.

```powershell
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; npm.cmd run dev -- --host 127.0.0.1 --port 5188 --strictPort
```

- URL preparada: `http://127.0.0.1:5188/`. El harness de cada prueba es `http://127.0.0.1:5188/preview-harness`: se monta mediante la ruta controlada de Playwright, no es una página permanente de producto ni una app nativa.
- No se arrancó un motor de chat adicional ni se usaron cuentas reales. El harness solo prueba el panel, hook, adaptador e iframe reales con respuestas IPC guionadas; no requiere el motor del chat.
- Se observó además `D:\flufy\src-tauri\target\verification\debug\app.exe`, PID 39428, con listener propio `127.0.0.1:50178`. Esta sesión no lo inició ni lo detuvo; su existencia no acredita revisión, identificador embebido, persistencia ni panel actualizado. No se reutilizó su interfaz sin confirmar procedencia y propietario.
- Continúa la instancia instalada `E:\Fluffy\flufy\app.exe`, PID 28044, que aloja el trabajo. No se cerró ni sustituyó. La configuración fuente conserva `com.guillecode.desktop` y el registro incondicional de `tauri_plugin_single_instance`. No hay en ese punto de entrada un modo de segunda instancia de prueba: `--build-info` solo imprime metadatos y termina; no abre la UI.
- **Disponibilidad nativa: pendiente de coordinación.** No se identificó una vía autorizada y verificada para abrir el binario actualizado simultáneamente manteniendo identificador, controles y la instancia anfitriona. No se ejecutó `run.ps1` por sus cierres de procesos y arranque oculto. No se cambió identificador, perfil ni controles. El Lead debe confirmar procedencia/acceso del proceso de verificación existente o un mecanismo nativo admitido antes de T5. Leer el cache de Cargo fuera del proyecto fue denegado; no se eludió ese permiso.

### Pruebas ejecutadas y límites

| Comprobación | Resultado realmente observado | Alcance / límite |
| --- | --- | --- |
| Dominio `tests/preview-state.test.ts` | **passed: 15/15**, 0 omitidas | Operaciones, conflictos, renderer, selectores, snapshots y gate. Los fixtures de revisiones no acreditan transiciones SQLite ni historial del panel. Se corrigieron títulos/comentarios para explicitarlo. |
| Tipos `tsc -b` | **passed**, salida sin diagnósticos | Árbol disponible al inicio de T3; repetir en T4 tras terminar cambios concurrentes. No es una prueba de interacción. |
| Política `tests/agent-policy.test.ts` | **passed: 4/4** | Política de chat/equipo y flujo local existente; no acredita transferencia visual por UI. |
| Rust `--lib preview`, primer intento | **failed**, código 101, seis E0425 | El test nuevo invocaba `selected_reference` antes de que el cambio concurrente publicara esa función. No se modificaron archivos del Backend desde QA. |
| Rust `--lib preview`, tras aparecer la función real | **passed: 12/12**, 227 filtradas, 0 omitidas | Incluye 10 pruebas de `preview::tests`, una de herramientas desktop y una preexistente de features; filtro no vacío. SQLite real en datos temporales, aislamiento, artefacto congelado, referencia explícita y serialización de origen. No acredita WebView2, IPC desde la ventana autorizada ni reanudación de una ejecución completa. |
| E2E inicial conservado | **passed: 7/7** | Suite previa con IPC controlado, antes de ampliar cobertura. No constituye aprobación de la suite actual. |
| E2E ampliado | **failed: 13 passed / 1 failed** | El caso de HTML congelado muestra el texto y CSS correctos, pero un clic real sobre el bloque no actualiza la selección del editor. |
| Reproducción focalizada del clic | **failed: 0 passed / 1 failed** | Segundo fallo igual: `Bloque seleccionado` permanece vacío en lugar de `title`; no se hicieron reintentos ciegos posteriores. |
| Recorrido nativo y revisión visual escritorio/móvil | **not_run / pendiente acceso verificado** | No se capturaron ni examinaron imágenes de resultado en esta continuación. No se declara fidelidad visual ni aislamiento nativo aprobado. |

Comandos exactos usados (PowerShell; la terminal integrada agrega internamente su ubicación al reutilizar una pestaña):

```powershell
& "C:\Program Files\nodejs\node.exe" --experimental-strip-types --test tests/preview-state.test.ts
$env:PATH = 'C:\Program Files\nodejs;C:\Users\franc\.cargo\bin;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/typescript/bin/tsc -b --pretty false
& "C:\Program Files\nodejs\node.exe" --experimental-strip-types --test tests/agent-policy.test.ts
$env:PATH = 'C:\Program Files\nodejs;C:\Users\franc\.cargo\bin;C:\Program Files\Git\cmd;' + $env:PATH; & 'C:\Users\franc\.cargo\bin\cargo.exe' test --manifest-path src-tauri/Cargo.toml --lib preview
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --workers=1 --output=test-results/preview/playwright
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --workers=1 --output=test-results/preview/playwright-expanded
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --grep 'HTML congelado recibido' --workers=1 --output=test-results/preview/bridge-diagnostic
```

Los outputs E2E se ubicaron dentro de `test-results/preview/` conforme a la propiedad de escritura de T3. No se usó la carpeta general que Playwright limpiaría por defecto ni se reemplazaron evidencias de otras tareas.

### Cobertura actual y defecto reproducible

La suite ampliada continúa las pruebas previas y agrega: omitir/reabrir el panel; bloqueo de aprobación con texto local sin guardar; aprobación con la revisión visible; conflicto IPC con feedback explícito y documento intacto; rechazo local de cambio tardío del agente sin enviar `preview_apply`; deshacer una revisión del agente y anular rehacer con una edición posterior; uso del HTML/CSS congelado frente a un modelo deliberadamente diferente; selección mediante clic del iframe; rechazo de imágenes de otra revisión/viewport o URL externa. Las respuestas de escritura son snapshots preparados, no un servidor alternativo que implemente las transiciones.

**Defecto para T1 (selección directa, prioridad alta):**

1. Ejecutar el comando focalizado anterior sobre el servidor preparado.
2. El fixture aprobado `r1` presenta `<p data-preview-id="title">Artefacto nativo congelado QA</p>` dentro del iframe real del editor. El modelo contiene el nodo `title`.
3. Se comprueba texto visible, CSS recibido, referencia estática sin scripts y conservación del HTML recibido. Esas aserciones pasan.
4. Un clic Playwright real en ese texto no cambia `Bloque seleccionado`: esperado `title`, actual cadena vacía, timeout 5 s. El test no sustituye el clic por una selección programática ni se omite para lograr verde.
5. Evidencia existente: `test-results/preview/playwright-expanded/preview-P10-P14-editor-y-c-f174d--no-lo-regeneran-del-modelo/error-context.md` y el equivalente bajo `test-results/preview/bridge-diagnostic/`. El test añade observaciones de errores/mensajes del bridge como adjunto del runner para el próximo diagnóstico.

### Pendientes para integrar y cerrar

- **T1:** corregir/explicar el fallo de selección conservando la frontera de seguridad y completar identidad estable de tarea. Al inspeccionar `preview-identity.ts` todavía se elegía el último mensaje humano; el harness del panel no acredita continuidad de las correcciones del chat. Preparar regresión usando el contrato final que publique T1.
- **T1/T2:** completar y acordar atribución verificable de capturas al diseño/revisión/viewport; las pruebas actuales de comparación solo validan rechazo de capturas incompatibles y ausencia explícita.
- **T4:** ejecutar nuevamente tipos, dominio, política, Rust y E2E sobre el árbol integrado después de esos cambios. La compilación Rust fallida inicial queda como historial y su repetición satisfactoria como estado posterior; el fallo E2E sigue abierto.
- **T5:** confirmar acceso al binario actualizado y datos de proyecto autorizados, recorrer pedido → elección → edición manual/agente → aprobación → ejecución/reanudación chat/equipo → comparación. Registrar snapshot y screenshot examinada de la misma página y cada viewport; ninguna imagen de fixture sirve como resultado de implementación.

No se declara completada la verificación ni se delegan estas comprobaciones técnicas al usuario.

## Continuación T4 — regresiones preparadas sobre el árbol existente (2026-11-08)

Las secciones anteriores se conservan como historia de sus ejecuciones. Esta sección registra únicamente lo observado por QA en esta continuación; no convierte resultados antiguos en verificaciones del árbol actual. No se crearon equipos, perfiles aislados, servidores alternativos ni diseños sobre datos del usuario.

### Estado inicial observado antes de editar

- La suite ya contiene **14 casos web**, incluyendo el clic real en `Artefacto nativo congelado QA`. La primera ejecución de esta continuación terminó **14/14 passed**. Por tanto el clic antes fallido **sí pasa en este árbol**, sin reemplazarlo por `selectOption`, omitirlo ni cambiar su aserción. QA no atribuye la corrección a una edición propia ni inventa una fase roja nueva del clic.
- Dominio/adaptador existentes: **21/21 passed** antes de ampliar pruebas (15 de estado y 6 de artefacto). Sigue habiendo cobertura de aprobación visible, conflictos, historial manual/agente, aislamiento y HTML/CSS congelado.
- `src/agent/preview-identity.ts` aún recorre mensajes desde el último usuario en la primera lectura. `src/preview/task-identity.ts` no existía al inspeccionar; T1 lo publicó después y la regresión final ya se ejecutó contra ese contrato real.
- `comparison.ts` no existía en la primera lectura y apareció durante el trabajo paralelo de T3. Las pruebas nuevas lo importan desde producción, no copian sus validaciones ni implementan otro servidor.
- No se encontró `AGENTS.md` mediante búsqueda en el proyecto. Se conservaron las decisiones del plan y de `src/preview/CONTRACT.md`: autoridad nativa, adaptador único, previsualización antes de elegir ejecutor, referencia aprobada y continuidad del árbol existente.

### Entorno reutilizado y preparación exacta

Se consultaron listeners/procesos y requisitos documentados antes de arrancar procesos:

- Se observaron Vite ya existentes: `127.0.0.1:5173` PID 30840, `[::1]:5173` PID 40952 y `127.0.0.1:5188` PID 43928. Las tres líneas de comando apuntan al Vite de `D:\flufy`; el de 5188 incluye `--strictPort`. **Se reutilizó 5188** con `reuseExistingServer`, sin duplicar servidores ni detenerlos. Las pruebas se ejecutaron en terminales integradas visibles.
- `node_modules/@playwright/test`, `dist-pwa/pwa.html` y `src-tauri/binaries/whisper/whisper-server.exe` existen. Node, Edge/Playwright, TypeScript y Cargo ejecutaron las comprobaciones indicadas abajo; no hizo falta reinstalar dependencias.
- Las instancias observadas siguen siendo `E:\Fluffy\flufy\app.exe` PID 28044, listener 59081, y `D:\flufy\src-tauri\target\verification\debug\app.exe` PID 39428, listener 50178. QA no abrió, cerró, reconfiguró ni actualizó esas instancias. Estos listeners **no prueban** que el binario de verificación contenga los cambios concurrentes actuales.
- El arranque normal documentado continúa siendo `npm ci` si faltan dependencias y `npm run dev`; Tauri usa ese Vite mediante `beforeDevCommand`. `run.ps1` no se ejecutó por su cierre de procesos y lanzamiento oculto, ya documentados. Se necesita coordinación del Lead sobre acceso autorizado al binario actualizado para el recorrido nativo T5, conservando la instancia anfitriona.
- Git no está en PATH: la consulta inicial combinada informó ese error; `& 'C:\Program Files\Git\cmd\git.exe' status --short` funcionó después. Se observaron los cambios previos y no se tocaron archivos de otros responsables.

Los datos nuevos son exclusivamente fixtures identificables `qa-task-chat`, `qa-task-start`, `qa-task-correction` y las identidades QA ya existentes. El PNG embebido de rechazo es **un fixture de contrato**, nunca una captura de resultado real. No se prepararon escrituras nativas sobre un proyecto ajeno ni hay datos reales que limpiar. Los contextos Playwright propios se cierran al terminar; el servidor existente queda disponible. El harness `/preview-harness` solo existe durante la ruta interceptada de Playwright: no prometer que se pueda abrir como página persistente.

### Regresiones y ejecuciones observadas

| Escenario / comprobación | Resultado | Evidencia / límite |
| --- | --- | --- |
| Suite previa intacta, incluido clic real en HTML congelado | **passed 14/14** | Ejecución `t4-inicial`; no sustituye el recorrido nativo |
| Primer intento ampliado | **failed: 13 passed / 3 failed** | `t4-regresiones`: interop CJS de `createRoot` en la sonda nueva y dos selectores ambiguos de `status` al aparecer mensajes de rechazo de T3. Son fallos del harness, no tres defectos de producto. Se corrigieron usando el mismo fallback React existente y seleccionando el feedback específico, sin relajar el clic ni la atribución |
| Corrección humana sobre tarea activa, **antes** del contrato de T1 | **failed reproducible (histórico)** | `t4-contratos`: esperado `qa-task-start`, actual `qa-task-correction`. Se conserva como evidencia previa; no se reescribe ni se adjudica al árbol actual |
| Corrección humana sobre tarea activa, **contrato final de T1** | **passed** | `t4-identidad-final`: ancla `qa-task-start`; una corrección posterior lo conserva; `startPreviewTask` abre otra tarea y la persiste en `previewTasks`. La sonda importa el store desde la MISMA URL transformada que consume el hook, porque Vite dev sirve `state/agent.ts?t=...` y dos URLs distintas creaban dos stores (hallazgo del harness, no del producto) |
| Suite web ampliada final | **passed 17/17** | `t4-identidad-final`: incluye HTML congelado con clic real, elección/recarga, aprobación vigente, conflictos, historial, aislamiento, identidad estable por tarea, capturas sin procedencia rechazadas y referencia transferida priorizada sobre una aprobación mutable distinta |
| Identidad pura sobre `src/preview/task-identity.ts` | **passed 6/6** | Anclaje legado al primer turno humano, correcciones que no abren tarea, historial paginado que no infiere, marcador sintético, elección persistida, marcadores ajenos/malformados, normalización de ruta y contexto de identidad. Fixtures en memoria, no reanudación nativa |
| Dominio + adaptador + identidad + comparación | **passed 32/32**, sin omitidas | 16 estado + 6 artefacto + 6 identidad + 4 comparación. Validación de proyecto/conversación/tarea/diseño, revisión, viewport, dimensiones, URLs e inmutabilidad del artefacto. Snapshots en memoria, no persistencia |
| Tipos | **passed** | Sin diagnósticos en el árbol disponible en esa ejecución. `tsconfig.app.json` solo incluye `src`: no comprueba los archivos de `tests/` |
| Política | **passed 4/4** | No prueba por sí sola el flujo de aprobación/transferencia visible |
| Rust `--lib preview` | **passed 15/15**, 227 filtradas, 0 ignoradas | Incluye 13 de `preview::tests`, una desktop y una de features. SQLite real, transferencia persistente e idempotente tras reaprobación, conflictos e identidad; permanecen 13 warnings de compilación. No prueba IPC/WebView2 ni un run de chat/equipo real |
| Captura resultado real / recorrido nativo / revisión visual desktop y mobile | **not_run** en T4 | Pendiente integración y acceso verificado T5. No se examinaron screenshots de UI ni se declara fidelidad visual |

Comandos exactos de las ejecuciones satisfactorias (sin añadir el prefijo de ubicación que muestra internamente la terminal al reutilizarla):

```powershell
& "C:\Program Files\nodejs\node.exe" --experimental-strip-types --test tests/preview-state.test.ts src/preview/artifact.test.mjs
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --workers=1 --output=test-results/preview/t4-inicial
& "C:\Program Files\nodejs\node.exe" --experimental-strip-types --test tests/preview-state.test.ts tests/preview-comparison.test.ts src/preview/artifact.test.mjs
& "C:\Program Files\nodejs\node.exe" --experimental-strip-types --test tests/preview-identity.test.ts tests/preview-comparison.test.ts tests/preview-state.test.ts src/preview/artifact.test.mjs
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --workers=1 --output=test-results/preview/t4-identidad-final
& "C:\Program Files\nodejs\node.exe" node_modules/typescript/bin/tsc -b --pretty false
& "C:\Program Files\nodejs\node.exe" --experimental-strip-types --test tests/agent-policy.test.ts
$env:PATH = 'C:\Program Files\nodejs;C:\Users\franc\.cargo\bin;C:\Program Files\Git\cmd;' + $env:PATH; & 'C:\Users\franc\.cargo\bin\cargo.exe' test --manifest-path src-tauri/Cargo.toml --lib preview
```

Comandos fallidos conservados como diagnóstico, **no aprobados**:

```powershell
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --workers=1 --output=test-results/preview/t4-regresiones
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --workers=1 --output=test-results/preview/t4-contratos
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --workers=1 --output=test-results/preview/t4-identidad
```

La evidencia del defecto de identidad se comprobó leyendo `test-results/preview/t4-contratos/preview-P01-P05-una-correc-ac967-dentidad-de-la-tarea-activa/error-context.md`. Los directorios de salida de esta continuación son distintos de los históricos para conservar sus fallos y adjuntos. No se sobrescribió la evidencia del clic anterior.

### Coordinación necesaria para T5

1. **T1:** el contrato `src/preview/task-identity.ts` ya está publicado y su regresión pasa (17/17 web, 6/6 identidad). Resta que T5 repita sobre la integración final; no quedan pedidos de contrato abiertos para QA.
2. **T2/T3:** confirmar comandos/forma definitivos de listado de capturas y referencia transferida del chat y equipo. Ya se prueba el contrato puro de comparación y su preferencia por la referencia explícita. La prueba Rust de transferencia es persistencia real, no acredita generación/consumo real de screenshots por el navegador.
3. **Lead:** confirmar procedencia/acceso del binario nativo actualizado y proyecto/datos de prueba autorizados. No usar el proceso existente como prueba de código reciente ni cambiar identificador/perfil como sustituto del flujo normal.
4. **T5:** repetir tipos, dominio, política, Rust y la suite web completa sobre el árbol integrado; recorrer ambos modos con snapshot y screenshot examinadas de la misma página/viewport. La entrega sigue pendiente, no aprobada ni trasladada al usuario.

## Continuación en chat — 2026-11-08

El usuario pidió terminar el trabajo en este chat, sin modo equipo. Se continuó sobre los cambios existentes en `D:\flufy` (Principal), sin iniciar agentes ni otro equipo.

### Corrección integrada

Se encontró un corte real entre persistencia y UI: `PreviewPane` solo cargaba imágenes de observaciones de equipos. Aunque el backend ya ofrecía `preview_capture_list`/`preview_capture_image`, ninguna UI los consumía; un resultado registrado de una implementación en chat quedaba ausente en el comparador.

- `previewImplementations` en el adaptador consulta el registro nativo, conserva la identidad/revisión/viewport de cada captura y pide su imagen verificada por hash al backend. Una revisión o ámbito incompatible no se usa para solicitar imágenes. Los errores se muestran como tales.
- El pane combina esas capturas con las de equipos y refresca el registro mientras está abierta la comparación. Cancela actualizaciones tardías al cambiar de referencia o cerrar la vista.
- Se quitaron las guardas `requested` de efectos de carga de imágenes del chat/equipo: el cleanup podía cancelar una respuesta y la segunda ejecución del efecto omitir su carga, especialmente con StrictMode. Se conserva el descarte por cleanup.
- La nueva regresión monta `PreviewPane` real con StrictMode y sin chats de equipo, referencia transferida r4 y borrador posterior r5. Comprueba imágenes desktop/mobile desde los comandos nativos guionados. La imagen PNG es un fixture de contrato, **no una captura de implementación real**.

### Comprobaciones observadas en esta continuación

| Comprobación | Resultado actual | Alcance |
| --- | --- | --- |
| Suite web previa al cambio | **17/17 passed** | Panel/adaptador/iframe con IPC controlado |
| Nueva regresión antes de corregir | **failed**, imagen ausente | `test-results/preview/chat-registry-red/` |
| Diagnóstico del harness | **failed** | Al añadir el segundo pane sin altura definida, el panel previo alteraba el layout durante el clic. Se ocultó la raíz anterior y se dio al pane una altura definida como su alojamiento real. El test final conserva clic real; no lo sustituye por selección DOM |
| Suite web integrada final | **18/18 passed** | `test-results/preview/chat-integrated-final/`, incluye el registro nativo consumido sin equipo y el clic real en el artefacto congelado |
| Dominio/adaptador/identidad/comparación + política | **36/36 passed**, 0 omitidas | 32 de previsualización + 4 de política |
| TypeScript | **passed**, sin diagnósticos | Ejecutado tras integrar el consumidor del registro |
| Rust `--lib preview` | **17/17 passed**, 228 filtradas, 0 ignoradas | Incluye persistencia SQLite, transferencia y registro de capturas; 13 warnings preexistentes. No se modificó Rust en esta continuación |
| `git diff --check` | **passed** | Sin errores de whitespace; avisos de normalización LF/CRLF |
| Recorrido nativo y fidelidad visual sobre implementación real | **blocked / not_run** | No sustituido por los fixtures anteriores |

Comandos satisfactorios (PowerShell, desde `D:\flufy`):

```powershell
$env:PATH = 'C:\Program Files\nodejs;C:\Users\franc\.cargo\bin;C:\Program Files\Git\cmd;' + $env:PATH; cargo test --manifest-path src-tauri/Cargo.toml --lib preview
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --workers=1 --output=test-results/preview/chat-integrated-final; if ($?) { & 'C:\Program Files\nodejs\node.exe' --experimental-strip-types --test tests/preview-identity.test.ts tests/preview-comparison.test.ts tests/preview-state.test.ts src/preview/artifact.test.mjs tests/agent-policy.test.ts }
& 'C:\Program Files\nodejs\node.exe' node_modules/typescript/bin/tsc -b --pretty false
git diff --check
```

### Bloqueo nativo comprobado

`desktop_status` informó control general activado y sesión desbloqueada, pero la ventana **«flufy — Flufy» está bloqueada para el agente**; `desktop_windows` confirmó ese estado. El proceso observado es `E:\Fluffy\flufy\app.exe` (PID 19172); no apareció otro proceso `app.exe` compilado desde este árbol. No se acredita su versión/contenido como el de los cambios actuales.

No se intentó eludir el bloqueo ni cerrar/reemplazar la instancia que aloja la conversación. El binario normal comparte identificador y single-instance, de modo que lanzarlo junto al instalado no valida el código nuevo. Para cerrar T5 hace falta habilitar el acceso a la ventana y coordinar la activación del binario actualizado. No se declara terminado el recorrido pedido → edición → aprobación → implementación/reanudación → comparación nativa en chat/equipo.

El servidor Vite de esta continuación se inició en terminal integrada, puerto 5188; se detiene al terminar las comprobaciones. El harness sigue siendo una ruta de pruebas Playwright y no una página permanente del producto.

## Compilación y arranque dev solicitados — 2026-11-08

El usuario pidió compilar una versión nueva y ejecutarla en desarrollo. Se arrancó el flujo real `tauri dev` en la terminal integrada **Flufy dev** (`agent-d27dcea0c559`), con Vite y Cargo, sin cerrar la app instalada.

Se usó el override temporal `C:\Users\franc\AppData\Local\Temp\opencode\flufy-preview-dev.json`: identificador `com.guillecode.flufy.devcheck` para coexistir con la instancia anfitriona, y marcador de compilación `preview-chat-dev-2026-11-08`. No se cambió el identificador de distribución del repositorio ni el bloqueo de control de ventanas.

El primer arranque falló con **EBUSY**: Vite intentaba observar `src-tauri/target/debug/deps/app_lib.dll` durante el enlazado nativo. Se añadió `server.watch.ignored: ['**/src-tauri/**']` en `vite.config.ts`; Tauri mantiene su propio watcher de Rust. Al repetir el mismo arranque, Cargo terminó satisfactoriamente y ejecutó `target/debug/app.exe`; Vite permaneció disponible.

```powershell
$env:PATH = 'C:\Program Files\nodejs;C:\Users\franc\.cargo\bin;C:\Program Files\Git\cmd;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@tauri-apps/cli/tauri.js dev --config 'C:\Users\franc\AppData\Local\Temp\opencode\flufy-preview-dev.json'
```

Comprobaciones de arranque observadas:

- `app.exe --build-info` devolvió `{"identifier":"com.guillecode.flufy.devcheck","localBuild":"preview-chat-dev-2026-11-08","version":"0.18.0"}`.
- Proceso nuevo **PID 2832**, ejecutable `D:\flufy\src-tauri\target\debug\app.exe`, ventana `flufy — Flufy`, `Responding: True`. La instalada (PID 19172) sigue abierta.
- Vite en `http://localhost:5173/` respondió **HTTP 200**.
- La app nueva abrió su listener en 51387 y registró el arranque de OpenCode en `http://127.0.0.1:51388`. Una consulta sin credenciales a `/global/health` recibió **401**, no una salud autenticada aprobada; no se eludió la autenticación.
- La ventana nueva es la de primer plano (`w3016234`), pero continúa **bloqueada para el agente**, como exige `desktop::blocked_reason`. Por tanto queda comprobada compilación y arranque nativo, **no** la interacción completa del editor/aprobación/comparación.

La terminal y la app de desarrollo se dejan corriendo para el usuario. Este resultado resuelve la falta de procedencia del binario de prueba; no acredita el recorrido visual nativo pendiente.

## Editor flotante, arrastre, chat y pantallas/capas — continuación 2026-11-08

### Acceso a diseños guardados añadido posteriormente

- Se agregó el botón **Diseños** en la cabecera del panel del agente (disponible con proyecto abierto aunque no haya conversación activa) y en el editor flotante. Abre una galería con búsqueda, filtro borrador/aprobado, cantidad de pantallas/revisiones y fecha. Cada tarjeta vuelve al editor y a su conversación/tarea originales; un editor minimizado se restaura conservando su selección.
- Nuevo IPC `preview_list` autorizado contra el proyecto de la ventana. Consulta SQLite por proyecto y el diseño de aplicación de cada tarea (`design`), devuelve solo metadatos y contabiliza filas incompatibles sin cambiarlas. El contenido del diseño sigue abriéndose mediante la autorización habitual de `preview_get`.
- **TypeScript passed; 3/3 pruebas web de biblioteca passed** en `test-results/preview/library-final/`: búsqueda/filtros/identidad, vacío vs error/recarga y botón real de AgentPanel → conversación/tarea → editor → minimizar/reabrir conservando selección. Captura `preview-la-galería-muestra-844e0-erder-la-identidad-al-abrir/disenos-guardados.png` examinada (fixture de IPC, no captura nativa).
- **1/1 prueba Rust de biblioteca passed** (`cargo test --manifest-path src-tauri/Cargo.toml --lib preview_library`): varias conversaciones/tareas, aprobación, exclusión de otro proyecto, biblioteca vacía y conservación de una fila ilegible. La primera ejecución falló porque la función aún no existía; una posterior chocó con el sidecar OpenCode bloqueado al cambiar de configuración entre dev y tests. Se detuvo solo la terminal dev propia, se comprobó la prueba con código 0 y se recompiló/arrancó nuevamente `tauri dev` con el override de desarrollo.
- La instancia actualizada quedó corriendo (`D:\flufy\src-tauri\target\debug\app.exe`, PID 28952 al comprobar, ventana `Nuestro-Bolsillo — Flufy`, `Responding: True`). La instancia instalada que aloja este chat permaneció abierta. `git diff --check` pasó; no se sustituyen los fixtures web por una afirmación de recorrido nativo automatizado.

Comando web focalizado satisfactorio:

```powershell
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --grep 'galería|botón Diseños' --workers=1 --output=test-results/preview/library-final
```

Solicitado e implementado en este chat sobre Principal, sin equipo:

- Editor modal amplio, pantalla completa opcional y minimización/restauración sin desmontar el diseño. Zoom ajustado al espacio, propiedades plegables y navegación por teclado del diálogo nativo.
- Arrastre visual para reordenar/anidar bloques y tirador de tamaño por viewport. El historial sigue pasando por revisiones persistidas; se verificó deshacer el arrastre. Se utiliza Pointer Events dentro del sandbox: el drag HTML nativo dejaba de enrutar eventos en el iframe opaco. El host resuelve la finalización del resize cuando el puntero sale del lienzo.
- Chat del diseño dentro del editor con el agente y la conversación actuales, modelo de la sesión, historial, preguntas y permisos. El pedido incluye contexto sintético de tarea/revisión/pantalla/capa y la indicación de reconciliar sobre el estado actual, sin implementar ni aprobar. Se conserva el texto ante un fallo de envío.
- Pantallas nombradas y capas jerárquicas plegables, selección sincronizada con el lienzo, arrastre de capas, creación y renombrado de pantallas. Los diseños anteriores se muestran como una pantalla sin migración; agregar otra conserva el árbol previo. Metadatos `screens` persistidos en documento nativo/editable y validados por el backend.

### Verificación actual

- **TypeScript passed**, sin diagnósticos.
- **43/43 pruebas Node passed**: dominio/adaptador/identidad/comparación/artefacto/gestos/pantallas/contexto del editor y política.
- **23/23 pruebas Playwright passed** en `test-results/preview/visual-editor-final/`: incluyen punteros reales en lienzo escalado, arrastre y undo, resize saliendo del iframe, tamaño del modal, minimizar/restaurar, crear/renombrar/cambiar pantallas, arrastrar capas, reabrir metadatos y envío del chat al endpoint de la misma sesión con la revisión/capa/pantalla correctas.
- El chat E2E intercepta HTTP con un fixture; **no** ejecuta un modelo de IA real ni se atribuye una respuesta del modelo a esa prueba. El resto de la suite web usa IPC controlado, como antes.
- Capturas desktop y móvil **examinadas**, en `test-results/preview/visual-editor-final/preview-el-editor-flotante-b1dea-a-la-selección-al-minimizar/editor-flotante-{desktop,mobile}.png`. Muestran el UI React real con un prototipo de fixture y tema de Flufy, **no** una implementación de proyecto real ni una captura nativa de WebView2. Al examinarlas se corrigió el zoom reducido a 10 % durante la minimización: un contenedor oculto ya no recalcula la escala a partir de dimensiones cero.
- **Rust `--lib preview`: 18/18 passed**, 228 filtradas y 0 ignoradas. Incluye persistencia de varias pantallas y rechazo transaccional de metadatos inválidos sin cambiar la aprobación. Resultado de la última ejecución en la terminal integrada `Pantallas native checks`, código 0.
- La instancia `Flufy dev` recompila Rust mediante Tauri y aplica HMR del frontend. Los logs registran `Finished dev profile` y `Running target/debug/app.exe` tras los cambios. Se conserva el bloqueo de control sobre la propia ventana; no se declara un recorrido nativo interactivo automatizado ni aprobación manual del usuario.

Comando web/tipos/dominio final (desde `D:\flufy`):

```powershell
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH; & 'C:\Program Files\nodejs\node.exe' node_modules/typescript/bin/tsc -b --pretty false; if ($?) { & 'C:\Program Files\nodejs\node.exe' --experimental-strip-types --test tests/preview-interaction.test.ts tests/preview-state.test.ts tests/preview-identity.test.ts tests/preview-comparison.test.ts src/preview/artifact.test.mjs tests/agent-policy.test.ts }; if ($?) { & 'C:\Program Files\nodejs\node.exe' node_modules/@playwright/test/cli.js test tests/e2e/preview.spec.ts --workers=1 --output=test-results/preview/visual-editor-final }
```

### Corrección: conservar la apariencia original al editar — 2026-11-08

Síntoma reportado con capturas: al diseñar, el diseño perdía su aspecto normal (quedaba sin layout, tipografía ni tarjetas). El historial real de `previews.db` mostró la causa: el borrador del agente guardaba todo el CSS en el mapa nativo `styles` (`display`, `flexDirection`, `gap`, `padding`, `fontFamily`, `lineHeight`, sombras, etc.). `fromNativeDocument` solo representa en `PreviewNode` un subconjunto (color, fondo, borde, radio, tamaño/peso de fuente) y `change` reconstruía el documento nativo desde ese modelo, por lo que **cada edición de la UI descartaba las propiedades no modeladas**. La primera revisión (creada por el agente) se veía bien; la primera edición (reordenar, redimensionar o añadir pantalla) rompía la apariencia.

Corrección en `src/preview/client.ts` (`mergeNativeDocument`): una edición parte del documento nativo persistido, conserva cada nodo por id y aplica únicamente los campos que la operación modificó. Un ajuste de layout elimina de `styles` solo la propiedad duplicada para que el valor nuevo no quede tapado. El campo `preview` se actualiza para el modelo editable y el artefacto congelado del backend mantiene la apariencia.

Comprobación proporcional ejecutada:

- `tsc -b` **passed**, sin diagnósticos.
- `tests/preview-interaction.test.ts` **9/9 passed**, con dos regresiones nuevas: mover un bloque conserva todos los `styles` nativos (incluido `borderRadius: 50%` y `clamp(...)`), y un ajuste de `gap` reemplaza solo esa propiedad sin borrar `display`/`padding`/`fontFamily`.
- Suite Node completa **165/165 passed**.
- Reproducción sobre el diseño real de `previews.db` (`107faa19…`, "Nuestro-Bolsillo"): reordenar conserva `root.styles` y los estilos de los hijos, y añadir pantalla conserva el árbol original; `hero-title.mobileStyles` también se mantiene.
- **No se modificó el historial persistido.** La revisión que ya estaba rota sigue congelada; para recuperar la apariencia hay que **Deshacer** una vez hasta la última revisión fiel y, desde ahí, las ediciones nuevas conservan el diseño. Rehacer una revisión vieja vuelve a mostrar su artefacto original roto.


### Arrastre libre y tema de conversación en la galería — 2026-11-08

El arrastre del lienzo ya no elige un contenedor ni reordena el bloque: aplica un desplazamiento libre (`PreviewNode.offset`/`mobileOffset`) que viaja al artefacto como `styles.transform: translate(x, y)` y mantiene el flujo original. El orden y la anidación siguen disponibles arrastrando en **Pantallas y capas** (`preview-move`). El backend admite `transform` en `properties()`; el host completa el gesto si el puntero sale del iframe y Escape o `pointercancel` restauran la posición anterior. La galería muestra el tema de la conversación resuelto desde las sesiones cargadas (`allSessions`), conserva la identidad guardada en el `title` del texto y sigue abriendo por identidad completa.

Regresión encontrada y corregida durante la verificación: el parseo de `getComputedStyle(...).transform` dentro del puente del iframe iba en un template literal, así que `matrix\(` llegaba al navegador como `matrix(` y el segundo arrastre de un bloque ya desplazado reiniciaba su base a cero (el bloque saltaba). Se duplicó el escape (`matrix\\(`) y se amplió la prueba E2E para arrastrar dos veces y comprobar que el desplazamiento se acumula. El script generado ahora contiene `/^matrix\(([^)]+)\)$/`.

Comprobación ejecutada:

- `tsc -b` **passed**, sin diagnósticos, y `oxlint` sobre `interaction.ts` sin avisos nuevos.
- Grupo Node de previsualización **47/47 passed** (`preview-interaction` 11/11, `preview-state` 16/16, identidad, comparación, artefacto y política de agente). Las pruebas nuevas cubren el desplazamiento acotado, el rechazo de raíz/nodos ajenos y la conservación de `styles` nativos al mover.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib preview_renderer_rejects_duplicate_nodes` **1/1 passed**; incluye que `transform` sea una propiedad CSS admitida.
- Playwright `tests/e2e/preview.spec.ts` **26/26 passed** (workers=1). El caso del lienzo arrastra dos veces, verifica acumulación y deshace dos veces hasta el documento original; la galería comprueba el título de conversación. Con IPC/HTTP de fixture.
- La instancia `Flufy dev` se detuvo para liberar el build de Rust y se relanzó; los logs muestran la compilación y `Running target\debug\app.exe`. Sigue sin acreditarse un recorrido nativo interactivo automatizado de la propia ventana.

### Arrastre fluido y paleta de colores — 2026-11-08

Síntoma reportado: los movimientos «demoran» y se sienten toscos. Causa principal: `selectedId` y `readOnly` estaban incrustados en `srcDoc`, así que **seleccionar** un bloque y **cada guardado** (`busy`) regeneraban el artefacto y recargaban el iframe; al soltar un bloque, la recarga intermedia borraba el `transform` en vivo y el bloque volvía a su posición anterior antes de reaparecer en la nueva. Además el `pointermove` escribía `style.transform` en cada evento, sin agrupar.

Cambios:
- `src/preview/interaction.ts`: `pointermove` agrupa las escrituras en un `requestAnimationFrame` (`schedule`/`flush`/`cancelAnimationFrame`), arranque a 3 px, `data-dragging` con `will-change:transform` y `touch-action:none`, y fin de gesto con posición final directa.
- `src/preview/PreviewFrame.tsx`: `selectedId`/`readOnly` salen del contexto serializado y llegan por `postMessage` (`preview-state`, validado por canal y origen) en `onLoad` y en cada cambio; el puente mantiene `let readOnly` y aplica la selección sin devolver mensajes. `result` ya no depende de la identidad de `onSelect`.
- `src/preview/PreviewPanel.tsx` + `preview.css`: botón **Paleta de colores** en el panel lateral (destino fondo/texto/borde), selector nativo, campo `#FAFAFA`, validación visible, muestras rápidas desde `theme.tokens` y presets; aplica la operación `style` con debounce de 160 ms.

Comprobación ejecutada:
- `tsc -b` **passed**; `oxlint` sobre los tres archivos sin avisos nuevos relevantes (solo los avisos de refs/efectos ya existentes en el proyecto).
- Grupo Node de previsualización **48/48 passed** (suma una regresión del puente: rAF, `preview-state`, regex `matrix\(` y `will-change`).
- Playwright `tests/e2e/preview.spec.ts` **28/28 passed** (workers=1). Nuevos casos: seleccionar no recarga el iframe (marcador en el `body` y `srcdoc` sin cambios) y el `readOnly` llega por `postMessage` (`draggable=false` al editar texto sin guardar); la paleta valida un código inválido, aplica `#FAFAFA` al fondo y una muestra al texto vía IPC real; el arrastre marca `data-dragging` durante el gesto.
- Regresión corregida durante la verificación: `data-selected` pasó de `"true"` (lo ponía la recarga) a `""`; el puente ahora usa `setAttribute(...,'true')` de forma explícita.
- No se ejecutó un recorrido nativo interactivo de la ventana de Flufy ni una captura visual manual; la instancia `Flufy dev` sigue corriendo con HMR.
