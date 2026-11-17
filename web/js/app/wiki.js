// Wiki: the project's wiki and the personal one. Explore the pages as a tree, search them, see them
// as a map of their links, and read or edit any page. The agents update them after each task
// (server/knowledge/wikiUpdater.js); this view shows it live.

import { api } from './api.js';
import { h, clear, toast } from './dom.js';
import { on } from './events.js';
import { registerView } from './views.js';
import { currentProjectId } from './workbenches.js';
import { renderMarkdown } from './markdown.js';

const sel = {
  scope: localStorage.getItem('optimia:wiki-scope') === 'personal' ? 'personal' : 'project',
  page: 'index.md',
  mode: 'read', // read | edit | map
  query: ''
};
let root = null;
let data = { wiki: null, pages: [] };
let page = null;
let results = null;
let searchTimer = null;

const params = () => {
  const q = new URLSearchParams({ scope: sel.scope });
  if (sel.scope === 'project') q.set('projectId', currentProjectId());
  return q;
};

async function load() {
  data = await api.get(`/api/wiki?${params()}`);
  if (!data.pages.some((p) => p.path === sel.page)) sel.page = 'index.md';
  await openPage(sel.page, { keepMode: true });
}

async function openPage(path, { keepMode = false } = {}) {
  sel.page = path;
  if (!keepMode || sel.mode === 'edit') sel.mode = sel.mode === 'map' && keepMode ? 'map' : 'read';
  try {
    page = await api.get(`/api/wiki/page?${params()}&${new URLSearchParams({ path })}`);
  } catch (err) {
    page = null;
    toast(err.message, { kind: 'error' });
  }
  render();
}

// [[Page]] and [[Page|text]] become links the view opens itself.
function linkify(text) {
  return text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target, label) => {
    return `[${(label || target).trim()}](#wiki/${encodeURIComponent(target.trim())})`;
  });
}

function resolveLink(target) {
  const t = decodeURIComponent(target).toLowerCase();
  const base = t.replace(/\.md$/, '');
  const name = (p) => p.path.toLowerCase().replace(/\.md$/, '');
  const found =
    data.pages.find((p) => name(p) === base) ||
    data.pages.find((p) => name(p).split('/').pop() === base.split('/').pop()) ||
    data.pages.find((p) => p.title.toLowerCase() === t);
  return found?.path || null;
}

async function paintPage(el) {
  await renderMarkdown(el, linkify(page.content));
  for (const a of el.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    const wikiLink = href.startsWith('#wiki/') ? href.slice(6) : /^[^:]+\.md(#.*)?$/.test(href) ? href : null;
    if (wikiLink === null) continue;
    const target = resolveLink(wikiLink.replace(/#.*$/, ''));
    a.removeAttribute('target');
    if (!target) a.classList.add('wiki-missing');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (target) openPage(target);
      else toast('Esa página aún no existe.');
    });
  }
}

function tree() {
  // Folders first, then pages, with index.md always on top.
  const folders = new Map();
  for (const p of data.pages) {
    const parts = p.path.split('/');
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(p);
  }
  const item = (p) =>
    h(
      'button',
      {
        class: `wiki-item${p.path === sel.page && sel.mode !== 'map' ? ' active' : ''}`,
        title: p.path,
        onclick: () => openPage(p.path)
      },
      p.title
    );
  const top = (folders.get('') || []).sort((a, b) =>
    a.path === 'index.md' ? -1 : b.path === 'index.md' ? 1 : a.title.localeCompare(b.title)
  );
  const groups = [...folders.keys()].filter(Boolean).sort();
  return h(
    'nav',
    { class: 'wiki-tree', 'aria-label': 'Páginas' },
    top.map(item),
    groups.map((g) =>
      h(
        'details',
        { class: 'wiki-folder', open: sel.page.startsWith(`${g}/`) || groups.length < 6 },
        h('summary', {}, g),
        folders
          .get(g)
          .sort((a, b) => a.title.localeCompare(b.title))
          .map(item)
      )
    )
  );
}

function header() {
  return h(
    'div',
    { class: 'wiki-header' },
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Qué wiki' },
      [
        ['project', 'Proyecto'],
        ['personal', 'Personal']
      ].map(([value, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: sel.scope === value ? 'active' : '',
            'aria-pressed': String(sel.scope === value),
            onclick: () => {
              if (sel.scope === value) return;
              sel.scope = value;
              localStorage.setItem('optimia:wiki-scope', value);
              sel.page = 'index.md';
              results = null;
              sel.query = '';
              load().catch((err) => toast(err.message, { kind: 'error' }));
            }
          },
          label
        )
      )
    ),
    h('input', {
      type: 'search',
      class: 'wiki-search',
      placeholder: 'Buscar en la wiki…',
      'aria-label': 'Buscar en la wiki',
      value: sel.query,
      oninput: (e) => {
        sel.query = e.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runSearch, 250);
      }
    }),
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Vista' },
      [
        ['read', 'Página'],
        ['map', 'Mapa']
      ].map(([value, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: (sel.mode === 'edit' ? 'read' : sel.mode) === value ? 'active' : '',
            onclick: () => {
              sel.mode = value;
              render();
            }
          },
          label
        )
      )
    ),
    h(
      'span',
      { class: 'muted wiki-count' },
      `${data.wiki?.title || ''} · ${data.pages.length} ${data.pages.length === 1 ? 'página' : 'páginas'}`
    )
  );
}

