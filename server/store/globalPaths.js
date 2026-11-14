'use strict';

const os = require('os');
const path = require('path');

// Estado global de optimia (no de un proyecto concreto), siguiendo XDG:
//   config: workbenches, agentes globales          ~/.config/optimia
//   data:   timeline, papelera de ficheros           ~/.local/share/optimia
// Los tests apuntan XDG_CONFIG_HOME / XDG_DATA_HOME a carpetas temporales.
function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'optimia');
}

function dataDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'optimia');
}

module.exports = { configDir, dataDir };
