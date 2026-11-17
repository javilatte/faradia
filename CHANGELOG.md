# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Entrega por pull request**: tras el commit, en un repo con remoto la tarjeta ya no ofrece fusionar en la rama base. Tiene una pestaña «Pull request» (título, descripción y borrador) y otra «Jira» (comentario para el ticket, que se copia al portapapeles). «Redactar con IA» genera cada texto a partir del encargo, el plan, la verificación y el diff de la rama, con indicaciones opcionales. «Crear PR» sube la rama y abre la PR con `gh`, o la actualiza en commits posteriores; sin `gh`, o en GitLab y Bitbucket, sube la rama y abre la página para crearla. Los repos sin remoto siguen fusionando en local.
- Agente nuevo **Redactor de PR y Jira** (etapa «Descripción»).
- **LM Studio** como IA local, además de Ollama: Ajustes › IA local › «Detectar servidores locales» encuentra los dos y sus modelos, y el selector de modelo del chat los lista junto a los de Claude.
- «+» junto a «Repositorios» para añadir un repo con el diálogo de carpetas del sistema.

### Changed
- **Cambiar de repo ya no recarga la página**: el chat, los agentes, los ajustes y la terminal pasan al otro repo, la vista abierta se mantiene, cada repo conserva su mensaje sin enviar y los botones atrás/adelante del navegador cambian de repo.
- Al cambiar de workbench se abre el último repo usado en él (o el primero), en vez de seguir en un repo de otro workbench.
- La rama base recordada para las tareas nuevas es por repo.
- Una carpeta que no es un repo git se rechaza con una pista, y una subcarpeta cuenta como su repo.
- El chat oculta «Effort» con un modelo local.

### Fixed
- Las sesiones con modelo local ya no envían las credenciales de la cuenta de Claude al servidor local.
- Un enlace con `?token=…&p=<repo>` perdía el repo al cambiar el token por la cookie.
- Guardar la memoria de «Conocer el repo» deja de dejar un worktree y una rama `optimia/task-…` sin usar.
- Una tarea puede volver a hacer commit si una etapa posterior deja cambios nuevos.

## [2.0.1] - 2026-11-15

Correcciones para macOS.

### Fixed
- Si la terminal integrada no puede arrancar, optimia muestra el motivo en la interfaz en vez de cerrarse; un error en cualquier mensaje del WebSocket ya no tumba el servidor.
- La terminal integrada no arrancaba en macOS (`posix_spawnp failed`): `node-pty` 1.1.0 trae su `spawn-helper` para macOS sin permiso de ejecución. optimia se lo da antes de abrir la terminal y, si no puede, explica cómo arreglarlo.
- En macOS, la vigilancia de ficheros podía no ver un fichero creado justo después de su carpeta, así que el dashboard, la vista Cambios y el timeline no lo mostraban. En macOS y Windows se usa ahora la vigilancia recursiva nativa del sistema, sin los cambios dentro de carpetas que git ignora; en Linux se sigue vigilando carpeta a carpeta.

### Changed
- La CI ejecuta todas las suites también en macOS.

## [2.0.0] - 2026-11-15

Supervisión de agentes y de varios repos a la vez. Cambio incompatible con 1.x en la API local (ver "Cambios incompatibles").

