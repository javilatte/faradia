// Punto de entrada de la carcasa: selector de workbench/repo, navegacion entre
// vistas y canal de eventos globales. Las vistas se registran importando su modulo.

import { connectEvents } from './events.js';
import { loadWorkbenches, state } from './workbenches.js';
import { viewNames, viewLabel, showView, viewFromHash } from './views.js';
import { h } from './dom.js';
import './markdown.js';
import './agents.js';
import './dashboard.js';
import './changes.js';
import './timeline.js';
import './signals.js';
import './files.js';

const ctx = { state };

// Iconos de la barra lateral (trazo fino, al estilo de los símbolos de macOS).
const NAV_ICONS = {
  project: 'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 10h8M8 13h5',
  dashboard: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  changes: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M13 10v6M10 18h6',
  timeline: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  files: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
};

function navIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    width: '16',
    height: '16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.7',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true'
  }))
    svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', NAV_ICONS[name] || NAV_ICONS.files);
  svg.append(path);
  return svg;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const VIEW_KEY = isMac ? '⌥' : 'Alt+';

function renderNav() {
  const nav = document.getElementById('main-nav');
  nav.replaceChildren(
    ...viewNames().map((name, i) =>
      h(
        'button',
        {
          class: 'main-nav-item sidebar-item',
          dataset: { view: name },
          title: `${viewLabel(name)} (${VIEW_KEY}${i + 1})`,
          onclick: () => showView(name, ctx)
        },
        navIcon(name),
        h('span', { class: 'sidebar-item-label' }, viewLabel(name))
      )
    )
  );
}

// Barra lateral plegable (botón de la barra de herramientas o ⌃⌘S / Ctrl+Alt+S).
function setSidebar(open) {
  document.getElementById('app-window')?.classList.toggle('sidebar-hidden', !open);
  document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', String(open));
  try {
    localStorage.setItem('optimia:sidebar', open ? '1' : '0');
  } catch {
    /* sin persistencia */
  }
}
function sidebarOpen() {
  return !document.getElementById('app-window')?.classList.contains('sidebar-hidden');
}

// Atajos: ⌥1…⌥5 (Alt en Linux y Windows) cambian de vista —⌘1…⌘8 los reserva el
// navegador para sus pestañas—, ⌘, abre Ajustes y ⌃⌘S (Ctrl+Alt+S) pliega la barra lateral.
function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && e.key === ',') {
      e.preventDefault();
      document.getElementById('settings-button')?.click();
      return;
    }
    const sidebarCombo = isMac ? e.metaKey && e.ctrlKey : e.ctrlKey && e.altKey;
    if (sidebarCombo && e.code === 'KeyS') {
      e.preventDefault();
      setSidebar(!sidebarOpen());
      return;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
      const names = viewNames();
      const n = Number(e.code.slice(5));
      if (n <= names.length) {
        e.preventDefault();
        showView(names[n - 1], ctx);
      }
    }
  });
}

async function boot() {
  connectEvents();
  document
    .getElementById('glance-button')
    ?.addEventListener('click', () => window.open('/glance.html', 'optimia-glance', 'popup,width=420,height=300'));
  renderNav();
  bindShortcuts();
  let open = true;
  try {
    open = localStorage.getItem('optimia:sidebar') !== '0';
  } catch {
    /* sin persistencia */
  }
  // En ventanas estrechas la barra lateral empieza plegada (como Mail o Finder).
  if (window.innerWidth < 900) open = false;
  setSidebar(open);
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => setSidebar(!sidebarOpen()));
  try {
    await loadWorkbenches();
  } catch (err) {
    console.error('optimia: no se pudieron cargar los workbenches', err);
  }
  showView(viewFromHash(), ctx);
  window.addEventListener('hashchange', () => showView(viewFromHash(), ctx));
}

boot();
