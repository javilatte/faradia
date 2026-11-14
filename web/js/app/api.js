// Acceso a la API desde las vistas nuevas (modulos ES). La sesion va en la cookie
// que optimia fija al abrir su enlace, asi que basta con fetch normal.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url, body) => request('DELETE', url, body)
};

// Ruta de la API de un proyecto concreto.
export const projectApi = (projectId, rest) => `/api/projects/${projectId}${rest}`;
