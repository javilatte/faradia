'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const zlib = require('zlib');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { saveAttachment, loadAttachments, attachmentsPrompt, pdfPages } = require('../../server/bridge/attachments');

// A real (deflated) ZIP, like the ones Office writes.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(zlib.crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(zlib.crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function chat(t) {
  const repo = mkTmpDir('att');
  t.after(() => rmTmpDir(repo));
  return repo;
}

const b64 = (buf) => Buffer.from(buf).toString('base64');

test('docx: headings, lists and paragraphs to markdown, small enough to go inline', (t) => {
  const repo = chat(t);
  const docx = zip({
    'word/document.xml':
      '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Contrato</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Partes &amp; objeto.</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Plazo: 12 meses</w:t></w:r></w:p></w:body></w:document>'
  });
  const a = saveAttachment(repo, 'c1', { name: 'contrato.docx', data: b64(docx) });
  assert.equal(a.kind, 'docx');
  assert.equal(a.inline, '# Contrato\n\nPartes & objeto.\n\n- Plazo: 12 meses');
  assert.ok(fs.existsSync(a.extractedPath));
  const prompt = attachmentsPrompt([a]);
  assert.match(prompt, /contrato\.docx \(Word, 9 palabras, 1 KB\): su contenido va debajo/);
  assert.match(prompt, /# Contrato/);
});

test('xlsx and pptx: sheets as CSV, slides as text', (t) => {
  const repo = chat(t);
  const xlsx = zip({
    'xl/sharedStrings.xml': '<sst><si><t>Producto</t></si><si><t>Precio</t></si><si><t>Café, molido</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="s"><v>2</v></c><c><v>4.5</v></c></row></sheetData></worksheet>'
  });
  const x = saveAttachment(repo, 'c1', { name: 'precios.xlsx', data: b64(xlsx) });
  assert.match(x.inline, /## Hoja 1\n\n```csv\nProducto,Precio\n"Café, molido",4\.5\n```/);
  const pptx = zip({
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Cierre</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide1.xml':
      '<p:sld><a:p><a:r><a:t>Hola</a:t></a:r></a:p><a:p><a:r><a:t>Mundo</a:t></a:r></a:p></p:sld>'
  });
  const p = saveAttachment(repo, 'c1', { name: 'demo.pptx', data: b64(pptx) });
  assert.equal(p.inline, '## Diapositiva 1\n\nHola\nMundo\n\n## Diapositiva 2\n\nCierre');
});

test('pdf: referenced by path and pages, for Read; big text by path; others by path', (t) => {
  const repo = chat(t);
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type /Pages /Count 2>>endobj 2 0 obj<</Type /Page>>endobj 3 0 obj<</Type/Page>>endobj'
  );
  assert.equal(pdfPages(pdf), 2);
  const a = saveAttachment(repo, 'c1', { name: 'informe.pdf', mediaType: 'application/pdf', data: b64(pdf) });
  assert.equal(a.kind, 'pdf');
  assert.equal(a.pages, 2);
  assert.match(
    attachmentsPrompt([a]),
    /informe\.pdf \(PDF, 2 páginas, 1 KB\): .*informe\.pdf — léelo con la herramienta Read\./
  );

  const big = saveAttachment(repo, 'c1', { name: 'log.txt', data: b64('línea\n'.repeat(5000)) });
  assert.equal(big.inline, undefined);
  assert.match(attachmentsPrompt([big]), /log\.txt \(texto, 5000 palabras, 34 KB\): .* léelo con Read/);
  const bin = saveAttachment(repo, 'c1', { name: 'datos.bin', data: b64(Buffer.from([0, 1, 2])) });
  assert.equal(bin.kind, 'file');

  // The message refers to them by id; unknown or malformed ids are ignored.
  const loaded = loadAttachments(repo, 'c1', [a.id, big.id, 'nope', '../../etc']);
  assert.deepEqual(
    loaded.map((x) => x.name),
    ['informe.pdf', 'log.txt']
  );
  assert.throws(() => saveAttachment(repo, 'c1', { name: 'vacío.txt', data: '' }), /vacío/);
});
