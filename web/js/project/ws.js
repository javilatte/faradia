'use strict';

// Conexion WebSocket con el servidor y despacho de mensajes.

function connect() {
  setConnectionState(false, 'Conectando...');

  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    wsOpen = true;
    setConnectionState(true, 'Conectado');
    setWaiting(waitingForResult);
    if (currentChatId) ws.send(wsPayload({ type: 'subscribe', chatId: currentChatId }));
    if (window.TerminalView && window.TerminalView.isOpen()) ws.send(wsPayload({ type: 'terminal_subscribe' }));
  });

  ws.addEventListener('message', (raw) => {
    const msg = JSON.parse(raw.data);
    if (!isForThisProject(msg)) return;
    if (msg.type === 'claude_event') {
      if (msg.chatId === currentChatId) handleClaudeEvent(msg.event);
    } else if (msg.type === 'bridge_error') {
      if (!msg.chatId || msg.chatId === currentChatId) {
        appendMessage('error', msg.error);
        setWaiting(false);
      }
    } else if (msg.type === 'chat_renamed') {
      const meta = chatsMeta.get(msg.chatId);
      if (meta) {
        meta.title = msg.title;
        renderChatTabs();
      }
    } else if (msg.type === 'chat_stopped') {
      if (msg.chatId === currentChatId) {
        currentAssistantBubble = null;
        appendMessage(
          'system',
          'Consulta parada. La conversacion se conserva; el siguiente mensaje continua desde aqui.'
        );
        setWaiting(false);
      }
    } else if (msg.type === 'claude_exit') {
      if (msg.chatId === currentChatId) {
        appendMessage(
          'system',
          'La sesion de Claude Code para este chat termino. Se reanudara con el siguiente mensaje.'
        );
        setWaiting(false);
      }
    } else if (msg.type === 'client_error') {
      console.warn('[optimia] client_error', msg.error);
      appendMessage('error', msg.error);
      setWaiting(false);
    } else if (msg.type === 'permission_needed') {
      if (msg.scope === 'chat' ? msg.id === currentChatId : true) {
        appendMessage(
          'system',
          `Permiso denegado: ${msg.toolName}. Abriendo la terminal para continuar de forma interactiva.`
        );
      }
      if (window.TerminalView) window.TerminalView.flagAttention();
    } else if (msg.type === 'terminal_handoff') {
      if (msg.scope === 'chat' ? msg.id === currentChatId : true) {
        appendMessage(
          'system',
          `Abriendo la terminal (${msg.toolName} necesitaba permiso). Al cerrarla, esta conversacion sigue aqui.`
        );
        setWaiting(false);
      }
      if (msg.scope === 'chat') {
        // The headless session gets killed for the handoff, so any agent
        // card still "running" for this chat never gets its task_updated —
        // and per Claude Code's own terminal output, the background agent
        // itself gets orphaned, not just its status report. Mark the card
        // rather than delete it: making it vanish silently while the chat
        // text may still say "cuando termine, te aviso" is more confusing
        // than an honest "interrumpido" state. It clears itself next time a
        // background_tasks_changed snapshot confirms it's really gone (e.g.
        // on the next message sent in this chat).
        let agentsChanged = false;
        for (const [id, agent] of chatAgents) {
          if (agent.chatId === msg.id && !agent.interrupted && !agent.finished) {
            agent.interrupted = true;
            agentsChanged = true;
          }
        }
        if (agentsChanged) renderTasks();
      }
      if (window.TerminalView) window.TerminalView.open();
    } else if (msg.type === 'chat_resumed') {
      if (msg.chatId === currentChatId) {
        appendMessage('system', 'Terminal cerrada. La conversacion sigue aqui, puedes continuar.');
        setWaiting(false);
      }
    } else if (msg.type === 'task_updated') {
      const entry = tasks.get(msg.task.id);
      const prevStatus = entry ? entry.task.status : null;
      tasks.set(msg.task.id, { task: msg.task, lastStep: entry ? entry.lastStep : null });
      renderTasks();
      notifyTaskInChat(msg.task, prevStatus);
    } else if (msg.type === 'task_deleted') {
      if (tasks.delete(msg.taskId)) renderTasks();
    } else if (msg.type === 'task_claude_event') {
      logTaskEvent(msg.taskId, msg.event);
      const entry = tasks.get(msg.taskId);
      if (entry) {
        entry.lastStep = stepLabelFor(msg.event) || entry.lastStep;
        renderTasks();
      } else if (openTaskLogs.has(msg.taskId)) {
        renderTasks();
      }
    } else if (msg.type === 'task_error') {
      console.warn('[optimia] task_error', msg.taskId, msg.error);
    } else if (msg.type === 'terminal_scrollback') {
      if (window.TerminalView) window.TerminalView.handleScrollback(msg.data);
    } else if (msg.type === 'terminal_data') {
      if (window.TerminalView) window.TerminalView.handleData(msg.data);
    } else if (msg.type === 'terminal_exit') {
      if (window.TerminalView) window.TerminalView.handleExit(msg.info);
    }
  });

  ws.addEventListener('close', () => {
    wsOpen = false;
    setConnectionState(false, 'Desconectado');
    setWaiting(true);
    setTimeout(connect, 1500);
  });

  ws.addEventListener('error', () => ws.close());
}
