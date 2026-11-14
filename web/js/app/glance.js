// Modo compacto (glance): una ventana pequena para dejar en una esquina, con una
// linea por repo del workbench activo y el ultimo aviso. Se abre desde la barra
// superior y se actualiza en vivo con el mismo canal de eventos.

import { api } from './api.js';
import { h, clear, timeAgo } from './dom.js';
import { connectEvents, on } from './events.js';

const ACTIVE_MS = 60 * 1000;
const repos = new Map();
let lastSignal = null;

async function load() {
  const [{ repos: list }, { signals }] = await Promise.all([
    api.get('/api/monitor/state'),
    api.get('/api/monitor/signals')
  ]);
  repos.clear();
  for (const r of list) repos.set(r.projectId, r);
  lastSignal = signals[0] || null;
  render();
}

function line(r) {
  const s = r.state;
  const agent = r.worktrees.some((w) => w.lastActivity && Date.now() - Date.parse(w.lastActivity) < ACTIVE_MS);
  const active = agent || (r.lastActivity && Date.now() - Date.parse(r.lastActivity) < ACTIVE_MS);
  return h(
    'li',
    { class: `glance-line${active ? ' active' : ''}`, title: r.path },
    h('span', { class: 'dash-pulse' }),
    h('b', {}, r.name),
    s ? h('span', { class: 'muted' }, s.branch || '—') : null,
    s?.dirty
      ? h(
          'span',
          { class: 'dash-lines' },
          h('span', { class: 'add' }, `+${s.lines.added}`),
          h('span', { class: 'del' }, `−${s.lines.removed}`),
          ` ${s.files.length}f`
        )
      : h('span', { class: 'muted' }, 'limpio'),
    agent ? h('span', { class: 'glance-agent' }, 'agente') : null
  );
}

function render() {
  const root = document.getElementById('glance');
  clear(root);
  const sorted = [...repos.values()].sort(
    (a, b) => (Date.parse(b.lastActivity || 0) || 0) - (Date.parse(a.lastActivity || 0) || 0)
  );
  root.append(h('ul', { class: 'glance-list' }, sorted.map(line)));
  if (lastSignal) {
    root.append(
      h(
        'p',
        { class: `glance-signal sev-${lastSignal.severity}` },
        `${timeAgo(lastSignal.at)} · ${lastSignal.name}: ${lastSignal.message}`
      )
    );
  }
  document.title = `optimia · ${[...repos.values()].filter((r) => r.state?.dirty).length} con cambios`;
}

let queued = false;
const queue = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    render();
  });
};

on('monitor_state', (e) => {
  const r = repos.get(e.projectId);
  if (r) {
    r.state = e.state;
    queue();
  }
});
on('monitor_activity', (e) => {
  const r = repos.get(e.projectId);
  if (!r) return;
  if (e.taskId) {
    const wt = r.worktrees.find((w) => w.taskId === e.taskId);
    if (wt) wt.lastActivity = e.at;
  } else r.lastActivity = e.at;
  queue();
});
on('signal', ({ signal }) => {
  lastSignal = signal;
  queue();
});
on('workbenches_changed', () => setTimeout(load, 300));
on('events_connected', () => load().catch(() => {}));

connectEvents();
setInterval(render, 30 * 1000);
