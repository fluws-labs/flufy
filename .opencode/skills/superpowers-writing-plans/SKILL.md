---
name: superpowers-writing-plans
description: "Usar cuando hay un pedido o especificación de varias etapas y todavía no se tocó código: escribir un plan ejecutable con decisiones y verificaciones explícitas. Adaptación selectiva de obra/superpowers."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  version: "1"
  upstream: "https://github.com/obra/superpowers"
  revision: "22f0b463e7a5e579904dd6211a520321035526f7"
  source: "skills/writing-plans/SKILL.md"
  license: MIT
---

## Contrato de Flufy

Esta skill produce un plan; no concede permisos ni obliga a un método de ejecución, worktree o commit. Respetá el formato y la ubicación que pida el encargo. En equipo, el Lead decide la asignación; no crees subagentes por aplicar esta skill.

# Writing Plans

Adaptación en español de obra/superpowers, revisión 22f0b463e7a5e579904dd6211a520321035526f7, archivo skills/writing-plans/SKILL.md. Copyright (c) 2025 Jesse Vincent; licencia MIT adjunta. Se conservó el plan por tareas con pasos verificables y se quitaron las dependencias de subagentes, worktrees y elección obligatoria de ejecutor.

**Principio: el plan es el conjunto de decisiones que otra persona no puede inferir sola.** Escribilo para alguien que no vio este código ni esta especificación.

## Antes de escribir

- Leé el pedido, la especificación y el código que se va a tocar. Si hay contexto previo, no preguntes lo que ya está respondido.
- Si el pedido abarca subsistemas independientes, proponé separarlo en planes o entregas; cada uno debe producir algo funcionando y comprobable.
- Mapeá los archivos a crear o modificar y la responsabilidad de cada uno. Seguí los patrones existentes; no reestructures por preferencia.

## Estructura del documento

- Objetivo en una frase.
- Enfoque o arquitectura en dos o tres frases.
- Restricciones globales: versiones, dependencias, convenciones, plataformas.
- Referencia al pedido o especificación que el plan implementa.
- Tareas en orden, cada una con archivos, interfaces que consume y produce, y pasos.

## Tamaño de las tareas

Una tarea es la unidad más pequeña que tiene su propio ciclo de prueba y que un revisor podría aceptar o rechazar por separado. Agrupá preparación, configuración y documentación dentro de la tarea que las necesita. Cada tarea termina con algo comprobable de forma independiente.

## Pasos

Cada paso es una acción con un resultado verificable:

- «Escribir la prueba que falla» y «ejecutarla para ver el fallo esperado».
- «Implementar lo mínimo para que pase» y «ejecutar la prueba».
- «Ejecutar la suite pertinente» con el resultado esperado.
- «Commit» solo si el encargo lo pide.

Para cada paso que ejecuta un comando, indicá el comando exacto y qué salida significa que pasó. Un paso tiene que dejar una sola interpretación razonable; si no, dividilo.

## Revisión propia

Antes de entregar, contrastá el plan con el pedido:

1. **Cobertura:** cada requisito tiene una tarea que lo implementa.
2. **Pasos:** cada uno permite una acción inequívoca; no hay «manejar casos borde» ni «agregar validaciones» sin decir cuáles.
3. **Consistencia:** nombres, firmas y tipos coinciden entre tareas.
4. **Proporción:** el plan no es más largo que el código que describe; si hay bloques de código de más, reemplazalos por firmas y pruebas.
5. **Riesgos:** los modos de falla o entradas que el pedido implica tienen una prueba en la tarea que corresponde.

Corregí en el momento; no hace falta otra ronda.

## Entrega

Guardá el plan donde indique el proyecto o el encargo; si no hay indicación, proponé una ruta y decila. Pedí revisión cuando el trabajo sea no trivial. No impongas cómo ejecutarlo: eso lo decide el usuario o el Lead.
