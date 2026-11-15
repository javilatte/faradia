# optimia: diseño

Este documento explica cómo está hecho optimia 2.0: las piezas, cómo se comunican y
las decisiones que no son evidentes leyendo el código.

## Visión general

```
navegador ──HTTP/WS──▶ servidor (server/index.js)
                         ├── seguridad: Host, Origin y token por ejecución
                         ├── ProjectRegistry ──▶ ProjectRuntime (uno por repo, bajo demanda)
                         │                        ├── API del proyecto (runtime/projectApp.js)
                         │                        ├── sesiones de chat y de tareas (`claude` -p)
                         │                        └── terminal (PTY)
                         ├── workbenches (store/workbenchStore.js)
                         ├── MonitorService ──▶ TreeWatcher por repo y por worktree de tarea
                         │        │
                         │        ├──▶ Timeline (monitor/timeline.js)
                         │        ├──▶ SignalEngine (monitor/signals.js)
                         │        └──▶ Metrics (monitor/metrics.js)
                         └── explorador y papelera (fs/)
```

Todo es Node sin framework. El frontend no tiene paso de build: la vista de proyecto
son scripts clásicos (`web/js/project/`), y las vistas nuevas son módulos ES
(`web/js/app/`).

## Multiproyecto

Antes había un único `projectRoot` capturado en el servidor. Ahora `start()` solo
enruta: cada proyecto tiene un `ProjectRuntime` con sus sesiones, su `mcp.json`, su
registro y su API. La API de un proyecto vive en `/api/projects/:id/*`. El id es un
sha1 de la ruta real, así que se mantiene entre reinicios. `/api/*` sin id sigue
apuntando al proyecto de arranque, por compatibilidad.

La vista de proyecto elige su proyecto con `?p=<id>` en la URL. Cambiar de repo
recarga la vista, porque los scripts clásicos cargan su estado al arrancar y así es
más fiable que intentar reiniciarlos en caliente. Todos los mensajes del WebSocket
llevan `projectId`, y cada vista filtra los suyos.

optimia no deja rastro en el repo: `.optimia` se excluye en `.git/info/exclude` (no se
toca el `.gitignore`), y los permisos de Claude Code de sus propias sesiones van en
`.optimia/claude-settings.json` (chat y terminal: permisos base, modo y lista
"Prohibido") y `.optimia/claude-settings-agents.json` (agentes: solo la lista
"Prohibido" y la aprobación del MCP), que se pasan con `claude --settings`. Así el
`.claude/` del proyecto, que es configuración compartida del equipo, no se modifica, y
sus reglas `deny` siguen sumándose a las de optimia.

## Configuración por capas

Para que el flujo de trabajo sea el mismo en todos los repos y cada uno conserve lo
suyo, los ajustes tienen dos capas (`server/store/settingsStore.js`):

- **Global**, en `~/.config/optimia/settings.json`: apariencia, modelo y effort, IA
  local, instrucciones comunes y lista "Prohibido".
- **Repo**, en `.optimia/settings.json` (versión 2): solo los campos de IA que el repo
  cambia, sus instrucciones y prohibiciones propias (se suman a las globales) y los
  permisos aprobados en sus tareas.

`loadSettings()` devuelve los ajustes efectivos, que son los que usan las sesiones: las
instrucciones van en dos apartados (todos los repos y este repo, que manda) y la lista
"Prohibido" es la unión de las dos. `PATCH /api/settings {scope}` cambia una capa; en
la del repo, un valor igual al global deja de ser un cambio, `reset` vuelve a heredar
y `promote` lo pasa a todos. Los agentes y el mapa de etapas ya tenían las mismas
capas (por defecto → global → repo), y en Ajustes comparten el mismo selector de
ámbito.

El conocimiento propio de cada repo es su memoria (`.optimia/memory.md`). La tarea
interna `onboard` ("Conocer este repo") la propone con un agente de solo lectura, y
`POST /api/tasks/:id/apply-memory` la guarda (la anterior queda en `memory.prev.md`).

Un `settings.json` antiguo (copia completa por repo) se migra al leerlo: solo queda
como cambio del repo lo que difiere de los valores por defecto.

## Agentes

- `server/agents/catalog.js`: diez agentes por defecto más ficheros `.md` con
  frontmatter, en el ámbito global (`~/.config/optimia/agents`) o en el de proyecto
  (`.optimia/agents`). Se combinan campo a campo: por defecto < global < proyecto.
- `server/bridge/taskStages.js`: la tabla `STAGES`, con el acceso, el agente por
  defecto y si la etapa puede preguntar, y la tabla `TASK_TYPES` con los pipelines.
  `decideAfterStage` sigue siendo una función pura: recibe el resultado de una etapa
  y devuelve el parche de la tarea y la siguiente etapa.
- `server/agents/stageMap.js`: qué agente hace cada etapa (configurable). Si el
  agente de una etapa opcional (verify) está desactivado, esa etapa se salta.
- `buildSessionOptions(..., agent)`: el agente decide el motor, el modelo, el effort y
  el prompt de rol. Para modelos locales se pasa el nombre real del modelo: el CLI de
  `claude` 2.1.x lo reenvía tal cual a `ANTHROPIC_BASE_URL`, cosa que se verificó con
  un servidor falso. Por eso desapareció el alias único de Ollama y varios agentes
  pueden usar modelos locales distintos a la vez.

