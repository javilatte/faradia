'use strict';

const fs = require('fs');
const pty = require('node-pty');
const { EventEmitter } = require('events');
const { ensureSpawnHelperExecutable } = require('./nodePtyFix');

const SCROLLBACK_LIMIT = 200_000; // chars kept in memory, oldest trimmed first

/**
 * Wraps one long-lived, real interactive `claude` process in a pseudo-terminal.
 * Unlike ClaudeSession (headless -p, --permission-prompts none), this is the
 * normal interactive CLI with real permission prompts, rendered and answerable
 * because there is a real TTY on the other end. It gets the same Faradia
 * settings as the chat (--settings .faradia/claude-settings.json: the "prohibido"
 * list and the base permissions) on top of the repo's own .claude/ settings.
 */
class PtySession extends EventEmitter {
  constructor({ cwd, mcpConfigPath, settingsPath, cols = 80, rows = 24, resumeSessionId } = {}) {
    super();
    this.scrollback = '';
    this._exited = false;

    const args = [];
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
    if (settingsPath && fs.existsSync(settingsPath)) args.push('--settings', settingsPath);
    ensureSpawnHelperExecutable();
    this.proc = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env
    });

    this.proc.onData((data) => {
      this.scrollback = (this.scrollback + data).slice(-SCROLLBACK_LIMIT);
      this.emit('data', data);
    });
    this.proc.onExit((info) => {
      this._exited = true;
      this.emit('exit', info);
    });
  }

  write(data) {
    if (this._exited) return;
    this.proc.write(data);
  }

  resize(cols, rows) {
    if (this._exited) return;
    this.proc.resize(cols, rows);
  }

  kill() {
    if (this._exited) return;
    this.proc.kill();
  }
}

module.exports = { PtySession };
