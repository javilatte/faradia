'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickFile } = require('../../server/bridge/filePicker');

test('pickFile: platforms without a supported file dialog fail with a clear message', async () => {
  await assert.rejects(pickFile({ platform: 'win32' }), /no hay explorador de ficheros para win32/);
});
