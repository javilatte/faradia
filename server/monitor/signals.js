'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { compileGlobs } = require('./glob');
const { loadPrefs } = require('../store/globalPrefs');

// Passive signals: Faradia neither approves nor blocks anything, it only points out what deserves a
// second look. Rules:
//   largeDelete  many lines or files deleted at once
//   sensitive    a sensitive file changes (.env, keys, CI, deployment)
//   secret       a possible secret in a file git would commit
//   tests        tests change (especially when an agent changes them)
// A signal never includes a secret's value: only the rule and file:line.

const SENSITIVE = [
  { pattern: '.env', severity: 'high' },
  { pattern: '.env.*', severity: 'high' },
  { pattern: '*.pem', severity: 'high' },
  { pattern: '*.key', severity: 'high' },
  { pattern: '*.p12', severity: 'high' },
  { pattern: 'id_rsa*', severity: 'high' },
  { pattern: 'id_ed25519*', severity: 'high' },
  { pattern: '*.tfvars', severity: 'high' },
  { pattern: '.npmrc', severity: 'medium' },
  { pattern: '.pypirc', severity: 'medium' },
  { pattern: '.github/workflows/**', severity: 'medium' },
  { pattern: '.gitlab-ci.yml', severity: 'medium' },
  { pattern: 'Dockerfile', severity: 'medium' },
  { pattern: 'docker-compose*.yml', severity: 'medium' },
  { pattern: 'secrets/**', severity: 'high' }
].map((r) => ({ ...r, match: compileGlobs([r.pattern]) }));

const TEST_FILES = compileGlobs([
  '*.test.*',
  '*.spec.*',
  'test/**',
  'tests/**',
  '__tests__/**',
  '*_test.go',
  'test_*.py',
  '*_test.py',
  '*.bats'
]);

// Secret patterns (no dependencies). The matched value never leaves this module.
const SECRET_RULES = [
  { id: 'aws-access-key', label: 'clave de acceso de AWS', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'high' },
  {
    id: 'github-token',
    label: 'token de GitHub',
    re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    severity: 'high'
  },
  { id: 'slack-token', label: 'token de Slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, severity: 'high' },
  { id: 'anthropic-key', label: 'clave de API de Anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, severity: 'high' },
  { id: 'openai-key', label: 'clave de API de OpenAI', re: /\bsk-(proj-)?[A-Za-z0-9]{20,}\b/, severity: 'high' },
  { id: 'google-api-key', label: 'clave de API de Google', re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'high' },
  { id: 'stripe-key', label: 'clave secreta de Stripe', re: /\b[rs]k_live_[0-9A-Za-z]{20,}\b/, severity: 'high' },
  { id: 'private-key', label: 'clave privada', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, severity: 'high' },
  {
    id: 'generic-secret',
    label: 'credencial en el código',
    re: /\b(api[_-]?key|secret|token|passw(or)?d)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    severity: 'medium'
  }
];

const MAX_SCAN_BYTES = 1024 * 1024;
const DEDUPE_MS = 10 * 60 * 1000;

/**
 * Looks for possible secrets in a text. Returns [{ rule, label, severity, line }] without the
 * value.
 */
function scanText(text) {
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const rule of SECRET_RULES) {
      if (rule.re.test(lines[i]))
        found.push({ rule: rule.id, label: rule.label, severity: rule.severity, line: i + 1 });
    }
  }
  return found;
}

function sensitiveRule(rel) {
  return SENSITIVE.find((r) => r.match(rel)) || null;
}

let gitleaksAvailable = null;
function hasGitleaks() {
  if (gitleaksAvailable === null) {
    gitleaksAvailable = new Promise((resolve) => execFile('gitleaks', ['version'], (err) => resolve(!err)));
  }
  return gitleaksAvailable;
}

// If gitleaks is installed it is used on top of the built-in rules (it has many more).
async function gitleaksScan(file) {
  if (!(await hasGitleaks())) return [];
  const report = path.join(os.tmpdir(), `faradia-gitleaks-${crypto.randomUUID()}.json`);
  return new Promise((resolve) => {
    execFile(
      'gitleaks',
      [
        'detect',
        '--no-git',
        '--no-banner',
        '--source',
        file,
        '--report-format',
        'json',
        '--report-path',
        report,
        '--exit-code',
        '0'
      ],
      { timeout: 20000 },
      () => {
        try {
          const findings = JSON.parse(fs.readFileSync(report, 'utf8'));
          resolve(
            findings.map((f) => ({
              rule: `gitleaks:${f.RuleID}`,
              label: f.Description || f.RuleID,
              severity: 'high',
              line: f.StartLine
            }))
          );
        } catch {
          resolve([]);
        } finally {
          fs.rm(report, { force: true }, () => {});
        }
      }
    );
  });
}

