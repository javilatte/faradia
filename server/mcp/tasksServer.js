'use strict';

// Stdio MCP server, launched as a child process of `claude` itself (via
// --mcp-config), not of the Faradia HTTP server. It has no direct access to
// the running server's in-memory state, so every tool call round-trips back
// into it over plain HTTP, using the port the parent process passed through
// FARADIA_PORT (the real listening port is only known after server.listen()
// resolves, since Faradia uses an ephemeral port — see server/index.js).

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const port = process.env.FARADIA_PORT;
if (!port) {
  console.error('tasksServer: FARADIA_PORT env var is required');
  process.exit(1);
}
// Each project has its own mcp.json with its id and the token of this Faradia run (see
// server/runtime/projectRuntime.js#writeMcpConfig).
const projectId = process.env.FARADIA_PROJECT;
const base = projectId ? `http://127.0.0.1:${port}/api/projects/${projectId}` : `http://127.0.0.1:${port}/api`;
const authHeaders = process.env.FARADIA_TOKEN ? { 'X-Faradia-Token': process.env.FARADIA_TOKEN } : {};
const fixedTaskId = process.env.FARADIA_TASK_ID || null;

// Without an id (the model left it out and the session has none fixed): the task whose worktree is
// the folder this session runs in.
async function taskOfThisFolder() {
  try {
    const res = await fetch(`${base}/tasks`, { headers: authHeaders });
    if (!res.ok) return null;
    const here = process.cwd();
    const task = (await res.json()).find(
      (t) => t.worktreePath && (here === t.worktreePath || here.startsWith(`${t.worktreePath}/`))
    );
    return task?.id || null;
  } catch {
    return null;
  }
}

const server = new McpServer({ name: 'faradia-tasks', version: '1.0.0' });

server.registerTool(
  'create_task',
  {
    description:
      'Crea una tarea nueva para un agente de Faradia a partir de un plan acordado con el usuario en el chat. ' +
      'Usar solo después de cerrar un plan concreto con el usuario (p. ej. con la skill plan-optimizer), no para pedidos vagos.',
    inputSchema: {
      title: z.string().describe('Short task title, shown in the agents panel'),
      type: z
        .enum(['coding', 'bugfix', 'tests', 'documentation', 'audit', 'custom'])
        .describe(
          'Task type: coding (plan, implement, verify), bugfix (diagnose, fix, verify), tests (write tests), documentation, audit (report without changes) or custom (a custom agent, give agentId)'
        ),
      agentId: z.string().optional().describe('Id of the custom agent, only for type "custom"'),
      instruction: z
        .string()
        .describe('Complete, self-contained instruction for the agent that will run the task in its own worktree')
    }
  },
  async ({ title, type, instruction, agentId }) => {
    const res = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ title, type, instruction, agentId })
    });
    if (!res.ok) {
      return { content: [{ type: 'text', text: `Error creando la tarea: HTTP ${res.status}` }], isError: true };
    }
    const task = await res.json();
    return { content: [{ type: 'text', text: `Tarea creada con id ${task.id}: ${task.title}` }] };
  }
);

server.registerTool(
  'update_task_progress',
  {
    description:
      'Reporta el progreso real de una tarea en una de sus 3 fases (plan, implement, test) para que el panel de ' +
      'agentes de Faradia lo refleje. Llamar al empezar y al terminar cada fase, no solo al final.',
    inputSchema: {
      taskId: z
        .string()
        .optional()
        .describe('Task id. Can be omitted if this session already belongs to a specific task.'),
      phase: z.enum(['plan', 'implement', 'test']),
      status: z.enum(['pending', 'active', 'done', 'blocked'])
    }
  },
  async ({ taskId, phase, status }) => {
    const id = taskId || fixedTaskId || (await taskOfThisFolder());
    if (!id) {
      return {
        content: [
          { type: 'text', text: 'Error: no se pudo determinar el taskId (no se pasó y esta sesión no tiene uno fijo)' }
        ],
        isError: true
      };
    }
    const res = await fetch(`${base}/tasks/${id}/phase`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ phase, status })
    });
    if (!res.ok) {
      return { content: [{ type: 'text', text: `Error actualizando la fase: HTTP ${res.status}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Fase "${phase}" de la tarea ${id} actualizada a "${status}"` }] };
  }
);

const transport = new StdioServerTransport();
server.connect(transport);
