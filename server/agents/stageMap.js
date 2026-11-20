'use strict';

const { writeJsonFile } = require('../store/jsonFile');
const fs = require('fs');
const path = require('path');
const { STAGES } = require('../bridge/taskStages');
const { loadAgents, globalAgentsDir, projectAgentsDir } = require('./catalog');

// Which agent runs each stage. By default, the one in the STAGES table; it can be changed for every
// project (~/.config/faradia/agents/stages.json) or for one
// (<project>/.faradia/agents/stages.json). The project wins.

const MAPPABLE = Object.keys(STAGES).filter((s) => STAGES[s].agent);

function defaultMap() {
  return Object.fromEntries(MAPPABLE.map((s) => [s, STAGES[s].agent]));
}

function fileFor(scope, projectRoot) {
  if (scope === 'global') return path.join(globalAgentsDir(), 'stages.json');
  if (scope === 'project') return path.join(projectAgentsDir(projectRoot), 'stages.json');
  throw new Error('scope debe ser "global" o "project"');
}

function readMap(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function loadStageMap(projectRoot) {
  const merged = {
    ...defaultMap(),
    ...readMap(fileFor('global')),
    ...(projectRoot ? readMap(fileFor('project', projectRoot)) : {})
  };
  return Object.fromEntries(MAPPABLE.map((s) => [s, merged[s]]));
}

/**
 * Changes the agent of one or more stages in a scope. `null` goes back to the inherited value. A
 * stage that edits cannot be assigned to a read-only agent.
 */
function saveStageMap(projectRoot, scope, changes) {
  const agents = new Map(loadAgents(projectRoot).map((a) => [a.id, a]));
  const file = fileFor(scope, projectRoot);
  const current = readMap(file);
  for (const [stage, agentId] of Object.entries(changes || {})) {
    if (!MAPPABLE.includes(stage)) throw new Error(`etapa desconocida: ${stage}`);
    if (agentId === null) {
      delete current[stage];
      continue;
    }
    const agent = agents.get(agentId);
    if (!agent) throw new Error(`agente desconocido: ${agentId}`);
    if (STAGES[stage].access === 'edit' && agent.access !== 'edit') {
      throw new Error(`la etapa "${stage}" modifica ficheros: elige un agente con acceso de edicion`);
    }
    current[stage] = agentId;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonFile(file, current);
  return loadStageMap(projectRoot);
}

/** Agent that runs `stage` of `task` in this project (or null if there is no valid one). */
function resolveStageAgent(projectRoot, task, stage) {
  const agents = loadAgents(projectRoot);
  if (stage === 'custom') return agents.find((a) => a.id === task.agentId) || null;
  const id = loadStageMap(projectRoot)[stage];
  return agents.find((a) => a.id === id) || agents.find((a) => a.id === STAGES[stage]?.agent) || null;
}

/** Optional stages skipped because their agent is disabled. */
function skippedStages(projectRoot) {
  const map = loadStageMap(projectRoot);
  const agents = new Map(loadAgents(projectRoot).map((a) => [a.id, a]));
  return MAPPABLE.filter((s) => STAGES[s].optional && agents.get(map[s])?.enabled === false);
}

module.exports = { MAPPABLE, defaultMap, loadStageMap, saveStageMap, resolveStageAgent, skippedStages };
