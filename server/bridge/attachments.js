'use strict';

const { writeJsonFile } = require('../store/jsonFile');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// Files attached to a chat message. They go into the context as cheaply as possible:
//   - images: native image blocks (handled by the caller, not here);
//   - PDF: saved in the repo and referenced by path and page count; Claude Code's Read tool reads
//     PDFs natively, page ranges included, so only what is needed enters the context;
//   - DOCX / XLSX / PPTX (and ODT): their text extracted to markdown next to the file;
//   - small text files: inline in the message; big ones, by path;
//   - anything else: saved and referenced by path.
// Stored in <repo>/.optimia/attachments/<chatId>/ (.optimia is excluded from git).

const MAX_BYTES = 30 * 1024 * 1024;
const INLINE_MAX_CHARS = 12_000;
const TEXT_EXT = new Set(
  'txt md markdown csv tsv json jsonl yaml yml toml ini xml html htm css js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp hpp cs php sh bash zsh sql log env conf cfg diff patch svg'.split(
    ' '
  )
);

function attachmentsDir(projectRoot, chatId) {
  return path.join(projectRoot, '.optimia', 'attachments', String(chatId).replace(/[^\w-]/g, '_'));
}

function safeName(name) {
  const base = path.basename(String(name || 'fichero')).replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_');
  return base.slice(-120) || 'fichero';
}

// ---------- a minimal ZIP reader (Office documents are ZIP files of XML) ----------

function readZip(buf) {
  const entries = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no es un fichero ZIP válido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.size);
      return (e.method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
  };
}

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

function docxText(zip) {
  const xml = zip.read('word/document.xml') || '';
  return xml
    .split(/<\/w:p>/)
    .map((para) => {
      const heading = /<w:pStyle w:val="(?:Heading|Ttulo|Título)?(\d)"/i.exec(para);
      const list = /<w:numPr\b/.test(para);
      const text = decode(
        para
          .replace(/<w:tab\/>/g, '\t')
          .replace(/<w:br\/>/g, '\n')
          .replace(/<[^>]+>/g, '')
      ).trim();
      if (!text) return '';
      if (heading) return `${'#'.repeat(Math.min(6, Number(heading[1])))} ${text}`;
      return list ? `- ${text}` : text;
    })
    .filter(Boolean)
    .join('\n\n');
}

function xlsxText(zip) {
  const shared = [];
  const ss = zip.read('xl/sharedStrings.xml') || '';
  for (const si of ss.split('</si>')) {
    if (!si.includes('<si')) continue;
    shared.push(decode([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
  }
  const sheets = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  return sheets
    .map((name, i) => {
      const xml = zip.read(name) || '';
      const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)]
          .map(([, attrs, inner]) => {
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '';
            const value = /t="s"/.test(attrs) ? shared[Number(v)] || '' : decode(v);
            return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
          })
          .join(',')
      );
      return `## Hoja ${i + 1}\n\n\`\`\`csv\n${rows.join('\n')}\n\`\`\``;
    })
    .join('\n\n');
}

function pptxText(zip) {
  const slides = zip.names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  return slides
    .map((name, i) => {
      const xml = zip.read(name) || '';
      const paras = xml
        .split('</a:p>')
        .map((p) => decode([...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join('')).trim())
        .filter(Boolean);
      return `## Diapositiva ${i + 1}\n\n${paras.join('\n')}`;
    })
    .join('\n\n');
}

function odtText(zip) {
  const xml = zip.read('content.xml') || '';
  return decode(
    xml
      .replace(/<\/text:(p|h)>/g, '\n\n')
      .replace(/<text:tab\/>/g, '\t')
      .replace(/<[^>]+>/g, '')
  ).trim();
}

// Pages of a PDF, counted from its page objects (approximate for unusual files).
function pdfPages(buf) {
  const text = buf.toString('latin1');
  const pages = text.match(/\/Type\s*\/Page(?!s)\b/g);
  return pages ? pages.length : null;
}

const words = (text) => (text.match(/\S+/g) || []).length;

/**
 * Saves an attachment and prepares it for the context. Returns
 * {id, name, kind, size, path, pages?, words?, extractedPath?, inline?}.
 */
function saveAttachment(projectRoot, chatId, { name, mediaType = '', data }) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw new Error('el fichero está vacío');
  if (buf.length > MAX_BYTES) throw new Error(`el fichero supera ${MAX_BYTES / 1024 / 1024} MB`);
  const dir = attachmentsDir(projectRoot, chatId);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  const file = path.join(dir, `${id}-${safeName(name)}`);
  fs.writeFileSync(file, buf);
  const ext = path.extname(file).slice(1).toLowerCase();
  const out = { id, name: safeName(name), size: buf.length, path: file, mediaType };
  const result = describe(buf, file, ext, out, mediaType);
  // Kept next to the file: the message refers to attachments by id.
  writeJsonFile(path.join(dir, `${id}.json`), result);
  return result;
}

