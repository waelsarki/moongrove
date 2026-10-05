import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG } from '../src/config.js';

// Fresh database for a reproducible smoke run.
for (const suffix of ['', '-wal', '-shm']) {
  try { rmSync(`${resolve(process.cwd(), CONFIG.dbFile)}${suffix}`); } catch { /* absent */ }
}

const seed = spawn(process.execPath, ['src/seed.js'], { stdio: 'inherit' });
await new Promise((res) => seed.on('exit', res));

const port = 3100 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, ['src/server.js'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, PORT: String(port) },
});
server.stdout.on('data', () => {});
await new Promise((res) => setTimeout(res, 2500));

const smoke = spawn(process.execPath, ['scripts/smoke.js'], {
  stdio: 'inherit',
  env: { ...process.env, BASE: `http://localhost:${port}` },
});
const code = await new Promise((res) => smoke.on('exit', res));

server.kill();
process.exit(code ?? 0);
