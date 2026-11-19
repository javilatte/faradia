'use strict';

// Skill autocompletion when typing /.

// Skill autocompletion: typing "/" at the start of a word offers the skills in .claude/skills/ and
// inserts them as "/slug ".
const skillSuggest = document.getElementById('skill-suggest');
let skillSuggestItems = [];
let skillSuggestIndex = 0;
let skillSuggestRange = null;
let skillSuggestToken = 0;

// "/" offers skills and commands; "@" at the start of the message offers agents: picking one turns
// the message into a task for that agent.
function currentSkillQuery() {
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const agent = before.match(/^\s*@([a-z0-9-]*)$/i);
  if (agent) {
    const query = agent[1].toLowerCase();
    return { query, start: caret - query.length - 1, end: caret, kind: 'agent' };
  }
  const match = before.match(/(^|\s)\/([a-z0-9-]*)$/i);
  if (!match) return null;
  const query = match[2].toLowerCase();
  return { query, start: caret - query.length - 1, end: caret, kind: 'skill' };
}

function hideSkillSuggest() {
  skillSuggestToken++;
  skillSuggest.hidden = true;
  skillSuggestItems = [];
  skillSuggestRange = null;
}

function renderSkillSuggest() {
  skillSuggest.replaceChildren();
  skillSuggestItems.forEach((skill, i) => {
    const row = document.createElement('div');
    row.className = 'skill-suggest-item' + (i === skillSuggestIndex ? ' active' : '');
    row.setAttribute('role', 'option');
    const name = document.createElement('span');
    name.className = 'skill-suggest-name';
    name.textContent = (skill.agent ? '@' : '/') + skill.slug;
    const source = document.createElement('span');
    source.className = 'skill-suggest-source';
    source.textContent =
      { claude: 'Claude', ecc: 'ECC', builtin: 'faradia', global: 'tuyo', project: 'este repo' }[skill.source] ||
      'proyecto';
    const head = document.createElement('div');
    head.className = 'skill-suggest-head';
    head.appendChild(name);
    head.appendChild(source);
    row.appendChild(head);
    if (skill.description) {
      const desc = document.createElement('span');
      desc.className = 'skill-suggest-desc';
      desc.textContent = skill.description;
      row.appendChild(desc);
    }
    // mousedown + preventDefault keeps the textarea from losing focus before inserting.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySkillSuggest(i);
    });
    skillSuggest.appendChild(row);
  });
  skillSuggest.hidden = false;
}

function applySkillSuggest(i) {
  const skill = skillSuggestItems[i];
  const range = skillSuggestRange;
  if (!skill || !range) return;
  if (skill.agent) return pickAgent(skill, range);
  const insert = '/' + skill.slug + ' ';
  input.value = input.value.slice(0, range.start) + insert + input.value.slice(range.end);
  const caret = range.start + insert.length;
  input.setSelectionRange(caret, caret);
  hideSkillSuggest();
  input.dispatchEvent(new Event('input'));
  input.focus();
}

// Claude Code built-in commands. Static list: plugin or user commands do not show here. Interactive
// ones (/model, /config, /vim...) need the terminal; in the chat they are inserted anyway.
const CLAUDE_COMMANDS = [
  { slug: 'add-dir', description: 'Añade un directorio de trabajo a la sesión' },
  { slug: 'agents', description: 'Gestiona los subagentes' },
  { slug: 'bug', description: 'Informa de un error de Claude Code' },
  { slug: 'clear', description: 'Vacia la conversación actual' },
  { slug: 'compact', description: 'Resume la conversación para liberar contexto' },
  { slug: 'config', description: 'Abre la configuración de Claude Code' },
  { slug: 'cost', description: 'Muestra el coste y la duración de la sesión' },
  { slug: 'doctor', description: 'Comprueba la instalacion de Claude Code' },
  { slug: 'help', description: 'Ayuda de Claude Code' },
  { slug: 'init', description: 'Crea un CLAUDE.md para el proyecto' },
  { slug: 'login', description: 'Inicia sesión en Claude' },
  { slug: 'logout', description: 'Cierra la sesión de Claude' },
  { slug: 'mcp', description: 'Gestiona los servidores MCP' },
  { slug: 'memory', description: 'Edita los ficheros CLAUDE.md de memoria' },
  { slug: 'model', description: 'Cambia el modelo' },
  { slug: 'permissions', description: 'Gestiona los permisos' },
  { slug: 'pr-comments', description: 'Muestra los comentarios de un pull request' },
  { slug: 'review', description: 'Revisa un pull request' },
  { slug: 'status', description: 'Estado de la cuenta y la configuración' },
  { slug: 'terminal-setup', description: 'Configura el terminal para atajos de teclado' },
  { slug: 'vim', description: 'Activa el modo vim en el editor de entrada' }
].map((c) => ({ ...c, source: 'claude' }));

