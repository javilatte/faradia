// Files: explorer of the workbench's repos, with a tree (that remembers what is collapsed), preview
// (markdown, code, image, audio, video, pdf), copy path, a file clipboard and operations with Undo.
// Deleting sends to optimia's trash, where it can be restored from.

import { api } from './api.js';
import { h, clear, toast, formatBytes, timeAgo } from './dom.js';
import { on } from './events.js';
import { registerView } from './views.js';
import { activeRepos, currentProjectId } from './workbenches.js';
import { langFor, tokenizeLines, paintTokens } from './syntax.js';
import { openChanges } from './changes.js';
import { renderMarkdown } from './markdown.js';

let root = null;
let projectId = null;
const listings = new Map(); // folder path -> entries
let expanded = new Set(['']);
let selected = null; // { path, dir }
let previewData = null;
let clipboard = null; // { projectId, path, mode: 'copy' | 'cut' }
let refreshTimer = null;

const raw = (p) => `/api/fs/raw?${new URLSearchParams({ projectId, path: p })}`;
const storageKey = () => `optimia:tree:${projectId}`;

function saveExpanded() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify([...expanded]));
  } catch {
    /* no storage */
  }
}

function loadExpanded() {
  try {
    expanded = new Set(['', ...JSON.parse(localStorage.getItem(storageKey()) || '[]')]);
  } catch {
    expanded = new Set(['']);
  }
}

async function loadDir(dir) {
  try {
    const { entries } = await api.get(`/api/fs/list?${new URLSearchParams({ projectId, path: dir })}`);
    listings.set(dir, entries);
  } catch {
    listings.delete(dir);
    expanded.delete(dir); // the folder no longer exists
  }
}

async function loadTree() {
  listings.clear();
  await Promise.all([...expanded].map(loadDir));
}

async function select(entry) {
  selected = { path: entry.path, dir: entry.dir };
  previewData = null;
  render();
  if (entry.dir) return;
  try {
    previewData = await api.get(`/api/fs/preview?${new URLSearchParams({ projectId, path: entry.path })}`);
  } catch (err) {
    previewData = { kind: 'none', reason: err.message };
  }
  render();
}

async function toggle(entry) {
  if (expanded.has(entry.path)) expanded.delete(entry.path);
  else {
    expanded.add(entry.path);
    if (!listings.has(entry.path)) await loadDir(entry.path);
  }
  saveExpanded();
  render();
}

// ---- operations with undo ----

async function runOp(url, body, message) {
  try {
    const result = await api.post(url, { projectId, ...body });
    await loadTree();
    if (result.path) selected = { path: result.path, dir: selected?.dir };
    render();
    if (result.undo) {
      toast(message, {
        action: 'Deshacer',
        ms: 8000,
        onAction: async () => {
          try {
            await api.post('/api/fs/undo', { projectId, undo: result.undo });
            await loadTree();
            render();
            toast('Deshecho');
          } catch (err) {
            toast(err.message, { kind: 'error' });
          }
        }
      });
    } else toast(message);
    return result;
  } catch (err) {
    toast(err.message, { kind: 'error' });
    return null;
  }
}

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const targetDir = () => (selected ? (selected.dir ? selected.path : parentOf(selected.path)) : '');

function copyText(text, what) {
  navigator.clipboard?.writeText(text).then(
    () => toast(`${what} copiada`),
    () => toast(text, { ms: 10000 })
  );
}

function repoRootPath() {
  return activeRepos().find((r) => r.projectId === projectId)?.path || '';
}

function actions() {
  if (!selected) return null;
  const p = selected.path;
  const name = p.split('/').pop();
  return h(
    'div',
    { class: 'fx-actions' },
    h('button', { onclick: () => copyText(p, 'Ruta') }, 'Copiar ruta'),
    h('button', { onclick: () => copyText(`${repoRootPath()}/${p}`, 'Ruta completa') }, 'Ruta completa'),
    h(
      'button',
      {
        onclick: () => {
          const next = window.prompt('Nuevo nombre', name);
          if (next && next !== name) runOp('/api/fs/rename', { path: p, name: next }, `Renombrado a ${next}`);
        }
      },
      'Renombrar'
    ),
    h('button', { onclick: () => ((clipboard = { projectId, path: p, mode: 'copy' }), render()) }, 'Copiar'),
    h('button', { onclick: () => ((clipboard = { projectId, path: p, mode: 'cut' }), render()) }, 'Cortar'),
    h(
      'button',
      {
        onclick: () =>
          api.post('/api/fs/open', { projectId, path: p }).catch((e) => toast(e.message, { kind: 'error' }))
      },
      'Abrir'
    ),
    h(
      'button',
      {
        onclick: () =>
          api
            .post('/api/fs/open', { projectId, path: p, reveal: true })
            .catch((e) => toast(e.message, { kind: 'error' }))
      },
      'Mostrar en carpeta'
    ),
    selected.dir ? null : h('button', { onclick: () => openChanges({ projectId, path: p }) }, 'Ver cambios'),
    h(
      'button',
      {
        class: 'danger',
        onclick: async () => {
          const res = await runOp('/api/fs/delete', { path: p }, `${name} enviado a la papelera`);
          if (res) {
            selected = null;
            previewData = null;
            render();
          }
        }
      },
      'Borrar'
    )
  );
}

