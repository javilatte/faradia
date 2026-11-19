'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTmpDir, rmTmpDir } = require('./helpers');
const { listFilesModifiedSince, resolveInside, readPreview, openWithSystem } = require('../../server/bridge/taskFiles');

test('listFilesModifiedSince: includes files ignored by git and skips dependencies', (t) => {
  const dir = mkTmpDir('taskfiles-list');
  t.after(() => rmTmpDir(dir));
  const since = Date.now() - 1000;
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'seo.docx'), 'x');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'a.js'), 'x');
  assert.deepEqual(listFilesModifiedSince(dir, since), ['docs/seo.docx']);
});

test('listFilesModifiedSince: build output is skipped when git ignores it, real files in a folder named build are not', (t) => {
  const dir = mkTmpDir('taskfiles-build');
  t.after(() => rmTmpDir(dir));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
  const since = Date.now() - 1000;
  for (const rel of ['dist/app.js', 'src/build/config.ts', 'coverage/index.html']) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'x');
  }
  const listed = listFilesModifiedSince(dir, since);
  assert.ok(!listed.includes('dist/app.js'), 'ignored build output');
  assert.ok(listed.includes('src/build/config.ts'), 'a real file of the task');
  assert.ok(listed.includes('coverage/index.html'), 'not ignored: the task may have meant it');
});

test('resolveInside: does not allow leaving the worktree', (t) => {
  const dir = mkTmpDir('taskfiles-resolve');
  t.after(() => rmTmpDir(dir));
  fs.writeFileSync(path.join(dir, 'a.md'), 'hola');
  assert.ok(resolveInside(dir, 'a.md'));
  assert.equal(resolveInside(dir, '../a.md'), null);
  assert.equal(resolveInside(dir, '/etc/passwd'), null);
  assert.equal(resolveInside(dir, 'no-existe.md'), null);
});

test('readPreview: plain text and html; unsupported types are flagged', (t) => {
  const dir = mkTmpDir('taskfiles-preview');
  t.after(() => rmTmpDir(dir));
  fs.writeFileSync(path.join(dir, 'a.md'), '# hola');
  fs.writeFileSync(path.join(dir, 'b.html'), '<p>x</p>');
  fs.writeFileSync(path.join(dir, 'c.bin'), 'x');
  assert.deepEqual(readPreview(path.join(dir, 'a.md')), { kind: 'text', content: '# hola' });
  assert.deepEqual(readPreview(path.join(dir, 'b.html')), { kind: 'html', content: '<p>x</p>' });
  assert.equal(readPreview(path.join(dir, 'c.bin')).kind, 'unsupported');
});

test('readPreview: extracts the text of a docx', (t) => {
  const dir = mkTmpDir('taskfiles-docx');
  t.after(() => rmTmpDir(dir));
  fs.mkdirSync(path.join(dir, 'word'));
  fs.writeFileSync(
    path.join(dir, 'word', 'document.xml'),
    '<w:document><w:body><w:p><w:r><w:t>Hola &amp; adios</w:t></w:r></w:p></w:body></w:document>'
  );
  try {
    execFileSync('zip', ['-q', '-r', 'doc.docx', 'word'], { cwd: dir });
  } catch {
    return t.skip('zip no disponible');
  }
  const preview = readPreview(path.join(dir, 'doc.docx'));
  assert.equal(preview.kind, 'text');
  assert.match(preview.content, /Hola & adios/);
});

test('openWithSystem: unsupported platforms fail with a clear message', async () => {
  await assert.rejects(openWithSystem('/tmp/x', { platform: 'win32' }), /no hay forma de abrir ficheros en win32/);
});
