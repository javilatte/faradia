'use strict';

// Suggestions while typing: after a short pause, a cheap model (Gemini, the local model or Claude
// Haiku, see server/ai/suggest.js) reads the message and may propose a skill, an agent or a task
// type. They show as chips above the message box; nothing is applied until the user picks one
// (click or Tab). Esc or × dismisses them for that message.

const intentBar = document.createElement('div');
intentBar.className = 'intent-bar';
intentBar.id = 'intent-bar';
intentBar.setAttribute('role', 'group');
intentBar.setAttribute('aria-label', 'Sugerencias para este mensaje');
intentBar.hidden = true;
document.querySelector('.chat-input-row').before(intentBar);

const INTENT_DELAY = 700;
let intentTimer = null;
let intentToken = 0;
let intentItems = [];
let intentDismissed = '';
let intentOff = false;

const intentKey = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');

function hideIntent() {
  intentBar.hidden = true;
  intentBar.replaceChildren();
  intentItems = [];
}

function intentLabel(s) {
  if (s.kind === 'skill') return `Usar /${s.id}`;
  if (s.kind === 'agent') return `Encargar a @${s.id.replace(/^ecc-/, '')}`;
  const opt = [...chatKindSelect.options].find((o) => o.value === s.id);
  return `Tarea: ${opt ? opt.textContent : s.id}`;
}

async function applyIntent(i) {
  const s = intentItems[i];
  if (!s) return;
  hideIntent();
  intentDismissed = intentKey(input.value);
  reportIssue('suggest.accepted', { kind: s.kind, id: s.id, position: i }, 'signal');
  if (s.kind === 'skill') {
    if (!new RegExp(`(^|\\s)/${s.id}(\\s|$)`).test(input.value)) input.value = `/${s.id} ${input.value.trimStart()}`;
    input.dispatchEvent(new Event('input'));
  } else if (s.kind === 'task') {
    chatKindSelect.value = s.id;
    chatKindSelect.dispatchEvent(new Event('change'));
  } else {
    await pickAgent({ slug: s.id, name: s.id, enabled: false }, { start: 0, end: 0 });
  }
  input.focus();
}

function renderIntent() {
  intentBar.replaceChildren(
    ...intentItems.map((s, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'intent-chip';
      chip.title = s.description || '';
      const label = document.createElement('span');
      label.className = 'intent-label';
      label.textContent = intentLabel(s);
      chip.append(label);
      if (s.reason) {
        const why = document.createElement('span');
        why.className = 'intent-reason';
        why.textContent = s.reason;
        chip.append(why);
      }
      if (i === 0) {
        const kbd = document.createElement('kbd');
        kbd.textContent = 'Tab';
        chip.append(kbd);
      }
      // mousedown: keeps the focus in the message box.
      chip.addEventListener('mousedown', (e) => e.preventDefault());
      chip.addEventListener('click', () => applyIntent(i));
      return chip;
    }),
    (() => {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'intent-close';
      close.setAttribute('aria-label', 'Descartar sugerencias');
      close.title = 'Descartar (Esc)';
      close.textContent = '×';
      close.addEventListener('mousedown', (e) => e.preventDefault());
      close.addEventListener('click', () => {
        reportIssue('suggest.dismissed', { shown: intentItems.map((x) => `${x.kind}:${x.id}`) }, 'signal');
        intentDismissed = intentKey(input.value);
        hideIntent();
      });
      return close;
    })()
  );
  intentBar.hidden = intentItems.length === 0;
}

async function fetchIntent(text, token) {
  try {
    const res = await fetch(apiPath('/api/suggest'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (token !== intentToken || intentKey(input.value) !== intentKey(text)) return;
    intentOff = Boolean(data.off);
    // A task type already chosen in "Modo" is not worth proposing.
    intentItems = (data.suggestions || []).filter((s) => !(s.kind === 'task' && s.id === chatKindSelect.value));
    renderIntent();
  } catch {
    /* no suggestions this time */
  }
}

function scheduleIntent() {
  clearTimeout(intentTimer);
  const text = input.value;
  const key = intentKey(text);
  // Changing the message hides the previous chips (they were for another text).
  if (intentItems.length) hideIntent();
  if (intentOff) return;
  if (!key || key === intentDismissed || /^[@/]/.test(key) || key.split(' ').length < 4) return;
  const token = ++intentToken;
  intentTimer = setTimeout(() => fetchIntent(text, token), INTENT_DELAY);
}

input.addEventListener('input', scheduleIntent);
input.addEventListener(
  'keydown',
  (e) => {
    if (intentBar.hidden || !skillSuggest.hidden) return;
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      applyIntent(0);
    } else if (e.key === 'Escape') {
      reportIssue('suggest.dismissed', { shown: intentItems.map((x) => `${x.kind}:${x.id}`) }, 'signal');
      intentDismissed = intentKey(input.value);
      hideIntent();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      hideIntent();
    }
  },
  true
);
document.getElementById('send-button').addEventListener('click', hideIntent);
// Settings may turn suggestions back on.
window.addEventListener('focus', () => {
  intentOff = false;
});