## Vigilancia

**Por qué no se usa `fs.watch` recursivo.** En Linux, el modo recursivo de Node pone
un watch de inotify en cada subcarpeta, `node_modules` incluido. Con varios repos
agota `max_user_watches`. `TreeWatcher` vigila carpeta a carpeta solo:

- las carpetas con ficheros versionados o nuevos no ignorados (`git ls-files`),
- las carpetas fijas de la lista de vigilancia (`dist/**` → `dist`),
- los metadatos de git (`HEAD`, `index`, `refs/heads`).

Cuando aparece una carpeta nueva, se vigila si git no la ignora, y se informa de los
ficheros que ya contenga, porque los que se crearon antes de poner el watch no
generaron evento. Los eventos se agrupan durante 300 ms.

**Flujo de los diffs en vivo.**

1. Un agente escribe en su worktree.
2. `TreeWatcher` emite un lote, `MonitorService` emite `activity` y, 400 ms después,
   recalcula el estado git del worktree y emite `worktree_state`.
3. El servidor reenvía ambos por el WebSocket como `monitor_*`.
4. La vista Cambios, si está mirando ese worktree, vuelve a pedir el diff
   (`/api/monitor/diff`, solo lectura) y lo repinta conservando el scroll.

**Bus de eventos.** `MonitorService` es un `EventEmitter` con los eventos `state`,
`activity`, `watch_event` y `worktree_state`. El servidor conecta a esos eventos el
timeline, los avisos, las métricas y el WebSocket.

## Avisos

`SignalEngine` es pasivo: nunca bloquea nada. Para los secretos solo escanea lo que
git commitearía (`git check-ignore`). Un `.env` ignorado contiene secretos por
diseño, así que avisar de él cada vez solo sería ruido. Si un fichero sensible **no**
está ignorado, el aviso lo dice expresamente y sube a gravedad alta. El valor de un
secreto no sale nunca del escáner: solo se guardan la regla y `fichero:línea`. Los
avisos se deduplican durante 10 minutos.

## Seguridad

- El servidor escucha en `127.0.0.1`, comprueba el `Host` (contra DNS rebinding), el
  `Origin` (contra CSRF) y un token por ejecución. El token va en una cabecera o en
  una cookie `SameSite=Strict` con el nombre del puerto, para que dos optimia no se
  pisen la cookie.
- El explorador resuelve toda ruta dentro del repo (también siguiendo enlaces
  simbólicos), no toca `.git` ni `.optimia`, nunca sobrescribe y sirve los ficheros
  en bruto con una CSP `sandbox`.
- Los agentes no pueden hacer commit, push, merge ni rebase: lo impiden una lista de
  denegación y un hook de git que se activa por variables de entorno. Una acción
  denegada por esa política no para la etapa: el agente recibe la denegación y sigue
  por otro camino; la etapa solo se detiene si insiste (5 veces). Las herramientas
  que sí se pueden aprobar paran la etapa y se aprueban desde la tarjeta.
- Las etapas de solo lectura bloquean `Edit`, `MultiEdit`, `Write` y `NotebookEdit`
  con `--disallowedTools`, que gana a cualquier permiso aprobado.
- Los agentes de las tareas usan `--strict-mcp-config`: solo el MCP de optimia y el
  `.mcp.json` del repo, sin los conectores de la cuenta de claude.ai del usuario.
- El commit de una tarea respeta `.gitignore`: un fichero ignorado que generó el
  agente solo entra si el usuario lo marca en la tarjeta.

## Pruebas

- `test/unit`: `node --test`, con repos git temporales reales y XDG apuntando a
  carpetas temporales (los tests nunca tocan `~/.config`).
- `test/*.bats`: el lanzador y la API HTTP reales.
- `test/e2e`: Playwright contra un `claude` simulado
  (`test/e2e/fixtures/bin/claude`) que habla stream-json, registra sus argumentos y
  escribe un fichero en las etapas que editan.

## Diseño de la interfaz

La interfaz sigue las Human Interface Guidelines de Apple para macOS:

- **Ventana**: barra lateral (material translúcido) con el workbench, las vistas y los
  repos, y una barra de herramientas con el título de la vista y sus acciones. La
  barra lateral tiene una sola selección: la vista; el repo abierto se marca con ✓.
- **Color**: tokens semánticos (`--label`, `--secondary-label`, `--separator`,
  `--accent`, `--selection-bg`...) definidos en `web/styles.css`, con variante oscura,
  "Aumentar contraste" (`prefers-contrast: more`) y "Reducir transparencia"
  (`prefers-reduced-transparency`). El texto cumple un contraste mínimo de 4,5:1; los
  estados no dependen solo del color (llevan texto o símbolo).
- **Tipografía**: la del sistema con la escala de macOS (cuerpo de 13 pt, mínimo 10).
- **Controles**: `web/macos.css` unifica botones push (un único botón principal por
  vista), menús desplegables, campos, controles segmentados y anillos de foco.
- **Ajustes**: se aplican al momento, sin botón Guardar, y se abren en el último
  apartado visitado.
