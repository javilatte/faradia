// "What's new": a short, optional tour in a sheet. On the first run it shows how Faradia works and
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
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  cloud: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 4.25 4.25 0 0 0 7 18zM12 12v4M10 14l2-2 2 2',
  check: 'M4 4h16v16H4zM8 12l3 3 5-6',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  scissors: 'M6 6a2 2 0 1 0 0 .01M6 18a2 2 0 1 0 0 .01M8 7l12 10M8 17L20 7',
  mic: 'M9 3h6v11H9zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14'
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
    text: 'Con una basta. Si Claude se queda sin uso, Faradia sigue con tu modelo local sin perder la conversación, y vuelve a Claude cuando se renueva.',
    extra: connectCard
  },
  {
    icon: 'chat',
    title: 'Pide en el chat',
    text: 'Mientras escribes, Faradia te sugiere la skill, el agente o el tipo de tarea que encaja. Tab para usarla. Con @ llamas a un agente y con / a una skill.'
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
    version: '3.0.0',
    cards: [
      {
        icon: 'spark',
        title: 'optimia ahora es Faradia',
        text: 'Crea código de calidad automatizando tus procesos y multiplica tu productividad sin perder las riendas de tu trabajo. Es la misma app con otro nombre (ya había otras cosas llamadas Optimia): tus ajustes, agentes y repos se han movido solos.'
      },
      {
        icon: 'plug',
        title: 'Instala el paquete faradia',
        text: 'A partir de ahora: npm i -g faradia, y arráncalo con faradia. El paquete optimia seguirá actualizándose unos meses más y abre Faradia, pero dejará de hacerlo.'
      },
      {
        icon: 'mic',
        title: 'Habla en vez de escribir',
        text: 'Pulsa el micrófono junto al cuadro de mensaje y dicta en español o en inglés: el texto aparece en el cuadro para que lo revises antes de enviarlo. Se transcribe en tu equipo, sin cuentas ni pagos: en un Mac con el reconocimiento de voz de macOS y en Linux y Windows con Whisper.',
        action: { label: 'Ajustes del dictado…', run: () => openPane('voice') }
      },
      {
        icon: 'map',
        title: 'Mapa del código',
        text: 'Con CodeGraph activado, la wiki del repo tiene un mapa del código: las piezas más usadas y qué zona depende de cuál. Se actualiza solo después de cada tarea, y «Conocer este repo» y la wiki parten de él en vez de leer el repo a ciegas.'
      }
    ]
  },
  {
    version: '2.4.0',
    cards: [
      {
        icon: 'lock',
        title: 'Que no vuelva a pasar',
        text: 'Cuando un agente se equivoque, crea una tarea de Corrección: el error se convierte en una comprobación que falla (arquitectura, tipos, lint o test) y se demuestra con el error real. Mejor que una línea más en las instrucciones.'
      },
      {
        icon: 'eye',
        title: 'Evidencia, no palabras',
        text: 'La verificación guarda cada comando que ejecutó el agente con su resultado y sus capturas. Si dice «OK» pero los tests fallaron, Faradia no se lo cree.'
      },
      {
        icon: 'scissors',
        title: 'Sin comentarios de apaño',
        text: 'Una pasada nueva quita los comentarios que narran el código o justifican un parche, y propone una comprobación para cada regla que defendían.'
      },
      {
        icon: 'check',
        title: 'Principios en cada agente',
        text: 'Los agentes trabajan con los principios de pstack de Lauren Tan (demostrar que funciona, arreglar la causa raíz, restar antes de sumar…) y dicen cuál cambió una decisión.',
        action: { label: 'Ver los agentes…', run: () => openPane('agents') }
      }
    ]
  },
  {
    version: '2.3.0',
    cards: [
      {
        icon: 'spark',
        title: 'Sugerencias mientras escribes',
        text: 'faradia propone la skill, el agente o el tipo de tarea que encaja con tu mensaje. Tab para aceptarla, Esc para descartarla.'
      },
      {
        icon: 'shield',
        title: 'Permisos en el chat, no en la terminal',
        text: 'Cuando el agente necesita permiso, lo pide con una tarjeta en la conversación. En modo automático solo pregunta lo arriesgado.'
      },
      {
        icon: 'archive',
        title: 'Archivo de tareas',
        text: 'Las tareas terminadas quedan en el Archivo del tablero, con su resultado, sus agentes y su informe. Tú decides cuánto se guardan.'
      },
      {
        icon: 'cloud',
        title: 'Tu configuración en todos tus equipos',
        text: 'Actívalo en Ajustes › Sincronización con una carpeta que ya sincronices. Se cifra en tu equipo con una frase que solo tú conoces antes de guardarla.',
        action: { label: 'Activar sincronización…', run: () => openPane('sync') }
      },
      {
        icon: 'list',
        title: 'Skills de serie',
        text: 'ponytail (la solución más simple que funcione), frontend-craft, unslop, security-audit y plan-optimizer vienen activadas para el chat y los agentes. Las encontrarás en Ajustes › Skills.'
      },
      {
        icon: 'swap',
        title: 'Sin cortes si Claude se agota',
        text: 'Si Claude se queda sin uso, el chat y las tareas siguen con tu modelo local en la misma sesión, con todo su contexto, y vuelven a Claude cuando se renueva.',
        action: { label: 'Configurar la IA local…', run: () => openPane('local-ai') }
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
  showTour({ cards: INTRO, title: 'Así funciona faradia' });
}

/** After an update: the news since the version last seen, once. */
export function maybeShowNews(status) {
  const cards = newsSince(status.tourSeen, status.version);
  if (cards.length) showTour({ cards, title: `Novedades de Faradia ${status.version}` });
  else if (status.tourSeen !== status.version) api.post('/api/config/tour').catch(() => {});
}

export function showAllNews(version) {
  const cards = newsSince(null, version);
  showTour({
    cards: cards.length ? cards : INTRO,
    title: cards.length ? `Novedades de Faradia ${version}` : 'Así funciona faradia'
  });
}
