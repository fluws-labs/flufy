# Skills selectivas de obra/superpowers

## Selección incorporada

Se incorporaron **nueve adaptaciones independientes en español**, no el plugin ni la metodología completa:

- `superpowers-systematic-debugging` v1: reproducir fallos, investigar su causa raíz, contrastar una hipótesis y verificar una corrección mínima. Útil para especialistas que diagnostican errores.
- `superpowers-verification-before-completion` v1: respaldar afirmaciones de éxito con comprobaciones reales y proporcionales. Útil para QA, revisión y cierre de tareas.
- `superpowers-requesting-code-review` v1: pedir una revisión enfocada con el alcance delimitado y contexto acotado.
- `superpowers-receiving-code-review` v1: procesar feedback con verificación técnica y sin acuerdos performativos.
- `superpowers-test-driven-development` v1: escribir primero una prueba que falle y después el código mínimo, con verificación proporcional.
- `superpowers-writing-plans` v1: convertir un pedido de varias etapas en un plan con archivos, interfaces y pasos verificables.
- `superpowers-executing-plans` v1: ejecutar el plan tarea por tarea, comparando la salida real con la esperada y registrando desvíos.
- `superpowers-writing-skills` v1: crear o editar skills reutilizables y probarlas contra un escenario real.
- `superpowers-brainstorming` v1: clarificar objetivo, motivo y enfoque antes de construir, sin interrogatorios innecesarios.

Las adaptaciones eliminan dependencias de subagentes, worktrees, scripts, ledgers, servidores visuales y decisiones de Git; conservan el contrato de Flufy y la verificación proporcional.

Están instaladas en este proyecto como `.opencode/skills/<nombre>/SKILL.md`. OpenCode descubre esas carpetas por su mecanismo nativo de skills de proyecto. No se modificó la configuración global ni se agregó un plugin, hook de arranque, symlink o bootstrap. Los nombres prefijados evitan colisionar con skills originales o personalizadas.

## Equipos y versiones

El catálogo compilado de Flufy incluye las nueve adaptaciones mediante `superpowers-catalog.json`, reutilizando la persistencia versionada y su actualización conservadora. **Disponibles no significa asignadas**: no se agregan a perfiles, integrantes o selecciones existentes por defecto.

En **Equipos → editar/crear plantilla → integrante → Skills combinables**, seleccioná solo las pertinentes y guardá la plantilla. Las encontrarás con el prefijo «Superpowers ·». El registro de skills existente permite editar y guardar una nueva versión. Las versiones personalizadas no se reemplazan; las selecciones explícitas y los snapshots de chats/ejecuciones históricos conservan su contenido original.

En un equipo automático nuevo, el Lead puede pedir sus IDs en `skillIds` al incorporar un especialista, usando el catálogo real. Un chat ya abierto conserva su catálogo snapshot: creá otro chat después de actualizar Flufy para disponer de las nuevas skills. No se reescriben chats históricos para activarlas.

## Instalación selectiva en otro proyecto

Desde este checkout, con Node instalado:

```powershell
node scripts/install-superpowers-skills.mjs --list
node scripts/install-superpowers-skills.mjs --project "D:\mi-proyecto" systematic-debugging
node scripts/install-superpowers-skills.mjs --project "D:\mi-proyecto" verification-before-completion
```

También acepta ambos nombres en una sola ejecución o los IDs completos con prefijo `superpowers-`. La carpeta del proyecto debe existir. Sin nombres no instala nada. Copia únicamente las skills seleccionadas y sus licencias desde esta revisión local auditada; no descarga ni ejecuta código remoto. Una segunda ejecución idéntica informa `unchanged`. Si encuentra contenido distinto, aborta antes de copiar y preserva las personalizaciones; no tiene `--force`.

Este instalador instala skills de **proyecto para el motor**. El catálogo de **equipos de la aplicación** incluye las nueve incorporadas en esta versión, independientemente de qué otras carpetas tenga un proyecto; no promete importar automáticamente cualquier skill externa al catálogo de equipos.

## Procedencia y licencia

- Repositorio: https://github.com/obra/superpowers
- Revisión inspeccionada y fijada: `22f0b463e7a5e579904dd6211a520321035526f7` (commit del 3 de noviembre de 2026).
- Fuentes: `skills/systematic-debugging/SKILL.md` y `skills/verification-before-completion/SKILL.md` en esa revisión.
- Licencia: **MIT**, Copyright (c) 2025 Jesse Vincent. Se conserva el texto completo en `LICENSE` dentro de cada carpeta instalada.
- Adaptación local: v1. Traducción y síntesis; se eliminaron referencias obligatorias a otras skills, TDD global, delegación y consulta humana ante bloqueos técnicos. Se mantiene el contrato de Flufy, la comprobación proporcional y el control de permisos del motor.

El README público de esa revisión enumera testing, debugging, colaboración y meta-skills; **no anuncia una skill especializada de diseñador UI/UX**. No se instala ni se ofrece una inventada. `brainstorming` y su acompañante visual no equivalen a un diseñador UI/UX.

No se incorporan `using-superpowers`, `using-git-worktrees`, `subagent-driven-development`, `dispatching-parallel-agents`, `finishing-a-development-branch` ni `diagnosing-superpowers`: imponen bootstrap, delegación, decisiones de Git o un autoanálisis pesado fuera de esta selección.

## Activación

- **Motor, skills de proyecto:** abrir una sesión nueva después de la instalación; si el motor en ejecución tiene el descubrimiento en caché, reiniciarlo. No se afirma que esta sesión actual ya haya recargado el listado.
- **Catálogo de equipos:** recompilar y reiniciar Flufy para cargar el catálogo Rust incorporado; después crear un chat nuevo. Reiniciar solamente el motor no actualiza el catálogo compilado de una app anterior.
- Ninguna instalación inicia automáticamente tareas ni cambia equipos existentes.
