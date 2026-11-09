# Evals de agente

Mide al agente sobre tareas de código reales, no sobre fixtures de planificación. Cada tarea corre en una copia limpia del repositorio de prueba, con el motor incluido y el modelo que elijas.

## Comandos

```powershell
npm run eval:mock                 # valida las evals sin inferencia (control negativo + positivo)
npm run eval                      # corre todas las tareas con un modelo conectado
npm run eval -- --model openai/gpt-5
npm run eval -- --task fix-add --repeat 3
npm run eval -- --keep            # conserva las carpetas de trabajo en evals/.runs
```

El modo real copia `auth.json` desde `%USERPROFILE%\.local\share\opencode\auth.json` a un perfil temporal. No toca tus sesiones ni tu configuración. Si usás otro perfil, pasá `--auth <ruta>`.

## Qué mide

- **PASS/FAIL** según el comando de calificación de la tarea.
- Duración, tokens de entrada/salida/razonamiento, costo informado por el motor.
- Cantidad de llamadas a herramientas y errores de herramientas.
- Archivos modificados.
- Salida del comando de calificación (recortada).

Los resultados quedan en `evals/results/latest.json` y en un archivo por corrida. `latest-selftest.json` guarda la validación del harness.

## Agregar una tarea

1. Sumá un objeto a `evals/tasks.json` con `id`, `title`, `prompt`, `grade`, `timeoutSeconds` y, si hace falta, `copy` para inyectar un test oculto.
2. Agregá la solución en `evals/solutions/<id>.json` con ediciones exactas. El modo `--mock` la usa como control positivo.
3. Verificá con `npm run eval:mock`.

La solución no se usa en el modo real: sirve para comprobar que el comando de calificación falla con el fixture original y pasa con una solución conocida.

## Límites

- El modo real necesita un proveedor conectado y consume tokens/cuota.
- El harness mide el motor y el modelo, no la interfaz de Flufy. Para medir las herramientas `code_*` hay que levantar el MCP de Flufy y configurarlo en `OPENCODE_CONFIG_CONTENT`.
- Los fixtures son chicos a propósito: sirven para comparar modelos y cambios de prompt/herramientas, no para estimar rendimiento en repositorios enormes.
