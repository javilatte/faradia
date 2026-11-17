// Changes: list of a repo's changed files (or of a task's worktree, where an agent writes) and
// their LIVE diff: fetched again every time the monitor reports a change. Inline or side by side,
// with context or the whole file, syntax highlighting and a change map synced with the scroll.

import { api } from './api.js';
import { h, clear } from './dom.js';
import { on } from './events.js';
import { registerView, showView } from './views.js';
import { activeRepos, currentProjectId } from './workbenches.js';
import { langFor, tokenizeLines, paintTokens } from './syntax.js';

const sel = {
  projectId: null,
  taskId: null, // null = the repo's working tree
  ref: null, // a commit sha: its changes are shown (navigation from the timeline)
  commit: null, // { short, subject } of the open commit
  path: null,
  mode: 'head',
  layout: localStorage.getItem('optimia:diff-layout') || 'inline',
  full: localStorage.getItem('optimia:diff-full') === '1'
};
let root = null;
let monitorRepos = [];
let lastDiff = null;
let commitFiles = []; // files of the open commit (sel.ref)
let refreshTimer = null;

export function openChanges({ projectId, taskId = null, path = null, ref = null, commit = null } = {}) {
  sel.projectId = projectId;
  sel.taskId = ref ? null : taskId;
  sel.ref = ref;
  sel.commit = commit;
  sel.path = path;
  if (ref) sel.mode = 'commit';
  else if (sel.mode === 'commit') sel.mode = 'head';
  showView('changes', {});
}

// For the project's classic scripts (task cards): open a commit.
window.optimiaOpenCommit = (projectId, ref) => openChanges({ projectId, ref });

function leaveCommit() {
  sel.ref = null;
  sel.commit = null;
  sel.mode = 'head';
  sel.path = null;
  refresh();
}

function target() {
  const repo = monitorRepos.find((r) => r.projectId === sel.projectId);
  if (!repo) return { repo: null, state: null };
  if (sel.taskId) {
    const wt = repo.worktrees.find((w) => w.taskId === sel.taskId);
    return { repo, state: wt?.state || null, worktree: wt };
  }
  return { repo, state: repo.state };
}

async function loadState() {
  monitorRepos = (await api.get('/api/monitor/state')).repos;
  if (!sel.projectId || !monitorRepos.some((r) => r.projectId === sel.projectId)) {
    sel.projectId =
      monitorRepos.find((r) => r.projectId === currentProjectId())?.projectId || monitorRepos[0]?.projectId || null;
    sel.taskId = null;
  }
}

function diffUrl() {
  const q = new URLSearchParams({ projectId: sel.projectId, mode: sel.mode, context: sel.full ? 'full' : '3' });
  if (sel.taskId) q.set('taskId', sel.taskId);
  if (sel.ref) q.set('ref', sel.ref);
  if (sel.path) q.set('path', sel.path);
  return `/api/monitor/diff?${q}`;
}

async function loadDiff() {
  if (!sel.projectId || !sel.path) {
    lastDiff = null;
    return;
  }
  lastDiff = await api.get(diffUrl());
}

// ---- render ----

function render() {
  if (!root) return;
  const scroller = root.querySelector('.diff-scroll');
  const keepScroll = scroller ? scroller.scrollTop : 0;
  clear(root);
  const { repo, state, worktree } = target();
  root.append(renderToolbar(repo));
  const body = h('div', { class: 'changes-body' });
  body.append(renderFileList(state, worktree));
  body.append(renderDiffPane());
  root.append(body);
  const next = root.querySelector('.diff-scroll');
  if (next) next.scrollTop = keepScroll;
  paintSyntax();
}

