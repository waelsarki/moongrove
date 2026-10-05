import { randomUUID, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford-ish, no I/L/O/U

/** Short, sortable-ish, human-readable id with prefix. */
export function id(prefix = 'id') {
  const t = Date.now().toString(36).toUpperCase().padStart(9, '0').slice(-9);
  let rand = '';
  const bytes = randomBytes(8);
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${t}${rand}`;
}

/** Business reference shown to humans, e.g. MGP-7K2F9QX4. */
export function reference(prefix) {
  const t = Date.now().toString(36).toUpperCase().slice(-6);
  let rand = '';
  for (const b of randomBytes(4)) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}-${t}${rand}`;
}

export const uuid = () => randomUUID();

export const nowIso = () => new Date().toISOString();

export function addSeconds(iso, seconds) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

/** Round to currency decimals (XAF/XOF are 0-decimal). */
export function round(amount, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round((amount + Number.EPSILON) * f) / f;
}

/** Basis points -> multiplier factor. 150 bps = 1.005 */
export const bpsFactor = (bps) => 1 + bps / 10_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
