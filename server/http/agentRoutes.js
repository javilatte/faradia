'use strict';

const catalog = require('../agents/catalog');
const stageMap = require('../agents/stageMap');
const { STAGES, TASK_TYPES } = require('../bridge/taskStages');
const { sendJson, readJsonBody } = require('./util');

// Rutas de agentes de un proyecto (los ajustes de proyecto ganan a los globales):
//   GET    /api/agents                          catalogo efectivo, etapas, tipos de tarea y mapa etapa->agente
//   POST   /api/agents {scope, name, ...}        crea un agente propio
//   PATCH  /api/agents/:id {scope, ...campos}    cambia campos de un agente en un ambito
//   DELETE /api/agents/:id?scope=global|project  restaura el por defecto o borra el agente propio
//   PUT    /api/agents/stages {scope, changes}   cambia que agente hace cada etapa

function catalogView(projectRoot) {
  return {
    agents: catalog.loadAgents(projectRoot),
    stageMap: stageMap.loadStageMap(projectRoot),
    stages: Object.fromEntries(
      Object.entries(STAGES).map(([k, v]) => [
        k,
        { label: v.label, access: v.access, optional: Boolean(v.optional), manual: Boolean(v.manual) }
      ])
    ),
    taskTypes: Object.fromEntries(
      Object.entries(TASK_TYPES).map(([k, v]) => [k, { label: v.label, pipeline: v.pipeline }])
    ),
    claudeModels: catalog.CLAUDE_MODELS,
    efforts: catalog.EFFORTS
  };
}

const PICK = ['name', 'description', 'engine', 'model', 'effort', 'access', 'enabled', 'prompt'];
const pick = (body) => Object.fromEntries(PICK.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

async function handleAgentRoutes(req, res, url, projectRoot) {
  const p = url.pathname;
  const m = /^\/api\/agents\/([a-z0-9][a-z0-9-]{1,39})$/.exec(p);
  try {
    if (p === '/api/agents' && req.method === 'GET') return sendJson(res, 200, catalogView(projectRoot));

    if (p === '/api/agents' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const agent = catalog.createAgent(projectRoot, body.scope || 'project', pick(body));
      return sendJson(res, 201, { agent, ...catalogView(projectRoot) });
    }

    if (p === '/api/agents/stages' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      stageMap.saveStageMap(projectRoot, body.scope || 'project', body.changes || {});
      return sendJson(res, 200, catalogView(projectRoot));
    }

    if (m && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      if (!catalog.getAgent(projectRoot, m[1])) return sendJson(res, 404, { error: 'agente no encontrado' });
      catalog.saveAgent(projectRoot, body.scope || 'project', m[1], pick(body));
      return sendJson(res, 200, catalogView(projectRoot));
    }

    if (m && req.method === 'DELETE') {
      const scope = url.searchParams.get('scope') || 'project';
      const removed = catalog.removeAgent(projectRoot, scope, m[1]);
      if (!removed) return sendJson(res, 404, { error: 'ese agente no tiene ajustes en ese ambito' });
      return sendJson(res, 200, catalogView(projectRoot));
    }
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  return null;
}

module.exports = { handleAgentRoutes, catalogView };