function renderToolbar(repo) {
  const repoSelect = h(
    'select',
    {
      'aria-label': 'Repositorio',
      onchange: async (e) => {
        sel.projectId = e.target.value;
        sel.taskId = null;
        sel.path = null;
        await refresh();
      }
    },
    monitorRepos.map((r) => h('option', { value: r.projectId, selected: r.projectId === sel.projectId }, r.name))
  );
  const targetSelect = h(
    'select',
    {
      'aria-label': 'Árbol de trabajo o worktree de una tarea',
      onchange: async (e) => {
        sel.taskId = e.target.value || null;
        sel.path = null;
        sel.mode = 'head';
        await refresh();
      }
    },
    h('option', { value: '' }, 'Árbol de trabajo'),
    (repo?.worktrees || []).map((w) =>
      h('option', { value: w.taskId, selected: w.taskId === sel.taskId }, `Agente: ${w.title || w.taskId.slice(0, 8)}`)
    )
  );
  const seg = (items, current, onPick, label) =>
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': label },
      items.map(([value, text]) =>
        h(
          'button',
          {
            class: value === current ? 'active' : '',
            'aria-pressed': String(value === current),
            onclick: () => onPick(value)
          },
          text
        )
      )
    );
  return h(
    'div',
    { class: 'view-header' },
    h('h2', {}, 'Cambios'),
    sel.ref
      ? h(
          'span',
          { class: 'commit-chip', title: sel.ref },
          `Commit ${sel.commit?.short || sel.ref.slice(0, 7)}`,
          sel.commit?.subject ? h('span', { class: 'muted' }, ` · ${sel.commit.subject}`) : null,
          h('button', { class: 'link-button', onclick: leaveCommit }, 'Volver al árbol de trabajo')
        )
      : null,
    repoSelect,
    targetSelect,
    h('span', { class: 'live-badge', title: 'Se actualiza solo con cada cambio' }, 'EN VIVO'),
    h('span', { class: 'spacer' }),
    sel.taskId || sel.ref
      ? null
      : seg(
          [
            ['head', 'Todo'],
            ['worktree', 'Sin stage'],
            ['staged', 'En stage']
          ],
          sel.mode,
          (v) => {
            sel.mode = v;
            refresh();
          },
          'Qué cambios'
        ),
    seg(
      [
        ['inline', 'En línea'],
        ['split', 'Lado a lado']
      ],
      sel.layout,
      (v) => {
        sel.layout = v;
        localStorage.setItem('optimia:diff-layout', v);
        render();
      },
      'Disposición'
    ),
    seg(
      [
        ['ctx', 'Contexto'],
        ['full', 'Fichero entero']
      ],
      sel.full ? 'full' : 'ctx',
      (v) => {
        sel.full = v === 'full';
        localStorage.setItem('optimia:diff-full', sel.full ? '1' : '0');
        refresh();
      },
      'Contexto'
    )
  );
}

function filesFor(state) {
  if (sel.ref) return commitFiles;
  if (!state) return [];
  if (sel.taskId || sel.mode === 'head') return state.files;
  if (sel.mode === 'staged') return state.files.filter((f) => f.staged);
  return state.files.filter((f) => f.unstaged);
}

function renderFileList(state, worktree) {
  const list = h('nav', { class: 'changes-files', 'aria-label': 'Ficheros cambiados' });
  const files = filesFor(state);
  if (!state && !sel.ref) {
    list.append(h('p', { class: 'muted' }, worktree ? 'Leyendo el worktree…' : 'Sin estado git para este repo.'));
    return list;
  }
  if (!files.length) {
    list.append(h('p', { class: 'muted' }, 'No hay cambios.'));
    return list;
  }
  if (!sel.path || !files.some((f) => f.path === sel.path)) sel.path = files[0].path;
  for (const f of files) {
    list.append(
      h(
        'button',
        {
          class: `changes-file${f.path === sel.path ? ' active' : ''}`,
          title: f.path,
          onclick: async () => {
            sel.path = f.path;
            await loadDiff().catch(() => {});
            render();
          }
        },
        h('span', { class: `dash-fstatus st-${f.status}` }, f.status[0].toUpperCase()),
        h('span', { class: 'changes-file-name' }, f.path.split('/').pop()),
        h(
          'span',
          { class: 'changes-file-dir muted' },
          f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''
        ),
        f.added || f.removed
          ? h(
              'span',
              { class: 'changes-file-lines' },
              h('span', { class: 'add' }, `+${f.added || 0}`),
              h('span', { class: 'del' }, `−${f.removed || 0}`)
            )
          : null
      )
    );
  }
  return list;
}

