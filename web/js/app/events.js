// Canal de eventos globales (workbenches, vigilancia de repos, timeline, avisos).
// Usa su propia conexion WebSocket, independiente de la del chat del proyecto,
// y reconecta sola. Las vistas se suscriben por tipo de mensaje.

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
      /* mensaje no JSON: se ignora */
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
