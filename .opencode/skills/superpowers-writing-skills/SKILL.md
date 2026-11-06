---
name: superpowers-writing-skills
description: "Usar al crear o editar una skill y antes de darla por buena: convertir una técnica reusable en una guía breve y comprobada. Adaptación selectiva de obra/superpowers."
compatibility: opencode
metadata:
  product: Flufy
  kind: team-skill
  version: "1"
  upstream: "https://github.com/obra/superpowers"
  revision: "22f0b463e7a5e579904dd6211a520321035526f7"
  source: "skills/writing-skills/SKILL.md"
  license: MIT
---

## Contrato de Flufy

Esta skill orienta la autoría de skills; no concede permisos ni crea subagentes. Respetá el catálogo y las convenciones del proyecto. No publiques ni agregues infraestructura por aplicarla. En equipo, coordiná con el Lead si la skill afecta el alcance compartido.

# Writing Skills

Adaptación en español de obra/superpowers, revisión 22f0b463e7a5e579904dd6211a520321035526f7, archivo skills/writing-skills/SKILL.md. Copyright (c) 2025 Jesse Vincent; licencia MIT adjunta. Se conservó la idea de probar la skill contra un caso real y se quitaron la dependencia de subagentes y el ciclo de despliegue obligatorio.

**Principio: una skill es una guía reusable, no una crónica de cómo resolviste algo una vez.** Si no la probaste con un caso que falla sin ella, no sabés si enseña lo correcto.

## Cuándo crear una

- La técnica no era obvia y volverías a consultarla.
- El patrón aplica a varios proyectos o a varios integrantes.
- Otras personas se beneficiarían.

No crees skills para soluciones de una sola vez, convenciones específicas del proyecto, prácticas ya documentadas o reglas que se pueden automatizar con una validación. Las convenciones van en las instrucciones del proyecto.

## Estructura

- `SKILL.md` es obligatorio.
- Archivos de apoyo solo para referencias extensas o herramientas reutilizables; no para narrativas.
- Frontmatter con `name` (letras, números y guiones) y `description` en tercera persona que empiece por «Usar cuando…» e incluya disparadores y síntomas.
- Nombre de carpeta y `name` coincidentes; un namespace plano y predecible.

## Contenido

- Un resumen claro con el principio central.
- Pasos concretos y criterios de decisión.
- Un ejemplo excelente y ejecutable, no cinco mediocres.
- Tabla de referencia rápida y errores comunes si ayudan.
- Términos de búsqueda desde el inicio: síntomas, errores, herramientas.
- Sin historias personales, etiquetas genéricas ni código en diagramas.

## Probar la skill

1. **Línea base:** planteá un escenario realista sin la skill y documentá qué hace mal el agente.
2. **Versión mínima:** escribí la guía que corrige exactamente esas fallas; no agregues casos hipotéticos.
3. **Repetir:** ejecutá el mismo escenario con la skill y comprobá que ahora acierta.
4. **Cerrar atajos:** si aparece una racionalización nueva, agregá un contraejemplo explícito y volvé a probar.

Para cambios de redacción, una microprueba con varias repeticiones y un control sin guía alcanza; no reemplaza el escenario completo cuando la skill impone disciplina. Ajustá el esfuerzo al riesgo.

## Antipatrones

- Narrativa de una sesión concreta.
- Dilución en cinco lenguajes.
- Etiquetas tipo `helper1`, `step3`.
- Copiar y pegar sin adaptar al contrato del proyecto.
- Publicar varias skills sin probar ninguna.

## Entrega

Informá qué escenario usaste como línea base, qué cambió con la skill y qué limitaciones quedan. Una skill sin prueba observada es una hipótesis, no una capacidad.