async function runSearch() {
  if (!sel.query.trim()) {
    results = null;
    return render();
  }
  try {
    results = (await api.get(`/api/wiki/search?${params()}&${new URLSearchParams({ q: sel.query })}`)).results;
  } catch {
    results = [];
  }
  render();
}

function searchResults() {
  return h(
    'div',
    { class: 'wiki-results' },
    results.length
      ? results.map((r) =>
          h(
            'button',
            {
              class: 'wiki-result',
              onclick: () => {
                results = null;
                sel.query = '';
                openPage(r.path);
              }
            },
            h('strong', {}, r.title),
            h('span', { class: 'muted' }, r.path),
            h('span', { class: 'wiki-snippet' }, r.snippet)
          )
        )
      : h('p', { class: 'muted' }, 'Nada encontrado.')
  );
}

function pageView() {
  if (!page) return h('p', { class: 'muted' }, 'Página no encontrada.');
  if (sel.mode === 'edit') {
    const area = h('textarea', { class: 'wiki-editor', 'aria-label': `Editar ${page.path}`, spellcheck: 'true' });
    area.value = page.content;
    const save = async () => {
      try {
        page = await api.put('/api/wiki/page', {
          scope: sel.scope,
          projectId: currentProjectId(),
          path: page.path,
          content: area.value
        });
        sel.mode = 'read';
        await load();
        toast('Página guardada');
      } catch (err) {
        toast(err.message, { kind: 'error' });
      }
    };
    area.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    });
    return h(
      'div',
      { class: 'wiki-page' },
      h(
        'div',
        { class: 'wiki-page-actions' },
        h('span', { class: 'muted' }, page.path),
        h('button', { type: 'button', onclick: () => ((sel.mode = 'read'), render()) }, 'Cancelar'),
        h('button', { type: 'button', class: 'primary', onclick: save }, 'Guardar')
      ),
      area
    );
  }
  const body = h('article', { class: 'wiki-body' });
  paintPage(body);
  return h(
    'div',
    { class: 'wiki-page' },
    h(
      'div',
      { class: 'wiki-page-actions' },
      h('span', { class: 'muted' }, `${page.path} · ${new Date(page.updatedAt).toLocaleString()}`),
      h('button', { type: 'button', onclick: () => ((sel.mode = 'edit'), render()) }, 'Editar'),
      h('button', { type: 'button', onclick: newPage }, 'Nueva página…'),
      page.path !== 'index.md'
        ? h(
            'button',
            {
              type: 'button',
              class: 'danger',
              onclick: async () => {
                if (!window.confirm(`¿Borrar «${page.title}»?`)) return;
                await api.del('/api/wiki/page', { scope: sel.scope, projectId: currentProjectId(), path: page.path });
                sel.page = 'index.md';
                load();
              }
            },
            'Borrar'
          )
        : null
    ),
    body,
    page.backlinks?.length
      ? h(
          'div',
          { class: 'wiki-backlinks' },
          h('span', { class: 'muted' }, 'Enlazan aquí: '),
          page.backlinks.map((b) => h('button', { class: 'link-button', onclick: () => openPage(b) }, b))
        )
      : null
  );
}

