'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createProjectRuntime } = require('./projectRuntime');

// Id estable de un proyecto: no depende del orden en que se abren ni del nombre de
// la carpeta, solo de su ruta real, asi que sobrevive a reinicios de optimia.
function projectIdFor(root) {
  const real = fs.realpathSync(root);
  return crypto.createHash('sha1').update(real).digest('hex').slice(0, 12);
}

/**
 * Proyectos que este servidor conoce y sus runtimes. Un runtime (sesiones de
 * chat y tareas, mcp.json, registro) se crea la primera vez que se usa el
 * proyecto, no al registrarlo: un workbench con 30 repos no arranca 30 runtimes.
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
