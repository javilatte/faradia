'use strict';

const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const gemini = require('./gemini');
const { listSkills } = require('../bridge/skills');
const { builtinSkills } = require('../skills/library');
const ecc = require('../ecc/library');
const { loadAgents } = require('../agents/catalog');
const { TASK_TYPES } = require('../bridge/taskStages');

// While the user types in the chat, a cheap model reads the message and proposes at most two
// things from what optimia offers: a skill (/name), an agent (@id) or a task type. It may only pick
// ids from the catalog it is given; anything else is dropped.
//
// Engines, in order (the first configured one that answers wins):
//   1. Gemini (Settings › AI › Gemini), fast and cheap
//   2. the local model (Settings › AI › Local AI), free
//   3. Claude Haiku with low effort, through the claude CLI (uses a little of the account)

const MAX_DESC = 140;

const short = (s) => {
  const one = String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > MAX_DESC ? `${one.slice(0, MAX_DESC - 1)}…` : one;
};

/** What can be suggested in this repo: [{kind, id, description}]. */
function buildCatalog(projectRoot, settings) {
  const items = [];
  const seen = new Set();
  const add = (kind, id, description, core = false) => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, id, description: short(description), core });
  };
  for (const [type, def] of Object.entries(TASK_TYPES)) {
    if (type === 'custom' || def.internal) continue;
    const what = {
      coding: 'write or change code: plan, implement and verify in its own worktree',
      bugfix: 'fix a bug or an error: diagnose, fix and verify',
      tests: 'write or improve automated tests',
      documentation: 'write or update documentation (README, guides, docs)',
      audit: 'review the code (security, performance, quality) and report, without changes'
    }[type];
    add('task', type, `${def.label}: ${what || def.label}`, true);
  }
  for (const s of builtinSkills()) add('skill', s.name, s.description, true);
  try {
    for (const s of listSkills(projectRoot)) add('skill', s.slug, s.description);
  } catch {
    /* no repo skills */
  }
  const enabledEcc = new Set(ecc.selection(settings.ecc || {}).skills);
  for (const s of ecc.eccSkills()) if (enabledEcc.has(s.name)) add('skill', s.name, s.description);
  try {
    for (const a of loadAgents(projectRoot)) {
      // The stage agents (planner, implementer…) run inside task types, which are offered instead.
      if (a.source === 'builtin') continue;
      add('agent', a.id, `${a.name}: ${a.description}`);
    }
  } catch {
    /* no agents */
  }
  return items;
}

const SYSTEM = [
  'You route a developer request to the tools of a coding app. You get the request and a catalog of',
  'skills, agents and task types, one per line as "kind id: description".',
  'Pick at most 2 catalog entries that would clearly help with this request; pick none when nothing',
  'fits well, when the request is a casual question, or when it is too vague. Prefer a task type for',
  'work that changes code, a skill for know-how the chat can apply, an agent for a specialist job.',
  'Answer ONLY with JSON: {"suggestions":[{"kind":"skill|agent|task","id":"<exact id>","reason":"<max 8',
  'words, in the language of the request>"}]}'
].join(' ');

// Spanish words mapped to the English ones the catalog descriptions use.
const SYNONYMS = {
  seguridad: 'security',
  vulnerabilidad: 'vulnerability security',
  vulnerabilidades: 'vulnerability security',
  inyeccion: 'injection security',
  contraseña: 'password auth',
  login: 'auth login',
  autenticacion: 'auth',
  interfaz: 'ui frontend interface',
  pantalla: 'ui screen',
  diseño: 'design ui',
  componente: 'component react',
  estilos: 'css design',
  pruebas: 'tests testing',
  prueba: 'test testing',
  cobertura: 'coverage tests',
  error: 'bug error debug',
  fallo: 'bug error',
  falla: 'bug error',
  peta: 'bug crash error',
  rendimiento: 'performance',
  lento: 'performance',
  base: 'database',
  datos: 'database data',
  migracion: 'migration database',
  documentacion: 'documentation docs',
  plan: 'plan planning',
  planificar: 'plan planning',
  despliegue: 'deploy deployment',
  contenedor: 'docker container',
  revisar: 'review',
  revisa: 'review',
  refactorizar: 'refactor',
  tipos: 'types typescript'
};

const tokens = (text) =>
  String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 2);

/**
 * The entries worth showing the model: optimia's own (task types and built-in skills) always, plus
 * the 12 others that share most words with the request. A short catalog makes small models faster
 * and more accurate.
 */
