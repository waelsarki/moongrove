import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG } from '../src/config.js';

const dir = resolve(process.cwd(), CONFIG.dbFile).replace(/[\\/][^\\/]+$/, '');
for (const f of ['', '-wal', '-shm']) {
  try { rmSync(`${resolve(process.cwd(), CONFIG.dbFile)}${f}`); } catch { /* absent */ }
}
console.log(`Reset: removed ${dir}`);