### Added
- **Workbenches**: conjuntos de repos con nombre, en `~/.config/optimia/workbenches.json`. Se añaden a mano o buscando repos git bajo una carpeta, y el chat y los agentes funcionan en cualquier repo del workbench (selector en la barra superior).
- **Agentes configurables**: diez agentes por defecto (Planificador, Implementador, Verificador, Revisor, Redactor de commits, Investigador, Redactor de documentación, Depurador, Escritor de tests y Auditor), cada uno con su motor (Claude o local), modelo, effort, acceso y prompt de rol. Se pueden ajustar o crear agentes propios por proyecto o para todos (Ajustes > Agentes), y elegir qué agente hace cada etapa.
- **Pipelines nuevos**: bug (diagnosticar, implementar, verificar), tests, auditoría (solo informe) y agente propio, y una etapa de verificación que ejecuta tests, lint y build y da un veredicto. Cada tarjeta muestra qué agente y modelo hizo cada etapa.
- **Dashboard** con el estado git en vivo de cada repo, la actividad de los agentes en sus worktrees, la actividad de las últimas 24 h y los avisos recientes.
- **Diffs en vivo** (vista Cambios) de repos y worktrees de tareas: en línea o lado a lado, con contexto o el fichero entero, resaltado de sintaxis con Shiki y mapa de cambios.
- **Timeline** de ficheros, commits, ramas, lista de vigilancia, tareas, avisos y cambios huérfanos, con filtros e historial de commits.
- **Avisos pasivos**: borrados grandes, ficheros sensibles (marcados si git los commitearía), posibles secretos (reglas propias y gitleaks si está instalado; nunca se guarda el valor) y cambios en tests. Con notificaciones del sistema y modo compacto (glance).
- **Lista de vigilancia** por repo (plano 2) para ficheros que git ignora.
- **Explorador de ficheros** con vistas previas (markdown, código, imagen, audio, vídeo, PDF), portapapeles, renombrar, copiar, mover y borrar con Deshacer, y papelera restaurable.
- CI en GitHub Actions (lint, formato, unitarios, bats, e2e con Playwright y gitleaks), ESLint y Prettier, `docs/design.md` y `docs/roadmap.md`.
- `OPTIMIA_NO_OPEN=1` para arrancar sin abrir el navegador, y `--port` / `OPTIMIA_PORT` para fijar el puerto.
- Diseño según las Human Interface Guidelines de Apple para macOS: barra lateral con las vistas y los repos, barra de herramientas con el título de la vista, colores semánticos con modo claro y oscuro, "Aumentar contraste" y "Reducir transparencia", escala tipográfica del sistema, botones push, menús desplegables, controles segmentados y anillos de foco. Atajos ⌥1…⌥5 (vistas), ⌘, (Ajustes) y ⌃⌘S (barra lateral).
- Ajustes y agentes se guardan al momento, sin botón Guardar, y Ajustes se abre en el último apartado visitado.
- El compositor muestra, antes de enviar una tarea, sus etapas y qué agente y modelo hará cada una, con un enlace para cambiarlos.
- Las tarjetas de tarea muestran el pipeline con el estado de cada etapa y su agente y modelo; el chat y los informes se ven como markdown.
- "Proponer mensaje de commit" rellena el campo de commit con un mensaje Conventional Commits que sigue el idioma del repo; sin él, el tipo se deduce del tipo de tarea.
- Fusionar una tarea hace fast-forward cuando la base no ha avanzado, borra después su worktree y su rama, y la tarea pasa al grupo "Hechas".
- Effort `xhigh` y `max`.
- **Configuración global y por repo**: `~/.config/optimia/settings.json` guarda lo común (apariencia, modelo y effort, IA local, instrucciones de flujo de trabajo y lista "Prohibido") y cada repo solo lo que cambia; sus instrucciones y prohibiciones se suman a las globales. Ajustes tiene un selector "Todos los repos / Solo este repo" (también para agentes y pipelines), y cada campo dice si se hereda, con "Restablecer" y "Usar en todos los repos". Los `settings.json` antiguos se migran solos.
- **Fichero de configuración**: Ajustes > General exporta todo lo global (ajustes, instrucciones y "Prohibido" comunes, agentes globales, pipelines y avisos) a un JSON privado, sin repos ni memoria, y sin la cabecera de autenticación de la IA local salvo que se pida. Se importa arrastrándolo a la ventana: antes se ve qué cambia y se guarda una copia de la configuración actual. En una instalación nueva, una hoja de bienvenida lo ofrece.
- **Aviso de versiones nuevas**: optimia consulta el registro de npm una vez al día como mucho y avisa en la barra de herramientas con el comando para actualizar y las novedades. Se desactiva en Ajustes > General o con `OPTIMIA_NO_UPDATE_CHECK=1`.
- **Conocer este repo**: un agente de solo lectura estudia el repo (comandos, estructura, convenciones, trampas) y propone su memoria, que se guarda con un clic. El tablero vacío de un repo sin memoria lo sugiere.

### Changed
- Requiere Node 22 o posterior.
- Los modelos locales se pasan por su nombre real de Ollama, sin el alias `claude-haiku-4-5`, así que cada agente puede usar un modelo local distinto a la vez.
- `web/app.js` se divide en `web/js/project/`; las vistas nuevas son módulos ES en `web/js/app/`.

