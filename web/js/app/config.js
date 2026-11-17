// Portable configuration and update notices:
//   - first run: a welcome sheet to import a configuration file or start fresh;
//   - dropping an optimia configuration file anywhere imports it (after a preview);
//   - Settings > General: version, update check, export and import;
//   - a toolbar notice when a newer version is published.

import { api } from './api.js';
import { h, toast } from './dom.js';

const DISMISSED_KEY = 'optimia:update-dismissed';
const RECHECK_MS = 6 * 60 * 60 * 1000;
let updateInfo = null;

// ---------- sheets (macOS-style modal dialogs) ----------

/**
 * Shows a sheet. `actions` is a list of {label, primary?, destructive?, onClick}
 * rendered trailing, primary last. Esc cancels; Return triggers the primary one.
 */
function openSheet({ title, body = [], actions = [], className = '' }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const buttons = actions.map((a) =>
    h(
      'button',
      {
        type: 'button',
        class: a.primary ? 'primary' : a.destructive ? 'danger' : '',
        onclick: async () => {
          if ((await a.onClick?.(close)) !== false) close();
        }
      },
      a.label
    )
  );
  const sheet = h(
    'div',
    { class: `sheet ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
    h('h2', { class: 'sheet-title', id: 'sheet-title' }, title),
    h('div', { class: 'sheet-body' }, ...body),
    h('div', { class: 'sheet-actions' }, ...buttons)
  );
  const overlay = h('div', { class: 'sheet-overlay' }, sheet);
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA') {
      const primary = actions.findIndex((a) => a.primary);
      if (primary >= 0) {
        e.preventDefault();
        buttons[primary].click();
      }
    }
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  (buttons.find((b) => b.classList.contains('primary')) || buttons[buttons.length - 1])?.focus();
  return close;
}

// ---------- import ----------

function isConfigFile(file) {
  return Boolean(file) && (file.type === 'application/json' || /\.json$/i.test(file.name));
}

function pickConfigFile() {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  input.addEventListener('change', () => {
    if (input.files[0]) importFile(input.files[0]);
    input.remove();
  });
  document.body.append(input);
  input.click();
}

function list(title, items) {
  if (!items.length) return null;
  return h('div', { class: 'sheet-section' }, h('strong', {}, title), h('ul', {}, ...items.map((i) => h('li', {}, i))));
}

export async function importFile(file) {
  let config;
  try {
    config = JSON.parse(await file.text());
  } catch {
    toast(`${file.name} no es un fichero JSON válido`, { kind: 'error' });
    return;
  }
  let preview;
  try {
    preview = await api.post('/api/config/import', { config, apply: false });
  } catch (err) {
    toast(`No se puede importar ${file.name}: ${err.message}`, { kind: 'error' });
    return;
  }
  const when = preview.exportedAt ? new Date(preview.exportedAt).toLocaleString('es-ES') : 'fecha desconocida';
  const nothing =
    !preview.settings.length &&
    !preview.agents.added.length &&
    !preview.agents.updated.length &&
    !preview.agents.removed.length;
  openSheet({
    title: 'Importar configuración',
    className: 'import-sheet',
    body: [
      h(
        'p',
        { class: 'muted' },
        `${file.name} · exportada el ${when}${preview.optimiaVersion ? ` con optimia ${preview.optimiaVersion}` : ''}`
      ),
      nothing ? h('p', {}, 'Es igual a tu configuración actual: no cambia nada.') : null,
      list('Se sustituye', preview.settings),
      list('Agentes nuevos', preview.agents.added),
      list('Agentes que cambian', preview.agents.updated),
      list('Agentes que se quitan', preview.agents.removed),
      preview.instructionsPreview
        ? h(
            'details',
            { class: 'sheet-section' },
            h('summary', {}, 'Instrucciones para todos los repos'),
            h('pre', { class: 'inherited-text' }, preview.instructionsPreview)
          )
        : null,
      list('Avisos', preview.warnings),
      h(
        'p',
        { class: 'muted' },
        preview.secretsIncluded
          ? 'Incluye la cabecera de autenticación de la IA local.'
          : 'No incluye secretos: se conserva tu cabecera de autenticación de la IA local.'
      ),
      h('p', { class: 'muted' }, 'Antes se guarda una copia de tu configuración actual.')
    ],
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Importar',
        primary: true,
        onClick: async () => {
          try {
            await api.post('/api/config/import', { config, apply: true });
          } catch (err) {
            toast(`No se pudo importar: ${err.message}`, { kind: 'error' });
            return false;
          }
          toast('Configuración importada');
          // Every view reads settings and agents on load: start from a clean page.
          setTimeout(() => location.reload(), 600);
          return true;
        }
      }
    ]
  });
}

// Drop an optimia configuration anywhere in the window. Images keep going to the
// chat composer: only JSON files are taken here.
function bindDrop() {
  let overlay = null;
  const hasJson = (e) =>
    [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file' && i.type === 'application/json');
  const hide = () => {
    overlay?.remove();
    overlay = null;
  };
  window.addEventListener(
    'dragover',
    (e) => {
      if (!hasJson(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!overlay) {
        overlay = h(
          'div',
          { class: 'drop-overlay' },
          h('div', { class: 'drop-overlay-box' }, 'Suelta tu configuración de optimia para importarla')
        );
        document.body.append(overlay);
      }
    },
    true
  );
  window.addEventListener(
    'dragleave',
    (e) => {
      if (!e.relatedTarget) hide();
    },
    true
  );
  window.addEventListener(
    'drop',
    (e) => {
      const file = [...(e.dataTransfer?.files || [])].find(isConfigFile);
      hide();
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      importFile(file);
    },
    true
  );
}

// ---------- first run ----------

function welcome() {
  const zone = h(
    'div',
    { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Elegir un fichero de configuración' },
    h('strong', {}, 'Arrastra aquí tu fichero de configuración'),
    h('span', { class: 'muted' }, 'optimia-config-….json, exportado desde Ajustes › General'),
    h('button', { type: 'button', onclick: pickConfigFile }, 'Elegir fichero…')
  );
  zone.addEventListener('keydown', (e) => {
    if (e.key === ' ' || (e.key === 'Enter' && e.target === zone)) pickConfigFile();
  });
  openSheet({
    title: 'Bienvenido a optimia 2',
    className: 'welcome-sheet',
    body: [
      h(
        'p',
        {},
        'Si ya usas optimia en otro equipo, importa tu configuración: instrucciones, agentes, modelos y avisos para todos tus repos.'
      ),
      zone,
      h('p', { class: 'muted' }, 'Puedes importarla o exportarla cuando quieras desde Ajustes › General.')
    ],
    actions: [
      {
        label: 'Empezar con la configuración por defecto',
        primary: true,
        onClick: () => api.post('/api/config/welcome').catch(() => {})
      }
    ]
  });
}

// ---------- updates ----------

function dismissedVersion() {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function showUpdateSheet() {
  if (!updateInfo?.updateAvailable) return;
  const command = h('code', { class: 'update-command' }, updateInfo.installCommand);
  openSheet({
    title: `optimia ${updateInfo.latest} está disponible`,
    body: [
      h('p', {}, `Tienes la ${updateInfo.current}. Para actualizar, ejecuta en una terminal:`),
      command,
      h('p', { class: 'muted' }, 'Después, vuelve a arrancar optimia en tus repos.'),
      h(
        'p',
        {},
        h('a', { href: updateInfo.releaseUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Ver las novedades')
      )
    ],
    actions: [
      {
        label: 'Ahora no',
        onClick: () => {
          try {
            localStorage.setItem(DISMISSED_KEY, updateInfo.latest);
          } catch {
            /* no persistence */
          }
          renderUpdateButton();
        }
      },
      {
        label: 'Copiar comando',
        primary: true,
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(updateInfo.installCommand);
            toast('Comando copiado');
          } catch {
            toast('No se pudo copiar: selecciónalo y cópialo a mano', { kind: 'error' });
            return false;
          }
          return true;
        }
      }
    ]
  });
}

function renderUpdateButton() {
  const button = document.getElementById('update-button');
  if (!button) return;
  const show = Boolean(updateInfo?.updateAvailable) && dismissedVersion() !== updateInfo.latest;
  button.hidden = !show;
  if (show) {
    button.textContent = `optimia ${updateInfo.latest}`;
    button.title = `Hay una versión nueva de optimia (${updateInfo.latest}); tienes la ${updateInfo.current}`;
  }
}

async function checkUpdates({ force = false } = {}) {
  try {
    updateInfo = await api.get(`/api/update${force ? '?force=1' : ''}`);
  } catch {
    return;
  }
  renderUpdateButton();
  renderGeneralPane();
}

// ---------- Settings > General ----------

let includeSecrets = false;

async function renderGeneralPane() {
  const host = document.getElementById('general-pane');
  if (!host) return;
  let checkEnabled = true;
  let sandbox = null;
  try {
    checkEnabled = (await api.get('/api/settings')).layers.global.updates.check;
    sandbox = (await api.get('/api/config/status')).sandbox;
  } catch {
    /* keep the default */
  }
  const u = updateInfo;
  const status = !u
    ? 'Comprobando…'
    : u.disabled
      ? 'La comprobación de versiones está desactivada.'
      : u.updateAvailable
        ? `Hay una versión nueva: ${u.latest}.`
        : u.latest
          ? 'Tienes la última versión.'
          : `No se pudo comprobar${u.error ? ` (${u.error})` : ''}.`;
  host.replaceChildren(
    h(
      'div',
      { class: 'settings-field' },
      h('label', {}, `optimia ${u?.current || ''}`),
      h(
        'div',
        { class: 'muted' },
        status,
        u?.checkedAt ? ` Última comprobación: ${new Date(u.checkedAt).toLocaleString('es-ES')}.` : ''
      ),
      h(
        'div',
        { class: 'general-actions' },
        u?.updateAvailable
          ? h('button', { type: 'button', class: 'primary', onclick: showUpdateSheet }, 'Cómo actualizar…')
          : null,
        h('button', { type: 'button', onclick: () => checkUpdates({ force: true }) }, 'Buscar ahora')
      ),
      h(
        'label',
        { class: 'check-row' },
        h('input', {
          type: 'checkbox',
          checked: checkEnabled,
          onchange: async (e) => {
            await api.patch('/api/settings', { scope: 'global', updates: { check: e.target.checked } });
            checkUpdates({ force: e.target.checked });
          }
        }),
        'Avisar cuando haya una versión nueva (consulta el registro de npm una vez al día)'
      )
    ),
    renderSecurityField(sandbox),
    h(
      'div',
      { class: 'settings-field' },
      h('label', {}, 'Tu configuración'),
      h(
        'div',
        { class: 'muted' },
        'Un fichero con todo lo que comparten tus repos: instrucciones, lista "Prohibido", agentes, pipelines, modelos y avisos. ',
        'No incluye los repos ni su memoria. Guárdalo en un sitio privado: lleva tus instrucciones y los prompts de tus agentes. ',
        'Para importarlo, arrástralo a esta ventana.'
      ),
      h(
        'label',
        { class: 'check-row' },
        h('input', {
          type: 'checkbox',
          checked: includeSecrets,
          onchange: (e) => (includeSecrets = e.target.checked)
        }),
        'Incluir secretos (la cabecera de autenticación de la IA local)'
      ),
      h(
        'div',
        { class: 'general-actions' },
        h(
          'button',
          {
            type: 'button',
            onclick: () => {
              const a = h('a', { href: `/api/config/export${includeSecrets ? '?secrets=1' : ''}`, download: '' });
              document.body.append(a);
              a.click();
              a.remove();
            }
          },
          'Exportar configuración…'
        ),
        h('button', { type: 'button', onclick: pickConfigFile }, 'Importar configuración…')
      )
    )
  );
}

// Security: the OS sandbox of the agents (Bash can only write inside the task's worktree).
function renderSecurityField(sandbox) {
  if (!sandbox) return null;
  const state = sandbox.available
    ? 'Disponible en este equipo.'
    : sandbox.unsupported
      ? 'No disponible en este sistema.'
      : `No disponible: falta ${sandbox.missing.join(' y ')}.`;
  return h(
    'div',
    { class: 'settings-field', id: 'security-field' },
    h('label', { for: 'setting-sandbox' }, 'Seguridad de los agentes'),
    h(
      'div',
      { class: 'muted' },
      'Los agentes ejecutan sus comandos en el sandbox del sistema de Claude Code: solo pueden escribir dentro del worktree de su tarea. ',
      state,
      sandbox.install ? h('div', {}, 'Instálalo con: ', h('code', {}, sandbox.install)) : null
    ),
    h(
      'select',
      {
        id: 'setting-sandbox',
        onchange: async (e) => {
          await api.patch('/api/settings', { scope: 'global', security: { sandbox: e.target.value } });
          renderGeneralPane();
        }
      },
      h(
        'option',
        { value: 'required', selected: sandbox.mode !== 'off' },
        'Obligatorio: sin sandbox los agentes no arrancan'
      ),
      h(
        'option',
        { value: 'off', selected: sandbox.mode === 'off' },
        'Desactivado: los agentes trabajan sin sandbox (riesgo)'
      )
    ),
    sandbox.mode === 'off'
      ? h(
          'div',
          { class: 'error-text' },
          'Sin sandbox, solo las reglas de optimia frenan a un agente, y un agente decidido puede esquivarlas (por ejemplo, con un script).'
        )
      : null
  );
}

// ---------- boot ----------

export async function initConfig() {
  bindDrop();
  document.getElementById('update-button')?.addEventListener('click', showUpdateSheet);
  renderGeneralPane();
  try {
    const status = await api.get('/api/config/status');
    if (status.firstRun) welcome();
  } catch {
    /* the server is not ready yet: no welcome sheet */
  }
  checkUpdates();
  setInterval(checkUpdates, RECHECK_MS);
}
