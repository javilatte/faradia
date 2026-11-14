// Dashboard: una tarjeta por repo del workbench activo con su estado git en vivo
// (rama, ahead/behind, cambios, lineas, ultimo commit) y la actividad reciente,
// incluida la de los agentes en los worktrees de sus tareas.

import { api } from './api.js';
import { h, clear, timeAgo } from './dom.js';
import { on } from './events.js';
import { registerView } from './views.js';
import { openProject, onWorkbenchesChange } from './workbenches.js';
import { openChanges } from './changes.js';

const ACTIVE_MS = 60 * 1000;
const repos = new Map(); // projectId -> snapshot del monitor
let root = null;
let compact = localStorage.getItem('optimia:dashboard-compact') === '1';
let tick = null;

async function load() {
  const { repos: list } = await api.get('/api/monitor/state');
  repos.clear();
  for (const r of list) repos.set(r.projectId, r);
  render();
}

function isActive(iso) {
  return iso && Date.now() - Date.parse(iso) < ACTIVE_MS;
}

function stat(label, value, cls = '') {
  return h('span', { class: `dash-stat ${cls}`, title: label }, h('b', {}, String(value)), ` ${label}`);
}

function renderCard(repo) {
  const s = repo.state;
  const agentActive = repo.worktrees.some((w) => isActive(w.lastActivity));
  const card = h('article', {
    class: `dash-card${isActive(repo.lastActivity) || agentActive ? ' active' : ''}${s?.dirty ? ' dirty' : ''}`,
    dataset: { project: repo.projectId }
  });
  card.append(
    h(
      'header',
      { class: 'dash-card-head' },
      h('span', { class: 'dash-pulse', title: 'Actividad en el último minuto' }),
      h('h3', {}, repo.name),
      s ? h('span', { class: 'dash-branch' }, s.detached ? 'HEAD separada' : s.branch || '—') : null,
      s && (s.ahead || s.behind)
        ? h('span', { class: 'dash-ab', title: 'Por delante / por detrás del remoto' }, `↑${s.ahead} ↓${s.behind}`)
        : null
    )
  );
  if (!repo.git) {
    card.append(h('p', { class: 'muted' }, 'No es un repo git: solo se vigilan sus ficheros.'));
    return card;
  }
  if (!s) {
    card.append(h('p', { class: 'muted' }, 'Leyendo estado…'));
    return card;
  }
  const c = s.counts;
  card.append(
    h(
      'div',
      { class: 'dash-stats' },
      s.dirty
        ? [
            c.modified ? stat('modificados', c.modified) : null,
            c.staged ? stat('en stage', c.staged) : null,
            c.untracked ? stat('nuevos', c.untracked) : null,
            c.conflicts ? stat('conflictos', c.conflicts, 'danger') : null,
            h(
              'span',
              { class: 'dash-lines' },
              h('span', { class: 'add' }, `+${s.lines.added}`),
              ' ',
              h('span', { class: 'del' }, `−${s.lines.removed}`)
            )
          ]
        : h('span', { class: 'muted' }, 'Sin cambios')
    )
  );
  if (!compact) {
    if (s.lastCommit) {
      card.append(
        h(
          'p',
          { class: 'dash-commit', title: `${s.lastCommit.sha.slice(0, 8)} · ${s.lastCommit.author}` },
          h('span', { class: 'muted' }, `${timeAgo(s.lastCommit.date)} · `),
          s.lastCommit.subject
        )
      );
    }
    if (s.dirty) {
      const files = s.files.slice(0, 5);
      card.append(
        h(
          'ul',
          { class: 'dash-files' },
          files.map((f) =>
            h(
              'li',
              {},
              h('span', { class: `dash-fstatus st-${f.status}` }, f.status[0].toUpperCase()),
              h(
                'button',
                {
                  class: 'link-button dash-file',
                  onclick: () => openChanges({ projectId: repo.projectId, path: f.path })
                },
                f.path
              )
            )
          ),
          s.files.length > files.length ? h('li', { class: 'muted' }, `y ${s.files.length - files.length} más`) : null
        )
      );
    }
    for (const wt of repo.worktrees) {
      const ws = wt.state;
      card.append(
        h(
          'div',
          { class: `dash-worktree${isActive(wt.lastActivity) ? ' active' : ''}` },
          h('span', { class: 'dash-pulse' }),
          h('span', { class: 'dash-wt-title' }, `Agente: ${wt.title || wt.taskId.slice(0, 8)}`),
          ws
            ? h('span', { class: 'muted' }, ` ${ws.files.length} ficheros · +${ws.lines.added} −${ws.lines.removed}`)
            : null,
          h(
            'button',
            { class: 'link-button', onclick: () => openChanges({ projectId: repo.projectId, taskId: wt.taskId }) },
            'Ver en vivo'
          )
        )
      );
    }
  }
  card.append(
    h(
      'footer',
      { class: 'dash-card-foot' },
      h('span', { class: 'muted' }, repo.lastActivity ? `actividad ${timeAgo(repo.lastActivity)}` : ''),
      h('button', { onclick: () => openChanges({ projectId: repo.projectId }) }, 'Cambios'),
      h('button', { onclick: () => openProject(repo.projectId) }, 'Abrir')
    )
  );
  return card;
}

