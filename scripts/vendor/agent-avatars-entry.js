// Entry for web/vendor/agent-avatars/agent-avatars.js (scripts/vendor-agent-avatars.sh): the
// agent-avatars React component with React itself, as one browser script that sets window.AgentAvatars.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentAvatar, avatarFromSeed, SHAPES, COLORS, EYES, EYE_COLORS, MOODS, GESTURES } from '@jamesalmeida/agent-avatars';

/** Renders an avatar into `el`; update(props) changes it, unmount() removes it. */
function mount(el, props) {
  const root = createRoot(el);
  let current = props;
  const render = () => root.render(React.createElement(AgentAvatar, current));
  render();
  return {
    update(next) {
      current = { ...current, ...next };
      render();
    },
    unmount() {
      root.unmount();
    }
  };
}

globalThis.AgentAvatars = { mount, avatarFromSeed, SHAPES, COLORS, EYES, EYE_COLORS, MOODS, GESTURES };
