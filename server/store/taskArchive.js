'use strict';

const { writeJsonFile } = require('./jsonFile');
const fs = require('fs');
const path = require('path');

// Finished tasks, kept after they leave the agents board: what was asked, how it ended (pull
// request, commit, merged or discarded), which agents and models ran it and their report. Stored per
// repo in .faradia/tasks-archive.json and deleted after the retention chosen in the archive
// (30, 15, 7 or 1 days, or never).

const RETENTION_DAYS = [0, 1, 7, 15, 30]; // 0 = never delete
const DEFAULT_RETENTION = 30;
const MAX_ENTRIES = 1000;

const cut = (s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined);

function archivePath(projectRoot) {
  return path.join(projectRoot, '.faradia', 'tasks-archive.json');
}

function read(projectRoot) {
  try {
    const list = JSON.parse(fs.readFileSync(archivePath(projectRoot), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(projectRoot, list) {
  writeJsonFile(archivePath(projectRoot), list);
}

function outcomeOf(task) {
  if (task.mergedInto) return 'merged';
  if (task.pr?.url) return 'pr';
  if (task.lastCommit || task.deliveredAs === 'commit') return 'commit';
  if (task.status === 'ready_to_test' && (task.type === 'audit' || task.type === 'onboard')) return 'report';
  return 'discarded';
}

/** What is kept of a task (no worktree paths, sessions or transient state). */
function snapshot(task, now = new Date()) {
  return {
    id: task.id,
    title: task.title,
    type: task.type,
    instruction: cut(task.instruction, 4000),
    outcome: outcomeOf(task),
    branch: task.branch || task.branchName,
    baseBranch: task.baseBranch,
    mergedInto: task.mergedInto,
    pr: task.pr?.url ? { url: task.pr.url, title: task.pr.title } : undefined,
    lastCommit: task.lastCommit,
    lastCommitMessage: cut(task.lastCommitMessage, 400),
    createdAt: task.createdAt,
    finishedAt: task.updatedAt || now.toISOString(),
    archivedAt: now.toISOString(),
    stageRuns: (task.stageRuns || []).map((r) => ({
      stage: r.stage,
      agentName: r.agentName,
      engine: r.engine,
      model: r.model,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      costUsd: r.costUsd
    })),
    report: cut(task.output, 12000),
    verification: task.verification
      ? { verdict: cut(task.verification.line, 300), evidence: task.verification.evidence || undefined }
      : undefined,
    correction: task.correction || undefined
  };
}

function archiveTask(projectRoot, task, now = new Date()) {
  const list = read(projectRoot).filter((t) => t.id !== task.id);
  list.unshift(snapshot(task, now));
  write(projectRoot, list.slice(0, MAX_ENTRIES));
}

const validRetention = (days) => (RETENTION_DAYS.includes(Number(days)) ? Number(days) : DEFAULT_RETENTION);

/** Archived tasks, newest first, after deleting the ones older than the retention. */
function listArchive(projectRoot, retentionDays = DEFAULT_RETENTION, now = Date.now()) {
  const days = validRetention(retentionDays);
  const list = read(projectRoot);
  if (!days) return list;
  const limit = now - days * 24 * 60 * 60 * 1000;
  const kept = list.filter((t) => Date.parse(t.archivedAt) >= limit);
  if (kept.length !== list.length) write(projectRoot, kept);
  return kept;
}

function removeArchived(projectRoot, id) {
  const list = read(projectRoot);
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  write(projectRoot, next);
  return true;
}

function clearArchive(projectRoot) {
  write(projectRoot, []);
}

module.exports = {
  RETENTION_DAYS,
  DEFAULT_RETENTION,
  validRetention,
  archiveTask,
  listArchive,
  removeArchived,
  clearArchive,
  snapshot
};
