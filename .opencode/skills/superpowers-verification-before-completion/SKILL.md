---
name: superpowers-verification-before-completion
description: "Usar antes de afirmar que un trabajo está terminado, corregido o pasa pruebas: comprobar evidencia pertinente y actual. Adaptación selectiva de obra/superpowers."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  version: "1"
  upstream: "https://github.com/obra/superpowers"
  revision: "22f0b463e7a5e579904dd6211a520321035526f7"
  source: "skills/verification-before-completion/SKILL.md"
  license: MIT
---

## Contrato de Flufy

Esta skill orienta la verificación; no concede permisos ni reemplaza el contrato del encargo. Respetá las rutas, las herramientas y los formatos JSON vigentes. En equipo usá los resultados reales y la coordinación del Lead, sin crear subagentes ni nuevas aprobaciones. No implica hacer commits, publicar o desplegar. QA manual es opcional y pertenece al usuario; el equipo realiza sus comprobaciones antes de entregar.

# Verification Before Completion

Adaptación en español de obra/superpowers, revisión 22f0b463e7a5e579904dd6211a520321035526f7, archivo skills/verification-before-completion/SKILL.md. Copyright (c) 2025 Jesse Vincent; licencia MIT adjunta. Se conserva «evidencia antes de afirmaciones» y se adapta la comprobación a los flujos reales de Flufy.

**No afirmar que algo está terminado, corregido o aprobado sin evidencia pertinente y actual.** Aplicá esta skill al preparar una afirmación de éxito; no exige repetir pruebas exitosas si no hubo cambios o nueva evidencia que las invalide.

## Antes de afirmar éxito

1. Identificá qué observación comprueba exactamente la afirmación y los criterios del pedido.
2. Ejecutá la comprobación completa pertinente con las herramientas autorizadas. Para código usá pruebas, compilación o typecheck según el cambio; para una interacción real usá el navegador o la app, sin reemplazar el recorrido por una respuesta HTTP.
3. Leé el resultado completo relevante, los fallos y el código de salida. Un proceso que sigue vivo no equivale a un comando terminado con éxito.
4. Contrastá la evidencia con el alcance: un linter no prueba compilación; una compilación no prueba una interacción; un resumen de agente no es verificación independiente.
5. Comunicá lo demostrado y sus límites. Si hay fallo, acceso faltante o incertidumbre, informalo sin convertirlo en una aprobación.

## Evidencia proporcional

- «Pruebas aprobadas» requiere la ejecución observada sin fallos de las pruebas que nombrás.
- «Bug corregido» requiere comprobar el síntoma original, además de editar el archivo.
- «Regresión probada» requiere haber observado la reproducción y su corrección; no inventes una fase roja que no ejecutaste.
- «Criterios completos» requiere revisar cada criterio y su evidencia; no extrapoles desde un único test.
- En tareas visuales, distinguí snapshot, captura examinada y recorrido; solo afirmá lo efectivamente observado.

Reutilizá evidencia válida de la revisión actual. No hagas pruebas arbitrarias para llenar una lista, ni conviertas cada mensaje intermedio en una nueva suite. Para pruebas de código, registrá en checks solo comandos satisfactorios realmente ejecutados y exactamente como se enviaron. Declarar una prueba fallida en limitations no la convierte en aprobada.

## Entrega

Separá hechos, fallos y pendientes. Acompañá afirmaciones con resultados observados y dejá claras las comprobaciones que no pudiste realizar. No uses «debería funcionar», confianza personal o reportes de otros agentes como sustituto de evidencia.
