'use strict';

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../store/globalPaths');

// When Claude runs out of usage, optimia goes on with the local model and comes back by itself
// when the limit resets.
//
// The claude CLI reports its limits in the stream: {type: "rate_limit_event", rate_limit_info:
// {status: "allowed" | "allowed_warning" | "rejected", resetsAt, rateLimitType}}. A rejected one
// (or a result that says the limit was hit) marks Claude as unavailable until resetsAt; meanwhile
// sessions that would use Claude use the local model, when there is one. Switching keeps the
// same session (claude --resume), so the conversation and the task keep all their context.

const FILE = () => path.join(dataDir(), 'claude-usage.json');
// Wording of the account's usage limit. A plain rate limit (429, "rate limit exceeded") lasts
// seconds and the CLI retries it: it is not a reason to leave Claude for hours.
const LIMIT_TEXT = /(usage limit|hit your limit|limit reached|out of (extra )?usage)/i;
const DEFAULT_BLOCK_MS = 60 * 60 * 1000;

let state = null;

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    state = {};
  }
  return state;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(state));
  } catch {
    /* in memory only */
  }
}

/** Milliseconds timestamp until which Claude is out of usage, or 0. */
function claudeBlockedUntil(now = Date.now()) {
  const until = Number(load().blockedUntil) || 0;
  return until > now ? until : 0;
}

/** Whether a stream event says Claude is out of usage. Returns the reset time (ms) or 0. */
function limitHit(event, now = Date.now()) {
  if (event?.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') {
    const resets = Number(event.rate_limit_info.resetsAt) * 1000;
    return resets > now ? resets : now + DEFAULT_BLOCK_MS;
  }
  if (event?.type === 'result' && event.is_error) {
    const text = `${event.result || ''} ${(event.errors || []).join(' ')}`;
    if (LIMIT_TEXT.test(text)) {
      const m = /\|(\d{10})\b/.exec(text); // "Claude AI usage limit reached|1794957000"
      return m ? Number(m[1]) * 1000 : now + DEFAULT_BLOCK_MS;
    }
  }
  if (event?.type === 'assistant') {
    for (const b of event.message?.content || []) {
      if (b.type === 'text' && /^Claude AI usage limit reached\|(\d+)/.test(b.text || '')) {
        return Number(/\|(\d+)/.exec(b.text)[1]) * 1000;
      }
    }
  }
  return 0;
}

function markClaudeBlocked(until, kind = '') {
  load();
  state = { blockedUntil: until, kind, since: Date.now() };
  save();
}

function clearClaudeBlock() {
  state = {};
  save();
}

/** The provider to use while Claude is out: the local model when configured, else null. */
function fallbackEngine(settings) {
  const local = settings.ai?.localAi || {};
  if (local.url && local.model) return 'local';
  return null;
}

/** The override buildSessionOptions applies to sessions that would use Claude, or null. */
function engineOverride(settings, now = Date.now()) {
  return claudeBlockedUntil(now) ? fallbackEngine(settings) : null;
}

module.exports = {
  limitHit,
  claudeBlockedUntil,
  markClaudeBlocked,
  clearClaudeBlock,
  fallbackEngine,
  engineOverride,
  _reset: () => {
    state = null;
  }
};
