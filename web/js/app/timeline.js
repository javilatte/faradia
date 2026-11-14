// Timeline: feed cronologico de todo lo que pasa en los repos del workbench activo
// (ficheros, commits, ramas, lista de vigilancia, agentes, avisos, cambios
// huerfanos), con filtros, y el historial de commits de cada repo.

import { api } from './api.js';
import { h, clear, formatBytes } from './dom.js';
import { on } from './events.js';
import { registerView } from './views.js';
import { activeRepos } from './workbenches.js';
import { openChanges } from './changes.js';

const KINDS = {
  files: 'Ficheros',
  commit: 'Commits',
  branch: 'Ramas',
  watch: 'Vigilancia',
  agent: 'Agentes',
  signal: 'Avisos',
  orphan: 'Huérfanos'
};
// Etiqueta de una entrada suelta (los filtros usan el plural de KINDS).
const KIND_ONE = {
  files: 'Ficheros',
  commit: 'Commit',
  branch: 'Rama',
  watch: 'Vigilancia',
  agent: 'Agente',
  signal: 'Aviso',
  orphan: 'Huérfano'
};
const CHANGE_LABEL = { created: 'creado', modified: 'modificado', deleted: 'borrado' };
const STATUS_LABEL = {
  in_progress: 'en curso',
  pending: 'pendiente',
  awaiting_input: 'esperando tu respuesta',
  ready_to_test: 'lista para revisar'
};

const filters = { projectId: '', kinds: new Set(Object.keys(KINDS)), ext: '', since: '', until: '' };
let entries = [];
let root = null;
let history = { projectId: '', commits: [], loading: false, done: false };

function query() {
  const q = new URLSearchParams({ limit: '300' });
  if (filters.projectId) q.set('projectId', filters.projectId);
  if (filters.kinds.size !== Object.keys(KINDS).length) q.set('kind', [...filters.kinds].join(','));
  if (filters.ext) q.set('ext', filters.ext);
  if (filters.since) q.set('since', new Date(`${filters.since}T00:00:00`).toISOString());
  if (filters.until) q.set('until', new Date(`${filters.until}T23:59:59`).toISOString());
  return `/api/timeline?${q}`;
}

async function load() {
  entries = (await api.get(query())).entries;
  render();
}

