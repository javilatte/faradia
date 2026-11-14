// Resaltado de sintaxis con Shiki, cargado bajo demanda desde jsDelivr (igual que
// xterm). Es una mejora progresiva: si no hay red o falla, el diff se ve en texto
// plano. Los colores siguen el tema claro/oscuro con variables CSS de Shiki.

const SHIKI_URL = 'https://cdn.jsdelivr.net/npm/shiki@1.24.0/+esm';
const THEMES = { light: 'github-light', dark: 'github-dark' };

const EXT_LANG = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  dockerfile: 'docker',
  xml: 'xml',
  bats: 'bash'
};

let highlighterPromise = null;
const loadedLangs = new Set();

export function langFor(path) {
  const name = String(path || '')
    .split('/')
    .pop()
    .toLowerCase();
  if (name === 'dockerfile') return 'docker';
  if (name === 'makefile') return 'makefile';
  return EXT_LANG[name.split('.').pop()] || null;
}

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import(/* webpackIgnore: true */ SHIKI_URL)
      .then((shiki) => shiki.createHighlighter({ themes: Object.values(THEMES), langs: [] }))
      .catch((err) => {
        console.warn('optimia: resaltado de sintaxis no disponible', err.message);
        return null;
      });
  }
  return highlighterPromise;
}

/**
 * Tokeniza un bloque de codigo y devuelve, por linea, una lista de
 * { content, style } (style: objeto de propiedades CSS), o null si no se puede.
 */
export async function tokenizeLines(code, lang) {
  if (!lang) return null;
  const hl = await getHighlighter();
  if (!hl) return null;
  try {
    if (!loadedLangs.has(lang)) {
      await hl.loadLanguage(lang);
      loadedLangs.add(lang);
    }
    const lines = hl.codeToTokens(code, { lang, themes: THEMES, defaultColor: false }).tokens;
    return lines.map((tokens) => tokens.map((t) => ({ content: t.content, style: t.htmlStyle || {} })));
  } catch {
    return null;
  }
}

/** Pinta tokens en un elemento sin innerHTML (el codigo nunca se interpreta como HTML). */
export function paintTokens(el, tokens) {
  el.textContent = '';
  for (const t of tokens) {
    const span = document.createElement('span');
    span.textContent = t.content;
    for (const [prop, value] of Object.entries(t.style)) span.style.setProperty(prop, value);
    el.append(span);
  }
}
