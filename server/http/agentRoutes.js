'use strict';

const catalog = require('../agents/catalog');
const stageMap = require('../agents/stageMap');
const { STAGES, TASK_TYPES } = require('../bridge/taskStages');
const { sendJson, readJsonBody } = require('./util');
const { pstackPrinciples, frontmatterDescription } = require('../skills/library');
const { loadSettings } = require('../store/settingsStore');

const path = require('path');

// pstack's principles, for the agent editor: id, a readable name and when it applies.
let principleList = null;
function principleCatalog() {
  if (!principleList) {
    const dir = path.join(__dirname, '..', '..', 'vendor', 'pstack', 'principles');
    principleList = pstackPrinciples().map((id) => ({
      id,
      name: id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      description: frontmatterDescription(path.join(dir, id, 'SKILL.md'))
    }));
  }
  return principleList;
}

// Agent routes of a project (project settings win over global ones):
//   GET    /api/agents                          effective catalog, stages, task types and stage->agent map
//   POST   /api/agents {scope, name, ...}        creates a custom agent
//   PATCH  /api/agents/:id {scope, ...fields}    changes an agent's fields in a scope
//   DELETE /api/agents/:id?scope=global|project  restores the default or deletes the custom agent
//   PUT    /api/agents/stages {scope, changes}   changes which agent runs each stage

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
      Object.entries(TASK_TYPES).map(([k, v]) => [
        k,
        { label: v.label, pipeline: v.pipeline, internal: Boolean(v.internal) }
      ])
    ),
    claudeModels: catalog.CLAUDE_MODELS,
    efforts: catalog.EFFORTS,
    principles: principleCatalog(),
    principlesEnabled: loadSettings(projectRoot).principles?.enabled !== false
  };
}

const PICK = ['name', 'description', 'engine', 'model', 'effort', 'access', 'enabled', 'prompt', 'principles', 'face'];
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
