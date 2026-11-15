// Syntax highlighting with Shiki, loaded on demand from jsDelivr (like xterm). It is a progressive
// enhancement: without network or on failure, the diff shows as plain text. Colors follow the
// light/dark theme with Shiki's CSS variables.

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
 * Tokenizes a block of code and returns, per line, a list of { content, style } (style: an object
 * of CSS properties), or null if it cannot.
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

/** Paints tokens into an element without innerHTML (code is never interpreted as HTML). */
export function paintTokens(el, tokens) {
  el.textContent = '';
  for (const t of tokens) {
    const span = document.createElement('span');
    span.textContent = t.content;
    for (const [prop, value] of Object.entries(t.style)) span.style.setProperty(prop, value);
    el.append(span);
  }
}
