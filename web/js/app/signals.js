// Avisos pasivos: notificaciones del sistema (API de Notificaciones del navegador)
// y Ajustes > Supervision: reglas, umbrales, que avisos notificar, minutos para
// cambios huerfanos y la lista de vigilancia (plano 2) del repo actual.

import { api } from './api.js';
import { h, clear, toast } from './dom.js';
import { on } from './events.js';
import { currentProjectId, repoByProject } from './workbenches.js';

export const RULE_LABEL = {
  largeDelete: 'Borrados grandes',
  sensitive: 'Ficheros sensibles',
  secret: 'Posibles secretos',
  tests: 'Cambios en tests',
  orphan: 'Cambios huérfanos'
};
const NOTIFY_KEY = {
  largeDelete: 'largeDelete',
  sensitive: 'sensitive',
  secret: 'secrets',
  tests: 'tests',
  orphan: 'orphan'
};

let prefs = null;
const recent = [];
const listeners = new Set();

export function recentSignals() {
  return recent;
}
export function onSignal(fn) {
  listeners.add(fn);
}

async function loadPrefs() {
  prefs = await api.get('/api/preferences');
  return prefs;
}

function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      location.hash = '#/timeline';
    };
  } catch {
    /* algunos navegadores solo permiten notificaciones desde un service worker */
  }
}

on('signal', ({ signal }) => {
  recent.unshift(signal);
  if (recent.length > 100) recent.pop();
  for (const fn of listeners) fn(signal);
  const key = NOTIFY_KEY[signal.rule];
  if (prefs?.signals.notify[key])
    notify(`optimia · ${signal.name}`, signal.message, `${signal.projectId}:${signal.rule}:${signal.path || ''}`);
});

on('timeline_entry', ({ entry }) => {
  if (entry.kind !== 'orphan' || !prefs?.signals.notify.orphan) return;
  notify(
    `optimia · ${entry.name}`,
    `${entry.files} ficheros sin commitear y sin tocar desde hace ${entry.idleMinutes} min`,
    `${entry.projectId}:orphan`
  );
});

// ---- Ajustes > Supervision ----

function permissionLabel() {
  if (!('Notification' in window)) return 'Este navegador no admite notificaciones.';
  return {
    granted: 'Notificaciones del sistema permitidas.',
    denied: 'Notificaciones bloqueadas: permitelas en los ajustes del navegador para este sitio.',
    default: 'Todavía no has permitido las notificaciones.'
  }[Notification.permission];
}

async function save(patch, message = 'Guardado') {
  try {
    prefs = await api.put('/api/preferences', patch);
    toast(message);
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
  render();
}

async function render() {
  const host = document.getElementById('monitor-pane');
  if (!host || !prefs) return;
  clear(host);
  const s = prefs.signals;

  host.append(
    h('h3', { class: 'wb-h' }, 'Notificaciones del sistema'),
    h(
      'div',
      { class: 'sig-row' },
      h('span', { class: 'muted' }, permissionLabel()),
      'Notification' in window && Notification.permission === 'default'
        ? h(
            'button',
            { class: 'primary', onclick: async () => (await Notification.requestPermission(), render()) },
            'Permitir notificaciones'
          )
        : null
    ),
    h('h3', { class: 'wb-h' }, 'Reglas'),
    h(
      'table',
      { class: 'sig-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Aviso'), h('th', {}, 'Detectar'), h('th', {}, 'Notificar'))),
      h(
        'tbody',
        {},
        Object.entries(RULE_LABEL).map(([rule, label]) => {
          const detectKey = { sensitive: 'sensitive', secret: 'secrets', tests: 'tests' }[rule];
          const notifyKey = NOTIFY_KEY[rule];
          return h(
            'tr',
            {},
            h('td', {}, label),
            h(
              'td',
              {},
              detectKey
                ? h('input', {
                    type: 'checkbox',
                    checked: s[detectKey],
                    'aria-label': `Detectar ${label}`,
                    onchange: (e) => save({ signals: { [detectKey]: e.target.checked } })
                  })
                : h('span', { class: 'muted' }, 'siempre')
            ),
            h(
              'td',
              {},
              h('input', {
                type: 'checkbox',
                checked: s.notify[notifyKey],
                'aria-label': `Notificar ${label}`,
                onchange: (e) => save({ signals: { notify: { [notifyKey]: e.target.checked } } })
              })
            )
          );
        })
      )
    ),
    h('h3', { class: 'wb-h' }, 'Umbrales'),
    h(
      'form',
      {
        class: 'sig-thresholds',
        onsubmit: (e) => {
          e.preventDefault();
          const f = e.target.elements;
          save({
            orphanMinutes: Number(f.orphan.value),
            signals: { largeDeleteLines: Number(f.lines.value), largeDeleteFiles: Number(f.files.value) }
          });
        }
      },
      h(
        'label',
        {},
        'Borrado grande a partir de ',
        h('input', { name: 'lines', type: 'number', min: 1, value: s.largeDeleteLines }),
        ' líneas'
      ),
      h(
        'label',
        {},
        'o de ',
        h('input', { name: 'files', type: 'number', min: 1, value: s.largeDeleteFiles }),
        ' ficheros'
      ),
      h(
        'label',
        {},
        'Cambios huérfanos tras ',
        h('input', { name: 'orphan', type: 'number', min: 1, value: prefs.orphanMinutes }),
        ' minutos sin tocar'
      ),
      h('button', { type: 'submit' }, 'Guardar umbrales')
    )
  );

  const projectId = currentProjectId();
  const repo = repoByProject(projectId);
  host.append(
    h('h3', { class: 'wb-h' }, `Lista de vigilancia de ${repo?.name || 'este repo'}`),
    h(
      'p',
      { class: 'muted agents-help' },
      'Ficheros que se vigilan aunque git los ignore (secretos, configuraciones generadas, builds). Un patrón por línea, con la sintaxis de .gitignore: .env, dist/**, *.log.'
    )
  );
  try {
    const { patterns } = await api.get(`/api/monitor/watchlist?projectId=${projectId}`);
    const area = h(
      'textarea',
      { class: 'agent-prompt', rows: 6, 'aria-label': 'Patrones de la lista de vigilancia' },
      patterns.join('\n')
    );
    host.append(
      area,
      h(
        'button',
        {
          onclick: async () => {
            try {
              await api.put('/api/monitor/watchlist', { projectId, patterns: area.value.split('\n') });
              toast('Lista de vigilancia guardada');
            } catch (err) {
              toast(err.message, { kind: 'error' });
            }
          }
        },
        'Guardar lista'
      )
    );
  } catch {
    host.append(
      h('p', { class: 'muted' }, 'Este repo no está en el workbench activo: la lista se edita cuando lo está.')
    );
  }
}

document.querySelector('.settings-nav-item[data-pane="monitor"]')?.addEventListener('click', async () => {
  await loadPrefs();
  render();
});

loadPrefs().catch(() => {});