### Fixed
- Cada etapa recibe el encargo original del usuario, no solo el plan de la anterior.
- Una acción prohibida para los agentes ya no detiene la etapa: el agente recibe la denegación y sigue (la etapa solo se para si insiste).
- Abrir Ajustes ya no borra lo que se empieza a escribir mientras carga.
- El servidor MCP de tareas arranca con el mismo `node` que optimia (con nvm, `node` puede no estar en el PATH).
- El timeline ignora los ficheros temporales de escrituras atómicas y editores.

### Security
- La API local y el WebSocket comprueban el `Host` (contra DNS rebinding), el `Origin` (contra CSRF) y un token por ejecución (cabecera o cookie `SameSite=Strict`).
- optimia ya no escribe en el repo: los permisos de sus sesiones (lista "Prohibido" incluida) van en `.optimia/claude-settings*.json` y se pasan con `claude --settings`. Antes reescribía `.claude/settings.json` (configuración compartida del proyecto, sustituyendo su lista `deny`) y lo copiaba a los worktrees, donde acababa en los commits. Un `.claude/settings.json` generado por versiones anteriores, sin seguimiento en git, se borra solo.
- `.optimia` se excluye en `.git/info/exclude` en vez de editar el `.gitignore` del repo, y el enlace `.codegraph` solo se crea si se activa CodeGraph.
- Los agentes de las tareas no heredan los conectores MCP de la cuenta de claude.ai del usuario (Gmail, Drive, Slack…): solo el MCP de optimia y el `.mcp.json` del repo (`--strict-mcp-config`).
- Las etapas de solo lectura bloquean las herramientas de edición explícitamente.
- El commit de una tarea respeta `.gitignore`: un fichero ignorado solo entra si se marca en la tarjeta.

### Cambios incompatibles
- Los clientes de la API tienen que enviar `X-Optimia-Token`: el token sale en el enlace que imprime optimia al arrancar.
- La API de un proyecto concreto vive en `/api/projects/:id/*`; `/api/*` sigue apuntando al proyecto de arranque.

## [1.0.1] - 2026-11-01

### Added
- Registro por proyecto en `.optimia/logs/optimia.log` (JSON por línea, rotado a 5 MB): peticiones a la API, etapas de tareas, permisos denegados, cambios en archivos, commits, fusiones, preguntas y respuestas (texto recortado a 500 caracteres).
- Pestaña "Registro" en Ajustes para consultarlo, con filtros por cambios en archivos, preguntas y respuestas.

### Fixed
- Fusionar una tarea ya no exige cambiar la rama del checkout principal: se hace en un worktree temporal sobre la rama base.

## [1.0.0] - 2026-10-31

Reescritura completa del flujo de optimia. Cambio incompatible con versiones anteriores.

### Added
- Interfaz web local: `optimia` arranca un servidor Node (HTTP + WebSocket) y abre el navegador en vez de lanzar un wizard de terminal.
- Chat en vivo contra un proceso `claude` CLI real (long-lived, NDJSON por WebSocket), con soporte de multi-turno dentro de la misma sesión.
- Puente de IA local vía Ollama (endpoint `/v1/messages` compatible con la Anthropic Messages API).
- Soporte de imágenes/capturas en el chat (paste y drag-and-drop), enviadas como bloques de imagen inline al proceso `claude`.
- Panel de Settings en la web: modelo/effort de Claude, IA local, Instructions, Memory (`.optimia/memory.md`), No-go (patrones de `permissions.deny`), y gestión de Skills (`.claude/skills/`).
- Migración automática de las preferencias existentes de un proyecto (`.optimia/system-prompt.md`, `permissions.deny` de `.claude/settings.json`) a los nuevos campos de Settings, con vista previa antes de aplicar.
- Panel kanban de tareas para agentes de codificación, con worktrees de git por tarea.
- `bin/optimia` reescrito como launcher Node delgado: crea `.optimia/`, ofrece activar/inicializar/sincronizar CodeGraph, y arranca el servidor.

### Removed
- Soporte para opencode, Gemini CLI, GitHub Copilot CLI y `headroom`. Solo quedan **Claude Code** e **IA local** (Ollama).
- El wizard interactivo de preguntas al arrancar (`ask_quick_questions`) y los subcomandos `tools`/`config`/`repos`/`agents` de la CLI — la configuración ahora vive en la interfaz web.
- `openwiki` y la generación de `AGENTS.md`/`GEMINI.md`/`security.md` para otras herramientas.

### Changed
- `optimia` ya no usa la API de Claude directamente: siempre orquesta el CLI real `claude` como subproceso.
