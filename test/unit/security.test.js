'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('../../server/http/security');

const PORT = 4321;
const TOKEN = 'secret-token';
const req = (headers) => ({ headers });

test('hostAllowed: solo loopback con el puerto real', () => {
  assert.equal(security.hostAllowed(req({ host: `127.0.0.1:${PORT}` }), PORT), true);
  assert.equal(security.hostAllowed(req({ host: `localhost:${PORT}` }), PORT), true);
  assert.equal(security.hostAllowed(req({ host: `[::1]:${PORT}` }), PORT), true);
  assert.equal(security.hostAllowed(req({ host: `evil.example:${PORT}` }), PORT), false);
  assert.equal(security.hostAllowed(req({ host: '127.0.0.1:9999' }), PORT), false);
  assert.equal(security.hostAllowed(req({}), PORT), false);
});

test('originAllowed: sin Origin se acepta; con Origin solo el propio optimia', () => {
  assert.equal(security.originAllowed(req({}), PORT), true);
  assert.equal(security.originAllowed(req({ origin: `http://127.0.0.1:${PORT}` }), PORT), true);
  assert.equal(security.originAllowed(req({ origin: 'https://evil.example' }), PORT), false);
  assert.equal(security.originAllowed(req({ origin: `https://127.0.0.1:${PORT}` }), PORT), false);
  assert.equal(security.originAllowed(req({ origin: 'null' }), PORT), false);
});

test('isAuthorized: token por cabecera o por la cookie de este puerto', () => {
  const opts = { token: TOKEN, port: PORT };
  assert.equal(security.isAuthorized(req({ 'x-optimia-token': TOKEN }), opts), true);
  assert.equal(security.isAuthorized(req({ cookie: `a=1; optimia_${PORT}=${TOKEN}` }), opts), true);
  assert.equal(security.isAuthorized(req({ cookie: `optimia_9999=${TOKEN}` }), opts), false);
  assert.equal(security.isAuthorized(req({ 'x-optimia-token': 'otro' }), opts), false);
  assert.equal(security.isAuthorized(req({}), opts), false);
});

test('checkApiRequest: devuelve el primer control que falla', () => {
  const opts = { token: TOKEN, port: PORT };
  const ok = { host: `127.0.0.1:${PORT}`, 'x-optimia-token': TOKEN };
  assert.equal(security.checkApiRequest(req(ok), opts), null);
  assert.equal(security.checkApiRequest(req({ ...ok, host: 'evil.example' }), opts).status, 421);
  assert.equal(security.checkApiRequest(req({ ...ok, origin: 'https://evil.example' }), opts).status, 403);
  assert.equal(security.checkApiRequest(req({ host: ok.host }), opts).status, 401);
});

test('sessionCookie: HttpOnly y SameSite=Strict, con el nombre del puerto', () => {
  const cookie = security.sessionCookie(TOKEN, PORT);
  assert.match(cookie, new RegExp(`^optimia_${PORT}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('createToken: aleatorio y suficientemente largo', () => {
  const a = security.createToken();
  const b = security.createToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});
