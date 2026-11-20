'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createProjectRuntime } = require('./projectRuntime');

// Stable project id: it does not depend on the order projects open in or on the folder name, only
// on its real path, so it survives Faradia restarts.
function projectIdFor(root) {
  const real = fs.realpathSync(root);
  return crypto.createHash('sha1').update(real).digest('hex').slice(0, 12);
}

/**
 * Projects this server knows and their runtimes. A runtime (chat and task sessions, mcp.json, log)
 * is created the first time the project is used, not when it is registered: a workbench with 30
 * repos does not start 30 runtimes.
 */
class ProjectRegistry {
  constructor({ port, token, sendToClients }) {
    this.port = port;
    this.token = token;
    this.sendToClients = sendToClients;
    this.projects = new Map(); // id -> { id, root, name }
    this.runtimes = new Map(); // id -> ProjectRuntime
  }

  register(root) {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(`no existe la carpeta ${abs}`);
    }
    const id = projectIdFor(abs);
    if (!this.projects.has(id)) {
      this.projects.set(id, { id, root: fs.realpathSync(abs), name: path.basename(abs) });
    }
    return this.projects.get(id);
  }

  has(id) {
    return this.projects.has(id);
  }

  info(id) {
    return this.projects.get(id) || null;
  }

  list() {
    return [...this.projects.values()].map((p) => ({ ...p, active: this.runtimes.has(p.id) }));
  }

  runtime(id) {
    const project = this.projects.get(id);
    if (!project) return null;
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = createProjectRuntime({
        projectId: id,
        projectRoot: project.root,
        port: this.port,
        token: this.token,
        sendToClients: this.sendToClients
      });
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  dispose() {
    for (const rt of this.runtimes.values()) rt.dispose();
    this.runtimes.clear();
  }
}

module.exports = { ProjectRegistry, projectIdFor };
