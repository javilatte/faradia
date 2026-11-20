'use strict';

// Each agent's face: a BoopFace skin number (web/vendor/boopface), shown on its task cards and in
// Settings › Agentes. Built-in agents have their own; any other agent gets one from the pool, always
// the same for the same id. An agent file can choose another with `face: 1503`, or `face: plain`
// for the flat color.

const BUILTIN_FACES = {
  planner: '1002',
  implementer: '906',
  verifier: '1007',
  reviewer: '1102',
  committer: '926',
  'pr-writer': '1401',
  'wiki-keeper': '1103',
  researcher: '1609',
  'doc-writer': '1402',
  debugger: '1005',
  'test-writer': '701',
  auditor: '1001',
  corrector: '1004',
  'comment-sicko': '1503'
};

// The skins offered in the face picker, and the pool for agents without one.
const FACE_POOL = [
  ...new Set([
    ...Object.values(BUILTIN_FACES),
    '102',
    '103',
    '105',
    '106',
    '201',
    '404',
    '509',
    '603',
    '912',
    '916',
    '1006',
    '1301',
    '1606',
    '1612',
    '1701',
    '1702'
  ])
];

const FACE_RE = /^(plain|\d{3,4})$/;

function isFace(value) {
  return FACE_RE.test(String(value ?? ''));
}

function hash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

/** The face an agent shows: its own choice, its built-in one, or one from the pool by its id. */
function faceFor(id, chosen) {
  if (isFace(chosen)) return String(chosen);
  return BUILTIN_FACES[id] || FACE_POOL[hash(id) % FACE_POOL.length];
}

module.exports = { BUILTIN_FACES, FACE_POOL, faceFor, isFace };
