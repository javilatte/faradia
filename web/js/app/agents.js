// Settings > Agents: agent catalog (model, engine, effort, access, prompt), which agent runs each
// pipeline stage and creation of custom agents. Every change is saved at once in the chosen scope
// (this repo or all of them).

import { api, projectApi } from './api.js';
import { h, clear, toast } from './dom.js';
import { currentProjectId } from './workbenches.js';

let data = null;
let localModels = [];
// Scope shared with the rest of Settings ("Todos los repos" / "Solo este repo").
let scope = window.faradiaSettingsScope === 'project' ? 'project' : 'global';
window.addEventListener('faradia:settings-scope', (e) => {
  scope = e.detail === 'project' ? 'project' : 'global';
  render();
});
const openPrompts = new Set();
const openPrinciples = new Set();

const url = (rest = '') => projectApi(currentProjectId(), `/agents${rest}`);
const ENGINE_LABEL = { claude: 'Claude', local: 'IA local' };
const ACCESS_LABEL = { read: 'Solo lectura', edit: 'Puede editar' };
const EFFORT_LABEL = {
  default: 'Por defecto',
  low: 'Bajo',
  medium: 'Medio',
  high: 'Alto',
  xhigh: 'Muy alto',
  max: 'Máximo'
};

async function load() {
  const [catalog, models] = await Promise.all([
    api.get(url()),
    api.get(projectApi(currentProjectId(), '/local-models')).catch(() => [])
  ]);
  data = catalog;
  localModels = Array.isArray(models) ? models : [];
}

