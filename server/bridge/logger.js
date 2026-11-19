'use strict';

const fs = require('fs');
const path = require('path');
const { recordIssue } = require('../feedback/issues');

const MAX_BYTES = 5 * 1024 * 1024;

// One event per line in <project>/.faradia/logs/faradia.log. Never store message text, instructions
// or file contents: only ids, states and sizes. Each open project has its own instance
// (createLogger); the module API (initLogger/info/warn/error/readRecent) uses a default instance.
function createLogger(projectRoot) {
  let logFile = null;
  if (projectRoot) {
    const dir = path.join(projectRoot, '.faradia', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'faradia.log');
  }

  function rotateIfNeeded() {
    try {
      if (fs.statSync(logFile).size < MAX_BYTES) return;
      fs.renameSync(logFile, `${logFile}.1`);
    } catch {
      /* does not exist yet or cannot be rotated: keep writing */
    }
  }

  function log(level, event, data = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data });
    if (logFile) {
      try {
        rotateIfNeeded();
        fs.appendFileSync(logFile, line + '\n');
      } catch {
        /* disk full or permissions: the log never brings the server down */
      }
    }
    if (level === 'warn' || level === 'error') {
      process.stderr.write(line + '\n');
      // Also to the problem report shared by all repos (feedback/issues.js).
      recordIssue({ level, event, data, project: projectRoot ? path.basename(projectRoot) : '' });
    }
  }

  // Newest entries first, reading the current file and, if needed, the rotated one.
  function readRecent(limit = 200) {
    if (!logFile) return [];
    const lines = [];
    for (const file of [`${logFile}.1`, logFile]) {
      try {
        lines.push(...fs.readFileSync(file, 'utf8').split('\n').filter(Boolean));
      } catch {
        /* does not exist yet */
      }
    }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* corrupt line: skipped */
      }
    }
    return out;
  }

  return {
    log,
    readRecent,
    info: (event, data) => log('info', event, data),
    warn: (event, data) => log('warn', event, data),
    error: (event, data) => log('error', event, data)
  };
}

let defaultLogger = createLogger(null);

module.exports = {
  createLogger,
  initLogger: (projectRoot) => {
    defaultLogger = createLogger(projectRoot);
  },
  readRecent: (limit) => defaultLogger.readRecent(limit),
  log: (level, event, data) => defaultLogger.log(level, event, data),
  info: (event, data) => defaultLogger.info(event, data),
  warn: (event, data) => defaultLogger.warn(event, data),
  error: (event, data) => defaultLogger.error(event, data)
};
