import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONFIG } from '../config.js';
import { SCHEMA_CORE } from './schema-core.js';
import { SCHEMA_OPS } from './schema-ops.js';

const dbPath = resolve(process.cwd(), CONFIG.dbFile);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

/** Query helpers ------------------------------------------------------- */
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

/** Run fn inside a transaction; rolls back on throw. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* noop */ }
    throw err;
  }
}

/** Apply schema for all modules (idempotent). */
export function migrate() {
  db.exec(SCHEMA_CORE);
  db.exec(SCHEMA_OPS);
}

export function close() {
  try { db.close(); } catch { /* already closed */ }
}
