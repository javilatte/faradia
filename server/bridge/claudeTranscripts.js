'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code keeps each conversation in <config>/projects/<folder slug>/<session id>.jsonl. A
// session can only be resumed (--resume) when that file exists.
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function transcriptExists(sessionId, configDir = claudeConfigDir()) {
  if (!/^[0-9a-f-]{8,64}$/i.test(String(sessionId || ''))) return false;
  const projects = path.join(configDir, 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return false;
  }
  return dirs.some((d) => fs.existsSync(path.join(projects, d, `${sessionId}.jsonl`)));
}

module.exports = { transcriptExists, claudeConfigDir };
