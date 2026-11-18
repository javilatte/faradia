'use strict';

const crypto = require('crypto');

// "Sign in with Google" for syncing, as Google documents it for desktop apps: the browser opens
// Google's consent page, Google sends it back to optimia's own local address (loopback redirect)
// with a one-time code, and optimia exchanges it with PKCE. The only scope asked for is
// drive.appdata (a hidden folder of the user's Drive for this app) plus the email to show who is
// connected. optimia's author never receives anything: tokens and data stay between this computer
// and the user's Google account.
//
// The OAuth client of a desktop app is public by design (Google says so: its "secret" is not
// secret). It is read from OPTIMIA_GOOGLE_CLIENT_ID / OPTIMIA_GOOGLE_CLIENT_SECRET or from the
// constants below; without a client id the Google option is hidden and folder sync still works.

const CLIENT_ID = '';
const CLIENT_SECRET = '';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.appdata'];
const PENDING_TTL = 10 * 60 * 1000;

function client() {
  const id = process.env.OPTIMIA_GOOGLE_CLIENT_ID || CLIENT_ID;
  const secret = process.env.OPTIMIA_GOOGLE_CLIENT_SECRET || CLIENT_SECRET;
  return id ? { id, secret } : null;
}

const b64url = (buf) => buf.toString('base64url');

// Sign-ins started and not finished yet, by `state`. Each one is used once.
const pending = new Map();

/** Starts a sign-in. Returns the URL to open; `extra` comes back from finish(). */
function startSignIn(redirectUri, extra = {}, now = Date.now()) {
  const c = client();
  if (!c) throw new Error('esta instalación de optimia no tiene cliente de Google configurado');
  for (const [k, v] of pending) if (now - v.at > PENDING_TTL) pending.delete(k);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  pending.set(state, { verifier, redirectUri, extra, at: now });
  const params = new URLSearchParams({
    client_id: c.id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  return `${AUTH_URL}?${params}`;
}

function emailFromIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')).email || null;
  } catch {
    return null;
  }
}

async function tokenRequest(params, fetcher) {
  const c = client();
  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.id, ...(c.secret ? { client_secret: c.secret } : {}), ...params })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google: ${data.error_description || data.error || `HTTP ${res.status}`}`);
  return data;
}

/** Finishes a sign-in with the code Google sent back. Returns {refreshToken, email, extra}. */
async function finishSignIn({ state, code, error }, fetcher = fetch, now = Date.now()) {
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || now - entry.at > PENDING_TTL) throw new Error('el inicio de sesión caducó; vuelve a intentarlo');
  if (error) throw new Error(error === 'access_denied' ? 'cancelaste el inicio de sesión' : `Google: ${error}`);
  const data = await tokenRequest(
    {
      code,
      code_verifier: entry.verifier,
      grant_type: 'authorization_code',
      redirect_uri: entry.redirectUri
    },
    fetcher
  );
  if (!data.refresh_token) throw new Error('Google no devolvió un token de acceso duradero; vuelve a intentarlo');
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
    email: emailFromIdToken(data.id_token),
    extra: entry.extra
  };
}

/** A function that returns a valid access token, refreshing it a minute before it expires. */
function accessTokens(refreshToken, fetcher = fetch, initial = null) {
  let current = initial;
  return async () => {
    if (current && current.expiresAt - 60_000 > Date.now()) return current.accessToken;
    const data = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' }, fetcher);
    current = { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
    return current.accessToken;
  };
}

async function revoke(refreshToken, fetcher = fetch) {
  await fetcher(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' }).catch(() => {});
}

module.exports = { client, startSignIn, finishSignIn, accessTokens, revoke, emailFromIdToken, SCOPES };
