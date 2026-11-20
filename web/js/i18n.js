'use strict';

// optimia is now Faradia: the preferences this browser kept under the old name are carried over
// (once; the old keys are left as they were).
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('optimia:')) continue;
    const next = `faradia:${key.slice('optimia:'.length)}`;
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key));
  }
} catch {
  /* no storage */
}
/* global window, document, navigator, localStorage, location, Node, MutationObserver */

// Interface language. Settings › Appearance › Language picks Spanish, English or Automatic (the
// browser's language). The interface is written in Spanish; in English, the visible text and the
// placeholder, title and aria-label attributes are swapped with the dictionary in i18n-en.js, also
// for what is painted later (a MutationObserver). What the user, the agents or the wiki write
// (chat messages, reports, pages, inputs) is never touched.

(function () {
  const KEY = 'faradia:lang';
  function choice() {
    try {
      return localStorage.getItem(KEY) || 'auto';
    } catch {
      return 'auto';
    }
  }
  function resolve(pref) {
    if (pref === 'es' || pref === 'en') return pref;
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'es';
    return nav.toLowerCase().startsWith('es') ? 'es' : 'en';
  }

  const lang = resolve(choice());
  window.faradiaLang = {
    current: lang,
    // Locale for dates and numbers, in the interface's language.
    locale: lang === 'en' ? 'en-US' : 'es-ES',
    choice: choice(),
    set(pref) {
      try {
        localStorage.setItem(KEY, pref);
      } catch {
        /* not persisted */
      }
      location.reload();
    }
  };
  document.documentElement.lang = lang;
  window.t = (text) => text;
  if (lang !== 'en') return;

  const dict = window.FARADIA_I18N_EN || { exact: {}, patterns: [] };
  const exact = new Map(Object.entries(dict.exact));
  const patterns = dict.patterns.map(([re, out]) => [new RegExp(re), out]);

  function translate(text) {
    if (!text) return text;
    const trimmed = text.trim();
    if (!trimmed || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(trimmed)) return text;
    let out = exact.get(trimmed);
    if (out === undefined) {
      for (const [re, tpl] of patterns) {
        const m = re.exec(trimmed);
        if (!m) continue;
        out = tpl.replace(/\$(\d)/g, (_s, n) => {
          const v = m[Number(n)] || '';
          return exact.get(v) ?? v;
        });
        break;
      }
    }
    if (out === undefined) return text;
    return text.replace(trimmed, out);
  }
  window.t = translate;

  // Containers whose content is the user's or an agent's, not the interface's.
  const SKIP =
    '.msg-text, .task-output, .wiki-body, .wiki-editor, pre, code, textarea, .md, .act-say, .act-think-text, .act-detail, .act-result, .act-note, .todo-text, .task-title, .intent-reason, .permission-why, [contenteditable]';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'label'];

  function translateNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (!parent || parent.closest(SKIP) || parent.closest('script, style')) return;
      const next = translate(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    // Attributes (a textarea's placeholder) are the interface's even inside user content.
    for (const a of ATTRS) {
      const v = node.getAttribute(a);
      if (v) {
        const next = translate(v);
        if (next !== v) node.setAttribute(a, next);
      }
    }
    if (node.matches(SKIP)) return;
    for (const child of node.childNodes) translateNode(child);
  }

  function start() {
    translateNode(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') translateNode(r.target);
        else if (r.type === 'attributes') translateNode(r.target);
        else for (const n of r.addedNodes) translateNode(n);
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS
    });
    document.title = translate(document.title);
  }

  // Dialogs built with confirm/prompt/alert.
  for (const name of ['confirm', 'prompt', 'alert']) {
    const original = window[name].bind(window);
    window[name] = (message, ...rest) => original(translate(String(message ?? '')), ...rest);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
