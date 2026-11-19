'use strict';

const fs = require('fs');
const path = require('path');
const { readPreview } = require('../bridge/taskFiles');

// File explorer of a repo. Every path arrives relative to the repo and is resolved inside it: no
// absolute paths, ".." or symlinks leading out of the repo. The .git and .faradia folders
// (faradia's internal state: tasks, chats, agent worktrees) are never listed or touched.

const HIDDEN = new Set(['.git', '.faradia', '.optimia']);
const MAX_ENTRIES = 2000;
const MAX_TEXT_BYTES = 1024 * 1024;

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf'
};

class FsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isInside(root, abs) {
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

/**
 * Absolute path inside the repo for `rel` ("" = the root). Throws FsError if it leaves the repo,
 * touches .git or (with mustExist) does not exist.
 */
function resolveRepoPath(root, rel, { mustExist = true, allowRoot = true } = {}) {
  const clean = typeof rel === 'string' ? rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : null;
  if (clean === null || clean.includes('\0')) throw new FsError(400, 'ruta no valida');
  if (!clean && !allowRoot) throw new FsError(400, 'no se puede operar sobre la raíz del repo');
  const abs = path.resolve(root, clean);
  if (!isInside(root, abs)) throw new FsError(400, 'la ruta sale del repo');
  if (clean.split('/').some((part) => HIDDEN.has(part)))
    throw new FsError(403, 'las carpetas .git y .faradia no se pueden tocar desde el explorador');
  if (mustExist) {
    if (!fs.existsSync(abs)) throw new FsError(404, 'no existe');
    // A symlink cannot lead out of the repo.
    if (!isInside(fs.realpathSync(root), fs.realpathSync(abs)))
      throw new FsError(403, 'el enlace apunta fuera del repo');
  }
  return { abs, rel: clean };
}

function listDir(root, rel = '') {
  const { abs } = resolveRepoPath(root, rel);
  if (!fs.statSync(abs).isDirectory()) throw new FsError(400, 'no es una carpeta');
  const entries = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (HIDDEN.has(e.name)) continue;
    if (entries.length >= MAX_ENTRIES) break;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    let stat = null;
    try {
      stat = fs.statSync(path.join(abs, e.name));
    } catch {
      /* enlace roto */
    }
    entries.push({
      name: e.name,
      path: childRel,
      type: e.isSymbolicLink() ? 'symlink' : stat?.isDirectory() ? 'dir' : 'file',
      dir: Boolean(stat?.isDirectory()),
      size: stat && !stat.isDirectory() ? stat.size : null,
      mtime: stat ? new Date(stat.mtimeMs).toISOString() : null
    });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'es', { numeric: true }) : a.dir ? -1 : 1));
  return { path: rel, entries, truncated: entries.length >= MAX_ENTRIES };
}

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

/** What to show for a file: markdown, text, image, audio, video or nothing. */
function preview(root, rel) {
  const { abs } = resolveRepoPath(root, rel);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new FsError(400, 'es una carpeta');
  const ext = path.extname(abs).toLowerCase();
  const base = { path: rel, size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(), mime: mimeFor(abs) };
  if (base.mime.startsWith('image/')) return { ...base, kind: 'image' };
  if (base.mime.startsWith('audio/')) return { ...base, kind: 'audio' };
  if (base.mime.startsWith('video/')) return { ...base, kind: 'video' };
  if (ext === '.pdf') return { ...base, kind: 'pdf' };
  if (ext === '.docx') {
    const p = readPreview(abs);
    return p.kind === 'text'
      ? { ...base, kind: 'text', content: p.content }
      : { ...base, kind: 'none', reason: p.reason };
  }
  if (stat.size > MAX_TEXT_BYTES) return { ...base, kind: 'none', reason: 'fichero demasiado grande para mostrarlo' };
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: 'none', reason: 'fichero binario' };
  const content = buf.toString('utf8');
  return { ...base, kind: ['.md', '.markdown', '.mdx'].includes(ext) ? 'markdown' : 'text', content };
}

module.exports = { FsError, resolveRepoPath, listDir, preview, mimeFor, isInside };
