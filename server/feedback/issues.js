'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('../store/globalPaths');

// What goes wrong (and what users do with faradia's proposals), kept on this computer to improve the
// product: every warning and error any repo logs, errors from the page, and how suggestions are
// received. Settings › Registro groups them by kind ("Problemas detectados") and exports them as a
// file the user can choose to share. Nothing leaves the computer on its own.
//
// Before storing, values are cut short and anything that looks like a secret (API keys, tokens,
// passwords in URLs, private keys) is replaced with [redacted]. Home paths become ~.

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_STRING = 400;

const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{30,}/g, // Google
  /sk-(ant-|proj-)?[0-9A-Za-z_-]{20,}/g, // Anthropic / OpenAI
  /gh[pousr]_[0-9A-Za-z]{30,}/g, // GitHub
  /xox[abpr]-[0-9A-Za-z-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(bearer\s+)[0-9A-Za-z._-]{16,}/gi,
  /((?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
  /(\/\/[^/\s:@]+:)[^@\s/]+@/g // user:password@host
];

function file() {
  return path.join(dataDir(), 'issues.jsonl');
}

function redact(value) {
  let s = String(value);
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m, keep) =>
      typeof keep === 'string' && m.startsWith(keep) ? `${keep}[redacted]` : '[redacted]'
    );
  }
  const home = process.env.HOME;
  if (home && home.length > 1) s = s.split(home).join('~');
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
}

function clean(data, depth = 0) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return redact(data);
  if (typeof data !== 'object') return data;
  if (depth > 3) return '[…]';
  if (Array.isArray(data)) return data.slice(0, 20).map((v) => clean(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(data).slice(0, 30)) {
    // Free text written by the user or the agent is not needed to find the problem.
    if (['text', 'prompt', 'answer', 'content'].includes(k)) continue;
    out[k] = clean(v, depth + 1);
  }
  return out;
}

// Groups the same problem across occurrences: numbers, ids and paths do not make a new kind.
function signature(event, data) {
  const msg = String(data?.error || data?.message || data?.reason || '')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/\d+/g, '<n>')
    .replace(/(['"`]).*?\1/g, '<str>')
    .replace(/(~|\/)[^\s:]+/g, '<path>')
    .slice(0, 160);
  return crypto.createHash('sha1').update(`${event}|${msg}`).digest('hex').slice(0, 12);
}

function rotate() {
  try {
    if (fs.statSync(file()).size < MAX_BYTES) return;
    fs.renameSync(file(), `${file()}.1`);
  } catch {
    /* nothing yet */
  }
}

/**
 * Stores one entry: {level: 'warn'|'error'|'signal', event, data, source: 'server'|'web', project}.
 * Never throws.
 */
function recordIssue({ level = 'error', event, data = {}, source = 'server', project = '' }) {
  try {
    const safe = clean(data);
    const entry = {
      ts: new Date().toISOString(),
      level,
      event: String(event || 'unknown').slice(0, 80),
      sig: signature(event, safe),
      source,
      project: redact(project).slice(0, 80),
      version: require('../../package.json').version,
      data: safe
    };
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    rotate();
    fs.appendFileSync(file(), JSON.stringify(entry) + '\n');
  } catch {
    /* the report never breaks anything */
  }
}

function readAll() {
  const out = [];
  for (const f of [`${file()}.1`, file()]) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* torn line */
        }
      }
    } catch {
      /* missing */
    }
  }
  return out;
}

/**
 * The report: problems grouped by kind, most frequent first, and the signals (suggestions
 * accepted / dismissed) counted.
 */
function summary() {
  const entries = readAll();
  const groups = new Map();
  const signals = {};
  for (const e of entries) {
    if (e.level === 'signal') {
      const key = `${e.event}${e.data?.kind ? `:${e.data.kind}` : ''}`;
      signals[key] = (signals[key] || 0) + 1;
      continue;
    }
    const g = groups.get(e.sig) || {
      sig: e.sig,
      event: e.event,
      level: e.level,
      source: e.source,
      count: 0,
      projects: new Set()
    };
    g.count++;
    g.first = g.first || e.ts;
    g.last = e.ts;
    g.sample = e.data;
    if (e.project) g.projects.add(e.project);
    groups.set(e.sig, g);
  }
  return {
    total: entries.filter((e) => e.level !== 'signal').length,
    groups: [...groups.values()]
      .map((g) => ({ ...g, projects: [...g.projects].slice(0, 5) }))
      .sort((a, b) => b.count - a.count || String(b.last).localeCompare(String(a.last))),
    signals
  };
}

/** Everything, for the export file the user decides to share. */
function exportReport() {
  return {
    format: 'faradia-issues',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    version: require('../../package.json').version,
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    ...summary(),
    entries: readAll().slice(-2000)
  };
}

function clearIssues() {
  for (const f of [file(), `${file()}.1`]) fs.rmSync(f, { force: true });
}

module.exports = { recordIssue, summary, exportReport, clearIssues, redact, signature };