function clipboardBar() {
  if (!clipboard || clipboard.projectId !== projectId) return null;
  const dest = targetDir();
  return h(
    'div',
    { class: 'fx-clipboard', role: 'status' },
    h('span', {}, `${clipboard.mode === 'cut' ? 'Para mover' : 'Para copiar'}: `, h('code', {}, clipboard.path)),
    h(
      'button',
      {
        class: 'primary',
        onclick: async () => {
          const cut = clipboard.mode === 'cut';
          const res = await runOp(
            cut ? '/api/fs/move' : '/api/fs/copy',
            { path: clipboard.path, dest },
            cut ? 'Movido' : 'Copiado'
          );
          if (res && cut) clipboard = null;
          render();
        }
      },
      `Pegar en ${dest || 'la raíz'}`
    ),
    h('button', { onclick: () => ((clipboard = null), render()) }, 'Vaciar')
  );
}

// ---- arbol ----

function renderTree(dir, depth) {
  const entries = listings.get(dir) || [];
  const out = [];
  for (const e of entries) {
    const open = expanded.has(e.path);
    out.push(
      h(
        'button',
        {
          class: `fx-node${selected?.path === e.path ? ' active' : ''}${e.dir ? ' dir' : ''}`,
          style: { paddingLeft: `${8 + depth * 14}px` },
          title: e.path,
          'aria-expanded': e.dir ? String(open) : undefined,
          onclick: () => (e.dir ? (toggle(e), select(e)) : select(e))
        },
        h('span', { class: 'fx-caret' }, e.dir ? (open ? '▾' : '▸') : ''),
        h('span', { class: 'fx-name' }, e.name)
      )
    );
    if (e.dir && open) out.push(...renderTree(e.path, depth + 1));
  }
  return out;
}

// ---- vista previa ----

async function paintMarkdownPreview(el, text) {
  await renderMarkdown(el, text);
  el.classList.add('fx-markdown');
}

async function paintCode(el, text, path) {
  const tokens = await tokenizeLines(text, langFor(path));
  if (!tokens || !el.isConnected) return;
  clear(el);
  tokens.forEach((line, i) => {
    const row = h(
      'div',
      { class: 'fx-code-line' },
      h('span', { class: 'dl-no' }, i + 1),
      h('code', { class: 'dl-code' })
    );
    paintTokens(row.lastChild, line);
    el.append(row);
  });
}

function renderPreview() {
  const pane = h('section', { class: 'fx-preview' });
  if (!selected) {
    pane.append(h('p', { class: 'empty-state' }, 'Elige un fichero o una carpeta.'));
    return pane;
  }
  pane.append(h('div', { class: 'fx-preview-head' }, h('code', {}, selected.path), actions()));
  if (selected.dir) {
    const n = (listings.get(selected.path) || []).length;
    pane.append(h('p', { class: 'muted fx-meta' }, `Carpeta con ${n} ${n === 1 ? 'elemento' : 'elementos'}.`));
    return pane;
  }
  if (!previewData) {
    pane.append(h('p', { class: 'muted' }, 'Cargando…'));
    return pane;
  }
  const d = previewData;
  pane.append(
    h(
      'p',
      { class: 'muted fx-meta' },
      [formatBytes(d.size), d.mtime ? `modificado ${timeAgo(d.mtime)}` : ''].filter(Boolean).join(' · ')
    )
  );
  const body = h('div', { class: 'fx-body' });
  if (d.kind === 'image') body.append(h('img', { src: raw(d.path), alt: d.path.split('/').pop(), class: 'fx-media' }));
  else if (d.kind === 'audio') body.append(h('audio', { src: raw(d.path), controls: true, preload: 'metadata' }));
  else if (d.kind === 'video')
    body.append(h('video', { src: raw(d.path), controls: true, preload: 'metadata', class: 'fx-media' }));
  else if (d.kind === 'pdf')
    body.append(h('iframe', { src: raw(d.path), title: d.path, class: 'fx-pdf', sandbox: '' }));
  else if (d.kind === 'markdown') {
    const md = h('article', { class: 'fx-md' }, d.content);
    body.append(md);
    paintMarkdownPreview(md, d.content);
  } else if (d.kind === 'text') {
    const code = h('div', { class: 'fx-code diff-scroll' }, h('pre', {}, d.content));
    body.append(code);
    paintCode(code, d.content, d.path);
  } else body.append(h('p', { class: 'muted' }, d.reason || 'Sin vista previa para este tipo de fichero.'));
  pane.append(body);
  return pane;
}

