// Vistas principales. "project" es la vista clasica (chat + agentes, en
// web/js/project/); el resto son modulos que se registran aqui y se montan la
// primera vez que se abren. La vista actual va en el hash: #/dashboard, #/timeline...

const registry = new Map(); // name -> { label, mount, show, hide, mounted, el }
let current = null;

export function registerView(name, { label, order = 100, mount, show, hide }) {
  registry.set(name, { label, order, mount, show, hide, mounted: false, el: null });
}

export function viewNames() {
  return ['project', ...[...registry.entries()].sort((a, b) => a[1].order - b[1].order).map(([k]) => k)];
}

export function viewLabel(name) {
  return name === 'project' ? 'Proyecto' : registry.get(name)?.label || name;
}

export function currentView() {
  return current;
}

export function showView(name, ctx) {
  if (name !== 'project' && !registry.has(name)) name = 'project';
  const projectEl = document.getElementById('project-view');
  if (current && current !== name) registry.get(current)?.hide?.();
  projectEl.hidden = name !== 'project';
  for (const [key, view] of registry) {
    if (view.el) view.el.hidden = key !== name;
  }
  if (name !== 'project') {
    const view = registry.get(name);
    if (!view.mounted) {
      view.el = document.createElement('main');
      view.el.className = `view view-${name}`;
      view.el.dataset.view = name;
      document.getElementById('views').append(view.el);
      view.mount(view.el, ctx);
      view.mounted = true;
    }
    view.el.hidden = false;
    view.show?.(ctx);
  }
  current = name;
  document.querySelectorAll('#main-nav [data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
    b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false');
  });
  const hash = name === 'project' ? '' : `#/${name}`;
  if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

export function viewFromHash() {
  const m = /^#\/([a-z-]+)/.exec(location.hash);
  return m ? m[1] : 'project';
}
