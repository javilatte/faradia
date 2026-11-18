'use strict';

const fs = require('fs');
const path = require('path');

// Where the encrypted configuration is kept. Each target reads and writes one JSON file:
//   folder  a folder the user already syncs (Google Drive for desktop, Dropbox, iCloud, Syncthing…)
//   google  the hidden app folder of the user's own Google Drive (appDataFolder): only optimia can
//           see it, and it counts against the user's storage, not anyone else's.
// read() returns the parsed file or null when there is none yet.

const FILE_NAME = 'optimia-sync.json';

function folderTarget(dir) {
  const file = path.join(dir, FILE_NAME);
  return {
    kind: 'folder',
    label: dir,
    async read() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new Error(`no se pudo leer ${file}: ${err.message}`);
      }
    },
    async write(value) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    async remove() {
      fs.rmSync(file, { force: true });
    }
  };
}

function checkFolder(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('indica la ruta completa de la carpeta');
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error('esa carpeta no existe');
  }
  if (!stat.isDirectory()) throw new Error('esa ruta no es una carpeta');
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error('optimia no puede escribir en esa carpeta');
  }
  return path.resolve(dir);
}

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

/** `auth()` resolves to a valid access token (google.js refreshes it). */
function googleTarget({ auth, email, fetcher = fetch }) {
  let fileId = null;
  const call = async (url, init = {}) => {
    const res = await fetcher(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${await auth()}` }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const reason = /"message":\s*"([^"]+)"/.exec(body)?.[1] || `HTTP ${res.status}`;
      throw new Error(`Google Drive: ${reason}`);
    }
    return res;
  };
  const find = async () => {
    if (fileId) return fileId;
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const res = await call(`${DRIVE}?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&pageSize=10`);
    const { files = [] } = await res.json();
    fileId = files[0]?.id || null;
    return fileId;
  };
  return {
    kind: 'google',
    label: email || 'Google Drive',
    async read() {
      const id = await find();
      if (!id) return null;
      const res = await call(`${DRIVE}/${id}?alt=media`);
      return JSON.parse(await res.text());
    },
    async write(value) {
      const body = JSON.stringify(value);
      const id = await find();
      if (id) {
        await call(`${UPLOAD}/${id}?uploadType=media`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        return;
      }
      const boundary = `optimia${Date.now().toString(36)}`;
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] }) +
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const res = await call(`${UPLOAD}?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart
      });
      fileId = (await res.json()).id;
    },
    async remove() {
      const id = await find();
      if (id) await call(`${DRIVE}/${id}`, { method: 'DELETE' });
      fileId = null;
    }
  };
}

module.exports = { FILE_NAME, folderTarget, checkFolder, googleTarget };
