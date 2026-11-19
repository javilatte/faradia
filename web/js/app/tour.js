// "What's new": a short, optional tour in a sheet. On the first run it shows how optimia works and
// helps connect an AI; after an update, only what changed since the version the user last saw.
// Nothing to download: a few cards of text with small inline icons. Esc or "Saltar" closes it.

import { h } from './dom.js';
import { api, projectApi } from './api.js';
import { currentProjectId } from './workbenches.js';

const ICONS = {
  plug: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v5',
  chat: 'M4 5h16v11H8l-4 4V5z',
  agents:
    'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 3-5 6-5s6 2 6 5M14 15c3 0 8 1 8 5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4',
  book: 'M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4V4zM20 4h-7a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h7V4z',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18',
  swap: 'M4 8h13l-4-4M20 16H7l4 4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'tour-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.spark);
  svg.append(path);
  return svg;
}

function openPane(pane) {
  window.openSettingsPane?.(pane);
  document.querySelector(`.settings-nav-item[data-pane="${pane}"]`)?.click();
}

// The first card of the first run: which AI is ready, and one click to connect the rest.
function connectCard() {
  const rows = h('ul', { class: 'tour-connect' });
  const row = (name, state, ok, action) =>
    h(
      'li',
      {},
      h('span', { class: `tour-dot ${ok ? 'ok' : ''}`, 'aria-hidden': 'true' }),
      h('span', { class: 'tour-connect-name' }, name),
      h('span', { class: 'tour-connect-state' }, state),
      action ? h('button', { type: 'button', onclick: action.run }, action.label) : null
    );
  (async () => {
    const pid = currentProjectId();
    const [auth, settings] = await Promise.all([
      pid ? api.get(projectApi(pid, '/claude-auth')).catch(() => ({})) : {},
      pid ? api.get(projectApi(pid, '/settings')).catch(() => ({})) : {}
    ]);
    const local = settings.ai?.localAi || {};
    rows.replaceChildren(
      row(
        'Claude',
        auth.loggedIn ? 'Conectado' : 'Sin sesión',
        auth.loggedIn,
        auth.loggedIn
          ? null
          : {
              label: 'Iniciar sesión…',
              run: () => pid && api.post(projectApi(pid, '/claude-auth/login')).catch(() => {})
            }
      ),
      row(
        'Modelo local',
        local.url && local.model ? local.model : 'Ollama o LM Studio',
        Boolean(local.url && local.model),
        local.url ? null : { label: 'Detectar…', run: () => openPane('local-ai') }
      )
    );
  })();
  return rows;
}

// Cards for a first run.
const INTRO = [
  {
    icon: 'plug',
    title: 'Conecta una IA y listo',
    text: 'Con una basta. Si Claude se queda sin uso, optimia sigue con tu modelo local sin perder la conversación, y vuelve a Claude cuando se renueva.',
    extra: connectCard
  },
  {
    icon: 'chat',
    title: 'Pide en el chat',
    text: 'Mientras escribes, optimia te sugiere la skill, el agente o el tipo de tarea que encaja. Tab para usarla. Con @ llamas a un agente y con / a una skill.'
  },
  {
    icon: 'agents',
    title: 'Los agentes trabajan aparte',
    text: 'Cada tarea va en su propio worktree: un agente planifica, otro implementa y otro verifica. Tu rama no se toca hasta que tú haces el commit o la PR.'
  },
  {
    icon: 'shield',
    title: 'Lo arriesgado lo decides tú',
    text: 'Lo seguro se hace sin preguntar. Lo demás aparece como una tarjeta en el chat: Permitir, Permitir siempre o Denegar.'
  },
  {
    icon: 'book',
    title: 'Una wiki que se escribe sola',
    text: 'En Wiki, «Generar desde el repo» documenta el proyecto, y tras cada tarea los agentes apuntan lo que aprendieron. Todo se ajusta en Ajustes cuando quieras.'
  }
];

