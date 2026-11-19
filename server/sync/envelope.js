'use strict';

const crypto = require('crypto');

// The synced configuration leaves this computer encrypted with a passphrase only the user knows:
// scrypt derives the key and AES-256-GCM encrypts and authenticates the content. Whoever stores the
// file (Google Drive, a Dropbox folder…) sees only when it was written and from which computer.

const FORMAT = 'optimia-sync';
const VERSION = 1;
const KDF = { N: 2 ** 15, r: 8, p: 1, keyLen: 32 };
const MIN_PASSPHRASE = 8;

class PassphraseError extends Error {}

function deriveKey(passphrase, salt, kdf = KDF) {
  return crypto.scryptSync(String(passphrase), salt, kdf.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 128 * kdf.N * kdf.r * 2
  });
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new PassphraseError(`la frase de paso debe tener al menos ${MIN_PASSPHRASE} caracteres`);
  }
}

/** Encrypts `payload` (any JSON value). `meta` (updatedAt, machine) stays readable. */
function seal(payload, passphrase, meta = {}) {
  checkPassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const header = { format: FORMAT, version: VERSION, ...meta };
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    ...header,
    kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

function isEnvelope(value) {
  return Boolean(value && typeof value === 'object' && value.format === FORMAT);
}

/** Decrypts an envelope. Throws PassphraseError when the passphrase is wrong or the file was altered. */
function open(envelope, passphrase) {
  if (!isEnvelope(envelope)) throw new Error('no es un fichero de sincronización de optimia');
  if (envelope.version !== VERSION) throw new Error('fichero de sincronización de otra versión; actualiza optimia');
  const { format, version, kdf, iv, tag, data, ...meta } = envelope;
  const header = { format, version, ...meta };
  const N = Number(kdf?.N);
  if (kdf?.name !== 'scrypt' || !Number.isInteger(N) || N < 2 ** 14 || N > 2 ** 20) {
    throw new Error('parámetros de cifrado no válidos');
  }
  const key = deriveKey(passphrase, Buffer.from(kdf.salt, 'base64'), { N, r: kdf.r, p: kdf.p, keyLen: 32 });
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(header)));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const text = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(text);
  } catch {
    throw new PassphraseError('la frase de paso no es correcta');
  }
}

module.exports = { seal, open, isEnvelope, checkPassphrase, PassphraseError, MIN_PASSPHRASE };
