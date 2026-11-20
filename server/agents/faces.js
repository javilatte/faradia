'use strict';

// Each agent's face (web/js/faces.js, made with agent-avatars): a shape and a color, written
// "shape/color", e.g. "blob/ocean"; the color is a preset name or a hex color. The eyes are always
// white and change with what the agent is doing. Built-in agents have their own; any other agent
// without one gets a shape and color picked from its id in the browser (avatarFromSeed).

const SHAPES = ['circle', 'squircle', 'pill', 'blob', 'drop', 'hexagon'];
const COLORS = ['slate', 'teal', 'ocean', 'plum', 'clay', 'moss', 'black'];

const BUILTIN_FACES = {
  planner: 'blob/ocean',
  implementer: 'squircle/slate',
  verifier: 'pill/moss',
  reviewer: 'hexagon/plum',
  committer: 'circle/black',
  'pr-writer': 'squircle/clay',
  'wiki-keeper': 'squircle/moss',
  researcher: 'drop/teal',
  'doc-writer': 'drop/ocean',
  debugger: 'hexagon/clay',
  'test-writer': 'circle/teal',
  auditor: 'pill/black',
  corrector: 'blob/plum',
  'comment-sicko': 'blob/clay'
};

const HEX = /^#[0-9a-f]{6}$/i;

function isFace(value) {
  const parts = String(value ?? '').split('/');
  if (parts.length !== 2) return false;
  const [shape, color] = parts;
  return SHAPES.includes(shape) && (COLORS.includes(color) || HEX.test(color));
}

/** The face an agent shows: its own choice or its built-in one; null lets the browser pick by id. */
function faceFor(id, chosen) {
  if (isFace(chosen)) return String(chosen);
  return BUILTIN_FACES[id] || null;
}

module.exports = { BUILTIN_FACES, SHAPES, COLORS, faceFor, isFace };
