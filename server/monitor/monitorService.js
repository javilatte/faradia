'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { TreeWatcher } = require('./treeWatcher');
const { getRepoState, isGitRepo } = require('./gitState');
const { compileGlobs, staticPrefix } = require('./glob');
const { getWatchlist } = require('./watchlists');
const { loadTasks } = require('../store/taskStore');

// Read-only supervision of the active workbench's repos (and of their tasks' worktrees, where
// agents work). Never writes to a repo.
// Events:
//   'state'          { projectId, name, path, state }           plane 1 recomputed
//   'activity'       { projectId, taskId?, paths, at }           files that changed
//   'watch_event'    { projectId, path, kind, size, mtime, at }  plane 2 (watchlist)
//   'worktree_state' { projectId, taskId, state }                plane 1 of a task's worktree

const REFRESH_DEBOUNCE_MS = 400;
const WORKTREE_SYNC_MS = 5000;
const RECENT_WATCH_EVENTS = 200;

class MonitorService extends EventEmitter {
  constructor({ getRepos, debounceMs = 300 } = {}) {
    super();
    this.getRepos = getRepos; // () => [{ projectId, name, path }]
    this.debounceMs = debounceMs;
    this.repos = new Map(); // projectId -> entry
    this.watchEvents = []; // latest plane 2 events
    this.worktreeTimer = null;
  }

  async start() {
    await this.sync();
    this.worktreeTimer = setInterval(() => this.syncWorktrees().catch(() => {}), WORKTREE_SYNC_MS);
    this.worktreeTimer.unref?.();
  }

  /** Starts or stops watchers to match the current repos. */
  async sync() {
    const wanted = new Map((this.getRepos() || []).filter((r) => fs.existsSync(r.path)).map((r) => [r.projectId, r]));
    for (const [id, entry] of this.repos) {
      if (!wanted.has(id)) {
        this.stopEntry(entry);
        this.repos.delete(id);
      }
    }
    for (const [id, repo] of wanted) {
      if (!this.repos.has(id)) await this.startRepo(repo);
    }
    await this.syncWorktrees();
  }

  async startRepo(repo) {
    const entry = {
      ...repo,
      git: await isGitRepo(repo.path),
      watcher: null,
      state: null,
      lastActivity: null,
      refreshTimer: null,
      refreshing: false,
      refreshAgain: false,
      known: new Map(), // plano 2: rel -> { size, mtime }
      matches: compileGlobs([]),
      worktrees: new Map() // taskId -> { watcher, state, path }
    };
    this.repos.set(repo.projectId, entry);
    await this.restartWatcher(entry);
    if (entry.git) await this.refresh(entry);
  }

  async restartWatcher(entry) {
    entry.watcher?.close();
    const patterns = getWatchlist(entry.path);
    entry.matches = compileGlobs(patterns);
    const extraDirs = patterns.map(staticPrefix).filter(Boolean);
    entry.watcher = new TreeWatcher(entry.path, { extraDirs, debounceMs: this.debounceMs, watchGitMeta: entry.git });
    entry.watcher.on('change', (batch) => this.onChange(entry, batch));
    await entry.watcher.start();
  }

  onChange(entry, { paths, git }) {
    const at = new Date().toISOString();
    if (paths.length) {
      entry.lastActivity = at;
      this.emit('activity', { projectId: entry.projectId, name: entry.name, paths, at });
      for (const rel of paths) if (entry.matches(rel)) this.recordWatchEvent(entry, rel, at);
    }
    if (entry.git && (paths.length || git)) this.scheduleRefresh(entry);
  }

  recordWatchEvent(entry, rel, at) {
    let stat = null;
    try {
      stat = fs.statSync(path.join(entry.path, rel));
    } catch {
      /* deleted */
    }
    if (stat && stat.isDirectory()) return;
    const before = entry.known.get(rel);
    let kind;
    if (!stat) {
      kind = 'deleted';
      entry.known.delete(rel);
    } else {
      kind = before ? 'modified' : 'created';
      // An event without real changes (same size and date) is not repeated.
      if (before && before.size === stat.size && before.mtime === stat.mtimeMs) return;
      entry.known.set(rel, { size: stat.size, mtime: stat.mtimeMs });
    }
    const event = {
      projectId: entry.projectId,
      name: entry.name,
      path: rel,
      kind,
      size: stat ? stat.size : null,
      mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
      at
    };
    this.watchEvents.push(event);
    if (this.watchEvents.length > RECENT_WATCH_EVENTS) this.watchEvents.shift();
    this.emit('watch_event', event);
  }