// @agent: the message becomes a task for that agent (turned on first if it was off).
async function pickAgent(agent, range) {
  input.value = (input.value.slice(0, range.start) + input.value.slice(range.end)).replace(/^\s+/, '');
  hideSkillSuggest();
  if (!agent.enabled) {
    await fetch(apiPath(`/api/agents/${agent.slug}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', enabled: true })
    }).catch(() => {});
  }
  await loadTaskKinds().catch(() => {});
  const value = `custom:${agent.slug}`;
  if (![...chatKindSelect.options].some((o) => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = agent.name;
    chatKindSelect.appendChild(opt);
  }
  chatKindSelect.value = value;
  chatKindSelect.dispatchEvent(new Event('change'));
  input.focus();
}

async function updateAgentSuggest(range, token) {
  const data = await fetch(apiPath('/api/agents'))
    .then((r) => r.json())
    .catch(() => ({ agents: [] }));
  if (token !== skillSuggestToken) return;
  const q = range.query;
  const order = { builtin: 0, global: 1, project: 1, ecc: 2 };
  const matches = data.agents
    .filter((a) => a.id.includes(q) || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(!a.id.replace(/^ecc-/, '').startsWith(q)) - Number(!b.id.replace(/^ecc-/, '').startsWith(q)) ||
        order[a.source] - order[b.source] ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 12)
    .map((a) => ({
      agent: true,
      slug: a.id,
      name: a.name,
      enabled: a.enabled,
      source: a.source,
      description: `${a.name} · ${a.description}`
    }));
  if (!matches.length) return hideSkillSuggest();
  skillSuggestItems = matches;
  skillSuggestIndex = 0;
  skillSuggestRange = range;
  renderSkillSuggest();
}

async function updateSkillSuggest() {
  const range = currentSkillQuery();
  if (!range) return hideSkillSuggest();
  const token = ++skillSuggestToken;
  if (range.kind === 'agent') return updateAgentSuggest(range, token);
  const [skills, ecc] = await Promise.all([
    fetch(apiPath('/api/skills'))
      .then((r) => r.json())
      .catch(() => []),
    fetch('/api/ecc')
      .then((r) => r.json())
      .catch(() => ({ skills: [] }))
  ]);
  if (token !== skillSuggestToken) return;
  const q = range.query;
  const eccSkills = (ecc.skills || [])
    .filter((s) => s.enabled)
    .map((s) => ({ slug: s.name, name: s.name, description: s.description, source: 'ecc' }));
  const builtinSkills = (ecc.builtin || []).map((s) => ({
    slug: s.name,
    name: s.name,
    description: s.description,
    source: 'builtin'
  }));
  const all = [...skills.map((s) => ({ ...s, source: 'project' })), ...builtinSkills, ...eccSkills, ...CLAUDE_COMMANDS];
  const matches = all
    .filter((s) => s.slug.includes(q) || (s.name || '').toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(!a.slug.startsWith(q)) - Number(!b.slug.startsWith(q)) ||
        ({ project: 0, builtin: 1, ecc: 2, claude: 3 }[a.source] ?? 4) -
          ({ project: 0, builtin: 1, ecc: 2, claude: 3 }[b.source] ?? 4) ||
        a.slug.localeCompare(b.slug)
    )
    .slice(0, 12);
  if (matches.length === 0) return hideSkillSuggest();
  skillSuggestItems = matches;
  skillSuggestIndex = 0;
  skillSuggestRange = range;
  renderSkillSuggest();
}

// Returns true if the skill menu consumed the key.
function handleSkillSuggestKey(e) {
  if (skillSuggest.hidden) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = skillSuggestItems.length;
    skillSuggestIndex = (skillSuggestIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderSkillSuggest();
    return true;
  }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    applySkillSuggest(skillSuggestIndex);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideSkillSuggest();
    return true;
  }
  return false;
}

input.addEventListener('keydown', (e) => {
  if (handleSkillSuggestKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCurrentInput();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  updateSkillSuggest();
});

input.addEventListener('blur', hideSkillSuggest);
input.addEventListener('click', updateSkillSuggest);
