// Ajustes > Agentes: catalogo de agentes (modelo, motor, effort, acceso, prompt),
// que agente hace cada etapa de los pipelines y alta de agentes propios. Cada
// cambio se guarda al momento en el ambito elegido (este proyecto o todos).

import { api, projectApi } from './api.js';
import { h, clear, toast } from './dom.js';
import { currentProjectId } from './workbenches.js';

let data = null;
let localModels = [];
let scope = localStorage.getItem('optimia:agents-scope') || 'project';
const openPrompts = new Set();

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
  host.append(
    h(
      'div',
      { class: 'agents-scope' },
      h('span', { class: 'muted' }, 'Guardar cambios en'),
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Ambito de los cambios' },
        ['project', 'global'].map((s) =>
          h(
            'button',
            {
              class: scope === s ? 'active' : '',
              'aria-pressed': String(scope === s),
              onclick: () => {
                scope = s;
                localStorage.setItem('optimia:agents-scope', s);
                render();
              }
            },
            s === 'project' ? 'Este proyecto' : 'Todos los proyectos'
          )
        )
      )
    ),
    renderPipelines(),
    h('h3', { class: 'wb-h' }, 'Agentes'),
    ...data.agents.map(renderAgent),
    renderNewAgent()
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
        placeholder: 'qwen2.5-coder:7b',
        'aria-label': `Modelo local de ${agent.name}`,
        spellcheck: 'false',
        oninput: (e) => (draft.model = e.target.value.trim()),
        onchange: () => draft.save({ model: draft.model })
      }),
      h(
        'datalist',
        { id: listId },
        localModels.map((m) => h('option', { value: m.name }, m.size))
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
    // Como en los Ajustes de macOS, cada cambio se aplica al momento.
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
      h('span', { class: 'wb-badge' }, agent.builtin ? 'por defecto' : 'propio'),
      agent.overriddenIn.length
        ? h(
            'span',
            { class: 'wb-badge' },
            `cambiado en ${agent.overriddenIn.map((s) => (s === 'project' ? 'este proyecto' : 'todos los proyectos')).join(' y ')}`
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
        // Sin modelo local no hay nada que guardar todavía: primero hay que elegirlo.
        if (draft.engine === 'claude' || draft.model) draft.save({ engine: draft.engine, model: draft.model });
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
          // El prompt se guarda al salir del campo (no en cada tecla).
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
            { onclick: () => mutate(() => api.del(url(`/${agent.id}?scope=${scope}`)), 'Restaurado') },
            'Restaurar'
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

// Agentes y Supervision guardan cada cambio al momento: el "Guardar" general del
// pie solo confundiria ahi, asi que se oculta mientras esos paneles estan abiertos.
document.querySelectorAll('.settings-nav-item').forEach((item) =>
  item.addEventListener('click', () => {
    const footer = document.querySelector('#settings-overlay .settings-footer');
    if (footer) footer.hidden = ['agents', 'monitor'].includes(item.dataset.pane);
  })
);
