'use strict';

// Autocompletado de skills al escribir /.

// Autocompletado de skills: al escribir "/" al inicio de una palabra se
// ofrecen las skills de .claude/skills/ y se insertan como "/slug ".
const skillSuggest = document.getElementById('skill-suggest');
let skillSuggestItems = [];
let skillSuggestIndex = 0;
let skillSuggestRange = null;
let skillSuggestToken = 0;

function currentSkillQuery() {
  const caret = input.selectionStart;
  const match = input.value.slice(0, caret).match(/(^|\s)\/([a-z0-9-]*)$/i);
  if (!match) return null;
  const query = match[2].toLowerCase();
  return { query, start: caret - query.length - 1, end: caret };
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
    name.textContent = '/' + skill.slug;
    const source = document.createElement('span');
    source.className = 'skill-suggest-source';
    source.textContent = skill.source === 'claude' ? 'Claude' : 'proyecto';
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
    // mousedown + preventDefault evita que el textarea pierda el foco antes de insertar.
    row.addEventListener('mousedown', (e) => { e.preventDefault(); applySkillSuggest(i); });
    skillSuggest.appendChild(row);
  });
  skillSuggest.hidden = false;
}

function applySkillSuggest(i) {
  const skill = skillSuggestItems[i];
  const range = skillSuggestRange;
  if (!skill || !range) return;
  const insert = '/' + skill.slug + ' ';
  input.value = input.value.slice(0, range.start) + insert + input.value.slice(range.end);
  const caret = range.start + insert.length;
  input.setSelectionRange(caret, caret);
  hideSkillSuggest();
  input.dispatchEvent(new Event('input'));
  input.focus();
}

// Comandos integrados de Claude Code. Lista estatica: los comandos de plugins
// o del usuario no aparecen aqui. Los de tipo interactivo (/model, /config,
// /vim...) necesitan la terminal; en el chat se insertan igual.
const CLAUDE_COMMANDS = [
  { slug: 'add-dir', description: 'Anade un directorio de trabajo a la sesion' },
  { slug: 'agents', description: 'Gestiona los subagentes' },
  { slug: 'bug', description: 'Informa de un error de Claude Code' },
  { slug: 'clear', description: 'Vacia la conversacion actual' },
  { slug: 'compact', description: 'Resume la conversacion para liberar contexto' },
  { slug: 'config', description: 'Abre la configuracion de Claude Code' },
  { slug: 'cost', description: 'Muestra el coste y la duracion de la sesion' },
  { slug: 'doctor', description: 'Comprueba la instalacion de Claude Code' },
  { slug: 'help', description: 'Ayuda de Claude Code' },
  { slug: 'init', description: 'Crea un CLAUDE.md para el proyecto' },
  { slug: 'login', description: 'Inicia sesion en Claude' },
  { slug: 'logout', description: 'Cierra la sesion de Claude' },
  { slug: 'mcp', description: 'Gestiona los servidores MCP' },
  { slug: 'memory', description: 'Edita los ficheros CLAUDE.md de memoria' },
  { slug: 'model', description: 'Cambia el modelo' },
  { slug: 'permissions', description: 'Gestiona los permisos' },
  { slug: 'pr-comments', description: 'Muestra los comentarios de un pull request' },
  { slug: 'review', description: 'Revisa un pull request' },
  { slug: 'status', description: 'Estado de la cuenta y la configuracion' },
  { slug: 'terminal-setup', description: 'Configura el terminal para atajos de teclado' },
  { slug: 'vim', description: 'Activa el modo vim en el editor de entrada' }
].map((c) => ({ ...c, source: 'claude' }));

async function updateSkillSuggest() {
  const range = currentSkillQuery();
  if (!range) return hideSkillSuggest();
  const token = ++skillSuggestToken;
  const skills = await fetch('/api/skills').then((r) => r.json()).catch(() => []);
  if (token !== skillSuggestToken) return;
  const q = range.query;
  const all = [...skills.map((s) => ({ ...s, source: 'project' })), ...CLAUDE_COMMANDS];
  const matches = all
    .filter((s) => s.slug.includes(q) || (s.name || '').toLowerCase().includes(q))
    .sort((a, b) => Number(!a.slug.startsWith(q)) - Number(!b.slug.startsWith(q))
      || (a.source === b.source ? 0 : a.source === 'project' ? -1 : 1)
      || a.slug.localeCompare(b.slug))
    .slice(0, 12);
  if (matches.length === 0) return hideSkillSuggest();
  skillSuggestItems = matches;
  skillSuggestIndex = 0;
  skillSuggestRange = range;
  renderSkillSuggest();
}

// Devuelve true si la tecla la ha consumido el menu de skills.
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

