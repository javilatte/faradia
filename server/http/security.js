'use strict';

const crypto = require('crypto');

// Faradia only listens on 127.0.0.1, but that is not enough: any web page open in the browser can
// try to call http://127.0.0.1:<port> (CSRF) or point a domain of its own at 127.0.0.1 (DNS
// rebinding). Since the API can read, move and delete files in several repos, every request passes
// three checks:
//   1. Host: only 127.0.0.1, localhost or [::1] with the real port.
//   2. Origin: if the browser sends it, it must be Faradia itself.
//   3. Token: a per-run secret, in a header (MCP, tests) or in a SameSite=Strict
//      cookie set when opening the ?token= link Faradia prints.

const TOKEN_HEADER = 'x-faradia-token';

function createToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Cookies do not tell ports apart: two Faradia instances open at once need different names.
function cookieName(port) {
  return `faradia_${port}`;
}

function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function hostAllowed(req, port) {
  return allowedHosts(port).has(String(req.headers.host || '').toLowerCase());
}

// No Origin header (curl, the MCP server) is accepted: the token is still required.
function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && allowedHosts(port).has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function tokenFromRequest(req, port) {
  return req.headers[TOKEN_HEADER] || parseCookies(req.headers.cookie)[cookieName(port)] || null;
}

function isAuthorized(req, { token, port }) {
  return safeEqual(tokenFromRequest(req, port), token);
}

/**
 * Checks a request to the API or the WebSocket. Returns null if it passes, or { status, error } to
 * answer with.
 */
function checkApiRequest(req, { token, port }) {
  if (!hostAllowed(req, port)) return { status: 421, error: 'host no permitido' };
  if (!originAllowed(req, port)) return { status: 403, error: 'origen no permitido' };
  if (!isAuthorized(req, { token, port })) {
    return { status: 401, error: 'falta el token de faradia: abre el enlace que imprime Faradia al arrancar' };
  }
  return null;
}

function sessionCookie(token, port) {
  return `${cookieName(port)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

module.exports = {
  TOKEN_HEADER,
  createToken,
  cookieName,
  hostAllowed,
  originAllowed,
  parseCookies,
  isAuthorized,
  checkApiRequest,
  sessionCookie,
  safeEqual
};
