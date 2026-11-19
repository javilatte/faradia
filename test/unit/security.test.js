'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('../../server/http/security');

const PORT = 4321;
const TOKEN = 'secret-token';
const req = (headers) => ({ headers });

test('hostAllowed: only loopback with the real port', () => {
  assert.equal(security.hostAllowed(req({ host: `127.0.0.1:${PORT}` }), PORT), true);
  assert.equal(security.hostAllowed(req({ host: `localhost:${PORT}` }), PORT), true);
  assert.equal(security.hostAllowed(req({ host: `[::1]:${PORT}` }), PORT), true);
  assert.equal(security.hostAllowed(req({ host: `evil.example:${PORT}` }), PORT), false);
  assert.equal(security.hostAllowed(req({ host: '127.0.0.1:9999' }), PORT), false);
  assert.equal(security.hostAllowed(req({}), PORT), false);
});

test('originAllowed: no Origin is accepted; with Origin only Faradia itself', () => {
  assert.equal(security.originAllowed(req({}), PORT), true);
  assert.equal(security.originAllowed(req({ origin: `http://127.0.0.1:${PORT}` }), PORT), true);
  assert.equal(security.originAllowed(req({ origin: 'https://evil.example' }), PORT), false);
  assert.equal(security.originAllowed(req({ origin: `https://127.0.0.1:${PORT}` }), PORT), false);
  assert.equal(security.originAllowed(req({ origin: 'null' }), PORT), false);
});

test("isAuthorized: token in a header or in this port's cookie", () => {
  const opts = { token: TOKEN, port: PORT };
  assert.equal(security.isAuthorized(req({ 'x-faradia-token': TOKEN }), opts), true);
  assert.equal(security.isAuthorized(req({ cookie: `a=1; faradia_${PORT}=${TOKEN}` }), opts), true);
  assert.equal(security.isAuthorized(req({ cookie: `faradia_9999=${TOKEN}` }), opts), false);
  assert.equal(security.isAuthorized(req({ 'x-faradia-token': 'otro' }), opts), false);
  assert.equal(security.isAuthorized(req({}), opts), false);
});

test('checkApiRequest: returns the first check that fails', () => {
  const opts = { token: TOKEN, port: PORT };
  const ok = { host: `127.0.0.1:${PORT}`, 'x-faradia-token': TOKEN };
  assert.equal(security.checkApiRequest(req(ok), opts), null);
  assert.equal(security.checkApiRequest(req({ ...ok, host: 'evil.example' }), opts).status, 421);
  assert.equal(security.checkApiRequest(req({ ...ok, origin: 'https://evil.example' }), opts).status, 403);
  assert.equal(security.checkApiRequest(req({ host: ok.host }), opts).status, 401);
});

test('sessionCookie: HttpOnly and SameSite=Strict, named after the port', () => {
  const cookie = security.sessionCookie(TOKEN, PORT);
  assert.match(cookie, new RegExp(`^faradia_${PORT}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test('createToken: random and long enough', () => {
  const a = security.createToken();
  const b = security.createToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});
