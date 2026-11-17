'use strict';

// Live agent activity: what each task agent reasons, reads, edits, runs and checks, as a feed.
// Built from the stream-json events the server relays (task_claude_event). Claude Code does not
// expose the text of its private reasoning, only how much of it there is (system/thinking_tokens),
// so the feed shows that alongside what the agent says while it works.

const taskActivity = new Map();
const ACTIVITY_MAX = 400;
const ACTIVITY_LIVE_ROWS = 7;

function activityFor(taskId) {
  let a = taskActivity.get(taskId);
  if (!a) {
    a = { items: [], tools: new Map(), thinking: null };
    taskActivity.set(taskId, a);
  }
  return a;
}

function activityCount(taskId) {
  const a = taskActivity.get(taskId);
  return a ? a.items.filter((i) => i.kind !== 'stage').length : 0;
}

function relativePath(file, root) {
  if (!file) return '';
  const text = String(file);
  if (root && text.startsWith(root)) return text.slice(root.length).replace(/^\/+/, '') || '.';
  // Outside the task's folder (another repo, the wikis): the last parts are what tells it apart.
  const parts = text.split('/').filter(Boolean);
  return text.startsWith('/') && parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : text;
}

function countLines(text) {
  if (!text) return 0;
  const lines = String(text).split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function compactTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function toolActivity(block, root) {
  const input = block.input || {};
  const item = { kind: 'tool', id: block.id, tool: block.name, status: 'running', detail: '', add: 0, del: 0 };
  switch (block.name) {
    case 'Read':
      return { ...item, verb: 'Lee', detail: relativePath(input.file_path, root) };
    case 'Edit':
      return {
        ...item,
        verb: 'Edita',
        detail: relativePath(input.file_path, root),
        add: countLines(input.new_string),
        del: countLines(input.old_string)
      };
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      return {
        ...item,
        verb: 'Edita',
        detail: relativePath(input.file_path, root),
        add: edits.reduce((n, e) => n + countLines(e.new_string), 0),
        del: edits.reduce((n, e) => n + countLines(e.old_string), 0)
      };
    }
    case 'Write':
      return { ...item, verb: 'Crea', detail: relativePath(input.file_path, root), add: countLines(input.content) };
    case 'Bash':
      return {
        ...item,
        verb: 'Ejecuta',
        detail: String(input.command || '').split('\n')[0],
        note: input.description || ''
      };
    case 'Grep':
      return {
        ...item,
        verb: 'Busca',
        detail: `${input.pattern || ''}${input.path ? `  en ${relativePath(input.path, root)}` : ''}`
      };
    case 'Glob':
      return { ...item, verb: 'Lista', detail: input.pattern || '' };
    case 'Task':
    case 'Agent':
      return { ...item, verb: 'Delega', detail: input.description || input.subagent_type || '' };
    case 'WebFetch':
      return { ...item, verb: 'Consulta', detail: input.url || '' };
    case 'WebSearch':
      return { ...item, verb: 'Consulta', detail: input.query || '' };
    case 'TodoWrite':
      return {
        kind: 'todo',
        id: block.id,
        todos: (Array.isArray(input.todos) ? input.todos : []).map((t) => ({
          text: t.content || t.activeForm || '',
          status: t.status || 'pending'
        }))
      };
    case 'mcp__optimia-tasks__update_task_progress':
      return {
        kind: 'progress',
        id: block.id,
        phase: input.phase || '',
        status: input.status || ''
      };
    default: {
      // MCP tools: "mcp__server__tool" reads as "tool (server)".
      const mcp = /^mcp__(.+?)__(.+)$/.exec(block.name);
      const verb = mcp ? mcp[2].replace(/_/g, ' ') : block.name;
      return { ...item, verb, detail: input.description || input.file_path || input.query || (mcp ? mcp[1] : '') };
    }
  }
}

function toolResultText(block) {
  const content = block.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  return '';
}

