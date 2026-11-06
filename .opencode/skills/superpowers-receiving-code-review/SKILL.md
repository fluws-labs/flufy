---
name: superpowers-receiving-code-review
description: "Usar al recibir comentarios de revisión de código, antes de implementar: verificar cada sugerencia y responder con rigor técnico. Adaptación selectiva de obra/superpowers."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  version: "1"
  upstream: "https://github.com/obra/superpowers"
  revision: "22f0b463e7a5e579904dd6211a520321035526f7"
  source: "skills/receiving-code-review/SKILL.md"
  license: MIT
---

## Contrato de Flufy

Esta skill gobierna cómo procesar feedback; no concede permisos ni autoriza refactors fuera del encargo. En equipo, contrastá el feedback con el Lead cuando afecte decisiones de arquitectura o el alcance. No hagas commits ni publiques por aplicar esta skill.

# Code Review Reception

Adaptación en español de obra/superpowers, revisión 22f0b463e7a5e579904dd6211a520321035526f7, archivo skills/receiving-code-review/SKILL.md. Copyright (c) 2025 Jesse Vincent; licencia MIT adjunta. Se conservó la verificación técnica antes de implementar y se adaptaron las referencias a la coordinación de Flufy.

**Principio: verificar antes de implementar; preguntar antes de asumir; la corrección técnica pesa más que la comodidad social.**

## Patrón de respuesta

1. Leer el feedback completo sin reaccionar.
2. Reformular el requisito con tus palabras o pedir aclaración.
3. Verificar contra el código real y el contrato del encargo.
4. Evaluar si es correcto para este proyecto.
5. Responder con reconocimiento técnico o con una objeción razonada.
6. Implementar de a uno, probando cada cambio.

## Sin agradecimientos vacíos

No respondas «tenés toda la razón», «buen punto» o «gracias por detectarlo». Reformulá el requisito, hacé la pregunta concreta o mostrá la corrección. Las acciones y el código demuestran que escuchaste.

## Feedback ambiguo

Si algún punto no está claro, detené la implementación y aclaralo antes de tocar código: los puntos suelen estar relacionados y una comprensión parcial produce una corrección equivocada. No implementes la parte clara y dejes la ambigua para después.

## Según quién revisa

- El usuario: es una fuente confiable; implementá después de entender. Si el alcance no está claro, preguntá.
- Un revisor externo o automático: sé escéptico pero verificá. ¿Es correcto para este código? ¿Rompe algo? ¿Entiende el contexto completo? ¿Aplica a todas las plataformas o versiones?
- Si contradice una decisión previa del usuario, detenete y consultá antes de cambiar.

## YAGNI

Si el revisor propone «implementarlo bien», primero buscá si la función se usa. Si nadie la llama, proponé eliminarla en lugar de ampliarla. Si se usa, implementá lo necesario con evidencia.

## Orden de implementación

1. Aclarar todo lo ambiguo.
2. Corregir primero lo bloqueante (seguridad, roturas), después lo simple (typos, imports) y al final lo complejo (lógica, refactor).
3. Probar cada corrección.
4. Verificar que no haya regresiones.

## Cuándo objetar

Objetá cuando la sugerencia rompe funcionalidad, ignora contexto, viola YAGNI, es incorrecta para el stack o contradice decisiones del usuario. Usá razones técnicas, preguntas específicas y pruebas; no defensas personales.

Si objetaste y estabas equivocado, decilo con hechos («verifiqué X y hace Y; lo corrijo») y seguí. Sin disculpas largas ni explicaciones de más.

## Errores comunes

- Aceptar todo sin verificar.
- Implementar en lote sin probar.
- Asumir que el revisor tiene razón.
- Evitar la objeción por comodidad.
- Implementar parcialmente sin aclarar el resto.
- No poder verificar y avanzar igual: declaralo y pedí dirección.

## Entrega

Mostrá qué se corrigió, con qué prueba o verificación, y qué queda pendiente o en discusión.
