'use strict';

const { writeJsonFile } = require('./jsonFile');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function tasksPath(projectRoot) {
  return path.join(projectRoot, '.faradia', 'tasks.json');
}

function loadTasks(projectRoot) {
  const file = tasksPath(projectRoot);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveTasks(projectRoot, tasks) {
  const dir = path.join(projectRoot, '.faradia');
  fs.mkdirSync(dir, { recursive: true });
  writeJsonFile(tasksPath(projectRoot), tasks);
}

function addTask(
  projectRoot,
  { title, type, steps, instruction, chatId, baseBranch, branchName, agentId, existingBranch }
) {
  const tasks = loadTasks(projectRoot);
  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    title,
    type, // coding | bugfix | tests | documentation | audit | custom (ver bridge/taskStages.js TASK_TYPES)
    agentId: type === 'custom' ? agentId || null : null, // custom agent of a custom task
    stageRuns: [], // { stage, agentId, agentName, engine, model, startedAt, finishedAt, status, filesTouched, costUsd }
    chatId: chatId || null, // chat it was started from, to notify that conversation
    // pending | in_progress | awaiting_input | ready_to_test (ver bridge/taskStages.js)
    status: 'pending',
    stage: null, // running stage or the last one that ran (plan, implement, research, write, review, commit)
    stageOutputs: {}, // final text of each stage, by stage name
    output: null, // final text of the last stage, shown on the card
    pendingQuestion: null, // { kind: 'plan-details' | 'research-details' | 'implement-details' | 'doc-options', text }
    docOptions: null, // { mode, format, targetPath, template } for documentation
    sessionId: null, // Claude session of the last stage (to resume when answering)
    error: null,
    steps: (steps || []).map((label) => ({ id: crypto.randomUUID(), label, status: 'pending' })),
    // Real checkpoints an agent self-reports via the update_task_progress MCP
    // tool (see server/mcp/tasksServer.js) — not a guess derived from stream
    // events, the agent itself says when each phase starts/finishes.
    phases: [
      { key: 'plan', status: 'pending' },
      { key: 'implement', status: 'pending' },
      { key: 'test', status: 'pending' }
    ],
    instruction: instruction || title,
    baseBranch: baseBranch || null,
    branchName: branchName || null,
    // true: the task works on a branch that already existed (several tasks can share one branch)
    existingBranch: Boolean(existingBranch),
    branch: null,
    worktreePath: null,
    createdAt: now,
    updatedAt: now
  };
  tasks.push(task);
  saveTasks(projectRoot, tasks);
  return task;
}

function updateTask(projectRoot, taskId, patch) {
  const tasks = loadTasks(projectRoot);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  tasks[idx] = { ...tasks[idx], ...patch, updatedAt: new Date().toISOString() };
  saveTasks(projectRoot, tasks);
  return tasks[idx];
}

function updateTaskPhase(projectRoot, taskId, phaseKey, status) {
  const tasks = loadTasks(projectRoot);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  const phases = (tasks[idx].phases || []).map((p) => (p.key === phaseKey ? { ...p, status } : p));
  if (!phases.some((p) => p.key === phaseKey)) return null;
  tasks[idx] = { ...tasks[idx], phases, updatedAt: new Date().toISOString() };
  saveTasks(projectRoot, tasks);
  return tasks[idx];
}

function deleteTask(projectRoot, taskId) {
  const tasks = loadTasks(projectRoot);
  const next = tasks.filter((t) => t.id !== taskId);
  if (next.length === tasks.length) return false;
  saveTasks(projectRoot, next);
  return true;
}

module.exports = { tasksPath, loadTasks, saveTasks, addTask, updateTask, updateTaskPhase, deleteTask };
