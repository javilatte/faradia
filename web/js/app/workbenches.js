// Selector de workbench y repo en la barra superior, y el gestor de workbenches
// (crear, renombrar, borrar, anadir repos a mano o buscandolos en una carpeta).

import { api } from './api.js';
import { h, clear, toast } from './dom.js';
import { on } from './events.js';

export const state = {
  activeWorkbenchId: null,
  workbenches: [],
  defaultProjectId: null,
  currentProjectId: new URLSearchParams(location.search).get('p')
};

const changeListeners = new Set();
export function onWorkbenchesChange(fn) {
  changeListeners.add(fn);
}

export function activeWorkbench() {
  return state.workbenches.find((w) => w.id === state.activeWorkbenchId) || state.workbenches[0] || null;
}

export function currentProjectId() {
  return state.currentProjectId || state.defaultProjectId;
}

// Repos del workbench activo que existen en disco, con su id de proyecto.
export function activeRepos() {
  return (activeWorkbench()?.repos || []).filter((r) => r.exists && r.projectId);
}

export function repoByProject(projectId) {
  for (const wb of state.workbenches) {
    const repo = wb.repos.find((r) => r.projectId === projectId);
    if (repo) return repo;
  }
  return null;
}

function apply(data) {
  state.activeWorkbenchId = data.activeWorkbenchId;
  state.workbenches = data.workbenches;
  renderSwitcher();
  for (const fn of changeListeners) fn(state);
}

export async function loadWorkbenches() {
  const [wbs, projects] = await Promise.all([api.get('/api/workbenches'), api.get('/api/projects')]);
  state.defaultProjectId = projects.defaultProjectId;
  apply(wbs);
}

// Cambiar de repo recarga la vista de proyecto con ?p=<id> y conserva la vista actual.
export function openProject(projectId) {
  const params = new URLSearchParams(location.search);
  params.set('p', projectId);
  location.href = `${location.pathname}?${params}${location.hash}`;
}