async function newPage() {
  const name = window.prompt('Nombre de la página (puede llevar carpeta, p. ej. guias/despliegue)');
  if (!name) return;
  const path = name.trim().replace(/\s+/g, '-').toLowerCase();
  const title = name.split('/').pop().trim();
  try {
    await api.put('/api/wiki/page', {
      scope: sel.scope,
      projectId: currentProjectId(),
      path,
      content: `# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\n`
    });
    await load();
    const created = data.pages.find((p) => p.path === (path.endsWith('.md') ? path : `${path}.md`));
    if (created) {
      await openPage(created.path);
      sel.mode = 'edit';
      render();
    }
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

// ---------- map: pages as nodes, links as edges (a small force layout, no library) ----------

// Fruchterman-Reingold: nodes repel each other (k²/d), links pull (d²/k), and the step shrinks as
// the layout cools down.
function layout(nodes, edges, width, height) {
  const margin = { x: 80, y: 30 };
  const w = width - 2 * margin.x;
  const ht = height - 2 * margin.y;
  const pos = new Map(
    nodes.map((n, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, nodes.length);
      return [n.id, { x: Math.cos(a) * w * 0.25, y: Math.sin(a) * ht * 0.25 }];
    })
  );
  const k = 0.75 * Math.sqrt((w * ht) / Math.max(1, nodes.length));
  const steps = 250;
  for (let step = 0; step < steps; step++) {
    const temp = (Math.min(w, ht) / 8) * (1 - step / steps);
    const disp = new Map(nodes.map((n) => [n.id, { x: 0, y: 0 }]));
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id);
        const b = pos.get(nodes[j].id);
        const dx = a.x - b.x || 0.1;
        const dy = a.y - b.y || 0.1;
        const d = Math.sqrt(dx * dx + dy * dy);
        const f = (k * k) / d;
        const da = disp.get(nodes[i].id);
        const db = disp.get(nodes[j].id);
        da.x += (dx / d) * f;
        da.y += (dy / d) * f;
        db.x -= (dx / d) * f;
        db.y -= (dy / d) * f;
      }
    }
    for (const e of edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
      const f = (d * d) / k;
      disp.get(e.from).x -= (dx / d) * f;
      disp.get(e.from).y -= (dy / d) * f;
      disp.get(e.to).x += (dx / d) * f;
      disp.get(e.to).y += (dy / d) * f;
    }
    for (const n of nodes) {
      const p = pos.get(n.id);
      const d = disp.get(n.id);
      // Gravity towards the centre (like a link to it, weaker) keeps unlinked pages close.
      const r = Math.sqrt(p.x * p.x + p.y * p.y) || 0.1;
      const g = (r * r) / (k * 3);
      d.x -= (p.x / r) * g;
      d.y -= (p.y / r) * g;
      const len = Math.sqrt(d.x * d.x + d.y * d.y) || 1;
      p.x += (d.x / len) * Math.min(len, temp);
      p.y += (d.y / len) * Math.min(len, temp);
    }
  }
  // Fit the result into the box.
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = maxX > minX ? w / (maxX - minX) : 1;
  const sy = maxY > minY ? ht / (maxY - minY) : 1;
  const scale = Math.min(sx, sy, 1.5);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const p of pos.values()) {
    p.x = width / 2 + (p.x - cx) * scale;
    p.y = height / 2 + (p.y - cy) * scale;
  }
  return pos;
}

function mapView() {
  const host = h('div', { class: 'wiki-map', role: 'img', 'aria-label': 'Mapa de la wiki' });
  api
    .get(`/api/wiki/graph?${params()}`)
    .then((map) => {
      // The maintenance log is not knowledge: it stays out of the map.
      const nodes = map.nodes.filter((n) => n.id !== 'log.md');
      const edges = map.edges.filter((e) => e.from !== 'log.md' && e.to !== 'log.md');
      const width = host.clientWidth || 800;
      const height = Math.max(420, host.clientHeight || 520);
      const pos = layout(nodes, edges, width, height);
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(height));
      const el = (name, attrs) => {
        const node = document.createElementNS(ns, name);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        return node;
      };
      for (const e of edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (a && b) svg.append(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'wiki-edge' }));
      }
      for (const n of nodes) {
        const p = pos.get(n.id);
        const g = el('g', { class: `wiki-node${n.id === sel.page ? ' current' : ''}`, tabindex: '0', role: 'button' });
        g.append(el('circle', { cx: p.x, cy: p.y, r: 5 + Math.min(10, n.links * 1.5) }));
        const label = el('text', { x: p.x, y: p.y - 10 - Math.min(10, n.links * 1.5), 'text-anchor': 'middle' });
        label.textContent = n.title;
        g.append(label);
        const title = el('title', {});
        title.textContent = `${n.title} (${n.links} enlaces)`;
        g.append(title);
        const open = () => {
          sel.mode = 'read';
          openPage(n.id);
        };
        g.addEventListener('click', open);
        g.addEventListener('keydown', (ev) => ev.key === 'Enter' && open());
        svg.append(g);
      }
      host.replaceChildren(svg);
      if (!nodes.length) host.replaceChildren(h('p', { class: 'muted' }, 'La wiki está vacía.'));
    })
    .catch((err) => host.replaceChildren(h('p', { class: 'error-text' }, err.message)));
  return host;
}

function render() {
  if (!root) return;
  clear(root);
  const main = results ? searchResults() : sel.mode === 'map' ? mapView() : pageView();
  root.append(header(), h('div', { class: 'wiki-layout' }, tree(), h('div', { class: 'wiki-main' }, main)));
}

registerView('wiki', {
  label: 'Wiki',
  order: 25,
  mount(el) {
    root = el;
  },
  show() {
    load().catch((err) => {
      clear(root).append(h('p', { class: 'error-text' }, err.message));
    });
  }
});

// Live: the agent (or another window) changed the wiki shown here.
on('wiki_changed', () => {
  if (root && !root.hidden && sel.mode !== 'edit') load().catch(() => {});
});
window.addEventListener('optimia:project-changed', () => {
  if (sel.scope !== 'project') return;
  sel.page = 'index.md';
  results = null;
  if (root && !root.hidden) load().catch(() => {});
});