// ---- papelera ----

async function openTrash() {
  const { items } = await api.get(`/api/fs/trash?projectId=${projectId}`);
  const overlay = h('div', {
    class: 'modal-overlay',
    id: 'fx-trash',
    onclick: (e) => e.target === overlay && overlay.remove()
  });
  const close = () => overlay.remove();
  const list = h(
    'ul',
    { class: 'wb-repos' },
    items.length
      ? items.map((i) =>
          h(
            'li',
            {},
            h('div', { class: 'wb-repo-name' }, i.name, i.dir ? h('span', { class: 'wb-badge' }, 'carpeta') : null),
            h('div', { class: 'wb-repo-path muted' }, `${i.path} · ${formatBytes(i.size)} · ${timeAgo(i.deletedAt)}`),
            h(
              'button',
              {
                onclick: async () => {
                  try {
                    const r = await api.post('/api/fs/trash/restore', { id: i.id });
                    close();
                    await loadTree();
                    render();
                    toast(`Restaurado en ${r.path}`);
                  } catch (err) {
                    toast(err.message, { kind: 'error' });
                  }
                }
              },
              'Restaurar'
            )
          )
        )
      : h('li', { class: 'muted' }, 'La papelera de este repo está vacía.')
  );
  overlay.append(
    h(
      'div',
      { class: 'modal wb-modal fx-trash-modal', role: 'dialog', 'aria-label': 'Papelera' },
      h(
        'div',
        { class: 'settings-content' },
        h(
          'div',
          { class: 'settings-content-header' },
          h('span', {}, 'Papelera'),
          h('button', { class: 'icon-button wb-close', title: 'Cerrar', onclick: close }, '✕')
        ),
        h(
          'div',
          { class: 'settings-pane-body wb-pane' },
          h(
            'p',
            { class: 'muted agents-help' },
            'Lo borrado desde optimia se guarda aquí hasta que vacías la papelera.'
          ),
          list,
          items.length
            ? h(
                'button',
                {
                  class: 'danger',
                  onclick: async () => {
                    if (!window.confirm('¿Vaciar la papelera de este repo? Esto no se puede deshacer.')) return;
                    await api.post('/api/fs/trash/purge', { projectId });
                    close();
                    toast('Papelera vaciada');
                  }
                },
                'Vaciar papelera'
              )
            : null
        )
      )
    )
  );
  document.body.append(overlay);
}

// ---- vista ----

function render() {
  if (!root) return;
  const treeEl = root.querySelector('.fx-tree');
  const keep = treeEl ? treeEl.scrollTop : 0;
  clear(root);
  const repos = activeRepos();
  root.append(
    h(
      'div',
      { class: 'view-header' },
      h('h2', {}, 'Archivos'),
      h(
        'select',
        {
          'aria-label': 'Repositorio',
          onchange: async (e) => {
            await setProject(e.target.value);
          }
        },
        repos.map((r) => h('option', { value: r.projectId, selected: r.projectId === projectId }, r.name))
      ),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => openTrash().catch((e) => toast(e.message, { kind: 'error' })) }, 'Papelera')
    ),
    clipboardBar() || '',
    h(
      'div',
      { class: 'fx-layout' },
      h('nav', { class: 'fx-tree', 'aria-label': 'Arbol de ficheros' }, renderTree('', 0)),
      renderPreview()
    )
  );
  const next = root.querySelector('.fx-tree');
  if (next) next.scrollTop = keep;
}

async function setProject(id) {
  projectId = id;
  selected = null;
  previewData = null;
  loadExpanded();
  await loadTree();
  render();
}

// Changes on disk (from an agent, another editor...): open folders are reloaded.
on('monitor_activity', (e) => {
  if (!root || root.hidden || e.projectId !== projectId || e.taskId) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadTree();
    if (selected && !selected.dir && e.paths.includes(selected.path)) {
      previewData = await api
        .get(`/api/fs/preview?${new URLSearchParams({ projectId, path: selected.path })}`)
        .catch(() => null);
    }
    render();
  }, 400);
});

registerView('files', {
  label: 'Archivos',
  order: 40,
  mount(el) {
    root = el;
  },
  async show() {
    const repos = activeRepos();
    const wanted =
      repos.find((r) => r.projectId === (projectId || currentProjectId()))?.projectId || repos[0]?.projectId;
    if (!wanted) {
      clear(root).append(h('p', { class: 'empty-state' }, 'No hay repos en el workbench activo.'));
      return;
    }
    if (wanted !== projectId) await setProject(wanted);
    else {
      await loadTree();
      render();
    }
  }
});

// The repo opened in the sidebar is the one shown here as well.
window.addEventListener('optimia:project-changed', (e) => {
  if (root && !root.hidden) setProject(e.detail.projectId).catch(() => {});
  else projectId = null;
});