  scheduleRefresh(entry) {
    clearTimeout(entry.refreshTimer);
    entry.refreshTimer = setTimeout(() => this.refresh(entry), REFRESH_DEBOUNCE_MS);
  }

  async refresh(entry) {
    if (entry.refreshing) {
      entry.refreshAgain = true;
      return;
    }
    entry.refreshing = true;
    try {
      const previous = entry.state;
      entry.state = await getRepoState(entry.path);
      this.emit('state', {
        projectId: entry.projectId,
        name: entry.name,
        path: entry.path,
        state: entry.state,
        previous
      });
    } catch (err) {
      entry.error = err.message;
    } finally {
      entry.refreshing = false;
      if (entry.refreshAgain) {
        entry.refreshAgain = false;
        this.scheduleRefresh(entry);
      }
    }
  }

  /** Watches the worktree of every task that has one on disk (agents write there). */
  async syncWorktrees() {
    for (const entry of this.repos.values()) {
      let tasks = [];
      try {
        tasks = loadTasks(entry.path);
      } catch {
        tasks = [];
      }
      const live = new Map(tasks.filter((t) => t.worktreePath && fs.existsSync(t.worktreePath)).map((t) => [t.id, t]));
      for (const [taskId, wt] of entry.worktrees) {
        if (!live.has(taskId)) {
          wt.watcher.close();
          clearTimeout(wt.timer);
          entry.worktrees.delete(taskId);
        }
      }
      for (const [taskId, task] of live) {
        if (entry.worktrees.has(taskId)) continue;
        const wt = { path: task.worktreePath, title: task.title, state: null, timer: null };
        wt.watcher = new TreeWatcher(task.worktreePath, { debounceMs: this.debounceMs, watchGitMeta: false });
        wt.watcher.on('change', ({ paths }) => {
          const at = new Date().toISOString();
          this.emit('activity', { projectId: entry.projectId, name: entry.name, taskId, paths, at });
          clearTimeout(wt.timer);
          wt.timer = setTimeout(() => this.refreshWorktree(entry, taskId, wt), REFRESH_DEBOUNCE_MS);
        });
        entry.worktrees.set(taskId, wt);
        await wt.watcher.start();
        await this.refreshWorktree(entry, taskId, wt);
      }
    }
  }

  async refreshWorktree(entry, taskId, wt) {
    try {
      const previous = wt.state;
      wt.state = await getRepoState(wt.path);
      this.emit('worktree_state', {
        projectId: entry.projectId,
        name: entry.name,
        taskId,
        title: wt.title,
        state: wt.state,
        previous
      });
    } catch {
      /* the worktree was removed */
    }
  }

  /** A repo's plane 2 watchlist changed: its watcher is set up again. */
  async reloadWatchlist(projectId) {
    const entry = this.repos.get(projectId);
    if (entry) await this.restartWatcher(entry);
  }

  snapshot() {
    return [...this.repos.values()].map((e) => ({
      projectId: e.projectId,
      name: e.name,
      path: e.path,
      git: e.git,
      state: e.state,
      lastActivity: e.lastActivity,
      watchedDirs: e.watcher?.size || 0,
      truncated: Boolean(e.watcher?.truncated),
      worktrees: [...e.worktrees.entries()].map(([taskId, wt]) => ({
        taskId,
        title: wt.title,
        path: wt.path,
        state: wt.state
      }))
    }));
  }

  entry(projectId) {
    return this.repos.get(projectId) || null;
  }

  recentWatchEvents(projectId) {
    return this.watchEvents
      .filter((e) => !projectId || e.projectId === projectId)
      .slice()
      .reverse();
  }

  stopEntry(entry) {
    entry.watcher?.close();
    clearTimeout(entry.refreshTimer);
    for (const wt of entry.worktrees.values()) {
      wt.watcher.close();
      clearTimeout(wt.timer);
    }
  }

  stop() {
    clearInterval(this.worktreeTimer);
    for (const entry of this.repos.values()) this.stopEntry(entry);
    this.repos.clear();
  }
}

module.exports = { MonitorService };