class SignalEngine extends EventEmitter {
  constructor() {
    super();
    this.recent = [];
    this.lastFired = new Map(); // dedupe key -> ms
  }

  fire(signal) {
    const key = `${signal.projectId}:${signal.rule}:${signal.path || ''}:${signal.line || ''}`;
    const now = Date.now();
    if (now - (this.lastFired.get(key) || 0) < DEDUPE_MS) return null;
    this.lastFired.set(key, now);
    const full = { id: crypto.randomUUID(), at: new Date(now).toISOString(), ...signal };
    this.recent.push(full);
    if (this.recent.length > 300) this.recent.shift();
    this.emit('signal', full);
    return full;
  }

  /**
   * Batch of changed files. `committable(rel)` tells whether git would commit it (tracked, or new
   * and not ignored): only those are scanned for secrets.
   */
  async onActivity({ projectId, name, taskId = null, paths, root, committable = async () => true }) {
    const prefs = loadPrefs().signals;
    const base = { projectId, name, taskId };
    if (prefs.sensitive) {
      for (const rel of paths) {
        const rule = sensitiveRule(rel);
        if (!rule) continue;
        // A .env or a key that git does NOT ignore is much more serious: it would be committed.
        const exposed = rule.severity === 'high' && root ? await committable(rel) : false;
        this.fire({
          ...base,
          rule: 'sensitive',
          severity: exposed ? 'high' : rule.severity,
          path: rel,
          exposed,
          message: `${taskId ? 'Un agente ha tocado' : 'Ha cambiado'} un fichero sensible: ${rel}${exposed ? ' (git NO lo ignora: se commitearía)' : ''}`
        });
      }
    }
    if (prefs.tests) {
      const tests = paths.filter((p) => TEST_FILES(p));
      if (tests.length) {
        this.fire({
          ...base,
          rule: 'tests',
          severity: taskId ? 'medium' : 'info',
          path: tests[0],
          message: `${taskId ? 'Un agente ha cambiado' : 'Cambios en'} ${tests.length} ${tests.length === 1 ? 'fichero de test' : 'ficheros de test'}`
        });
      }
    }
    if (prefs.secrets && root) {
      for (const rel of paths) {
        if (!(await committable(rel))) continue;
        await this.scanFile({ ...base, root, rel });
      }
    }
  }

  async scanFile({ projectId, name, taskId, root, rel }) {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return [];
    }
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return [];
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return []; // binario
    const findings = [...scanText(buf.toString('utf8')), ...(await gitleaksScan(abs))];
    const fired = [];
    for (const f of findings) {
      const s = this.fire({
        projectId,
        name,
        taskId,
        rule: 'secret',
        severity: f.severity,
        path: rel,
        line: f.line,
        detail: f.rule,
        message: `Posible ${f.label} en ${rel}:${f.line} (fichero que git commitearia)`
      });
      if (s) fired.push(s);
    }
    return fired;
  }

  /** Recomputed git state: large deletes compared with the previous state. */
  onState({ projectId, name, state, previous, taskId = null }) {
    if (!state || !previous) return;
    const prefs = loadPrefs().signals;
    const removed = state.lines.removed - (previous.lines?.removed || 0);
    const deletedFiles = state.counts.deleted - (previous.counts?.deleted || 0);
    if (removed >= prefs.largeDeleteLines || deletedFiles >= prefs.largeDeleteFiles) {
      const parts = [];
      if (removed >= prefs.largeDeleteLines) parts.push(`${removed} líneas`);
      if (deletedFiles >= prefs.largeDeleteFiles) parts.push(`${deletedFiles} ficheros`);
      this.fire({
        projectId,
        name,
        taskId,
        rule: 'largeDelete',
        severity:
          removed >= prefs.largeDeleteLines * 5 || deletedFiles >= prefs.largeDeleteFiles * 4 ? 'high' : 'medium',
        message: `Borrado grande: ${parts.join(' y ')} de golpe`,
        at: state.at
      });
    }
  }

  recentSignals(projectIds) {
    return this.recent
      .filter((s) => !projectIds || projectIds.includes(s.projectId))
      .slice()
      .reverse();
  }
}

module.exports = { SignalEngine, scanText, sensitiveRule, TEST_FILES, SECRET_RULES };
