'use strict';

const { execFile } = require('child_process');

// Opens the system's native file dialog and returns the chosen absolute path, or null if the user
// cancels. The app runs on the user's machine, so the dialog shows up where they are.
function pickFile({ prompt = 'Elige un fichero', platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const script = `POSIX path of (choose file with prompt ${JSON.stringify(prompt)})`;
    return run('osascript', ['-e', script]);
  }
  if (platform === 'linux') {
    return run('zenity', ['--file-selection', `--title=${prompt}`])
      .catch((err) => {
        if (err.code !== 'ENOENT') throw err;
        return run('kdialog', ['--getopenfilename', '.']);
      })
      .catch((err) => {
        if (err.code === 'ENOENT') throw new Error('instala zenity o kdialog para elegir ficheros');
        throw err;
      });
  }
  return Promise.reject(new Error(`no hay explorador de ficheros para ${platform}`));
}

// Same, for a folder (adding a repo to a workbench).
function pickFolder({ prompt = 'Elige una carpeta', platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`;
    return run('osascript', ['-e', script]).then((p) => (p ? p.replace(/\/$/, '') : p));
  }
  if (platform === 'linux') {
    return run('zenity', ['--file-selection', '--directory', `--title=${prompt}`])
      .catch((err) => {
        if (err.code !== 'ENOENT') throw err;
        return run('kdialog', ['--getexistingdirectory', process.env.HOME || '.']);
      })
      .catch((err) => {
        if (err.code === 'ENOENT') throw new Error('instala zenity o kdialog para elegir carpetas');
        throw err;
      });
  }
  return Promise.reject(new Error(`no hay explorador de carpetas para ${platform}`));
}

// Cancelling the dialog ends the process with a non-zero code and no output: that means "no
// selection", not an error.
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(err);
        return resolve(null);
      }
      const chosen = String(stdout).trim();
      resolve(chosen || null);
    });
  });
}

module.exports = { pickFile, pickFolder };