function lineEl(line, side) {
  const no = side === 'old' ? line.oldNo : side === 'new' ? line.newNo : null;
  return h(
    'div',
    { class: `dl dl-${line.type}`, dataset: { type: line.type } },
    side === 'both'
      ? [h('span', { class: 'dl-no' }, line.oldNo ?? ''), h('span', { class: 'dl-no' }, line.newNo ?? '')]
      : h('span', { class: 'dl-no' }, no ?? ''),
    h('span', { class: 'dl-sign' }, line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '),
    h('code', { class: 'dl-code', dataset: { side: line.type === 'del' ? 'old' : 'new', text: line.text } }, line.text)
  );
}

// Side by side: deleted lines on the left and added lines on the right, paired.
function splitRows(lines) {
  const rows = [];
  let dels = [];
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push([dels[i] || null, adds[i] || null]);
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.type === 'del') dels.push(l);
    else if (l.type === 'add') adds.push(l);
    else {
      flush();
      if (l.type === 'ctx') rows.push([l, l]);
    }
  }
  flush();
  return rows;
}

function renderDiffPane() {
  const pane = h('section', { class: 'diff-pane' });
  if (!sel.path) {
    pane.append(h('p', { class: 'empty-state' }, 'Elige un fichero para ver su diff.'));
    return pane;
  }
  if (!lastDiff) {
    pane.append(h('p', { class: 'muted' }, 'Cargando diff…'));
    return pane;
  }
  const file = lastDiff.files[0];
  pane.append(
    h(
      'div',
      { class: 'diff-file-head' },
      h('code', {}, sel.path),
      file
        ? h(
            'span',
            { class: 'changes-file-lines' },
            h('span', { class: 'add' }, `+${file.added}`),
            h('span', { class: 'del' }, `−${file.removed}`)
          )
        : null
    )
  );
  if (!file) {
    pane.append(h('p', { class: 'muted' }, 'Sin diferencias en este modo.'));
    return pane;
  }
  if (file.binary || file.tooLarge) {
    pane.append(
      h('p', { class: 'muted' }, file.binary ? 'Fichero binario.' : 'Fichero demasiado grande para mostrarlo.')
    );
    return pane;
  }
  const scroller = h('div', { class: `diff-scroll layout-${sel.layout}`, dataset: { lang: langFor(sel.path) || '' } });
  for (const hunk of file.hunks) {
    if (!sel.full || file.hunks.length > 1) {
      scroller.append(
        h(
          'div',
          { class: 'dl dl-hunk' },
          `@@ −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}`
        )
      );
    }
    if (sel.layout === 'split') {
      for (const [left, right] of splitRows(hunk.lines)) {
        scroller.append(
          h(
            'div',
            { class: 'dl-row' },
            left ? lineEl(left.type === 'ctx' ? left : left, 'old') : h('div', { class: 'dl dl-empty' }),
            right ? lineEl(right, 'new') : h('div', { class: 'dl dl-empty' })
          )
        );
      }
    } else {
      for (const line of hunk.lines) if (line.type !== 'meta') scroller.append(lineEl(line, 'both'));
    }
  }
  const ruler = h('div', { class: 'diff-ruler', 'aria-hidden': 'true' });
  const wrap = h('div', { class: 'diff-wrap' }, scroller, ruler);
  pane.append(wrap);
  requestAnimationFrame(() => drawRuler(scroller, ruler));
  scroller.addEventListener('scroll', () => updateRulerViewport(scroller, ruler));
  return pane;
}