// The line of a command's output worth showing: a test summary if there is one, else the last line.
function resultSummary(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const summary = [...lines]
    .reverse()
    .find((l) => /\b(tests?|passed|failed|passing|failing|errors?|warnings?|suites?)\b/i.test(l));
  return (summary || lines[lines.length - 1]).slice(0, 160);
}

function closeThinking(a) {
  if (a.thinking) a.thinking.live = false;
  a.thinking = null;
}

function pushActivity(a, item) {
  a.items.push(item);
  if (a.items.length > ACTIVITY_MAX) a.items.splice(0, a.items.length - ACTIVITY_MAX);
}

function stageHeading(task) {
  const run = task?.stageRuns?.[task.stageRuns.length - 1];
  const stage = task?.stage ? stageLabel(task.stage) : 'Etapa';
  if (!run) return { stage, agent: '' };
  return { stage, agent: `${run.agentName || run.agentId} · ${modelText(run.engine, run.model)}` };
}

function recordActivity(taskId, event) {
  const a = activityFor(taskId);
  const task = tasks.get(taskId)?.task;
  const root = task?.worktreePath || '';
  if (event.type === 'system' && event.subtype === 'init') {
    closeThinking(a);
    pushActivity(a, { kind: 'stage', ...stageHeading(task) });
  } else if (event.type === 'system' && event.subtype === 'thinking_tokens') {
    if (!a.thinking) {
      a.thinking = { kind: 'think', tokens: 0, live: true, text: '' };
      pushActivity(a, a.thinking);
    }
    a.thinking.tokens = event.estimated_tokens || a.thinking.tokens + (event.estimated_tokens_delta || 0);
  } else if (event.type === 'assistant') {
    for (const block of event.message?.content || []) {
      if (block.type === 'thinking') {
        if (block.thinking?.trim()) {
          if (!a.thinking) {
            a.thinking = { kind: 'think', tokens: 0, live: false, text: '' };
            pushActivity(a, a.thinking);
          }
          a.thinking.text = block.thinking.trim();
        }
        continue;
      }
      closeThinking(a);
      if (block.type === 'text' && block.text?.trim()) pushActivity(a, { kind: 'say', text: block.text.trim() });
      if (block.type === 'tool_use') {
        const item = toolActivity(block, root);
        a.tools.set(block.id, item);
        pushActivity(a, item);
      }
    }
  } else if (event.type === 'user') {
    for (const block of event.message?.content || []) {
      if (block.type !== 'tool_result') continue;
      const item = a.tools.get(block.tool_use_id);
      if (!item || item.kind !== 'tool') continue;
      item.status = block.is_error ? 'error' : 'ok';
      if (item.tool === 'Bash' || block.is_error) item.result = resultSummary(toolResultText(block));
      a.tools.delete(block.tool_use_id);
    }
  } else if (event.type === 'system' && event.subtype === 'permission_denied') {
    closeThinking(a);
    pushActivity(a, { kind: 'blocked', text: event.tool_name || 'herramienta' });
  } else if (event.type === 'result') {
    closeThinking(a);
    for (const item of a.tools.values()) if (item.status === 'running') item.status = 'ok';
    a.tools.clear();
    const seconds = Math.round((event.duration_ms || 0) / 1000);
    pushActivity(a, {
      kind: 'end',
      ok: !event.is_error,
      duration: seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`
    });
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderActivityItem(item, live) {
  if (item.kind === 'stage') {
    const row = el('div', 'act-stage');
    row.appendChild(el('span', 'act-stage-name', item.stage));
    if (item.agent) row.appendChild(el('span', 'act-stage-agent', item.agent));
    return row;
  }
  if (item.kind === 'think') {
    const row = el('div', 'act-row act-think' + (item.live ? ' live' : ''));
    row.appendChild(el('span', 'act-glyph'));
    const body = el('div', 'act-body');
    const head = el('div', 'act-think-head');
    head.appendChild(el('span', '', item.live ? 'Pensando…' : 'Pensó'));
    if (item.tokens) head.appendChild(el('span', 'act-count', `${compactTokens(item.tokens)} tokens`));
    body.appendChild(head);
    if (item.text) body.appendChild(el('div', 'act-think-text', item.text));
    row.appendChild(body);
    return row;
  }
  if (item.kind === 'say') {
    const row = el('div', 'act-row act-say');
    row.appendChild(el('span', 'act-glyph'));
    const body = el('div', 'act-body act-say-text' + (live ? ' clamp' : ''));
    paintMarkdown(body, item.text.length > 700 ? `${item.text.slice(0, 700)}…` : item.text);
    row.appendChild(body);
    return row;
  }
  if (item.kind === 'todo') {
    const row = el('div', 'act-row act-todo');
    row.appendChild(el('span', 'act-glyph'));
    const list = el('ul', 'act-body act-todo-list');
    for (const t of item.todos) {
      const li = el('li', `todo-${t.status}`);
      li.appendChild(el('span', 'todo-box'));
      li.appendChild(el('span', 'todo-text', t.text));
      list.appendChild(li);
    }
    row.appendChild(list);
    return row;
  }
  if (item.kind === 'progress') {
    const row = el('div', 'act-row act-progress');
    row.appendChild(el('span', 'act-glyph'));
    const body = el('div', 'act-body');
    const names = { plan: 'Plan', implement: 'Implementación', test: 'Pruebas' };
    const states = { active: 'en marcha', done: 'hecha', blocked: 'bloqueada' };
    body.appendChild(el('span', 'act-verb', 'Fase'));
    body.appendChild(el('span', 'act-phase', names[item.phase] || item.phase));
    body.appendChild(el('span', 'act-phase-state', states[item.status] || item.status));
    row.appendChild(body);
    return row;
  }
  if (item.kind === 'blocked') {
    const row = el('div', 'act-row act-blocked');
    row.appendChild(el('span', 'act-glyph'));
    row.appendChild(el('div', 'act-body', `Bloqueado por seguridad: ${item.text}`));
    return row;
  }
  if (item.kind === 'end') {
    const row = el('div', 'act-end' + (item.ok ? '' : ' failed'));
    row.appendChild(el('span', '', item.ok ? 'Etapa completada' : 'Etapa con error'));
    row.appendChild(el('span', 'act-count', item.duration));
    return row;
  }
  const row = el('div', `act-row act-tool tool-${item.tool.toLowerCase()} status-${item.status}`);
  row.appendChild(el('span', 'act-glyph'));
  const body = el('div', 'act-body');
  const line = el('div', 'act-tool-line');
  line.appendChild(el('span', 'act-verb', item.verb));
  line.appendChild(el('code', 'act-detail', item.detail));
  if (item.add) line.appendChild(el('span', 'act-add', `+${item.add}`));
  if (item.del) line.appendChild(el('span', 'act-del', `−${item.del}`));
  body.appendChild(line);
  if (item.result) body.appendChild(el('div', 'act-result', item.result));
  else if (item.note && item.status === 'running') body.appendChild(el('div', 'act-note', item.note));
  row.appendChild(body);
  return row;
}

// live: only the last few rows, newest at the bottom (the card of a running task).
function renderActivity(taskId, { live = false } = {}) {
  const a = taskActivity.get(taskId);
  const feed = el('div', 'activity-feed' + (live ? ' live' : ' full'));
  const items = a ? a.items : [];
  if (!items.length) {
    feed.appendChild(el('div', 'act-empty', 'Sin actividad registrada desde que abriste esta pestaña.'));
    return feed;
  }
  const shown = live ? items.slice(-ACTIVITY_LIVE_ROWS) : items;
  for (const item of shown) feed.appendChild(renderActivityItem(item, live));
  if (!live) requestAnimationFrame(() => (feed.scrollTop = feed.scrollHeight));
  return feed;
}

function clearActivity(id) {
  taskActivity.delete(id);
}
