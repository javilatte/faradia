// Punto de entrada de la carcasa: selector de workbench/repo, navegacion entre
// vistas y canal de eventos globales. Las vistas se registran importando su modulo.

import { connectEvents } from './events.js';
import { loadWorkbenches, state } from './workbenches.js';
import { viewNames, viewLabel, showView, viewFromHash } from './views.js';
import { h } from './dom.js';
import './agents.js';

const ctx = { state };

function renderNav() {
  const nav = document.getElementById('main-nav');
  nav.replaceChildren(
    ...viewNames().map((name) =>
      h(
        'button',
        { class: 'main-nav-item', dataset: { view: name }, onclick: () => showView(name, ctx) },
        viewLabel(name)
      )
    )
  );
}

async function boot() {
  connectEvents();
  renderNav();
  try {
    await loadWorkbenches();
  } catch (err) {
    console.error('optimia: no se pudieron cargar los workbenches', err);
  }
  showView(viewFromHash(), ctx);
  window.addEventListener('hashchange', () => showView(viewFromHash(), ctx));
}

boot();
