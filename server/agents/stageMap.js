'use strict';

const fs = require('fs');
const path = require('path');
const { STAGES } = require('../bridge/taskStages');
const { loadAgents, globalAgentsDir, projectAgentsDir } = require('./catalog');

// Que agente hace cada etapa. Por defecto, el de la tabla STAGES; se puede cambiar
// para todos los proyectos (~/.config/optimia/agents/stages.json) o solo para uno
// (<proyecto>/.optimia/agents/stages.json). El proyecto gana.

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
 * Cambia el agente de una o varias etapas en un ambito. `null` vuelve al valor
 * heredado. Una etapa que edita no puede asignarse a un agente de solo lectura.
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
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  return loadStageMap(projectRoot);
}

/** Agente que ejecuta `stage` de `task` en este proyecto (o null si no hay ninguno valido). */
function resolveStageAgent(projectRoot, task, stage) {
  const agents = loadAgents(projectRoot);
  if (stage === 'custom') return agents.find((a) => a.id === task.agentId) || null;
  const id = loadStageMap(projectRoot)[stage];
  return agents.find((a) => a.id === id) || agents.find((a) => a.id === STAGES[stage]?.agent) || null;
}

/** Etapas opcionales que se saltan porque su agente esta desactivado. */
function skippedStages(projectRoot) {
  const map = loadStageMap(projectRoot);
  const agents = new Map(loadAgents(projectRoot).map((a) => [a.id, a]));
  return MAPPABLE.filter((s) => STAGES[s].optional && agents.get(map[s])?.enabled === false);
}

module.exports = { MAPPABLE, defaultMap, loadStageMap, saveStageMap, resolveStageAgent, skippedStages };
