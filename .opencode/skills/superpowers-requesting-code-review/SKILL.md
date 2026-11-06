---
name: superpowers-requesting-code-review
description: "Usar al terminar una tarea o funcionalidad importante y antes de integrar: pedir una revisión enfocada con contexto preciso. Adaptación selectiva de obra/superpowers."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  version: "1"
  upstream: "https://github.com/obra/superpowers"
  revision: "22f0b463e7a5e579904dd6211a520321035526f7"
  source: "skills/requesting-code-review/SKILL.md"
  license: MIT
---

## Contrato de Flufy

Esta skill orienta cuándo y cómo pedir revisión; no concede permisos ni crea subagentes. En equipo, pedí la revisión al Lead o al integrante revisor/QA disponible; fuera de un equipo, presentá el cambio al usuario. No implica commits, merges ni publicaciones. Respetá el contrato del encargo y el alcance asignado.

# Requesting Code Review

Adaptación en español de obra/superpowers, revisión 22f0b463e7a5e579904dd6211a520321035526f7, archivo skills/requesting-code-review/SKILL.md. Copyright (c) 2025 Jesse Vincent; licencia MIT adjunta. Se conservó el criterio de revisión temprana con contexto acotado y se quitaron la dependencia de subagentes y los pasos de Git obligatorios.

**Principio: revisar temprano y seguido evita que un error se propague.** Pedí revisión cuando el costo de un defecto supera el de revisarlo; no conviertas cada cambio menor en una ceremonia.

## Cuándo pedir revisión

- Al cerrar una funcionalidad relevante y antes de integrar a la rama principal.
- Cuando estás trabado y una mirada externa destraba el problema.
- Antes de un refactor riesgoso, como línea base.
- Después de corregir un bug complejo.
- Para correcciones triviales y reversibles, usá criterio proporcional; no lo exijas si el proyecto no lo pide.

## Cómo pedirla

1. Delimitá el cambio: resumen breve, requisitos o criterios de aceptación y el rango exacto (commits, diff o archivos). Si no hay Git, indicá los archivos y el antes/después.
2. Entregá contexto elaborado, no toda la sesión: qué se buscaba, qué se cambió, qué se verificó y qué quedó fuera. El revisor evalúa el producto, no tu proceso.
3. En equipo usá el revisor o QA asignado; no inventes subagentes ni interrumpas a todos los integrantes.

## Cómo actuar con el resultado

- Crítico: corregir antes de seguir.
- Importante: corregir antes de integrar.
- Menor: anotar para después.
- Si el revisor se equivoca, respondé con evidencia técnica (código, pruebas, contrato); no aceptes a ciegas ni discutas sin datos.

## Señales de alerta

- Saltear la revisión porque «es simple».
- Ignorar hallazgos críticos.
- Avanzar con importantes sin corregir.
- Aceptar o rechazar feedback sin verificarlo.

## Entrega

Informá qué se revisó, qué se corrigió y qué quedó pendiente. No afirmes que un cambio está aprobado sin una revisión observada.
