// Sanitized markdown (marked + DOMPurify, loaded on demand from jsDelivr). Used by the explorer,
// the chat and the task cards. Without network, plain text.

const MARKED_URL = 'https://cdn.jsdelivr.net/npm/marked@15.0.4/+esm';
const PURIFY_URL = 'https://cdn.jsdelivr.net/npm/dompurify@3.2.3/+esm';

let libs = null;

export async function renderMarkdown(el, text) {
  el.textContent = text;
  try {
    libs ??= Promise.all([import(MARKED_URL), import(PURIFY_URL)]);
    const [{ marked }, purify] = await libs;
    // Sanitized: no scripts or handlers; markdown never runs code.
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

// For the classic scripts in web/js/project (not modules): what they painted before this module
// loaded is painted again now.
window.faradiaMarkdown = renderMarkdown;
window.dispatchEvent(new Event('faradia:markdown-ready'));
