# optimia: roadmap

## Hecho en 2.0

- Workbenches y chat y agentes en cualquier repo.
- Catálogo de agentes con modelo por agente, pipelines (código, bug, tests,
  documentación, auditoría, agente propio) y etapa de verificación.
- Vigilancia de solo lectura (planos 1 y 2), dashboard, diffs en vivo, timeline,
  avisos, métricas, notificaciones y modo compacto.
- Explorador de ficheros con vistas previas, portapapeles, deshacer y papelera.
- Seguridad de la API local (Host, Origin y token), CI con lint, formato, tests
  unitarios, bats, e2e y gitleaks.

## Siguiente

- **Atajos de teclado** para cambiar de vista, de repo y de fichero en Cambios.
- **Búsqueda** en el explorador y en el timeline (por nombre y por contenido).
- **Comentarios en el diff** que se envían al agente de la tarea como respuesta.
- **Varios proyectos en la misma pestaña** sin recargar: migrar la vista de proyecto
  (`web/js/project/`) a módulos ES.
- **Ventanas separadas** para la consola de un agente y para el diff de una tarea.
- **Windows**: probar y documentar la vigilancia en NTFS y con WSL.
- **Más motores**: Codex y OpenCode como motores de agente, igual que Claude y Ollama.

## Ideas

- Presupuesto de coste por tarea y por agente, con aviso al acercarse.
- Reglas de avisos propias (patrones y gravedad) por repo.
- Exportar el timeline como informe de la jornada.
