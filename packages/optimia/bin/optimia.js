#!/usr/bin/env node
'use strict';

// optimia is now Faradia: this command runs Faradia and says so once per run.
const quiet = process.argv.some((a) => ['-V', '--version', '-h', '--help'].includes(a));
if (!quiet) {
  process.stderr.write(
    'optimia ahora se llama Faradia. Cambia cuando quieras con: npm i -g faradia (y después ejecuta faradia).\n' +
      'Este paquete seguirá recibiendo actualizaciones unos meses más.\n\n'
  );
}
require('faradia/bin/faradia');
