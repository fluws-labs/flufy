---
name: superpowers-test-driven-development
description: "Usar al implementar comportamiento nuevo o corregir un bug: escribir primero una prueba que falle y recién después el código mínimo. Adaptación selectiva de obra/superpowers."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  version: "1"
  upstream: "https://github.com/obra/superpowers"
  revision: "22f0b463e7a5e579904dd6211a520321035526f7"
  source: "skills/test-driven-development/SKILL.md"
  license: MIT
---

## Contrato de Flufy

Esta skill ordena la implementación; no concede permisos ni obliga a crear pruebas para cambios reversibles de bajo impacto. Respetá el contrato del encargo, las rutas asignadas y la verificación proporcional de Flufy. En equipo coordiná con el Lead los casos dudosos; no crees subagentes.

# Test-Driven Development

Adaptación en español de obra/superpowers, revisión 22f0b463e7a5e579904dd6211a520321035526f7, archivo skills/test-driven-development/SKILL.md. Copyright (c) 2025 Jesse Vincent; licencia MIT adjunta. Se conservó el ciclo rojo-verde-refactor y se reemplazó el absolutismo por el criterio de verificación proporcional del proyecto.

**Principio: si no viste fallar la prueba, no sabés si prueba lo correcto.**

## Cuándo usarlo

- Comportamiento nuevo, corrección de bugs, refactors y cambios de comportamiento.
- Excepciones razonables: prototipos descartables, código generado, configuración o cambios reversibles de bajo impacto donde una comprobación focalizada alcanza. Declará la excepción; no la uses como excusa rutinaria.

## Ciclo rojo-verde-refactor

1. **Rojo:** escribí una prueba mínima que describa el comportamiento esperado, con nombre claro y valores reales del requisito.
2. **Verificar rojo:** ejecutala y confirmá que falla por la razón esperada (falta la funcionalidad, no un typo). Si pasa, estás probando algo existente.
3. **Verde:** escribí el código más simple que la haga pasar. Sin funciones, opciones ni abstracciones que la prueba no pida.
4. **Verificar verde:** ejecutá la prueba y la suite pertinente del proyecto; leé la salida completa.
5. **Refactor:** quitá duplicación y mejorá nombres sin agregar comportamiento; mantené todo en verde.

## Pruebas honestas

- Una prueba, un comportamiento. Si el nombre lleva «y», probablemente sean dos.
- Afirmá sobre comportamiento real, no sobre llamadas a mocks.
- Usá mocks solo cuando no haya alternativa; entendé los efectos del reemplazo.
- Cubrí el caso borde y el error, no solo el camino feliz.

## Bug fixing

Reproducí el bug con una prueba que falle, confirmá la causa, corregí lo mínimo y verificá que la prueba pase y que no rompas otras. No cierres un bug sin una reproducción observada.

## Verificación proporcional en Flufy

Para lógica o permisos, la prueba pertinente es la evidencia principal. Para textos, estilos reversibles o ajustes simples, el diff revisado puede alcanzar. Si afirmás «TDD», tenés que haber observado el rojo; no inventes una fase que no ejecutaste.

## Señales de alerta

- Código antes que la prueba.
- Prueba que pasa de inmediato.
- No poder explicar por qué falló.
- Prueba añadida «después».
- Probar solo mocks.
- Racionalizar «solo esta vez».

## Entrega

Informá qué prueba falló primero, qué código la hizo pasar y qué suite corriste. Si no usaste TDD, decí qué comprobación usaste en su lugar.
