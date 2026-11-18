'use strict';

// Settings › Gemini: connect a Google AI Studio key in three steps (open AI Studio, paste the key,
// pick a model) and choose how the chat suggestions work. The key is checked against Google before
// it is saved, and it never comes back to the page (only its last characters).

const geminiPane = document.getElementById('gemini-pane');
const AI_STUDIO_URL = 'https://aistudio.google.com/apikey';
let geminiModels = [];
let geminiRecommended = '';
let geminiError = '';
let geminiBusy = false;

// Small DOM builder: gEl('div', {class, onclick…}, ...children). null/false attributes are left out.
function gEl(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== '' && c !== null && c !== undefined) node.append(c);
  return node;
}

async function geminiSettings() {
  const res = await fetch(apiPath('/api/settings'));
  return res.json();
}

async function saveGemini(patch) {
  await patchSettings({ scope: 'global', providers: { gemini: patch } });
}

async function checkGeminiKey(apiKey) {
  geminiBusy = true;
  geminiError = '';
  renderGeminiPane();
  try {
    const res = await fetch('/api/providers/gemini/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    geminiModels = data.models;
    geminiRecommended = data.recommended;
    const s = await geminiSettings();
    const model = s.providers.gemini.model && geminiModels.some((m) => m.id === s.providers.gemini.model);
    await saveGemini({ ...(apiKey ? { apiKey } : {}), ...(model ? {} : { model: geminiRecommended }) });
  } catch (err) {
    geminiError = err.message;
  } finally {
    geminiBusy = false;
    renderGeminiPane();
  }
}

function step(n, state, title, body) {
  return gEl(
    'li',
    { class: `gemini-step ${state}`, 'aria-current': state === 'current' ? 'step' : null },
    gEl('span', { class: 'gemini-step-mark', 'aria-hidden': 'true' }, state === 'done' ? '✓' : String(n)),
    gEl('div', { class: 'gemini-step-body' }, gEl('strong', {}, title), ...body)
  );
}

async function renderGeminiPane() {
  const s = await geminiSettings();
  const g = s.providers.gemini;
  if (g.hasKey && !geminiModels.length && !geminiBusy && !geminiError) {
    // A saved key: list its models once (also tells if it still works).
    checkGeminiKey('');
    return;
  }
  const keyInput = gEl('input', {
    type: 'password',
    id: 'gemini-key',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: g.hasKey ? `Clave guardada (${g.keyHint}). Pega otra para cambiarla` : 'AIza…',
    'aria-label': 'API key de Gemini'
  });
  const check = () => {
    const v = keyInput.value.trim();
    if (v || g.hasKey) checkGeminiKey(v);
  };
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') check();
  });
  keyInput.addEventListener('paste', () => setTimeout(check, 0));
  const keyOk = g.hasKey && geminiModels.length > 0 && !geminiError;
  const modelSelect = gEl(
    'select',
    {
      id: 'gemini-model',
      disabled: !keyOk,
      onchange: (e) => saveGemini({ model: e.target.value })
    },
    ...geminiModels.map((m) =>
      gEl(
        'option',
        { value: m.id, selected: m.id === g.model },
        `${m.name}${m.id === geminiRecommended ? ' · recomendado' : ''}`
      )
    )
  );
  geminiPane.replaceChildren(
    gEl(
      'p',
      { class: 'muted settings-help' },
      'Gemini de Google con una clave gratuita de AI Studio. optimia lo usa para las sugerencias del chat, como IA principal si lo eliges en el chat y como respaldo cuando Claude se queda sin uso.'
    ),
    gEl(
      'ol',
      { class: 'gemini-steps' },
      step(1, g.hasKey ? 'done' : 'current', 'Abre Google AI Studio', [
        gEl('span', { class: 'muted' }, 'Entra con tu cuenta de Google.'),
        gEl(
          'a',
          { class: 'button-link', href: AI_STUDIO_URL, target: '_blank', rel: 'noopener noreferrer' },
          'Abrir aistudio.google.com ↗'
        )
      ]),
      step(2, keyOk ? 'done' : g.hasKey || geminiError ? 'current' : 'next', 'Pulsa «Get API key» y pega la clave', [
        gEl('span', { class: 'muted' }, 'Se comprueba con Google antes de guardarla. Solo se guarda en este equipo.'),
        gEl(
          'div',
          { class: 'gemini-key-row' },
          keyInput,
          gEl(
            'button',
            { type: 'button', onclick: check, disabled: geminiBusy },
            geminiBusy ? 'Comprobando…' : 'Comprobar'
          )
        ),
        geminiError ? gEl('div', { class: 'error-text', role: 'alert' }, geminiError) : ''
      ]),
      step(3, keyOk && g.model ? 'done' : keyOk ? 'current' : 'next', 'Elige el modelo', [
        gEl(
          'span',
          { class: 'muted' },
          keyOk ? `${geminiModels.length} modelos disponibles con tu clave.` : 'Aparecen al comprobar la clave.'
        ),
        modelSelect
      ])
    ),
    g.hasKey
      ? gEl(
          'div',
          { class: 'general-actions' },
          gEl(
            'button',
            {
              type: 'button',
              onclick: async () => {
                geminiModels = [];
                geminiError = '';
                await saveGemini({ apiKey: '', model: '' });
                renderGeminiPane();
              }
            },
            'Quitar la clave'
          )
        )
      : '',
    gEl(
      'div',
      { class: 'settings-field' },
      gEl('label', { for: 'suggestions-mode' }, 'Sugerencias mientras escribes'),
      gEl(
        'select',
        {
          id: 'suggestions-mode',
          onchange: (e) => patchSettings({ scope: 'global', suggestions: { mode: e.target.value } })
        },
        gEl(
          'option',
          { value: 'auto', selected: s.suggestions.mode !== 'off' },
          'Activadas: Gemini, luego IA local, luego Claude Haiku'
        ),
        gEl('option', { value: 'off', selected: s.suggestions.mode === 'off' }, 'Desactivadas')
      ),
      gEl(
        'span',
        { class: 'muted' },
        'Tras una pausa al escribir, un modelo rápido propone una skill, un agente o un tipo de tarea. Nunca se aplica solo.'
      )
    )
  );
}

document.querySelector('.settings-nav-item[data-pane="gemini"]').addEventListener('click', () => {
  geminiError = '';
  renderGeminiPane();
});
