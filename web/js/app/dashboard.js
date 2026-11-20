// Dashboard: one card per repo of the active workbench with its live git state (branch,
// ahead/behind, changes, lines, last commit) and recent activity, including the agents' activity in
// their task worktrees.

import { api } from './api.js';
import { h, clear, timeAgo } from './dom.js';
import { on } from './events.js';
import { registerView } from './views.js';
import { openProject, onWorkbenchesChange } from './workbenches.js';
import { openChanges } from './changes.js';
import { onSignal, RULE_LABEL } from './signals.js';

const ACTIVE_MS = 60 * 1000;
const repos = new Map(); // projectId -> monitor snapshot
const metrics = new Map(); // projectId -> metrics (24 h activity, agent sessions)
let signals = [];
let root = null;
let compact = localStorage.getItem('faradia:dashboard-compact') === '1';
let tick = null;

async function load() {
  const [{ repos: list }, m, sig] = await Promise.all([
    api.get('/api/monitor/state'),
    api.get('/api/monitor/metrics').catch(() => ({ repos: [] })),
    api.get('/api/monitor/signals').catch(() => ({ signals: [] }))
  ]);
  repos.clear();
  for (const r of list) repos.set(r.projectId, r);
  metrics.clear();
  for (const r of m.repos) metrics.set(r.projectId, r);
  signals = sig.signals;
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
  const met = metrics.get(repo.projectId);
  if (met && !compact) card.append(renderActivity(met));
  const repoSignals = signals.filter((x) => x.projectId === repo.projectId && x.severity === 'high');
  if (repoSignals.length) {
    card.append(
      h(
        'p',
        { class: 'dash-signal sev-high', title: repoSignals[0].message },
        `⚠ ${repoSignals.length} ${repoSignals.length === 1 ? 'aviso' : 'avisos'}: ${repoSignals[0].message}`
      )
    );
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

// Activity in the last 24 h (changed files per hour) and agent metrics.
function renderActivity(met) {
  const max = Math.max(1, ...met.hourly);
  const bars = h(
    'div',
    { class: 'spark', role: 'img', 'aria-label': `${met.changesToday} ficheros cambiados en 24 horas` },
    met.hourly.map((v, i) => {
      const bar = h('span', { title: `hace ${23 - i} h: ${v}` });
      bar.style.height = `${Math.max(v ? 12 : 4, (v / max) * 100)}%`;
      if (v) bar.classList.add('on');
      return bar;
    })
  );
  return h(
    'div',
    { class: 'dash-activity' },
    bars,
    h(
      'span',
      { class: 'muted' },
      `${met.changesToday} cambios en 24 h`,
      met.agentSessions.length
        ? ` · agentes: ${met.agentFilesTouched} ficheros${met.agentCostUsd ? `, ${met.agentCostUsd.toFixed(2)} $` : ''}`
        : ''
    )
  );
}

function renderSignals() {
  if (!signals.length) return null;
  return h(
    'section',
    { class: 'dash-signals', 'aria-label': 'Avisos recientes' },
    h('h3', {}, 'Avisos recientes'),
    h(
      'ul',
      {},
      signals.slice(0, 6).map((x) =>
        h(
          'li',
          {},
          h('span', { class: `tl-sev sev-${x.severity}` }, RULE_LABEL[x.rule] || x.rule),
          h('b', {}, ` ${x.name} `),
          h('span', {}, x.message),
          x.path
            ? h(
                'button',
                {
                  class: 'link-button',
                  onclick: () => openChanges({ projectId: x.projectId, taskId: x.taskId || null, path: x.path })
                },
                'ver'
              )
            : null,
          h('span', { class: 'muted' }, ` · ${timeAgo(x.at)}`)
        )
      )
    )
  );
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
  const panel = renderSignals();
  if (panel) root.append(panel);
  const sorted = [...repos.values()].sort(
    (a, b) =>
      (Date.parse(b.lastActivity || 0) || 0) - (Date.parse(a.lastActivity || 0) || 0) || a.name.localeCompare(b.name)
  );
  root.append(h('div', { class: `dash-grid${compact ? ' compact' : ''}` }, sorted.map(renderCard)));
}

function setCompact(value) {
  compact = value;
  localStorage.setItem('faradia:dashboard-compact', value ? '1' : '0');
  render();
}

// Cheap, batched re-render: many events in a row paint once.
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
  // Activity metrics also update live (the current hour is the last one).
  const met = metrics.get(e.projectId);
  if (met) {
    met.hourly[23] += e.paths.length;
    met.changesToday += e.paths.length;
    met.changesLastHour += e.paths.length;
  }
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
onSignal((signal) => {
  signals.unshift(signal);
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
    // The "hace X min" texts and the activity pulse expire on their own.
    tick = setInterval(render, 30 * 1000);
  },
  hide() {
    clearInterval(tick);
  }
});