function render() {
  if (!root) return;
  clear(root);
  root.append(
    h(
      'div',
      { class: 'view-header' },
      h('h2', {}, 'Dashboard'),
      h('span', { class: 'muted' }, `${repos.size} ${repos.size === 1 ? 'repo' : 'repos'} en el workbench activo`),
      h('span', { class: 'spacer' }),
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Densidad' },
        h('button', { class: compact ? '' : 'active', onclick: () => setCompact(false) }, 'Ampliada'),
        h('button', { class: compact ? 'active' : '', onclick: () => setCompact(true) }, 'Compacta')
      )
    )
  );
  if (repos.size === 0) {
    root.append(
      h('p', { class: 'empty-state' }, 'No hay repos en el workbench activo. Añádelos desde el gestor de workbenches.')
    );
    return;
  }
  const sorted = [...repos.values()].sort(
    (a, b) =>
      (Date.parse(b.lastActivity || 0) || 0) - (Date.parse(a.lastActivity || 0) || 0) || a.name.localeCompare(b.name)
  );
  root.append(h('div', { class: `dash-grid${compact ? ' compact' : ''}` }, sorted.map(renderCard)));
}

function setCompact(value) {
  compact = value;
  localStorage.setItem('optimia:dashboard-compact', value ? '1' : '0');
  render();
}

// Re-render barato y agrupado: muchos eventos seguidos pintan una sola vez.
let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

on('monitor_state', (e) => {
  const repo = repos.get(e.projectId);
  if (repo) {
    repo.state = e.state;
    queueRender();
  }
});
on('monitor_activity', (e) => {
  const repo = repos.get(e.projectId);
  if (!repo) return;
  if (e.taskId) {
    const wt = repo.worktrees.find((w) => w.taskId === e.taskId);
    if (wt) wt.lastActivity = e.at;
  } else repo.lastActivity = e.at;
  queueRender();
});
on('monitor_worktree_state', (e) => {
  const repo = repos.get(e.projectId);
  if (!repo) return;
  const wt = repo.worktrees.find((w) => w.taskId === e.taskId);
  if (wt) wt.state = e.state;
  else repo.worktrees.push({ taskId: e.taskId, title: e.title, state: e.state });
  queueRender();
});
on('workbenches_changed', () => setTimeout(() => load().catch(() => {}), 300));
on('events_connected', () => root && load().catch(() => {}));
onWorkbenchesChange(() => root && load().catch(() => {}));

registerView('dashboard', {
  label: 'Dashboard',
  order: 10,
  mount(el) {
    root = el;
    load().catch((err) => clear(root).append(h('p', { class: 'error-text' }, err.message)));
  },
  show() {
    load().catch(() => {});
    // Los "hace X min" y el pulso de actividad caducan solos.
    tick = setInterval(render, 30 * 1000);
  },
  hide() {
    clearInterval(tick);
  }
});