// Change map: one mark per added/deleted line, at its relative position.
function drawRuler(scroller, ruler) {
  clear(ruler);
  const total = scroller.scrollHeight || 1;
  for (const el of scroller.querySelectorAll('.dl-add, .dl-del')) {
    const mark = h('span', { class: `ruler-mark ${el.classList.contains('dl-add') ? 'add' : 'del'}` });
    mark.style.top = `${(el.offsetTop / total) * 100}%`;
    ruler.append(mark);
  }
  ruler.append(h('span', { class: 'ruler-viewport' }));
  updateRulerViewport(scroller, ruler);
  ruler.onclick = (e) => {
    const rect = ruler.getBoundingClientRect();
    scroller.scrollTop = ((e.clientY - rect.top) / rect.height) * scroller.scrollHeight - scroller.clientHeight / 2;
  };
}

function updateRulerViewport(scroller, ruler) {
  const vp = ruler.querySelector('.ruler-viewport');
  if (!vp) return;
  const total = scroller.scrollHeight || 1;
  vp.style.top = `${(scroller.scrollTop / total) * 100}%`;
  vp.style.height = `${(scroller.clientHeight / total) * 100}%`;
}

// Highlighting: each side (old and new) is tokenized as one block, so multi-line comments and
// strings are colored correctly, then painted line by line.
async function paintSyntax() {
  const scroller = root?.querySelector('.diff-scroll');
  const lang = scroller?.dataset.lang;
  if (!scroller || !lang) return;
  for (const side of ['old', 'new']) {
    const codes = [...scroller.querySelectorAll(`.dl-code[data-side="${side}"]`)];
    if (!codes.length) continue;
    const tokens = await tokenizeLines(codes.map((c) => c.dataset.text).join('\n'), lang);
    if (!tokens || !scroller.isConnected) return;
    codes.forEach((code, i) => tokens[i] && paintTokens(code, tokens[i]));
  }
}

// ---- live data ----

async function refresh() {
  try {
    await loadState();
    if (sel.ref) {
      const q = new URLSearchParams({ projectId: sel.projectId, mode: 'commit', ref: sel.ref, context: '0' });
      const all = await api.get(`/api/monitor/diff?${q}`);
      commitFiles = all.files.map((f) => ({
        path: f.newPath || f.oldPath,
        status: f.status === 'modified' ? 'modified' : f.status,
        added: f.added,
        removed: f.removed
      }));
    }
    const { state } = target();
    const files = filesFor(state);
    if (files.length && (!sel.path || !files.some((f) => f.path === sel.path))) sel.path = files[0].path;
    if (!files.length) sel.path = null;
    await loadDiff();
  } catch (err) {
    lastDiff = null;
    console.error(err);
  }
  render();
}

function scheduleRefresh() {
  if (!root || root.hidden) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

on('monitor_state', (e) => e.projectId === sel.projectId && !sel.taskId && scheduleRefresh());
on('monitor_worktree_state', (e) => {
  if (e.projectId !== sel.projectId) return;
  // A worktree the selector does not list yet (an agent just started): refresh to offer it.
  const known = monitorRepos.find((r) => r.projectId === e.projectId)?.worktrees?.some((w) => w.taskId === e.taskId);
  if (e.taskId === sel.taskId || !known) scheduleRefresh();
});
on('monitor_activity', (e) => e.projectId === sel.projectId && (e.taskId || null) === sel.taskId && scheduleRefresh());

registerView('changes', {
  label: 'Cambios',
  order: 20,
  mount(el) {
    root = el;
  },
  show() {
    if (!sel.projectId)
      sel.projectId = activeRepos().find((r) => r.projectId === currentProjectId())?.projectId || null;
    refresh();
  }
});

// The repo opened in the sidebar is the one shown here as well.
window.addEventListener('optimia:project-changed', (e) => {
  sel.projectId = e.detail.projectId;
  sel.taskId = null;
  sel.ref = null;
  sel.commit = null;
  sel.path = null;
  if (root && !root.hidden) refresh();
});
