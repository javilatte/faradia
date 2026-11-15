// Main views. "project" is the classic view (chat + agents, in web/js/project/); the others are
// modules that register here and are mounted the first time they open. The current view goes in the
// hash: #/dashboard, #/timeline...

const registry = new Map(); // name -> { label, mount, show, hide, mounted, el }
let current = null;

export function registerView(name, { label, order = 100, mount, show, hide }) {
  registry.set(name, { label, order, mount, show, hide, mounted: false, el: null });
}

export function viewNames() {
  return ['project', ...[...registry.entries()].sort((a, b) => a[1].order - b[1].order).map(([k]) => k)];
}

export function viewLabel(name) {
  return name === 'project' ? 'Chat y agentes' : registry.get(name)?.label || name;
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
  const title = document.getElementById('view-title');
  if (title) title.textContent = viewLabel(name);
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
