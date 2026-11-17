'use strict';

// Opens another project in place: no page reload, so the window, the open view and the WebSocket
// stay; the chat, the agents board, the settings and the terminal switch to the other repo. Each
// repo keeps its own unsent message.

const composerDrafts = new Map(); // projectId -> unsent text

async function switchProject(projectId, { push = true } = {}) {
  const from = currentProjectId || defaultProjectId;
  if (!projectId || projectId === from) return;
  composerDrafts.set(from, input.value);

  currentProjectId = projectId;
  if (push) {
    const params = new URLSearchParams(location.search);
    params.set('p', projectId);
    history.pushState({ projectId }, '', `${location.pathname}?${params}${location.hash}`);
  }

  // Chat of the previous repo: it keeps running on the server, it is just no longer shown.
  currentChatId = null;
  currentAssistantBubble = null;
  waitingForResult = false;
  chatsMeta.clear();
  chatLog.innerHTML = '';
  input.value = composerDrafts.get(projectId) || '';
  pendingImages = [];
  setWaiting(false);

  // Agents board.
  tasks.clear();
  taskLogs.clear();
  openTaskLogs.clear();
  chatAgents.clear();
  agentCatalog = null;
  memoryKnown = null;
  repoDelivery = null;
  renderTasks();

  window.TerminalView?.reset();
  window.dispatchEvent(new CustomEvent('optimia:project-changed', { detail: { projectId } }));

  await Promise.all([
    loadInitialSettings().catch(() => {}),
    loadInitialTasks().catch(() => {}),
    loadInitialChats().catch(() => {}),
    loadTaskKinds().catch(() => {})
  ]);
  syncTaskControls();
}
window.optimiaSwitchProject = switchProject;

// Back / forward between repos.
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('p');
  if (id && id !== currentProjectId) switchProject(id, { push: false });
});
