'use strict';

const fs = require('fs');
const path = require('path');

// optimia's state lives in <repo>/.optimia/*.json. Many repos run `prettier --check .`, which also
// reads that folder (git's info/exclude does not reach it), so the files are written the way
// Prettier formats JSON: objects expanded, an array of plain values on one line when it fits in the
// repo's print width.

const DEFAULT_WIDTH = 80;
const widthCache = new Map();

/** The repo's Prettier print width (.prettierrc*, package.json "prettier", .editorconfig), or 80. */
function printWidth(projectRoot) {
  if (!projectRoot) return DEFAULT_WIDTH;
  if (widthCache.has(projectRoot)) return widthCache.get(projectRoot);
  let width = DEFAULT_WIDTH;
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(projectRoot, name), 'utf8');
    } catch {
      return null;
    }
  };
  const fromText = (text) => {
    const m = /["']?printWidth["']?\s*[:=]\s*(\d{2,3})/.exec(text || '');
    return m ? Number(m[1]) : null;
  };
  const editorconfig = /^\s*max_line_length\s*=\s*(\d{2,3})\s*$/m.exec(read('.editorconfig') || '');
  if (editorconfig) width = Number(editorconfig[1]);
  let pkgWidth = null;
  try {
    pkgWidth = Number(JSON.parse(read('package.json') || '{}').prettier?.printWidth) || null;
  } catch {
    /* not JSON */
  }
  const files = [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.json5',
    '.prettierrc.yaml',
    '.prettierrc.yml',
    '.prettierrc.toml',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.mjs',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs'
  ];
  const configured = files.map((f) => fromText(read(f))).find(Boolean) || pkgWidth;
  if (configured) width = configured;
  widthCache.set(projectRoot, width);
  return width;
}

function isPlain(value) {
  return value === null || typeof value !== 'object';
}

// What Prettier may keep on one line: plain values, empty objects and arrays, and arrays of those.
function canBeFlat(value) {
  if (isPlain(value)) return true;
  if (Array.isArray(value)) return value.every(canBeFlat);
  return Object.keys(value).length === 0;
}

function flat(value) {
  if (isPlain(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(flat).join(', ')}]`;
  return '{}';
}

// Columns a line takes, as Prettier counts them: wide characters (CJK, emoji) take two.
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
function textWidth(text) {
  let n = 0;
  for (const ch of text) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

function stringify(value, width = DEFAULT_WIDTH) {
  const pad = (n) => '  '.repeat(n);
  // prefix: what comes before the value on its line; suffix: the comma after it, if any.
  const render = (v, depth, prefix, suffix) => {
    if (isPlain(v)) return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      // Prettier breaks an array of several arrays that each hold more than one element.
      const matrix = v.length > 1 && v.every((x) => Array.isArray(x) && x.length > 1);
      if (!matrix && canBeFlat(v)) {
        const line = flat(v);
        if (textWidth(pad(depth) + prefix + line + suffix) <= width) return line;
      }
      const items = v.map((x, i) => {
        const comma = i < v.length - 1 ? ',' : '';
        return `${pad(depth + 1)}${render(x, depth + 1, '', comma)}${comma}`;
      });
      return `[\n${items.join('\n')}\n${pad(depth)}]`;
    }
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function');
    if (!keys.length) return '{}';
    const items = keys.map((k, i) => {
      const comma = i < keys.length - 1 ? ',' : '';
      const key = `${JSON.stringify(k)}: `;
      return `${pad(depth + 1)}${key}${render(v[k], depth + 1, key, comma)}${comma}`;
    });
    return `{\n${items.join('\n')}\n${pad(depth)}}`;
  };
  return `${render(JSON.parse(JSON.stringify(value)), 0, '', '')}\n`;
}

// The repo a file of <repo>/.optimia/ belongs to, or null.
function repoOf(file) {
  const parts = path.resolve(file).split(path.sep);
  const i = parts.lastIndexOf('.optimia');
  return i > 0 ? parts.slice(0, i).join(path.sep) || path.sep : null;
}

/** Writes JSON atomically, formatted as Prettier would with the print width of the file's repo. */
function writeJsonFile(file, value, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, stringify(value, printWidth(repoOf(file))), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

module.exports = { stringify, printWidth, writeJsonFile, repoOf, _clearWidthCache: () => widthCache.clear() };
