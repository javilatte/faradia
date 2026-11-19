'use strict';

// Settings › Sincronización: the same configuration on every computer (server/sync). The user picks
// a folder they already sync between computers and a passphrase; the copy is encrypted here with it
// before it is written, so whoever stores the folder (Google, Dropbox…) cannot read it.

const syncPane = document.getElementById('sync-pane');
let syncDraft = { folder: '', passphrase: '' };
let syncError = '';
let syncBusy = false;

function sEl(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== '' && c !== null && c !== undefined) node.append(c);
  return node;
}

async function syncCall(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const ACTION_TEXT = {
  up: 'se subieron los cambios de este equipo',
  down: 'se aplicaron los cambios de otro equipo',
  'conflict-down': 'había cambios en los dos lados: se quedó la versión más reciente (la de otro equipo)',
  'conflict-up': 'había cambios en los dos lados: se quedó la versión más reciente (la de este equipo)',
  unusable: 'la copia de otro equipo no se pudo aplicar; quedó guardada en ~/.config/optimia/backups'
};

function syncWhen(iso) {
  if (!iso) return 'nunca';
  return new Date(iso).toLocaleString(window.optimiaLang?.locale || 'es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function row(label, value) {
  return sEl(
    'li',
    { class: 'skill-row' },
    sEl('span', { class: 'skill-row-text' }, sEl('span', { class: 'skill-row-name' }, label)),
    sEl('span', { class: 'sync-row-value' }, value)
  );
}

function connectedView(st) {
  const wipe = sEl('button', { type: 'button', class: 'danger-text' }, 'Desactivar y borrar la copia…');
  wipe.addEventListener('click', async () => {
    // Two steps instead of a confirm dialog.
    if (!wipe.dataset.armed) {
      wipe.dataset.armed = '1';
      wipe.textContent = '¿Borrar la copia? Pulsa otra vez';
      setTimeout(() => {
        delete wipe.dataset.armed;
        wipe.textContent = 'Desactivar y borrar la copia…';
      }, 3000);
      return;
    }
    await run(() => syncCall('DELETE', '/api/sync?wipe=1'));
  });
  return [
    sEl(
      'ul',
      { class: 'grouped-list' },
      row('Carpeta', st.label),
      row('Este equipo', st.machine),
      row('Última comprobación', syncWhen(st.lastSyncAt)),
      st.lastAction ? row('Último cambio', ACTION_TEXT[st.lastAction] || st.lastAction) : ''
    ),
    st.lastError ? sEl('div', { class: 'error-text', role: 'alert' }, `No se pudo sincronizar: ${st.lastError}`) : '',
    sEl(
      'p',
      { class: 'group-help' },
      'Se comprueba cada pocos minutos y justo después de cada cambio. Si hay cambios en dos equipos a la vez gana el más reciente, y el otro se guarda en ~/.config/optimia/backups.'
    ),
    sEl(
      'div',
      { class: 'general-actions' },
      sEl(
        'button',
        { type: 'button', disabled: syncBusy, onclick: () => run(() => syncCall('POST', '/api/sync/now')) },
        syncBusy ? 'Sincronizando…' : 'Sincronizar ahora'
      ),
      sEl('button', { type: 'button', onclick: () => run(() => syncCall('DELETE', '/api/sync')) }, 'Desactivar'),
      wipe
    )
  ];
}

function setupView() {
  const pass = sEl('input', {
    type: 'password',
    id: 'sync-passphrase',
    autocomplete: 'new-password',
    minlength: '8',
    placeholder: 'Al menos 8 caracteres',
    'aria-describedby': 'sync-passphrase-help'
  });
  const folder = sEl('input', {
    type: 'text',
    id: 'sync-folder',
    spellcheck: 'false',
    placeholder: '~/Google Drive/Mi unidad, ~/Dropbox…',
    'aria-describedby': 'sync-folder-help'
  });
  // What was typed survives a re-render (an error, a status update).
  pass.value = syncDraft.passphrase;
  folder.value = syncDraft.folder;
  pass.addEventListener('input', () => (syncDraft.passphrase = pass.value));
  folder.addEventListener('input', () => (syncDraft.folder = folder.value));
  const choose = sEl('button', { type: 'button' }, 'Elegir…');
  choose.addEventListener('click', async () => {
    const { path } = await syncCall('POST', '/api/pick-folder', {}).catch(() => ({}));
    if (path) folder.value = syncDraft.folder = path;
  });
  const activate = sEl(
    'button',
    { type: 'button', class: 'primary', disabled: syncBusy },
    syncBusy ? 'Activando…' : 'Activar'
  );
  activate.addEventListener('click', () =>
    run(async () => {
      await syncCall('POST', '/api/sync/folder', { path: folder.value.trim(), passphrase: pass.value });
      syncDraft = { folder: '', passphrase: '' };
    })
  );
  for (const input of [pass, folder]) input.addEventListener('keydown', (e) => e.key === 'Enter' && activate.click());
  return [
    sEl(
      'div',
      { class: 'settings-field' },
      sEl('label', { for: 'sync-folder' }, 'Carpeta'),
      sEl('div', { class: 'inline-row' }, folder, choose),
      sEl(
        'span',
        { class: 'muted', id: 'sync-folder-help' },
        'Una carpeta que ya sincronices entre tus equipos: Google Drive para escritorio, Dropbox, iCloud, Syncthing… En los demás equipos elige la misma.'
      )
    ),
    sEl(
      'div',
      { class: 'settings-field' },
      sEl('label', { for: 'sync-passphrase' }, 'Frase de paso'),
      pass,
      sEl(
        'span',
        { class: 'muted', id: 'sync-passphrase-help' },
        'Cifra la copia en este equipo antes de guardarla en la carpeta. Usa la misma en todos tus equipos. Si la olvidas, la copia no se puede recuperar (tu configuración local no se pierde).'
      )
    ),
    syncError ? sEl('div', { class: 'error-text', role: 'alert' }, syncError) : '',
    sEl('div', { class: 'general-actions' }, activate)
  ];
}

async function run(fn) {
  syncBusy = true;
  syncError = '';
  renderSyncPane();
  try {
    await fn();
  } catch (err) {
    syncError = err.message;
  } finally {
    syncBusy = false;
    renderSyncPane();
  }
}

async function renderSyncPane() {
  const st = await syncCall('GET', '/api/sync').catch((err) => ({ error: err.message }));
  if (st.error) {
    syncPane.replaceChildren(sEl('div', { class: 'error-text' }, st.error));
    return;
  }
  syncPane.replaceChildren(
    sEl(
      'p',
      { class: 'muted settings-help' },
      'Tu configuración igual en todos tus equipos: ajustes, claves de IA, agentes, etapas, instrucciones y avisos. Los repos y las tareas se quedan en cada equipo.'
    ),
    ...(st.enabled ? connectedView(st) : setupView())
  );
}

window.onSyncStatus = () => {
  if (!syncPane.closest('.settings-pane')?.hidden) renderSyncPane();
};

document.querySelector('.settings-nav-item[data-pane="sync"]').addEventListener('click', () => {
  syncError = '';
  renderSyncPane();
});
