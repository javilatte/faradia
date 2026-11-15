'use strict';

const os = require('os');
const path = require('path');

// optimia's global state (not tied to a project), following XDG:
//   config: workbenches, global agents, settings   ~/.config/optimia
//   data:   timeline, file trash                   ~/.local/share/optimia
// Tests point XDG_CONFIG_HOME / XDG_DATA_HOME at temporary folders.
function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'optimia');
}

function dataDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'optimia');
}

module.exports = { configDir, dataDir };