function renderSwitcher() {
  const host = document.getElementById('wb-switcher');
  if (!host) return;
  clear(host);
  const wb = activeWorkbench();
  const wbSelect = h(
    'select',
    {
      id: 'wb-select',
      'aria-label': 'Workbench',
      title: 'Workbench activo',
      onchange: async (e) => {
        try {
          apply(await api.put('/api/workbenches/active', { id: e.target.value }));
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      }
    },
    state.workbenches.map((w) =>
      h('option', { value: w.id, selected: w.id === state.activeWorkbenchId }, `${w.name} (${w.repos.length})`)
    )
  );
  host.append(
    wbSelect,
    h(
      'button',
      {
        class: 'icon-button',
        id: 'wb-manage',
        title: 'Gestionar workbenches…',
        'aria-label': 'Gestionar workbenches',
        onclick: openManager
      },
      svgIcon('M4 6h16M4 12h16M4 18h10')
    )
  );
  renderRepoList(wb);
}

// Repos del workbench activo, como los buzones de Mail: el seleccionado es el
// proyecto abierto (chat, agentes, ajustes).
function renderRepoList(wb) {
  const list = document.getElementById('repo-list');
  if (!list) return;
  clear(list);
  const current = currentProjectId();
  const repos = wb ? wb.repos.filter((r) => r.exists && r.projectId) : [];
  const items = repos.map((r) => ({ id: r.projectId, name: r.name, path: r.path }));
  // El proyecto abierto puede no estar en el workbench activo: se muestra igualmente.
  if (current && !items.some((r) => r.id === current)) {
    const repo = repoByProject(current);
    items.unshift({ id: current, name: repo ? repo.name : 'proyecto actual', path: repo?.path, other: true });
  }
  if (!items.length) {
    list.append(h('div', { class: 'sidebar-empty' }, 'Sin repos. Añádelos desde Gestionar workbenches…'));
    return;
  }
  for (const r of items) {
    const selected = r.id === current;
    list.append(
      h(
        'button',
        {
          class: `sidebar-item repo-item${selected ? ' active' : ''}`,
          role: 'option',
          'aria-selected': String(selected),
          dataset: { projectId: r.id },
          title: r.other ? `${r.path || r.name} (de otro workbench)` : r.path || r.name,
          onclick: () => {
            if (!selected) openProject(r.id);
          }
        },
        svgIcon('M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9'),
        h('span', { class: 'sidebar-item-label' }, r.name)
      )
    );
  }
}

function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

// ---- gestor de workbenches ----

let managerSelected = null;

function closeManager() {
  document.getElementById('wb-manager')?.remove();
}

function openManager() {
  managerSelected = state.activeWorkbenchId;
  closeManager();
  const overlay = h('div', {
    class: 'modal-overlay',
    id: 'wb-manager',
    onclick: (e) => {
      if (e.target === overlay) closeManager();
    }
  });
  overlay.append(h('div', { class: 'modal wb-modal', role: 'dialog', 'aria-label': 'Workbenches' }));
  document.body.append(overlay);
  renderManager();
}

async function run(action) {
  try {
    apply(await action());
    renderManager();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

function renderManager() {
  const modal = document.querySelector('#wb-manager .wb-modal');
  if (!modal) return;
  clear(modal);
  const selected = state.workbenches.find((w) => w.id === managerSelected) || activeWorkbench();
  managerSelected = selected?.id;

  const list = h(
    'nav',
    { class: 'settings-nav wb-list' },
    h('div', { class: 'settings-nav-group' }, 'Workbenches'),
    state.workbenches.map((w) =>
      h(
        'button',
        {
          class: `settings-nav-item${w.id === managerSelected ? ' active' : ''}`,
          onclick: () => {
            managerSelected = w.id;
            renderManager();
          }
        },
        w.name,
        w.id === state.activeWorkbenchId ? h('span', { class: 'wb-badge' }, 'activo') : null
      )
    ),
    h(
      'form',
      {
        class: 'wb-new',
        onsubmit: (e) => {
          e.preventDefault();
          const name = e.target.elements.name.value;
          run(async () => {
            const data = await api.post('/api/workbenches', { name });
            managerSelected = data.workbenches[data.workbenches.length - 1].id;
            return data;
          });
        }
      },
      h('input', {
        name: 'name',
        placeholder: 'Nuevo workbench',
        'aria-label': 'Nombre del nuevo workbench',
        required: true
      }),
      h('button', { type: 'submit', class: 'primary' }, 'Crear')
    )
  );

  const body = h('div', { class: 'settings-content' });
  body.append(
    h(
      'div',
      { class: 'settings-content-header' },
      h('span', {}, selected ? selected.name : 'Workbenches'),
      h('button', { class: 'icon-button wb-close', title: 'Cerrar', onclick: closeManager }, '✕')
    )
  );
  if (selected) body.append(renderWorkbenchPane(selected));
  modal.append(list, body);
}

function renderWorkbenchPane(wb) {
  const pane = h('div', { class: 'settings-pane-body wb-pane' });
  pane.append(
    h(
      'div',
      { class: 'wb-actions' },
      h(
        'button',
        {
          disabled: wb.id === state.activeWorkbenchId,
          onclick: () => run(() => api.put('/api/workbenches/active', { id: wb.id }))
        },
        'Activar'
      ),
      h(
        'button',
        {
          onclick: () => {
            const name = window.prompt('Nuevo nombre del workbench', wb.name);
            if (name) run(() => api.patch(`/api/workbenches/${wb.id}`, { name }));
          }
        },
        'Renombrar'
      ),
      h(
        'button',
        {
          class: 'danger',
          disabled: state.workbenches.length === 1,
          onclick: () => {
            if (window.confirm(`¿Borrar el workbench "${wb.name}"? Los repos no se tocan.`)) {
              run(() => api.del(`/api/workbenches/${wb.id}`));
            }
          }
        },
        'Borrar'
      )
    )
  );

  pane.append(h('h3', { class: 'wb-h' }, `Repos (${wb.repos.length})`));
  const repoList = h('ul', { class: 'wb-repos' });
  if (wb.repos.length === 0) repoList.append(h('li', { class: 'muted' }, 'Todavía no hay repos en este workbench.'));
  for (const repo of wb.repos) {
    repoList.append(
      h(
        'li',
        { class: repo.exists ? '' : 'missing' },
        h(
          'div',
          { class: 'wb-repo-name' },
          repo.name,
          repo.exists ? null : h('span', { class: 'wb-badge danger' }, 'no existe')
        ),
        h('div', { class: 'wb-repo-path muted' }, repo.path),
        h(
          'button',
          {
            class: 'link-button',
            title: 'Quitar del workbench (no borra nada en disco)',
            onclick: () => run(() => api.del(`/api/workbenches/${wb.id}/repos`, { path: repo.path }))
          },
          'Quitar'
        )
      )
    );
  }
  pane.append(repoList);

  pane.append(
    h('h3', { class: 'wb-h' }, 'Añadir un repo'),
    h(
      'form',
      {
        class: 'wb-inline-form',
        onsubmit: (e) => {
          e.preventDefault();
          const path = e.target.elements.path.value.trim();
          if (path) run(() => api.post(`/api/workbenches/${wb.id}/repos`, { paths: [path] }));
        }
      },
      h('input', { name: 'path', placeholder: '/ruta/al/repo', 'aria-label': 'Ruta del repo', spellcheck: 'false' }),
      h('button', { type: 'submit' }, 'Añadir')
    ),
    h('h3', { class: 'wb-h' }, 'Buscar repos en una carpeta'),
    renderScanForm(wb)
  );
  return pane;
}

function renderScanForm(wb) {
  const results = h('div', { class: 'wb-scan-results' });
  const form = h(
    'form',
    {
      class: 'wb-inline-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const root = e.target.elements.root.value.trim();
        const maxDepth = Number(e.target.elements.depth.value);
        clear(results).append(h('p', { class: 'muted' }, 'Buscando…'));
        try {
          const { repos } = await api.post('/api/scan', { root, maxDepth });
          renderScanResults(results, wb, repos);
        } catch (err) {
          clear(results).append(h('p', { class: 'error-text' }, err.message));
        }
      }
    },
    h('input', {
      name: 'root',
      placeholder: '~/Documents/GitHub',
      'aria-label': 'Carpeta donde buscar',
      spellcheck: 'false'
    }),
    h(
      'select',
      { name: 'depth', 'aria-label': 'Profundidad' },
      [2, 3, 4, 5, 6].map((d) => h('option', { value: d, selected: d === 4 }, `${d} niveles`))
    ),
    h('button', { type: 'submit' }, 'Buscar')
  );
  return h('div', {}, form, results);
}

function renderScanResults(host, wb, repos) {
  clear(host);
  const known = new Set(wb.repos.map((r) => r.path));
  const fresh = repos.filter((r) => !known.has(r));
  if (repos.length === 0) return host.append(h('p', { class: 'muted' }, 'No se encontró ningún repo git.'));
  if (fresh.length === 0)
    return host.append(h('p', { class: 'muted' }, 'Todos los repos encontrados ya están en este workbench.'));
  const boxes = fresh.map((path) => h('input', { type: 'checkbox', value: path, checked: true }));
  host.append(
    h(
      'ul',
      { class: 'wb-scan-list' },
      fresh.map((path, i) => h('li', {}, h('label', {}, boxes[i], ' ', path)))
    ),
    h(
      'button',
      {
        class: 'primary',
        onclick: () => {
          const paths = boxes.filter((b) => b.checked).map((b) => b.value);
          if (paths.length) run(() => api.post(`/api/workbenches/${wb.id}/repos`, { paths }));
        }
      },
      `Añadir ${fresh.length === 1 ? 'el repo' : 'los seleccionados'}`
    )
  );
}

on('workbenches_changed', () =>
  loadWorkbenches()
    .then(renderManager)
    .catch(() => {})
);
