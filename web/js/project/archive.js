'use strict';

// Archive of finished tasks (server/store/taskArchive.js): a sheet opened from the agents board with
// what each task asked for, how it ended, which agents and models ran it and their report. Old
// entries go away after the retention chosen at the bottom (30, 15, 7 or 1 days, or never).

const OUTCOME = {
  pr: ['Pull request', 'ok'],
  merged: ['Fusionada', 'ok'],
  commit: ['Commit', 'ok'],
  report: ['Informe', 'ok'],
  discarded: ['Descartada', 'muted']
};
const RETENTION = [
  [30, '1 mes'],
  [15, '15 días'],
  [7, '7 días'],
  [1, '1 día'],
  [0, 'Nunca']
];

function archEl(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== '') node.append(c);
  return node;
}

function archDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(window.optimiaLang?.locale || 'es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function archivedTask(t, onRemove) {
  const [label, tone] = OUTCOME[t.outcome] || OUTCOME.discarded;
  const body = archEl('div', { class: 'archive-body' });
  if (t.instruction) body.append(archEl('p', { class: 'archive-instruction' }, t.instruction));
  const facts = archEl('dl', { class: 'archive-facts' });
  const fact = (k, v) => v && facts.append(archEl('dt', {}, k), archEl('dd', {}, v));
  fact('Rama', t.mergedInto ? `${t.branch} → ${t.mergedInto}` : t.branch);
  if (t.pr?.url)
    fact(
      'Pull request',
      archEl('a', { href: t.pr.url, target: '_blank', rel: 'noopener noreferrer' }, t.pr.title || t.pr.url)
    );
  if (t.lastCommit)
    fact('Commit', archEl('code', {}, `${t.lastCommit.slice(0, 7)} ${t.lastCommitMessage || ''}`.trim()));
  fact('Creada', archDate(t.createdAt));
  fact('Terminada', archDate(t.finishedAt));
  const runs = (t.stageRuns || []).filter((r) => r.agentName);
  if (runs.length) {
    fact(
      'Agentes',
      runs
        .map((r) => `${r.agentName}${r.model && r.model !== 'default' ? ` · ${r.model}` : ''}`)
        .filter((v, i, all) => all.indexOf(v) === i)
        .join(', ')
    );
  }
  body.append(facts);
  if (t.verification?.verdict)
    body.append(archEl('p', { class: 'archive-verdict' }, `Verificación: ${t.verification.verdict}`));
  if (t.report) {
    const report = archEl('div', { class: 'archive-report md' });
    if (typeof paintMarkdown === 'function') paintMarkdown(report, t.report);
    else report.textContent = t.report;
    body.append(report);
  }
  body.append(
    archEl(
      'div',
      { class: 'archive-row-actions' },
      archEl('button', { type: 'button', onclick: () => onRemove(t.id) }, 'Borrar del archivo')
    )
  );
  return archEl(
    'li',
    {},
    archEl(
      'details',
      { class: 'archive-item' },
      archEl(
        'summary',
        {},
        archEl('span', { class: `archive-outcome ${tone}` }, label),
        archEl('span', { class: 'archive-title' }, t.title),
        archEl('span', { class: 'archive-date' }, archDate(t.archivedAt))
      ),
      body
    )
  );
}

async function openArchive() {
  let filter = '';
  const list = archEl('ul', { class: 'archive-list' });
  const count = archEl('span', { class: 'archive-count' });
  const retention = archEl('select', { id: 'archive-retention', 'aria-label': 'Borrar del archivo tras' });
  const search = archEl('input', {
    type: 'search',
    placeholder: 'Buscar en el archivo',
    'aria-label': 'Buscar en el archivo'
  });
  const clearBtn = archEl('button', { type: 'button', class: 'danger-text' }, 'Vaciar archivo');
  const close = archEl('button', { type: 'button', class: 'primary' }, 'Listo');
  const sheet = archEl(
    'div',
    { class: 'sheet archive-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'archive-title' },
    archEl(
      'div',
      { class: 'archive-head' },
      archEl('h2', { class: 'sheet-title', id: 'archive-title' }, 'Archivo de tareas'),
      count
    ),
    search,
    list,
    archEl(
      'div',
      { class: 'sheet-actions archive-actions' },
      archEl('label', { class: 'archive-retention', for: 'archive-retention' }, 'Borrar tras ', retention),
      clearBtn,
      close
    )
  );
  const overlay = archEl('div', { class: 'sheet-overlay' }, sheet);
  let data = { tasks: [], retentionDays: 30 };
  const paint = () => {
    const q = filter.toLowerCase();
    const shown = data.tasks.filter(
      (t) => !q || `${t.title} ${t.instruction || ''} ${t.branch || ''}`.toLowerCase().includes(q)
    );
    count.textContent = data.tasks.length === 1 ? '1 tarea' : `${data.tasks.length} tareas`;
    list.replaceChildren(
      ...(shown.length
        ? shown.map((t) => archivedTask(t, remove))
        : [
            archEl(
              'li',
              { class: 'archive-empty' },
              data.tasks.length
                ? 'Ninguna tarea coincide con la búsqueda.'
                : 'Aún no hay tareas archivadas. Aparecen aquí al archivarlas desde el tablero, con su resultado y su informe.'
            )
          ])
    );
    clearBtn.hidden = !data.tasks.length;
  };
  const load = async () => {
    const d = await fetch(apiPath('/api/tasks-archive'))
      .then((r) => r.json())
      .catch(() => ({}));
    data = { tasks: Array.isArray(d.tasks) ? d.tasks : [], retentionDays: d.retentionDays ?? data.retentionDays };
    retention.replaceChildren(
      ...RETENTION.map(([v, l]) => archEl('option', { value: String(v), selected: v === data.retentionDays }, l))
    );
    paint();
  };
  async function remove(id) {
    await fetch(apiPath(`/api/tasks-archive/${id}`), { method: 'DELETE' });
    load();
  }
  const done = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    archiveButton.focus();
  };
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      done();
    }
  }
  search.addEventListener('input', () => {
    filter = search.value;
    paint();
  });
  retention.addEventListener('change', async () => {
    await fetch(apiPath('/api/settings'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', tasks: { archiveDays: Number(retention.value) } })
    });
    load();
  });
  // Two steps instead of a confirm dialog: the button asks once more in place.
  clearBtn.addEventListener('click', async () => {
    if (!clearBtn.dataset.armed) {
      clearBtn.dataset.armed = '1';
      clearBtn.textContent = '¿Vaciar? Pulsa otra vez';
      setTimeout(() => {
        delete clearBtn.dataset.armed;
        clearBtn.textContent = 'Vaciar archivo';
      }, 3000);
      return;
    }
    await fetch(apiPath('/api/tasks-archive'), { method: 'DELETE' });
    delete clearBtn.dataset.armed;
    clearBtn.textContent = 'Vaciar archivo';
    load();
  });
  close.addEventListener('click', done);
  overlay.addEventListener('click', (e) => e.target === overlay && done());
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  search.focus();
  await load();
}

const archiveButton = document.createElement('button');
archiveButton.type = 'button';
archiveButton.className = 'archive-button';
archiveButton.textContent = 'Archivo';
archiveButton.title = 'Tareas terminadas';
archiveButton.addEventListener('click', openArchive);
document.querySelector('.agents-panel-header')?.appendChild(archiveButton);