function shortlist(text, catalog, max = 12) {
  const want = new Set();
  for (const w of tokens(text)) {
    want.add(w);
    for (const extra of (SYNONYMS[w] || '').split(' ')) if (extra) want.add(extra);
  }
  const scored = catalog
    .filter((c) => !c.core)
    .map((c) => {
      const idWords = tokens(c.id.replace(/^ecc-/, ''));
      const descWords = new Set(tokens(c.description));
      let score = 0;
      for (const w of want) {
        if (idWords.includes(w)) score += 3;
        else if (descWords.has(w)) score += 1;
      }
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.c);
  return [...catalog.filter((c) => c.core), ...scored];
}

function userPrompt(text, catalog) {
  const lines = catalog.map((c) => `${c.kind} ${c.id}: ${c.description}`).join('\n');
  return [
    'Classify the request below. Do NOT carry it out, do not answer it: only choose catalog entries.',
    `Catalog:\n${lines}`,
    `Request (between the markers):\n<<<\n${text.slice(0, 2000)}\n>>>`,
    'Reply with the JSON only.'
  ].join('\n\n');
}

/** Keeps only valid catalog entries, at most 2, without repeats. */
function parseSuggestions(raw, catalog) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const valid = new Map(catalog.map((c) => [`${c.kind}:${c.id}`, c]));
  const out = [];
  for (const s of Array.isArray(data?.suggestions) ? data.suggestions : []) {
    const key = `${s?.kind}:${s?.id}`;
    if (!valid.has(key) || out.some((o) => `${o.kind}:${o.id}` === key)) continue;
    out.push({ kind: s.kind, id: s.id, reason: short(s.reason).slice(0, 80) });
    if (out.length === 2) break;
  }
  return out;
}

async function viaGemini(settings, system, user, { fetcher } = {}) {
  const g = settings.providers?.gemini || {};
  if (!g.apiKey || !g.model) return null;
  return gemini.askJson({ apiKey: g.apiKey, model: g.model, system, user, timeoutMs: 8000, fetcher });
}

async function viaLocal(settings, system, user, { fetcher = fetch } = {}) {
  const local = settings.ai?.localAi || {};
  if (!local.url || !local.model) return null;
  const headers = { 'Content-Type': 'application/json' };
  const h = /^([^:]+):\s*(.+)$/.exec(local.authHeader || '');
  if (h) headers[h[1].trim()] = h[2].trim();
  const res = await fetcher(`${local.url.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: local.model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`modelo local: HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

function viaClaude(settings, system, user, { spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--model',
      'haiku',
      '--effort',
      'low',
      '--output-format',
      'json',
      '--strict-mcp-config',
      // A classifier: no tools and one turn, or it starts doing what the request asks.
      '--tools',
      '',
      '--max-turns',
      '1',
      '--append-system-prompt',
      system
    ];
    // From an empty folder: in the repo, Claude Code would load its CLAUDE.md, settings and hooks
    // (10x slower, and the model starts working on the repo instead of answering).
    const proc = spawnFn('claude', args, { cwd: os.tmpdir(), env: { ...process.env } });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('claude: tiempo agotado'));
    }, 30000);
    proc.stdout.on('data', (c) => (out += c));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(out);
        if (data.is_error) return reject(new Error(String(data.result || 'claude error')));
        resolve(String(data.result || ''));
      } catch {
        reject(new Error(`claude: salida no válida (código ${code})`));
      }
    });
    proc.stdin.end(user);
  });
}

const ENGINES = [
  ['gemini', viaGemini],
  ['local', viaLocal],
  ['claude', viaClaude]
];

const cache = new Map();
const CACHE_MAX = 200;

/**
 * Suggestions for a message: {suggestions: [{kind, id, reason}], engine} or {suggestions: [],
 * engine: null} when suggestions are off, the text is too short or no engine answered.
 */
async function suggest({ text, projectRoot, settings, deps = {} }) {
  const clean = String(text || '').trim();
  if (settings.suggestions?.mode === 'off') return { suggestions: [], engine: null, off: true };
  if (clean.split(/\s+/).length < 4 || /^[@/]/.test(clean)) return { suggestions: [], engine: null };
  const catalog = deps.catalog || buildCatalog(projectRoot, settings);
  const key = crypto.createHash('sha256').update(`${projectRoot}\n${clean.toLowerCase()}`).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const user = userPrompt(clean, shortlist(clean, catalog));
  const errors = [];
  for (const [name, fn] of deps.engines || ENGINES) {
    try {
      const raw = await fn(settings, SYSTEM, user, { cwd: projectRoot, ...deps });
      if (raw === null) continue; // not configured
      const suggestions = parseSuggestions(raw, catalog);
      if (suggestions === null) {
        errors.push(`${name}: respuesta sin JSON`);
        continue;
      }
      const result = {
        engine: name,
        suggestions: suggestions.map((s) => ({
          ...s,
          description: catalog.find((c) => c.kind === s.kind && c.id === s.id)?.description || ''
        }))
      };
      cache.set(key, result);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return result;
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  return { suggestions: [], engine: null, errors };
}

module.exports = { suggest, buildCatalog, shortlist, parseSuggestions, userPrompt, SYSTEM, _cache: cache };