/** The attachments of a chat by id (unknown ids are skipped). */
function loadAttachments(projectRoot, chatId, ids = []) {
  const dir = attachmentsDir(projectRoot, chatId);
  return ids
    .filter((id) => /^[0-9a-f]{12}$/.test(String(id)))
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function describe(buf, file, ext, out, mediaType) {
  if (ext === 'pdf' || mediaType === 'application/pdf') return { ...out, kind: 'pdf', pages: pdfPages(buf) };

  const office = { docx: docxText, xlsx: xlsxText, pptx: pptxText, odt: odtText }[ext];
  if (office) {
    let text = '';
    try {
      text = office(readZip(buf));
    } catch (err) {
      return { ...out, kind: 'file', error: `no se pudo extraer el texto: ${err.message}` };
    }
    const extractedPath = `${file}.md`;
    fs.writeFileSync(extractedPath, `# ${out.name}\n\n${text}\n`);
    const result = { ...out, kind: ext, words: words(text), extractedPath };
    if (text.length <= INLINE_MAX_CHARS) result.inline = text;
    return result;
  }

  if (TEXT_EXT.has(ext) || mediaType.startsWith('text/') || /json|xml|yaml/.test(mediaType)) {
    const text = buf.toString('utf8');
    const result = { ...out, kind: 'text', words: words(text) };
    if (text.length <= INLINE_MAX_CHARS) result.inline = text;
    return result;
  }
  return { ...out, kind: 'file' };
}

const KIND_LABEL = {
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  odt: 'documento',
  text: 'texto',
  file: 'fichero'
};

function human(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The text block that tells the model about the attachments (added to the user's message). */
function attachmentsPrompt(list) {
  if (!list?.length) return '';
  const lines = ['', '---', 'Ficheros adjuntos a este mensaje:'];
  const inline = [];
  for (const a of list) {
    const what = [
      KIND_LABEL[a.kind] || 'fichero',
      a.pages ? `${a.pages} páginas` : null,
      a.words ? `${a.words} palabras` : null,
      human(a.size)
    ]
      .filter(Boolean)
      .join(', ');
    if (a.inline !== undefined) {
      lines.push(`- ${a.name} (${what}): su contenido va debajo.`);
      inline.push(`### ${a.name}\n\n\`\`\`\n${a.inline}\n\`\`\``);
    } else if (a.kind === 'pdf') {
      lines.push(
        `- ${a.name} (${what}): ${a.path} — léelo con la herramienta Read${a.pages > 10 ? ', por rangos de páginas (pages), solo lo que necesites' : ''}.`
      );
    } else if (a.extractedPath) {
      lines.push(
        `- ${a.name} (${what}): texto extraído en ${a.extractedPath} (original en ${a.path}). Léelo con Read, por partes si es largo.`
      );
    } else if (a.kind === 'text') {
      lines.push(`- ${a.name} (${what}): ${a.path} — léelo con Read, por partes si es largo.`);
    } else {
      lines.push(`- ${a.name} (${what}): ${a.path}${a.error ? ` (${a.error})` : ''}.`);
    }
  }
  return [...lines, ...(inline.length ? ['', ...inline] : [])].join('\n');
}

module.exports = { saveAttachment, loadAttachments, attachmentsPrompt, readZip, pdfPages, attachmentsDir, MAX_BYTES };