async function mutate(fn, okMessage) {
  try {
    const next = await fn();
    data = { ...data, ...next };
    if (okMessage) toast(okMessage);
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
  render();
}

function render() {
  const host = document.getElementById('agents-pane');
  if (!host || !data) return;
  clear(host);
  const mine = data.agents.filter((a) => a.source !== 'ecc');
  host.append(
    renderPipelines(),
    renderPrinciplesSwitch(),
    h('h3', { class: 'wb-h' }, 'Agentes'),
    ...mine.map(renderAgent),
    renderNewAgent(),
    renderEccLibrary(data.agents.filter((a) => a.source === 'ecc'))
  );
}

// pstack's engineering principles (Lauren Tan, MIT) in each agent's prompt: on for every repo or
// off; which ones each agent gets is chosen on its card.
function renderPrinciplesSwitch() {
  if (!data.principles?.length) return null;
  return h(
    'div',
    { class: 'settings-field principles-switch' },
    h(
      'label',
      { class: 'inline-row' },
      h('input', {
        type: 'checkbox',
        id: 'principles-enabled',
        checked: data.principlesEnabled,
        onchange: (e) =>
          mutate(
            async () => {
              await api.patch(projectApi(currentProjectId(), '/settings'), {
                scope: 'global',
                principles: { enabled: e.target.checked }
              });
              return { principlesEnabled: e.target.checked };
            },
            e.target.checked ? 'Principios activados' : 'Principios desactivados'
          )
      }),
      'Principios de ingeniería'
    ),
    h(
      'span',
      { class: 'muted' },
      'Cada agente recibe los principios de pstack (Lauren Tan, MIT) que encajan con su etapa —demostrar que funciona, arreglar la causa raíz, restar antes de sumar…— y dice en su informe cuál cambió una decisión. Igual en todos los repos.'
    )
  );
}

// ECC's agents (vendor/ecc, MIT): off until needed. Turned on, they show in the chat's mode
// selector; any of them can also be called by typing @ in the message box.
let eccQuery = '';
function renderEccLibrary(list) {
  if (!list.length) return null;
  const on = list.filter((a) => a.enabled);
  const box = h('div', { class: 'ecc-agents' });
  const paint = () => {
    const q = eccQuery.toLowerCase();
    const shown = list.filter((a) => !q || a.id.includes(q) || a.description.toLowerCase().includes(q) || a.enabled);
    box.replaceChildren(...shown.slice(0, q ? 72 : 12).map(renderAgent));
    if (!q && shown.length > 12) box.append(h('p', { class: 'muted' }, `y ${shown.length - 12} más: búscalos.`));
  };
  paint();
  return h(
    'details',
    { class: 'ecc-library', open: on.length > 0 || Boolean(eccQuery) },
    h('summary', {}, `Agentes de ECC (${list.length}${on.length ? `, ${on.length} activos` : ''})`),
    h(
      'p',
      { class: 'muted agents-help' },
      'De Everything Claude Code (licencia MIT), incluidos en faradia. Actívalos para tenerlos en el selector de modo, o escribe @ en el chat para llamar a cualquiera. Tus agentes ya siguen el método de su equivalente de ECC.'
    ),
    h('input', {
      type: 'search',
      placeholder: 'Buscar agentes de ECC (react, security, go…)',
      'aria-label': 'Buscar agentes de ECC',
      value: eccQuery,
      oninput: (e) => {
        eccQuery = e.target.value;
        paint();
      }
    }),
    box
  );
}

function renderPipelines() {
  const box = h('div', { class: 'agents-pipelines' });
  box.append(h('h3', { class: 'wb-h' }, 'Pipelines: quién hace cada etapa'));
  const types = Object.entries(data.taskTypes).filter(([t]) => t !== 'custom');
  box.append(
    h(
      'p',
      { class: 'muted agents-help' },
      types.map(([, def]) => `${def.label}: ${def.pipeline.map((s) => data.stages[s].label).join(' → ')}`).join(' · ')
    )
  );
  const grid = h('div', { class: 'agents-stage-grid' });
  for (const [stage, agentId] of Object.entries(data.stageMap)) {
    const meta = data.stages[stage];
    const options = data.agents.filter((a) => meta.access !== 'edit' || a.access === 'edit');
    grid.append(
      h(
        'label',
        { for: `stage-${stage}` },
        meta.label,
        meta.optional ? h('span', { class: 'muted' }, ' (opcional)') : null
      ),
      h(
        'select',
        {
          id: `stage-${stage}`,
          onchange: (e) =>
            mutate(
              () => api.put(url('/stages'), { scope, changes: { [stage]: e.target.value } }),
              'Pipeline actualizado'
            )
        },
        options.map((a) =>
          h('option', { value: a.id, selected: a.id === agentId }, a.enabled ? a.name : `${a.name} (desactivado)`)
        )
      )
    );
  }
  box.append(grid);
  box.append(
    h(
      'p',
      { class: 'muted agents-help' },
      'Desactivar el agente de una etapa opcional (Verificación) hace que los pipelines se la salten.'
    )
  );
  return box;
}

function modelControl(agent, draft) {
  if (draft.engine === 'local') {
    const listId = `local-models-${agent.id}`;
    return h(
      'span',
      { class: 'agents-model' },
      h('input', {
        list: listId,
        value: draft.model || '',
        placeholder: localModels[0]?.name || 'qwen2.5-coder:7b',
        'aria-label': `Modelo local de ${agent.name}`,
        spellcheck: 'false',
        oninput: (e) => (draft.model = e.target.value.trim()),
        onchange: () => draft.save({ model: draft.model })
      }),
      h(
        'datalist',
        { id: listId },
        localModels.map((m) => h('option', { value: m.name }, m.size ? `${(m.size / 1e9).toFixed(1)} GB` : ''))
      )
    );
  }
  return h(
    'select',
    {
      'aria-label': `Modelo de ${agent.name}`,
      onchange: (e) => {
        draft.model = e.target.value;
        draft.save({ model: draft.model });
      }
    },
    data.claudeModels.map((m) =>
      h('option', { value: m, selected: m === draft.model }, m === 'default' ? 'Por defecto' : m)
    )
  );
}

function renderAgent(agent) {
  const draft = {
    engine: agent.engine,
    model: agent.model,
    effort: agent.effort,
    access: agent.access,
    prompt: agent.prompt,
    description: agent.description,
    // As in macOS Settings, every change applies at once.
    save: (fields) => mutate(() => api.patch(url(`/${agent.id}`), { scope, ...fields }), `${agent.name}: guardado`)
  };
  const card = h('div', { class: `agent-card${agent.enabled ? '' : ' disabled'}`, dataset: { agent: agent.id } });
  const overridden = agent.overriddenIn.includes(scope);
  card.append(
    h(
      'div',
      { class: 'agent-card-head' },
      h(
        'label',
        { class: 'agent-toggle', title: agent.enabled ? 'Desactivar' : 'Activar' },
        h('input', {
          type: 'checkbox',
          checked: agent.enabled,
          'aria-label': `Activar ${agent.name}`,
          onchange: (e) => mutate(() => api.patch(url(`/${agent.id}`), { scope, enabled: e.target.checked }))
        })
      ),
      h('strong', {}, agent.name),
      h('span', { class: 'wb-badge' }, agent.source === 'ecc' ? 'ECC' : agent.builtin ? 'por defecto' : 'propio'),
      agent.overriddenIn.length
        ? h(
            'span',
            { class: 'wb-badge' },
            `cambiado en ${agent.overriddenIn.map((s) => (s === 'project' ? 'este repo' : 'todos los repos')).join(' y ')}`
          )
        : null
    ),
    h('p', { class: 'muted agent-desc' }, agent.description)
  );

  const engineSelect = h(
    'select',
    {
      'aria-label': `Motor de ${agent.name}`,
      onchange: (e) => {
        draft.engine = e.target.value;
        draft.model = draft.engine === 'claude' ? 'default' : localModels[0]?.name || '';
        // Without a local model there is nothing to save yet: one has to be chosen first.
        if (draft.engine !== 'local' || draft.model) draft.save({ engine: draft.engine, model: draft.model });
        else {
          modelSlot.replaceChildren(modelControl(agent, draft));
          effortSelect.disabled = true;
        }
      }
    },
    Object.entries(ENGINE_LABEL).map(([v, l]) => h('option', { value: v, selected: v === draft.engine }, l))
  );
  const modelSlot = h('span', {}, modelControl(agent, draft));
  const effortSelect = h(
    'select',
    {
      'aria-label': `Effort de ${agent.name}`,
      disabled: draft.engine !== 'claude',
      onchange: (e) => {
        draft.effort = e.target.value;
        draft.save({ effort: draft.effort });
      }
    },
    data.efforts.map((v) => h('option', { value: v, selected: v === draft.effort }, EFFORT_LABEL[v] || v))
  );
  const accessSelect = h(
    'select',
    {
      'aria-label': `Acceso de ${agent.name}`,
      disabled: agent.builtin,
      title: agent.builtin ? 'El acceso de los agentes por defecto lo fija su etapa' : '',
      onchange: (e) => {
        draft.access = e.target.value;
        draft.save({ access: draft.access });
      }
    },
    Object.entries(ACCESS_LABEL).map(([v, l]) => h('option', { value: v, selected: v === draft.access }, l))
  );
  card.append(
    h(
      'div',
      { class: 'agent-fields' },
      h('label', {}, 'Motor', engineSelect),
      h('label', {}, 'Modelo', modelSlot),
      h('label', {}, 'Effort', effortSelect),
      h('label', {}, 'Acceso', accessSelect)
    )
  );

  const principles = renderAgentPrinciples(agent, draft);
  if (principles) card.append(principles);

  const promptOpen = openPrompts.has(agent.id);
  if (promptOpen) {
    card.append(
      h(
        'textarea',
        {
          class: 'agent-prompt',
          rows: 6,
          'aria-label': `Prompt de rol de ${agent.name}`,
          oninput: (e) => (draft.prompt = e.target.value),
          // The prompt is saved when leaving the field (not on every keystroke).
          onchange: () => draft.save({ prompt: draft.prompt })
        },
        draft.prompt
      )
    );
  }

  card.append(
    h(
      'div',
      { class: 'agent-actions' },

      h(
        'button',
        {
          onclick: () => {
            if (promptOpen) openPrompts.delete(agent.id);
            else openPrompts.add(agent.id);
            render();
          }
        },
        promptOpen ? 'Ocultar prompt' : 'Editar prompt…'
      ),
      h(
        'button',
        {
          title: 'Crear un agente propio a partir de este',
          onclick: () =>
            mutate(
              () =>
                api.post(url(), {
                  scope,
                  name: `${agent.name} (copia)`,
                  description: agent.description,
                  engine: agent.engine,
                  model: agent.model,
                  effort: agent.effort,
                  access: agent.access,
                  prompt: agent.prompt
                }),
              'Agente duplicado'
            )
        },
        'Duplicar'
      ),
      agent.builtin && overridden
        ? h(
            'button',
            { onclick: () => mutate(() => api.del(url(`/${agent.id}?scope=${scope}`)), 'Restablecido') },
            'Restablecer'
          )
        : null,
      !agent.builtin && agent.source === scope
        ? h(
            'button',
            {
              class: 'danger',
              onclick: () => {
                if (window.confirm(`¿Borrar el agente "${agent.name}"?`)) {
                  mutate(() => api.del(url(`/${agent.id}?scope=${scope}`)), 'Agente borrado');
                }
              }
            },
            'Borrar'
          )
        : null
    )
  );
  return card;
}

// The principles an agent gets: a summary line and, opened, one checkbox per principle.
function renderAgentPrinciples(agent, draft) {
  if (!data.principles?.length || agent.source === 'ecc') return null;
  const chosen = new Set(agent.principles || []);
  const names = data.principles.filter((p) => chosen.has(p.id)).map((p) => p.name);
  const isOpen = openPrinciples.has(agent.id);
  const box = h('div', { class: `agent-principles${data.principlesEnabled ? '' : ' off'}` });
  box.append(
    h(
      'div',
      { class: 'agent-principles-head' },
      h('span', { class: 'muted' }, names.length ? `Principios: ${names.join(', ')}` : 'Sin principios'),
      h(
        'button',
        {
          class: 'button-link',
          'aria-expanded': String(isOpen),
          onclick: () => {
            if (isOpen) openPrinciples.delete(agent.id);
            else openPrinciples.add(agent.id);
            render();
          }
        },
        isOpen ? 'Ocultar' : 'Elegir…'
      )
    )
  );
  if (isOpen) {
    box.append(
      h(
        'div',
        { class: 'agent-principles-grid' },
        data.principles.map((p) =>
          h(
            'label',
            { title: p.description },
            h('input', {
              type: 'checkbox',
              checked: chosen.has(p.id),
              onchange: (e) => {
                if (e.target.checked) chosen.add(p.id);
                else chosen.delete(p.id);
                draft.save({ principles: data.principles.map((x) => x.id).filter((id) => chosen.has(id)) });
              }
            }),
            p.name
          )
        )
      )
    );
  }
  return box;
}

function renderNewAgent() {
  return h(
    'form',
    {
      class: 'agent-new',
      onsubmit: (e) => {
        e.preventDefault();
        const f = e.target.elements;
        mutate(
          () =>
            api.post(url(), {
              scope,
              name: f.name.value,
              description: f.description.value,
              access: f.access.value,
              prompt: f.prompt.value
            }),
          'Agente creado'
        );
      }
    },
    h('h3', { class: 'wb-h' }, 'Nuevo agente propio'),
    h('input', {
      name: 'name',
      placeholder: 'Nombre (p. ej. Revisor de accesibilidad)',
      required: true,
      'aria-label': 'Nombre del agente'
    }),
    h('input', { name: 'description', placeholder: 'Qué hace, en una frase', 'aria-label': 'Descripción del agente' }),
    h(
      'select',
      { name: 'access', 'aria-label': 'Acceso del agente' },
      Object.entries(ACCESS_LABEL).map(([v, l]) => h('option', { value: v }, l))
    ),
    h('textarea', {
      name: 'prompt',
      rows: 4,
      placeholder: 'Prompt de rol: cómo trabaja este agente',
      'aria-label': 'Prompt del agente'
    }),
    h('button', { type: 'submit', class: 'primary' }, 'Crear agente')
  );
}

async function open() {
  const host = document.getElementById('agents-pane');
  if (!host) return;
  clear(host).append(h('p', { class: 'muted' }, 'Cargando agentes…'));
  try {
    await load();
    render();
  } catch (err) {
    clear(host).append(h('p', { class: 'error-text' }, `No se pudieron cargar los agentes: ${err.message}`));
  }
}

document.querySelector('.settings-nav-item[data-pane="agents"]')?.addEventListener('click', open);

// Agents and Supervision save every change at once: a general "Guardar" in the footer would only
// confuse there, so it is hidden while those panes are open.
document.querySelectorAll('.settings-nav-item').forEach((item) =>
  item.addEventListener('click', () => {
    const footer = document.querySelector('#settings-overlay .settings-footer');
    if (footer) footer.hidden = ['agents', 'monitor'].includes(item.dataset.pane);
  })
);