function matches(e) {
  if (filters.projectId && e.projectId !== filters.projectId) return false;
  if (!activeRepos().some((r) => r.projectId === e.projectId)) return false;
  if (!filters.kinds.has(e.kind)) return false;
  if (filters.ext) {
    const exts = filters.ext.split(',').map((x) => x.trim().replace(/^\./, '').toLowerCase());
    const paths = e.paths || (e.path ? [e.path] : []);
    if (!paths.some((p) => exts.includes(p.split('.').pop().toLowerCase()))) return false;
  }
  return !filters.until; // con fecha final fija, lo nuevo no entra
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

function pathLink(e, p) {
  return h(
    'button',
    {
      class: 'link-button tl-path',
      onclick: () => openChanges({ projectId: e.projectId, taskId: e.taskId || null, path: p })
    },
    p
  );
}

function entryBody(e) {
  switch (e.kind) {
    case 'files':
      return [
        h('span', {}, `${e.count} ${e.count === 1 ? 'fichero cambiado' : 'ficheros cambiados'}`),
        e.taskId ? h('span', { class: 'tl-agent' }, ' · agente') : null,
        h(
          'div',
          { class: 'tl-paths' },
          e.paths.slice(0, 8).map((p) => pathLink(e, p)),
          e.paths.length > 8 ? h('span', { class: 'muted' }, ` y ${e.count - 8} más`) : null
        )
      ];
    case 'commit':
      return [
        h(
          'button',
          {
            class: 'link-button tl-commit',
            onclick: () =>
              openChanges({
                projectId: e.projectId,
                ref: e.sha,
                commit: { short: e.sha.slice(0, 7), subject: e.subject }
              })
          },
          h('code', {}, e.sha.slice(0, 7)),
          ` ${e.subject}`
        ),
        h('span', { class: 'muted' }, ` · ${e.author}${e.branch ? ` en ${e.branch}` : ''}`)
      ];
    case 'branch':
      return h('span', {}, `Rama: ${e.from || '—'} → ${e.to}`);
    case 'watch':
      return [
        pathLink(e, e.path),
        h('span', {}, ` ${CHANGE_LABEL[e.change] || e.change}`),
        e.size !== null && e.size !== undefined ? h('span', { class: 'muted' }, ` · ${formatBytes(e.size)}`) : null
      ];
    case 'agent':
      return h(
        'span',
        {},
        `Tarea «${e.title}»${e.stage ? ` · ${e.stage}` : ''}: ${STATUS_LABEL[e.status] || e.status}${e.error ? ` — ${e.error}` : ''}`
      );
    case 'signal':
      return [
        h(
          'span',
          { class: `tl-sev sev-${e.severity}` },
          e.severity === 'high' ? 'Alto' : e.severity === 'medium' ? 'Medio' : 'Info'
        ),
        h('span', {}, ` ${e.message}`),
        e.path ? [' · ', pathLink(e, e.path)] : null
      ];
    case 'orphan':
      return h(
        'span',
        {},
        `${e.files} ${e.files === 1 ? 'fichero' : 'ficheros'} sin commitear y sin tocar desde hace ${e.idleMinutes} min`
      );
    default:
      return h('span', {}, e.kind);
  }
}

function renderFeed() {
  const feed = h('ol', { class: 'tl-feed', 'aria-label': 'Timeline' });
  if (!entries.length) {
    feed.append(h('li', { class: 'empty-state' }, 'Nada que mostrar con estos filtros todavía.'));
    return feed;
  }
  let lastDay = null;
  for (const e of entries) {
    const day = dayLabel(e.at);
    if (day !== lastDay) {
      feed.append(h('li', { class: 'tl-day' }, day));
      lastDay = day;
    }
    feed.append(
      h(
        'li',
        { class: `tl-entry kind-${e.kind}`, dataset: { id: e.id } },
        h(
          'time',
          { datetime: e.at },
          new Date(e.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
        ),
        h('span', { class: 'tl-kind' }, KIND_ONE[e.kind] || e.kind),
        h('span', { class: 'tl-repo' }, e.name || ''),
        h('div', { class: 'tl-body' }, entryBody(e))
      )
    );
  }
  return feed;
}

function renderFilters() {
  const repos = activeRepos();
  return h(
    'div',
    { class: 'tl-filters' },
    h(
      'select',
      {
        'aria-label': 'Repositorio',
        onchange: (e) => {
          filters.projectId = e.target.value;
          load();
        }
      },
      h('option', { value: '' }, 'Todos los repos'),
      repos.map((r) => h('option', { value: r.projectId, selected: r.projectId === filters.projectId }, r.name))
    ),
    h(
      'div',
      { class: 'tl-chips', role: 'group', 'aria-label': 'Tipos' },
      Object.entries(KINDS).map(([k, label]) =>
        h(
          'button',
          {
            class: `tl-chip${filters.kinds.has(k) ? ' active' : ''}`,
            'aria-pressed': String(filters.kinds.has(k)),
            onclick: () => {
              if (filters.kinds.has(k)) filters.kinds.delete(k);
              else filters.kinds.add(k);
              load();
            }
          },
          label
        )
      )
    ),
    h('input', {
      type: 'text',
      placeholder: 'Extensiones: js, css',
      'aria-label': 'Filtrar por extension',
      value: filters.ext,
      onchange: (e) => {
        filters.ext = e.target.value.trim();
        load();
      }
    }),
    h(
      'label',
      { class: 'tl-date' },
      'Desde ',
      h('input', { type: 'date', value: filters.since, onchange: (e) => ((filters.since = e.target.value), load()) })
    ),
    h(
      'label',
      { class: 'tl-date' },
      'Hasta ',
      h('input', { type: 'date', value: filters.until, onchange: (e) => ((filters.until = e.target.value), load()) })
    )
  );
}

async function loadHistory(more = false) {
  if (!history.projectId || history.loading) return;
  history.loading = true;
  const q = new URLSearchParams({
    projectId: history.projectId,
    limit: '30',
    skip: String(more ? history.commits.length : 0)
  });
  try {
    const { commits } = await api.get(`/api/monitor/commits?${q}`);
    history.commits = more ? [...history.commits, ...commits] : commits;
    history.done = commits.length < 30;
  } finally {
    history.loading = false;
  }
  render();
}

function renderHistory() {
  const repos = activeRepos();
  if (!history.projectId && repos[0]) {
    history.projectId = repos[0].projectId;
    loadHistory();
  }
  return h(
    'aside',
    { class: 'tl-history', 'aria-label': 'Historial de commits' },
    h(
      'div',
      { class: 'tl-history-head' },
      h('h3', {}, 'Commits'),
      h(
        'select',
        {
          'aria-label': 'Repo del historial',
          onchange: (e) => {
            history = { projectId: e.target.value, commits: [], loading: false, done: false };
            loadHistory();
          }
        },
        repos.map((r) => h('option', { value: r.projectId, selected: r.projectId === history.projectId }, r.name))
      )
    ),
    h(
      'ol',
      { class: 'tl-commits' },
      history.commits.map((c) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              class: 'tl-commit-item',
              onclick: () =>
                openChanges({
                  projectId: history.projectId,
                  ref: c.sha,
                  commit: { short: c.short, subject: c.subject }
                })
            },
            h('span', { class: 'tl-commit-subject' }, c.subject),
            h(
              'span',
              { class: 'muted tl-commit-meta' },
              h('code', {}, c.short),
              ` · ${c.author} · ${new Date(c.date).toLocaleDateString('es-ES')} · `,
              h('span', { class: 'add' }, `+${c.added}`),
              ' ',
              h('span', { class: 'del' }, `−${c.removed}`)
            )
          )
        )
      )
    ),
    history.done || !history.commits.length ? null : h('button', { onclick: () => loadHistory(true) }, 'Cargar más')
  );
}

function render() {
  if (!root) return;
  clear(root);
  root.append(
    h('div', { class: 'view-header' }, h('h2', {}, 'Timeline'), h('span', { class: 'live-badge' }, 'EN VIVO')),
    renderFilters(),
    h('div', { class: 'tl-layout' }, renderFeed(), renderHistory())
  );
}

on('timeline_entry', ({ entry }) => {
  if (!root) return;
  // Un commit nuevo tambien entra en el historial del repo que se esta viendo.
  if (entry.kind === 'commit' && entry.projectId === history.projectId) loadHistory();
  if (!matches(entry)) return;
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i === -1) entries.unshift(entry);
  else entries[i] = entry;
  render();
});

registerView('timeline', {
  label: 'Timeline',
  order: 30,
  mount(el) {
    root = el;
  },
  show() {
    load().catch((err) => root && clear(root).append(h('p', { class: 'error-text' }, err.message)));
  }
});
