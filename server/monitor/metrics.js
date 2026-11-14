'use strict';

const { loadTasks } = require('../store/taskStore');

// Metricas ligeras por repo, sin persistir: lineas +/- (del estado git), frecuencia
// de cambios (lotes de ficheros por hora en las ultimas 24 h) y sesiones de agentes
// (ficheros tocados y coste de cada etapa, de tasks.json).

const HOUR = 60 * 60 * 1000;

class Metrics {
  constructor() {
    this.buckets = new Map(); // projectId -> Map(hourStartMs -> ficheros cambiados)
  }

  recordActivity({ projectId, paths, at }) {
    const t = Date.parse(at) || Date.now();
    const hour = Math.floor(t / HOUR) * HOUR;
    if (!this.buckets.has(projectId)) this.buckets.set(projectId, new Map());
    const b = this.buckets.get(projectId);
    b.set(hour, (b.get(hour) || 0) + paths.length);
    for (const k of b.keys()) if (k < hour - 24 * HOUR) b.delete(k);
  }

  /** 24 valores: ficheros cambiados en cada una de las ultimas 24 horas (la ultima, la actual). */
  hourly(projectId, now = Date.now()) {
    const b = this.buckets.get(projectId) || new Map();
    const current = Math.floor(now / HOUR) * HOUR;
    return Array.from({ length: 24 }, (_, i) => b.get(current - (23 - i) * HOUR) || 0);
  }

  forRepo(repo, now = Date.now()) {
    const hourly = this.hourly(repo.projectId, now);
    let sessions = [];
    try {
      sessions = loadTasks(repo.path)
        .flatMap((t) => (t.stageRuns || []).map((r) => ({ taskId: t.id, title: t.title, ...r })))
        .filter((r) => r.finishedAt)
        .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
        .slice(0, 20);
    } catch {
      sessions = [];
    }
    return {
      projectId: repo.projectId,
      name: repo.name,
      lines: repo.state?.lines || { added: 0, removed: 0 },
      changesLastHour: hourly[23],
      changesToday: hourly.reduce((a, b) => a + b, 0),
      hourly,
      agentSessions: sessions,
      agentFilesTouched: sessions.reduce((n, s) => n + (s.filesTouched || 0), 0),
      agentCostUsd: sessions.reduce((n, s) => n + (s.costUsd || 0), 0)
    };
  }
}

module.exports = { Metrics };
