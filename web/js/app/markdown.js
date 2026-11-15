// Markdown saneado (marked + DOMPurify, cargados bajo demanda desde jsDelivr).
// Lo usan el explorador, el chat y las tarjetas de tarea. Sin red, texto plano.

const MARKED_URL = 'https://cdn.jsdelivr.net/npm/marked@15.0.4/+esm';
const PURIFY_URL = 'https://cdn.jsdelivr.net/npm/dompurify@3.2.3/+esm';

let libs = null;

export async function renderMarkdown(el, text) {
  el.textContent = text;
  try {
    libs ??= Promise.all([import(MARKED_URL), import(PURIFY_URL)]);
    const [{ marked }, purify] = await libs;
    // Saneado: nada de scripts ni manejadores; el markdown nunca ejecuta codigo.
    const html = purify.default.sanitize(marked.parse(text, { breaks: true }), { USE_PROFILES: { html: true } });
    el.innerHTML = html;
    for (const a of el.querySelectorAll('a[href]')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    el.classList.add('md');
  } catch {
    el.textContent = text;
  }
}

// Para los scripts clasicos de web/js/project (no son modulos): lo que pintaron
// antes de que cargara este modulo se repinta ahora.
window.optimiaMarkdown = renderMarkdown;
window.dispatchEvent(new Event('optimia:markdown-ready'));
