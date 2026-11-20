// The agents' faces: BoopFace (web/vendor/boopface, MIT), one skin per agent (server/agents/faces.js).
// A face says what its agent is doing: it waits while the agent works, looks wary when the agent asks
// something, smiles when the work is ready and droops when it fails. Settings › Apariencia turns them
// off. Faces load the first time one is shown; the skins, the first time a skin is.

// A classic script (the task cards are classic scripts too): it exposes window.faces.
(() => {
  'use strict';

  const TAG = 'faradia-face';
  let enabled = true;
  let loading = null;

  // The task lists are rebuilt on every change, which takes each face out of the page and puts it back
  // at once. BoopFace starts over (idle) when it leaves the page; this subclass only lets it go when it
  // is still out after the rebuild, so a face keeps doing what it was doing.
  function define(BoopFace) {
    if (customElements.get(TAG)) return;
    customElements.define(
      TAG,
      class extends BoopFace {
        connectedCallback() {
          if (this._faradiaLive) return;
          this._faradiaLive = true;
          super.connectedCallback();
        }
        disconnectedCallback() {
          queueMicrotask(() => {
            if (this.isConnected || !this._faradiaLive) return;
            this._faradiaLive = false;
            super.disconnectedCallback();
          });
        }
      }
    );
  }

  function load() {
    loading ??= import(new URL('vendor/boopface/boopface.js', document.baseURI).href)
      .then((m) => define(m.BoopFace))
      .catch(() => null);
    return loading;
  }

  function setFacesEnabled(on) {
    enabled = on !== false;
    document.documentElement.classList.toggle('no-faces', !enabled);
  }

  function facesEnabled() {
    return enabled;
  }

  // One face per key (a task, a chat agent…), kept between rebuilds.
  const faces = new Map();

  const LOOPS = { working: 'spin', thinking: 'wave', reviewing: 'wrap' };
  const ONCE = { asking: 'wary', done: 'success', failed: 'failure', blocked: 'refuse' };

  function apply(el, state) {
    customElements.whenDefined(TAG).then(() => {
      if (el.dataset.state !== state) return; // it changed again meanwhile
      if (LOOPS[state]) return el.startWaiting({ variant: LOOPS[state] });
      el.stopWaiting?.();
      if (ONCE[state]) el.play(ONCE[state]);
      else el.reset?.();
    });
  }

  // A skin, or the flat color in a grey that shows on light and dark backgrounds alike.
  function paint(el, skin) {
    if (skin && skin !== 'plain') {
      if (el.getAttribute('skin') !== skin) el.setAttribute('skin', skin);
      el.removeAttribute('color');
    } else {
      el.removeAttribute('skin');
      el.setAttribute('color', '#8e8e93');
    }
  }

  /**
   * The face for `key`: `skin` is a BoopFace skin number or 'plain'; `state` one of idle, thinking,
   * working, reviewing, asking, done, failed, blocked. Null when faces are off.
   */
  function agentFace(key, { skin, size = 36, state = 'idle', label = '' } = {}) {
    if (!enabled) return null;
    load();
    let el = faces.get(key);
    if (!el) {
      el = document.createElement(TAG);
      el.className = 'agent-face';
      el.setAttribute('size', String(size));
      el.setAttribute('auto-sleep', '0');
      el.setAttribute('press-squeeze', 'false');
      el.setAttribute('aria-hidden', 'true');
      faces.set(key, el);
    }
    paint(el, skin);
    el.title = label;
    if (el.dataset.state !== state) {
      el.dataset.state = state;
      apply(el, state);
    }
    return el;
  }

  /** A face that does not change state: Settings › Agentes, the face picker. Not kept. */
  function staticFace(skin, { size = 40, label = '' } = {}) {
    if (!enabled) return null;
    load();
    const el = document.createElement(TAG);
    el.className = 'agent-face';
    el.setAttribute('size', String(size));
    el.setAttribute('auto-sleep', '0');
    el.setAttribute('press-squeeze', 'false');
    paint(el, skin);
    if (label) el.title = label;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  /** Forgets the faces whose key is not in `keys` (tasks deleted or archived). */
  function keepFaces(keys) {
    const keep = new Set(keys);
    for (const key of faces.keys()) if (!keep.has(key)) faces.delete(key);
  }

  window.faces = { agentFace, staticFace, keepFaces, setFacesEnabled, facesEnabled };
})();
