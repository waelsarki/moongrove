import { createHmac, timingSafeEqual } from 'node:crypto';
import { CONFIG } from '../config.js';
import { get, run, all } from '../db/index.js';
import { id, nowIso } from './util.js';
import { unauthorized, forbidden, AppError } from './errors.js';

/** Sign a payload (plan Sec.13/14: webhook signature verification). */
export function sign(payload, secret = CONFIG.security.webhookSecret) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHmac(CONFIG.security.hmacAlgorithm, secret).update(body).digest('hex');
}

/** Constant-time signature comparison. */
export function verifySignature(payload, signature, secret = CONFIG.security.webhookSecret) {
  const expected = sign(payload, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Resolve API key -> principal. */
export function authenticate(req) {
  const header = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!header) throw unauthorized('Missing x-api-key header');
  const entry = Object.entries(CONFIG.apiKeys).find(([, v]) => v.key === header);
  if (!entry) throw unauthorized('Invalid API key');
  return { actor: entry[0], role: entry[1].role, label: entry[1].label };
}

/** Role-based access control (plan Sec.14). */
export function authorize(principal, ...roles) {
  if (!roles.includes(principal.role)) {
    throw forbidden(`Role ${principal.role} not permitted; requires ${roles.join('|')}`);
  }
}

export function assertCustomerAccess(principal, customerId, customer) {
  if (principal.role === 'CUSTOMER') {
    if (!customer || customer.id !== customerId) throw forbidden('Customer may only access own records');
  }
}

/** In-memory sliding-window rate limiter (plan Sec.14). */
const buckets = new Map();
export function rateLimit(key) {
  const { windowMs, max } = CONFIG.security.rateLimit;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const k = `${key}:${windowStart}`;
  const hit = buckets.get(k);
  if (hit) {
    hit.count += 1;
    if (hit.count > max) {
      const retryAfter = Math.ceil((windowStart + windowMs - now) / 1000);
      throw new AppError(429, 'RATE_LIMITED', `Rate limit exceeded; retry in ${retryAfter}s`, { retryAfter });
    }
  } else {
    buckets.set(k, { count: 1 });
  }
  if (buckets.size > 5000) {
    for (const [bk, v] of buckets) {
      if (v.windowStart && v.windowStart + windowMs < now) buckets.delete(bk);
    }
  }
}

/** Append-only audit trail (plan Sec.14: immutable audit logs). */
export function audit(principal, action, entityType, entityId, details, ip) {
  run(
    `INSERT INTO audit_log (id, actor, role, action, entity_type, entity_id, details, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id('aud'), principal?.actor ?? 'system', principal?.role ?? 'SYSTEM', action,
    entityType ?? null, entityId ?? null,
    details ? JSON.stringify(details) : null, ip ?? null, nowIso(),
  );
}

export function recentAudit(limit = 100) {
  return all(`SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?`, limit);
}
