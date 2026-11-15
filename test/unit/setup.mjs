// Se carga antes de cada fichero de tests unitarios (--import): la configuración
// global de optimia (~/.config/optimia) y sus datos van a carpetas temporales, así
// ningún test toca la del usuario.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optimia-unit-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_DATA_HOME = path.join(root, 'data');
process.env.OPTIMIA_NO_UPDATE_CHECK = '1';
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
