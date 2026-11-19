// Loaded before every unit test file (--import): faradia's global configuration (~/.config/faradia)
// and data go to temporary folders, so no test touches the user's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faradia-unit-'));
process.env.XDG_CONFIG_HOME = path.join(root, 'config');
process.env.XDG_DATA_HOME = path.join(root, 'data');
process.env.FARADIA_NO_UPDATE_CHECK = '1';
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
