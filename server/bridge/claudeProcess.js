'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { localSessionEnv } = require('./localAi');

/**
 * Wraps one long-lived `claude -p --input-format stream-json --output-format
 * stream-json` process for a single chat/task. One process per open session,
 * fed NDJSON on stdin, emitting parsed NDJSON events read from stdout.
 *
 * `--permission-prompts none`: a headless process has no TTY to answer an
 * interactive permission prompt, so anything not already resolved by
 * .claude/settings.json (or --permission-mode) is auto-denied instead of
 * hanging forever. `--permission-mode` itself is left to the project's
 * normal settings.json — the bridge must behave like "claude code normal",
 * not grant itself extra permissions.
 */
class ClaudeSession extends EventEmitter {
  constructor({
    projectRoot,
    sessionId,
    resumeSessionId,
    model,
    effort,
    baseUrl,
    authHeader,
    systemPrompt,
    mcpConfigPath,
    extraMcpConfigPaths = [],
    settingsPath,
    strictMcpConfig = false,
    extraAllowedTools = [],
    disallowedTools = [],
    gitHooksPath,
    extraEnv = {},
    addDirs = [],
    approvals = false,
    permissionMode
  } = {}) {
    super();
    this.projectRoot = projectRoot;
    this.sessionId = resumeSessionId || sessionId || crypto.randomUUID();
    this._buffer = '';
    this._exited = false;

    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    // Resuming a prior conversation pins its identity via --resume; a fresh
    // session instead picks its own --session-id so we can persist it.
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      args.push('--session-id', this.sessionId);
    }
    // approvals: whatever needs permission is asked to Faradia (stdin/stdout control messages, the
    // same protocol as the Agent SDK) and shown to the user in the chat; without it, nobody is asked
    // and it is denied (task agents, which go on by themselves and list what was blocked).
    this.approvals = approvals;
    if (approvals) args.push('--permission-prompts', 'host', '--permission-prompt-tool', 'stdio');
    else args.push('--permission-prompts', 'none');
    this.pendingPermissions = new Map(); // request_id -> request
    if (permissionMode) args.push('--permission-mode', permissionMode);
    if (model) args.push('--model', model);
    // Extra folders Claude Code reads skills and commands from (ECC, see ecc/library.js).
    for (const dir of addDirs) args.push('--add-dir', dir);
    if (effort) args.push('--effort', effort);
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (settingsPath) args.push('--settings', settingsPath);
    const allowedTools = [];
    // Task agents: only faradia's MCP servers and the project's own (.mcp.json). Without
    // --strict-mcp-config they would inherit the connectors of the user's claude.ai account (Gmail,
    // Drive, Slack...), which use up context, have nothing to do with a coding task and open a path
    // for prompt injection.
    if (strictMcpConfig) args.push('--strict-mcp-config');
    const extraMcp = extraMcpConfigPaths.filter(Boolean);
    if (extraMcp.length && !mcpConfigPath) args.push('--mcp-config', ...extraMcp);
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath, ...extraMcp);
      // A headless, --permission-prompts none session has no approval surface:
      // MCP tool calls are denied outright regardless of .claude/settings.json's
      // permissions.allow (verified against the real binary — allow-list entries
      // and enableAllProjectMcpServers are not enough on their own). --allowedTools
      // is the one mechanism that actually lets a specific MCP tool through
      // without granting bypassPermissions (which would also defeat the no-go
      // deny list).
      allowedTools.push('mcp__faradia-tasks__create_task', 'mcp__faradia-tasks__update_task_progress');
    }
    // Extra tools a task stage needs without asking (see taskStages.js). Deny rules still win over
    // these.
    allowedTools.push(...extraAllowedTools);
    if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
    if (disallowedTools.length) args.push('--disallowedTools', disallowedTools.join(','));

    const env = { ...process.env, ...extraEnv };
    // Task sessions only: the hook blocks commits and pushes even when the command comes with flags
    // (git -c ...) that text rules do not cover.
    if (gitHooksPath) {
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
      env.GIT_CONFIG_VALUE_0 = gitHooksPath;
    }
    // Local model: the account's credentials stay out of the request (see localAi.js).
    const finalEnv = baseUrl ? localSessionEnv(env, { baseUrl, authHeader, model }) : env;

    this.proc = spawn('claude', args, { cwd: projectRoot, env: finalEnv });

    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString('utf8')));
    this.proc.on('exit', (code, signal) => {
      this._exited = true;
      this.emit('exit', { code, signal });
    });
    this.proc.on('error', (err) => this.emit('error', err));
    // Writing after claude has gone: its exit event reports it, the write must not crash Faradia.
    this.proc.stdin.on('error', () => {});
  }

  _onStdout(chunk) {
    this._buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, newlineIndex);
      this._buffer = this._buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        this.emit('error', new Error(`unparseable stream-json line: ${line}`));
        continue;
      }
      if (event.type === 'control_request') {
        this._onControlRequest(event);
        continue;
      }
      if (event.type === 'control_cancel_request') {
        if (this.pendingPermissions.delete(event.request_id)) this.emit('permission_cancelled', event.request_id);
        continue;
      }
      this.emit('event', event);
    }
  }

  _onControlRequest(event) {
    const req = event.request || {};
    if (req.subtype !== 'can_use_tool') {
      // Nothing else is supported: answer so the CLI does not wait.
      this._write({
        type: 'control_response',
        response: { subtype: 'error', request_id: event.request_id, error: `unsupported: ${req.subtype}` }
      });
      return;
    }
    const request = {
      requestId: event.request_id,
      toolName: req.tool_name,
      input: req.input || {},
      description: req.description || '',
      suggestions: req.permission_suggestions || []
    };
    this.pendingPermissions.set(event.request_id, request);
    this.emit('permission_request', request);
  }

  /**
   * Answers a permission request. decision: 'allow' | 'always' | 'deny'. 'always' also allows the
   * same rule for the rest of this session (the caller stores it for the repo).
   */
  respondPermission(requestId, decision, { message } = {}) {
    const request = this.pendingPermissions.get(requestId);
    if (!request || this._exited) return false;
    this.pendingPermissions.delete(requestId);
    let response;
    if (decision === 'deny') {
      response = { behavior: 'deny', message: message || 'El usuario no lo ha permitido.' };
    } else {
      response = { behavior: 'allow', updatedInput: request.input };
      if (decision === 'always') {
        const rules = request.suggestions.filter((s) => s.type === 'addRules' && s.behavior === 'allow');
        if (rules.length) response.updatedPermissions = rules.map((r) => ({ ...r, destination: 'session' }));
      }
    }
    this._write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    return true;
  }

  _write(obj) {
    if (this._exited) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** text: string, images: [{mediaType, base64Data}] */
  send(text, images = []) {
    if (this._exited) throw new Error('claude session already exited');
    const content = [];
    for (const img of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64Data } });
    }
    content.push({ type: 'text', text });
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content } });
    this.proc.stdin.write(line + '\n');
  }

  close() {
    if (this._exited) return;
    this.proc.stdin.end();
  }

  kill() {
    if (this._exited) return;
    this.proc.kill();
  }

  /** Resolves once the process has exited (at most `timeoutMs` later, if it never says so). */
  exited(timeoutMs = 5000) {
    if (this._exited || !this.proc) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = { ClaudeSession };
