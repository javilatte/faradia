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

Un repo abierto desde un workbench excluye `.optimia` en `.git/info/exclude`, para no
tocar el `.gitignore` del usuario.

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
  denegación y un hook de git que se activa por variables de entorno.

## Pruebas

- `test/unit`: `node --test`, con repos git temporales reales y XDG apuntando a
  carpetas temporales (los tests nunca tocan `~/.config`).
- `test/*.bats`: el lanzador y la API HTTP reales.
- `test/e2e`: Playwright contra un `claude` simulado
  (`test/e2e/fixtures/bin/claude`) que habla stream-json, registra sus argumentos y
  escribe un fichero en las etapas que editan.
