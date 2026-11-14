'use strict';

const crypto = require('crypto');

// optimia escucha solo en 127.0.0.1, pero eso no basta: cualquier web abierta en el
// navegador puede intentar llamar a http://127.0.0.1:<puerto> (CSRF) o apuntar un
// dominio propio a 127.0.0.1 (DNS rebinding). Con la API pudiendo leer, mover y
// borrar ficheros de varios repos, cada peticion pasa tres controles:
//   1. Host: solo 127.0.0.1, localhost o [::1] con el puerto real.
//   2. Origin: si el navegador lo manda, tiene que ser el propio optimia.
//   3. Token: un secreto por arranque, en cabecera (MCP, tests) o en una cookie
//      SameSite=Strict que se fija al abrir el enlace con ?token= que imprime optimia.

const TOKEN_HEADER = 'x-optimia-token';

function createToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Las cookies no distinguen puertos: dos optimia abiertos a la vez necesitan nombres distintos.
function cookieName(port) {
  return `optimia_${port}`;
}

function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function hostAllowed(req, port) {
  return allowedHosts(port).has(String(req.headers.host || '').toLowerCase());
}

// Sin cabecera Origin (curl, el servidor MCP) se acepta: el token sigue siendo obligatorio.
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
 * Comprueba una peticion a la API o al WebSocket. Devuelve null si pasa, o
 * { status, error } para responder.
 */
function checkApiRequest(req, { token, port }) {
  if (!hostAllowed(req, port)) return { status: 421, error: 'host no permitido' };
  if (!originAllowed(req, port)) return { status: 403, error: 'origen no permitido' };
  if (!isAuthorized(req, { token, port })) {
    return { status: 401, error: 'falta el token de optimia: abre el enlace que imprime optimia al arrancar' };
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
