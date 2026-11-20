// The agents' faces: agent-avatars (web/vendor/agent-avatars, MIT), a shape with two eyes per agent
// (server/agents/faces.js). A face says what its agent is doing: it thinks while it plans, works while
// it changes code, reads while it verifies or reviews, listens when it asks you something, smiles when
// the work is ready and says sorry when it fails. Settings › Apariencia turns them off. The library
// loads the first time a face is shown.

// A classic script (the task cards are classic scripts too): it exposes window.faces.
(() => {
  'use strict';

  let enabled = true;
  let loading = null;

  function load() {
    loading ??= new Promise((resolve) => {
      if (window.AgentAvatars) return resolve(window.AgentAvatars);
      const script = document.createElement('script');
      script.src = new URL('vendor/agent-avatars/agent-avatars.js', document.baseURI).href;
      script.onload = () => resolve(window.AgentAvatars || null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
    return loading;
  }

  function setFacesEnabled(on) {
    enabled = on !== false;
    document.documentElement.classList.toggle('no-faces', !enabled);
  }

  function facesEnabled() {
    return enabled;
  }

  /**
   * "shape/color" (or nothing: picked from the agent's id) as avatar props. The eyes are always the
   * same white ones: what changes them is the agent's mood.
   */
  function looks(face, seed, lib) {
    const parts = String(face || '').split('/');
    const [shape, color] =
      parts.length === 2
        ? parts
        : [lib.avatarFromSeed(seed || 'agent').shape, lib.avatarFromSeed(seed || 'agent').color];
    return { shape, color, eyes: 'round', eyeColor: 'white', fill: 'gradient' };
  }

  // A state of the task, as the avatar's mood.
  const MOODS = {
    idle: 'idle',
    thinking: 'thinking',
    searching: 'searching',
    working: 'working',
    writing: 'writing',
    reviewing: 'reading',
    asking: 'listening',
    done: 'happy',
    failed: 'sorry',
    blocked: 'confused'
  };

  // One face per key (a task, a chat agent…). Its element is kept between rebuilds of the lists, so
  // the avatar keeps its state and only changes what changed.
  const faces = new Map();

  function render(entry) {
    load().then((lib) => {
      if (!lib) return;
      const props = {
        ...looks(entry.face, entry.seed, lib),
        mood: MOODS[entry.state] || 'idle',
        size: entry.size,
        outline: true,
        followPointer: entry.state === 'idle',
        label: entry.label || undefined
      };
      if (entry.handle) entry.handle.update(props);
      else entry.handle = lib.mount(entry.el, props);
    });
  }

  /**
   * The face for `key`: `face` is "shape/color" or null (picked from `seed`), `state`
   * one of idle, thinking, searching, working, writing, reviewing, asking, done, failed, blocked.
   * Null when faces are off.
   */
  function agentFace(key, { face = null, seed = '', size = 36, state = 'idle', label = '' } = {}) {
    if (!enabled) return null;
    let entry = faces.get(key);
    if (!entry) {
      const el = document.createElement('span');
      el.className = 'agent-face';
      entry = { el, handle: null };
      faces.set(key, entry);
    }
    const changed =
      entry.face !== face ||
      entry.seed !== seed ||
      entry.state !== state ||
      entry.size !== size ||
      entry.label !== label;
    Object.assign(entry, { face, seed, size, state, label });
    entry.el.title = label;
    entry.el.dataset.state = state;
    if (changed) render(entry);
    return entry.el;
  }

  /** A face that does not follow a task: Settings › Agentes and its picker. */
  function staticFace(face, { seed = '', size = 32, mood = 'idle' } = {}) {
    if (!enabled) return null;
    const el = document.createElement('span');
    el.className = 'agent-face';
    load().then((lib) => lib && lib.mount(el, { ...looks(face, seed, lib), mood, size, outline: true }));
    return el;
  }

  /** Forgets the faces whose key is not in `keys` (tasks deleted or archived). */
  function keepFaces(keys) {
    const keep = new Set(keys);
    for (const [key, entry] of faces) {
      if (keep.has(key)) continue;
      entry.handle?.unmount();
      faces.delete(key);
    }
  }

  window.faces = { agentFace, staticFace, keepFaces, setFacesEnabled, facesEnabled, load };
})();