// What changed in each version (newest last). Only versions newer than the one seen are shown.
const NEWS = [
  {
    version: '2.3.0',
    cards: [
      {
        icon: 'swap',
        title: 'Sin cortes si Claude se agota',
        text: 'Si Claude se queda sin uso, el chat y las tareas siguen con tu modelo local en la misma sesión, con todo su contexto, y vuelven a Claude cuando se renueva.',
        action: { label: 'Configurar la IA local…', run: () => openPane('local-ai') }
      },
      {
        icon: 'spark',
        title: 'Sugerencias mientras escribes',
        text: 'optimia propone la skill, el agente o el tipo de tarea que encaja con tu mensaje. Tab para aceptarla, Esc para descartarla.'
      },
      {
        icon: 'shield',
        title: 'Permisos en el chat, no en la terminal',
        text: 'Cuando el agente necesita permiso, lo pide con una tarjeta en la conversación. En modo automático solo pregunta lo arriesgado.'
      },
      {
        icon: 'swap',
        title: 'Tu configuración en todos tus equipos',
        text: 'Actívalo en Ajustes › Sincronización con una carpeta que ya sincronices. Se cifra en tu equipo con una frase que solo tú conoces antes de salir.',
        action: { label: 'Activar sincronización…', run: () => openPane('sync') }
      },
      {
        icon: 'list',
        title: 'Skills de serie',
        text: 'ponytail (la solución más simple que funcione), frontend-craft, unslop, security-audit y plan-optimizer vienen activadas para el chat y los agentes. Las encontrarás en Ajustes › Skills.'
      }
    ]
  }
];

const cmp = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/** Cards of the versions after `seen` up to `current`. */
export function newsSince(seen, current) {
  return NEWS.filter((n) => (!seen || cmp(n.version, seen) > 0) && cmp(n.version, current) <= 0).flatMap(
    (n) => n.cards
  );
}

export function showTour({ cards, title }) {
  if (!cards.length) return;
  let index = 0;
  const card = h('div', { class: 'tour-card', 'aria-live': 'polite' });
  const dots = h('div', { class: 'tour-dots', 'aria-hidden': 'true' });
  const back = h('button', { type: 'button' }, 'Anterior');
  const next = h('button', { type: 'button', class: 'primary' }, 'Siguiente');
  const skip = h('button', { type: 'button', class: 'tour-skip' }, 'Saltar');
  const sheet = h(
    'div',
    { class: 'sheet tour-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title' },
    h('div', { class: 'tour-head' }, h('h2', { class: 'sheet-title', id: 'tour-title' }, title), skip),
    card,
    h('div', { class: 'sheet-actions tour-actions' }, dots, back, next)
  );
  const overlay = h('div', { class: 'sheet-overlay' }, sheet);
  const done = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    api.post('/api/config/tour').catch(() => {});
  };
  const paint = () => {
    const c = cards[index];
    card.replaceChildren(
      ...[
        icon(c.icon),
        h('h3', {}, c.title),
        h('p', {}, c.text),
        c.extra ? c.extra() : null,
        c.action
          ? h(
              'button',
              { type: 'button', class: 'tour-action', onclick: () => (done(), c.action.run()) },
              c.action.label
            )
          : null
      ].filter(Boolean)
    );
    dots.replaceChildren(...cards.map((_, i) => h('span', { class: i === index ? 'on' : '' })));
    back.hidden = index === 0;
    next.textContent = index === cards.length - 1 ? 'Empezar' : 'Siguiente';
    sheet.setAttribute('aria-label', `${index + 1} de ${cards.length}`);
  };
  back.addEventListener('click', () => {
    index = Math.max(0, index - 1);
    paint();
  });
  next.addEventListener('click', () => {
    if (index === cards.length - 1) return done();
    index++;
    paint();
  });
  skip.addEventListener('click', done);
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      done();
    } else if (e.key === 'ArrowRight' && e.target.tagName !== 'INPUT') next.click();
    else if (e.key === 'ArrowLeft' && e.target.tagName !== 'INPUT' && index > 0) back.click();
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  paint();
  next.focus();
}

export function showIntroTour() {
  showTour({ cards: INTRO, title: 'Así funciona optimia' });
}

/** After an update: the news since the version last seen, once. */
export function maybeShowNews(status) {
  const cards = newsSince(status.tourSeen, status.version);
  if (cards.length) showTour({ cards, title: `Novedades de optimia ${status.version}` });
  else if (status.tourSeen !== status.version) api.post('/api/config/tour').catch(() => {});
}

export function showAllNews(version) {
  const cards = newsSince(null, version);
  showTour({
    cards: cards.length ? cards : INTRO,
    title: cards.length ? `Novedades de optimia ${version}` : 'Así funciona optimia'
  });
}
