'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { dataDir } = require('../store/globalPaths');
const { loadPrefs } = require('../store/globalPrefs');

// Timeline: feed cronologico de lo que pasa en los repos vigilados. Se guarda en
// ~/.local/share/optimia/timeline/events.jsonl (rota a 5 MB, como el registro).
// Tipos de entrada (kind):
//   files    ficheros que cambiaron (lotes agrupados por repo/worktree en ventanas cortas)
//   commit   commit nuevo en un repo
//   branch   cambio de rama
//   watch    evento del plano 2 (lista de vigilancia)
//   agent    una tarea cambio de estado (empezo una etapa, quedo lista, pregunto...)
//   signal   aviso pasivo (borrado grande, fichero sensible, posible secreto...)
//   orphan   cambios sin commitear que llevan un rato sin tocarse

const MAX_BYTES = 5 * 1024 * 1024;
const COALESCE_MS = 20 * 1000;
const MAX_PATHS = 50;
const MEMORY = 2000;

function timelineFile() {
  return path.join(dataDir(), 'timeline', 'events.jsonl');
}

class Timeline extends EventEmitter {
  constructor() {
    super();
    this.recent = this.readAll().slice(-MEMORY);
    this.open = new Map(); // `${projectId}:${taskId}` -> entrada de ficheros abierta
    this.orphaned = new Map(); // projectId -> true mientras dure el periodo huerfano
  }

  readAll() {
    const lines = [];
    for (const f of [`${timelineFile()}.1`, timelineFile()]) {
      try {
        lines.push(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
      } catch {
        /* aun no existe */
      }
    }
    const out = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* linea corrupta */
      }
    }
    return out;
  }

  persist(entry) {
    try {
      const f = timelineFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      try {
        if (fs.statSync(f).size >= MAX_BYTES) fs.renameSync(f, `${f}.1`);
      } catch {
        /* aun no existe */
      }
      fs.appendFileSync(f, JSON.stringify(entry) + '\n');
    } catch {
      /* disco lleno o permisos: el timeline nunca tumba el servidor */
    }
  }

  add(entry) {
    const full = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
    this.recent.push(full);
    if (this.recent.length > MEMORY) this.recent.shift();
    this.persist(full);
    this.emit('entry', full);
    return full;
  }

  /** Lote de ficheros cambiados: se agrupa con el anterior del mismo repo si llega pronto. */
  recordFiles({ projectId, name, taskId = null, paths, at }) {
    const key = `${projectId}:${taskId}`;
    const now = Date.parse(at) || Date.now();
    const current = this.open.get(key);
    if (current && now - current.lastAt < COALESCE_MS) {
      // Lo mas reciente primero: es lo que se ve en la entrada (que solo ensena unas pocas rutas).
      const fresh = [...new Set(paths)];
      current.entry.paths = [...fresh, ...current.entry.paths.filter((p) => !fresh.includes(p))].slice(0, MAX_PATHS);
      current.entry.count = new Set([...current.all, ...paths]).size;
      for (const p of paths) current.all.add(p);
      current.lastAt = now;
      current.entry.until = at;
      this.emit('entry', current.entry); // actualizacion de la misma entrada (mismo id)
      clearTimeout(current.timer);
      current.timer = setTimeout(() => this.closeFiles(key), COALESCE_MS);
      return current.entry;
    }
    if (current) this.closeFiles(key);
    const entry = {
      id: crypto.randomUUID(),
      at,
      until: at,
      kind: 'files',
      projectId,
      name,
      taskId,
      paths: paths.slice(0, MAX_PATHS),
      count: new Set(paths).size
    };
    this.recent.push(entry);
    if (this.recent.length > MEMORY) this.recent.shift();
    const open = {
      entry,
      all: new Set(paths),
      lastAt: now,
      timer: setTimeout(() => this.closeFiles(key), COALESCE_MS)
    };
    this.open.set(key, open);
    this.emit('entry', entry);
    this.orphaned.delete(projectId); // hay actividad: ya no es huerfano
    return entry;
  }

  closeFiles(key) {
    const open = this.open.get(key);
    if (!open) return;
    clearTimeout(open.timer);
    this.open.delete(key);
    this.persist(open.entry);
  }

  /** Cambios de estado git: commits nuevos y cambios de rama. */
  recordState({ projectId, name, state, previous }) {
    if (!previous || !state) return;
    const before = previous.lastCommit?.sha;
    const after = state.lastCommit?.sha;
    if (after && before !== after) {
      this.add({
        kind: 'commit',
        projectId,
        name,
        sha: after,
        subject: state.lastCommit.subject,
        author: state.lastCommit.author,
        branch: state.branch
      });
    }
    if (previous.branch !== state.branch && state.branch) {
      this.add({ kind: 'branch', projectId, name, from: previous.branch, to: state.branch });
    }
    if (!state.dirty) this.orphaned.delete(projectId);
  }

  recordWatch(e) {
    this.add({ kind: 'watch', projectId: e.projectId, name: e.name, path: e.path, change: e.kind, size: e.size });
  }

  recordTask(projectId, name, task, previousStatus) {
    if (!task || task.status === previousStatus) return;
    this.add({
      kind: 'agent',
      projectId,
      name,
      taskId: task.id,
      title: task.title,
      type: task.type,
      stage: task.stage,
      status: task.status,
      error: task.error || null
    });
  }

  recordSignal(signal) {
    this.add({ kind: 'signal', ...signal });
  }

  /**
   * Cambios huerfanos: repos con cambios sin commitear cuya ultima actividad es
   * mas antigua que `orphanMinutes`. Se avisa una vez por periodo.
   */
  checkOrphans(repos, now = Date.now()) {
    const minutes = loadPrefs().orphanMinutes;
    const found = [];
    for (const r of repos) {
      if (!r.state?.dirty) {
        this.orphaned.delete(r.projectId);
        continue;
      }
      const last = Date.parse(r.lastActivity || r.state.at || 0) || 0;
      const idleMin = (now - last) / 60000;
      if (idleMin >= minutes && !this.orphaned.has(r.projectId)) {
        this.orphaned.set(r.projectId, true);
        found.push(
          this.add({
            kind: 'orphan',
            projectId: r.projectId,
            name: r.name,
            files: r.state.files.length,
            idleMinutes: Math.round(idleMin)
          })
        );
      }
    }
    return found;
  }

  /** Entradas mas recientes primero, con filtros. */
  query({ projectIds, kinds, ext, since, until, limit = 200 } = {}) {
    const exts = ext
      ? String(ext)
          .split(',')
          .map((e) => e.trim().replace(/^\./, '').toLowerCase())
          .filter(Boolean)
      : null;
    const sinceT = since ? Date.parse(since) : null;
    const untilT = until ? Date.parse(until) : null;
    const out = [];
    for (let i = this.recent.length - 1; i >= 0 && out.length < Math.min(1000, limit); i--) {
      const e = this.recent[i];
      if (projectIds && !projectIds.includes(e.projectId)) continue;
      if (kinds && !kinds.includes(e.kind)) continue;
      const t = Date.parse(e.at);
      if (sinceT && t < sinceT) continue;
      if (untilT && t > untilT) continue;
      if (exts) {
        const paths = e.paths || (e.path ? [e.path] : []);
        if (!paths.some((p) => exts.includes(p.split('.').pop().toLowerCase()))) continue;
      }
      out.push(e);
    }
    return out;
  }

  stop() {
    for (const key of [...this.open.keys()]) this.closeFiles(key);
  }
}

module.exports = { Timeline, timelineFile };
