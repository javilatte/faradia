'use strict';

// The problem report (server/feedback/issues.js) from the page side:
//   - errors in the page itself (exceptions, rejected promises) and the errors the server sends to
//     the chat or the agents panel are recorded;
//   - Settings › Registro shows "Problemas detectados": each kind of problem once, with how often
//     it happened, and lets the user export the report to share it, or empty it.

function reportIssue(event, data = {}, level = 'error') {
  try {
    fetch('/api/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, event, data }),
      keepalive: true
    }).catch(() => {});
  } catch {
    /* never in the way */
  }
}

// The same error repeated in a loop is reported once a minute.
const reportedRecently = new Map();
function reportOnce(event, data) {
  const key = `${event}|${data.message || data.error || ''}`;
  const last = reportedRecently.get(key) || 0;
  if (Date.now() - last < 60_000) return;
  reportedRecently.set(key, Date.now());
  reportIssue(event, data);
}

window.addEventListener('error', (e) => {
  if (!e.message) return;
  reportOnce('web.exception', {
    message: e.message,
    where: `${(e.filename || '').replace(location.origin, '')}:${e.lineno}:${e.colno}`
  });
});
window.addEventListener('unhandledrejection', (e) => {
  reportOnce('web.rejection', { message: String(e.reason?.message || e.reason || 'unknown') });
});

const issuesPane = document.getElementById('issues-pane');

function issueEl(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== '') node.append(c);
  return node;
}

function issueWhen(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(window.optimiaLang?.locale || 'es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function issueDetail(sample) {
  if (!sample || typeof sample !== 'object') return '';
  const main = sample.error || sample.message || sample.reason || '';
  const rest = Object.entries(sample)
    .filter(([k]) => !['error', 'message', 'reason'].includes(k))
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');
  return [main, rest].filter(Boolean).join(' — ');
}

async function renderIssues() {
  const data = await fetch('/api/issues')
    .then((r) => r.json())
    .catch(() => null);
  if (!data) return;
  const accepted = Object.entries(data.signals || {})
    .filter(([k]) => k.startsWith('suggest.accepted'))
    .reduce((n, [, v]) => n + v, 0);
  const dismissed = data.signals?.['suggest.dismissed'] || 0;
  issuesPane.replaceChildren(
    issueEl(
      'div',
      { class: 'settings-field' },
      issueEl('label', {}, 'Problemas detectados'),
      issueEl(
        'span',
        { class: 'muted' },
        data.total
          ? `${data.total} incidencias de ${data.groups.length} tipos, en todos los repos. Se guardan solo en este equipo, sin claves ni el texto de tus mensajes.`
          : 'Ningún problema registrado. Si algo falla, aparecerá aquí agrupado por tipo.'
      ),
      data.groups.length
        ? issueEl(
            'ul',
            { class: 'issue-list' },
            data.groups
              .slice(0, 12)
              .map((g) =>
                issueEl(
                  'li',
                  { class: `issue-row ${g.level}` },
                  issueEl(
                    'div',
                    { class: 'issue-head' },
                    issueEl('code', {}, g.event),
                    issueEl('span', { class: 'issue-count' }, `×${g.count}`),
                    issueEl('span', { class: 'muted issue-when' }, issueWhen(g.last))
                  ),
                  issueEl('div', { class: 'muted issue-detail' }, issueDetail(g.sample))
                )
              )
          )
        : '',
      accepted + dismissed
        ? issueEl('span', { class: 'muted' }, `Sugerencias del chat: ${accepted} aceptadas y ${dismissed} descartadas.`)
        : '',
      issueEl(
        'div',
        { class: 'general-actions' },
        issueEl('a', { class: 'button-link', href: '/api/issues/export', download: '' }, 'Exportar informe…'),
        data.total
          ? issueEl(
              'button',
              {
                type: 'button',
                onclick: async () => {
                  await fetch('/api/issues', { method: 'DELETE' });
                  renderIssues();
                }
              },
              'Vaciar'
            )
          : ''
      )
    )
  );
}

document.querySelector('.settings-nav-item[data-pane="registro"]').addEventListener('click', renderIssues);
