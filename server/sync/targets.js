'use strict';

const fs = require('fs');
const path = require('path');

// Where the encrypted configuration is kept: one JSON file in a folder the user already syncs
// between computers (Google Drive for desktop, Dropbox, iCloud, Syncthing…). read() returns the
// parsed file or null when there is none yet.

const FILE_NAME = 'faradia-sync.json';

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
    throw new Error('faradia no puede escribir en esa carpeta');
  }
  return path.resolve(dir);
}

module.exports = { FILE_NAME, folderTarget, checkFolder };
