---
name: superpowers-systematic-debugging
description: "Usar ante bugs, fallos de pruebas o comportamiento inesperado: investigar la causa raíz antes de corregir. Adaptación selectiva de obra/superpowers."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  version: "1"
  upstream: "https://github.com/obra/superpowers"
  revision: "22f0b463e7a5e579904dd6211a520321035526f7"
  source: "skills/systematic-debugging/SKILL.md"
  license: MIT
---

## Contrato de Flufy

Esta skill guía una investigación; no concede permisos, modifica locks ni reemplaza las instrucciones del proyecto. Respetá el contrato JSON vigente del encargo y las rutas asignadas. En equipo coordiná bloqueos técnicos con el Lead; no crees subagentes ni pidas aprobaciones de microtareas. No borres trabajo previo ni agregues commits, worktrees o infraestructura por aplicar esta skill. QA manual es opcional y pertenece al usuario.

# Systematic Debugging

Adaptación en español de obra/superpowers, revisión 22f0b463e7a5e579904dd6211a520321035526f7, archivo skills/systematic-debugging/SKILL.md. Copyright (c) 2025 Jesse Vincent; licencia MIT adjunta. Se conservaron las cuatro fases y se quitaron dependencias de otras skills y metodología global.

**Principio: encontrar la causa raíz antes de intentar una corrección.** Usala cuando haya un bug, un fallo de compilación o pruebas, un problema de integración o un comportamiento inesperado; no la actives solo porque existe.

## 1. Investigar

- Leé el mensaje y contexto del error completos: ubicaciones, códigos, stack y estado real.
- Reproducí el síntoma con pasos concretos y anotá las condiciones. Si no es reproducible, reuní evidencia antes de adivinar.
- Revisá cambios recientes, configuración y diferencias del entorno sin sobrescribir trabajo ajeno.
- En sistemas con varias capas, ubicá dónde se corta el flujo. Observá entradas, salidas y propagación de configuración con datos ficticios o sanitizados; nunca registres secretos.
- Seguí el dato hacia atrás desde el fallo hasta su origen. Instrumentá solo lo necesario y dentro del alcance autorizado.

## 2. Comparar patrones

Buscá un caso funcional en el proyecto. Leé la referencia relevante completa, compará diferencias concretas y verificá sus dependencias. No impongas una arquitectura nueva por una preferencia metodológica.

## 3. Probar una hipótesis

Escribí una hipótesis específica respaldada por lo observado: «X provoca Y porque Z». Hacé la comprobación mínima que la distingue de otras causas, cambiando una variable por vez. Si no se confirma, volvé a la evidencia; no acumules arreglos especulativos.

## 4. Corregir y verificar

Prepará una reproducción o prueba de regresión pertinente y proporcional al defecto. Corregí la causa con el cambio mínimo. Repetí el síntoma original y las comprobaciones afectadas; una compilación por sí sola no acredita que una interacción visual funciona. No hagas refactors no relacionados.

Si varios intentos no confirman la hipótesis, detené los cambios especulativos y reevaluá las suposiciones y límites del sistema. En equipo pedí diagnóstico al Lead con evidencia y lo que necesitás. Distinguí un bloqueo técnico recuperable de un permiso o decisión del usuario.

## Entrega

Informá síntoma, causa observada, cambio y verificación real. Si no identificaste la causa, explicitá qué investigaste y qué falta. No afirmes éxito por haber editado código o por el resumen de otro agente; usá los resultados observados y el formato exigido por el encargo.
