// Global events channel (workbenches, repo supervision, timeline, signals). Uses its own WebSocket
// connection, separate from the project chat's, and reconnects by itself. Views subscribe by
// message type.

const listeners = new Map(); // type -> Set<fn>
let socket = null;
let retryMs = 1000;

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

function emit(msg) {
  for (const key of [msg.type, '*']) {
    for (const fn of listeners.get(key) || []) {
      try {
        fn(msg);
      } catch (err) {
        console.error('optimia: error en un suscriptor de eventos', err);
      }
    }
  }
}

export function connectEvents() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    retryMs = 1000;
    emit({ type: 'events_connected' });
  });
  socket.addEventListener('message', (raw) => {
    try {
      emit(JSON.parse(raw.data));
    } catch {
      /* non-JSON message: ignored */
    }
  });
  socket.addEventListener('close', () => {
    emit({ type: 'events_disconnected' });
    setTimeout(connectEvents, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  });
  socket.addEventListener('error', () => socket.close());
}

export function send(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}
