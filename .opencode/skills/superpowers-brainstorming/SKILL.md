---
name: superpowers-brainstorming
description: "Usar ante un pedido creativo o poco definido, antes de construir: entender qué quiere el usuario, por qué y con qué enfoque. Adaptación selectiva de obra/superpowers."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  version: "1"
  upstream: "https://github.com/obra/superpowers"
  revision: "22f0b463e7a5e579904dd6211a520321035526f7"
  source: "skills/brainstorming/SKILL.md"
  license: MIT
---

## Contrato de Flufy

Esta skill ayuda a clarificar un pedido; no concede permisos ni bloquea tareas claras. Si el pedido es concreto y pequeño, ejecutalo sin interrogatorio. Respetá el contrato del encargo y el alcance. No abras servidores, navegadores ni prototipos por iniciativa propia.

# Brainstorming

Adaptación en español de obra/superpowers, revisión 22f0b463e7a5e579904dd6211a520321035526f7, archivo skills/brainstorming/SKILL.md. Copyright (c) 2025 Jesse Vincent; licencia MIT adjunta. Se conservó la conversación para descubrir intención y se quitaron el compañero visual, los scripts y la obligación de invocar otras skills.

**Principio: entender qué quiere y por qué antes de construir evita hacer muy bien algo que no era.** Preguntar ayuda a que el usuario termine de pensarlo.

## Antes de preguntar

- Si el pedido es claro y acotado, hacelo y contá qué hiciste.
- Si falta algo no trivial, leé el contexto disponible (archivos, especificación, conversación previa) antes de la primera pregunta. No preguntes lo que el proyecto ya responde.
- No reabras decisiones ya tomadas.

## Primera respuesta

- Si ya dijeron qué quieren: reformulá el pedido con tus palabras, agregá lo que encontraste que lo afecta y hacé una sola pregunta abierta sobre lo que más cambiaría el resultado. Si no hay nada abierto, proponé el enfoque concreto y pedí aprobación.
- Si no lo dijeron: preguntá por lo más importante que falta, explicando qué cambiaría la respuesta. Una pregunta por vez, en lenguaje del usuario.
- Si el usuario prefiere avanzar sin conversación, respetalo: declaré las decisiones relevantes y seguí.

## La conversación

- Preguntá solo cuando la respuesta cambie lo que se va a construir y ni el pedido ni el proyecto lo respondan.
- Para el resto, proponé una decisión con su motivo y seguí.
- Una pregunta por vez; sin menús de opciones antes de entender el motivo.
- Cuando el motivo esté claro, presentá dos o tres enfoques reales con sus ventajas y desventajas, recomendá uno y pedí elección.
- Si el usuario te delegó el «cómo», elegí y declaralo.

## Devolver lo entendido

A medida que comprendas una parte, reformulala en pocas palabras y preguntá qué falta o qué está mal. Separá lo que dijo el usuario de tus propuestas. No avances a construir sobre una interpretación no confirmada.

## Tamaño del trabajo

- Cambio pequeño: un diseño corto con lo acordado alcanza.
- Proyecto: documento de diseño con intención, objetivos, no objetivos, antiobjetivos, restricciones, enfoques, decisiones tomadas y lo que queda abierto.
- Guardalo donde indique el proyecto o el encargo; si no hay indicación, proponé una ruta.

## Puerta de aprobación

No empieces a construir hasta que el usuario apruebe el diseño, salvo que haya pedido explícitamente avanzar sin preguntas o haya aceptado un prototipo descartable. Un «suena bien» a la idea no aprueba un documento que no viste.

## Señales de alerta

- Ofrecer un menú de opciones antes de escuchar.
- Rellenar valores por defecto sin decirlos.
- Escribir el documento sin presentar enfoques.
- Tomar un «suena bien» como aprobación del diseño.
- Convertir un pedido claro en un interrogatorio.

## Entrega

Resumí el objetivo, el enfoque elegido, las decisiones y lo que queda abierto. Si el trabajo sigue, pasá al plan o a la implementación según lo acordado.
