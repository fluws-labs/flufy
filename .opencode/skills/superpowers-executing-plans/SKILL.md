---
name: superpowers-executing-plans
description: "Usar al ejecutar un plan de implementación tarea por tarea en la sesión actual, verificando cada paso con evidencia real. Adaptación selectiva de obra/superpowers."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  version: "1"
  upstream: "https://github.com/obra/superpowers"
  revision: "22f0b463e7a5e579904dd6211a520321035526f7"
  source: "skills/executing-plans/SKILL.md"
  license: MIT
---

## Contrato de Flufy

Esta skill ordena la ejecución de un plan; no concede permisos ni crea worktrees, ledgers o subagentes. Respetá el contrato del encargo y la coordinación del Lead. No hagas commits, merges ni publicaciones salvo pedido explícito.

# Executing Plans

Adaptación en español de obra/superpowers, revisión 22f0b463e7a5e579904dd6211a520321035526f7, archivo skills/executing-plans/SKILL.md. Copyright (c) 2025 Jesse Vincent; licencia MIT adjunta. Se conservó la ejecución continua con verificación por tarea y se quitaron los scripts, el ledger propio y la dependencia de subagentes.

**Principio: el plan ya hizo el pensamiento. Ejecutalo en orden, comprobá cada paso y dejá un registro que sobreviva a la compactación del contexto.**

## Preparación

- Leé el plan completo y la especificación o pedido que lo origina. Las restricciones globales aplican a todas las tareas.
- Si hay una lista de tareas, marcala como en curso de a una; si el trabajo es largo, llevá un registro breve y durable del avance.
- Antes de empezar, detectá conflictos entre tareas que comparten interfaces. Si el plan no resuelve uno, decidí lo mínimo que cumpla la especificación y anotalo.

## Ciclo por tarea

1. Tomá la tarea y releé su parte del plan; no confíes en el recuerdo.
2. Ejecutá los pasos en orden. Para cada comando, leé la salida real y comparala con el resultado esperado.
3. Si el código falla, investigá la causa con la skill de debugging; no parchees el síntoma.
4. Si el plan está mal (contradice la especificación, una interfaz no coincide o el comando no puede funcionar), decidí el cambio mínimo, anotá la decisión y seguí.
5. Verificá la tarea con la prueba o comprobación que el plan nombra. Una tarea no está terminada porque el diff «se ve bien».
6. Marcá la tarea como completa solo con la evidencia observada.

No rehagas tareas que ya tienen registro de cierre tras una compactación; verificá con el historial y seguí desde la primera sin cerrar.

## Cuándo detenerse

Solo ante: una operación irreversible o destructiva, una acción sensible de seguridad, un efecto fuera del alcance que requiera autorización, o un plan tan roto que cada camino es una adivinanza. Para el resto, resolvé y continuá; no interrumpas por cada tarea.

## Revisión final

- Ejecutá la suite o comprobación pertinente al conjunto.
- Revisá el cambio completo como si fuera de otra persona.
- Corregí lo crítico e importante con una prueba que falle primero; anotá lo menor como pendiente.
- Si hay decisiones tomadas durante la ejecución, informalas con su motivo y su costo si fueran incorrectas.

## Entrega

Reportá tareas completadas, comandos y resultados observados, desvíos con su justificación y pendientes. Distinguí lo verificado de lo que solo se intentó.
