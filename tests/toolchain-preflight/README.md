# Entorno Rust existente (Windows x64)

Desde la raíz del proyecto, en PowerShell:

```powershell
. .\tests\toolchain-preflight\env.ps1
cargo --version
rustc -vV
cargo run --manifest-path tests/toolchain-preflight/Cargo.toml --offline
```

El script solo configura la sesión actual. Reutiliza las instalaciones locales;
no instala Rust ni modifica PATH de usuario o máquina.

Verificado el 2026-11-08: Cargo y rustc 1.99.1, host
`x86_64-pc-windows-msvc`, compilación, enlace y ejecución del preflight correctos.
MSVC detectado en Visual Studio 18 BuildTools, versión 14.51.36231;
Windows SDK 10.0.26100.0 con `kernel32.lib` y `ucrt.lib` presentes.
No fue necesario cargar manualmente un Developer Command Prompt.
Este ejecutable mínimo no acredita pruebas del backend de Flufy.

Dependencias Rust descargadas correctamente con el lockfile existente:

```powershell
. .\tests\toolchain-preflight\env.ps1
cargo fetch --manifest-path src-tauri/Cargo.toml --locked
```

Antes de esa descarga, la resolución offline fallaba por `aes-gcm` sin cachear;
no era ausencia ni fallo del compilador.

## Arranque y preparación

README.md documenta `npm run dev`; las dependencias existentes pasan
`npm ls --depth=0`. Node 26.13.0 y npm 11.20.0 están disponibles.
Vite se inició en terminal integrada con `npm run dev`, en
`http://localhost:5173/`, y respondió HTTP 200 con la entrada `src/main.tsx`.
La existencia de esa respuesta solo verifica el servidor, no el recorrido UI.
Playwright configura su propio Vite en 5188 y permite reutilizarlo.

No ejecutar automáticamente `run.ps1`: detiene procesos del proyecto y abre
procesos ocultos. El arranque equivalente debe usar terminales integradas y
conservar las instancias existentes.

Durante esta preparación faltaban
`src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe` y el directorio
`src-tauri/binaries/piper`; `dist-pwa/pwa.html` y Whisper estaban presentes.
La receta existente para el motor es `npm run release:engine` (descarga con
SHA256 y versión fijados), y para Piper, `npm run release:piper`.
Esas recetas escriben fuera de la propiedad de esta tarea y deben asignarse
al responsable autorizado antes del arranque nativo completo.
No reutilizar ni detener ciegamente el motor activo del usuario.

Después de preparar los recursos, las verificaciones nativas deben usar
`env.ps1` en cada terminal nueva antes de Cargo. El preflight no sustituye
`cargo test --manifest-path src-tauri/Cargo.toml --lib ...` ni la ejecución real
de Tauri. No se ejecutaron pruebas del backend en esta tarea.

## Preparación de QA de fallback (2026-11-08, continuación)

Observación previa de esta sesión: existían `node_modules`, `dist/index.html`,
`dist-pwa/pwa.html` y Whisper. No existían el ejecutable empaquetado del motor
ni Piper. No había Node, Cargo ni rustc activos; solo un `opencode.exe` del
usuario, que se conservó sin reutilizar ni detener. No había listeners Vite en
5173/5188. Cargo y rustc respondieron 1.99.1 al cargar `env.ps1`.

Preparación realmente ejecutada con éxito:

```powershell
npm ls --depth=0
npm run release:engine
npm run release:piper
npm run build; if ($?) { npm run build:pwa }
```

Las recetas verificaron SHA256: OpenCode 1.19.5 y Piper 2023.11.14-2.
Vite se inició en terminal integrada con
`npm run dev -- --host 127.0.0.1 --port 5188`; anunció disponibilidad.
Esto no acredita recorrido visual ni arranque nativo de la app.

Comprobaciones independientes observadas: `npm test` pasó 130 pruebas;
`npx playwright test tests/e2e/fallback.spec.ts --workers=1 --reporter=line`
pasó los 15 escenarios de IPC simulado (18.3 segundos).

El conductor `tests/fallback-native.mjs` conserva cada ejecución bajo un
directorio único en `test-results/com.guillecode.fallback-test-*`, incluyendo
perfil de motor, SQLite, informes, archivos de efectos y logs. No borra informes
de otras ejecuciones. Solo termina sus propios hijos para comprobar reinicio.
Cargar `env.ps1` y ejecutar `node tests/fallback-native.mjs` compila el harness
release, inicia un motor propio con inferencia determinista y ejecuta
prepare/resume/reopen. No equivale a inferencia de proveedor real ni a la UI
nativa normal. El resultado de esa ejecución se informa por separado: la
existencia del conductor o la preparación de recursos no acredita que haya pasado.

### Resultado de la continuación de T3

Se agregaron dos regresiones de IPC simulado: panel oculto sin transición tardía
y selección de ejecución de otro chat sin perder la restauración del propietario.
Con el código leído en esta continuación pasaron:

```powershell
npm run build
npx playwright test tests/e2e/fallback.spec.ts --trace retain-on-failure
npx playwright test tests/e2e/fallback.spec.ts --grep selector --repeat-each 5 --trace retain-on-failure
```

Resultados: 17/17 en 44.5 s y 45/45 en 20.9 s. No hubo fallo del selector
en estas repeticiones; retain-on-failure no produjo traces de fallos.
Esto no acredita revisión visual interactiva ni persistencia nativa.

La ejecución nativa iniciada anteriormente terminó con código 1, no aprobada:
`. .\tests\toolchain-preflight\env.ps1; node tests/fallback-native.mjs`.
Cargo release compiló correctamente en 3m 37s, pero prepare falló a los 240.06 s
en `integration.rs:106`, `initial message not persisted`. No se alcanzó el gate
initial ni se invocó inferencia: `requests.json` contiene una lista vacía.
No se ejecutaron resume/reopen. Los logs reales `build.log`, `prepare.log` y
`requests.json` permanecen en
`test-results/com.guillecode.fallback-test-9df19bea-686d-4375-bb02-c278b3241fef/`.
El conductor ya terminó y liberó su Cargo; una observación posterior detectó
otro Cargo del equipo activo, que debe coordinarse con T1 antes de nuevas pruebas.
No se relaja la aserción ni se atribuye todavía el fallo al backend o al fixture:
T1 debe exponer el error real del mensaje previo al gate y la carpeta de SQLite
usada por Tauri, para comprobar que el almacenamiento de prueba está en el
directorio autorizado antes del siguiente intento.
