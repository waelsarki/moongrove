import { run, all, get } from '../db/index.js';
import { id, nowIso } from '../lib/util.js';
import { sign } from '../lib/security.js';
import { badRequest } from '../lib/errors.js';

/** Queue + "send" an in-app/email/sms notification. */
export function notify(customerId, channel, recipient, subject, body, payload) {
  const nid = id('ntf');
  run(
    `INSERT INTO notifications (id, customer_id, channel, recipient, subject, body, payload, status, created_at, sent_at)
     VALUES (?,?,?,?,?,?,?,'SENT',?,?)`,
    nid, customerId ?? null, channel, recipient, subject ?? null, body ?? null,
    payload ? JSON.stringify(payload) : null, nowIso(), nowIso(),
  );
  return get(`SELECT * FROM notifications WHERE id=?`, nid);
}

/** Dispatch a signed webhook (plan Sec.13/14). */
export function dispatchWebhook(event, payload, url = 'https://partner.example/webhooks/moongrove') {
  const body = { event, data: payload, timestamp: nowIso() };
  const signature = sign(body);
  const wid = id('whk');
  run(
    `INSERT INTO webhook_deliveries (id, event, url, payload, signature, status, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    wid, event, url, JSON.stringify(body), signature, 'DELIVERED', nowIso(),
  );
  return { id: wid, event, signature };
}

export const listNotifications = (customerId, limit = 50) =>
  customerId
    ? all(`SELECT * FROM notifications WHERE customer_id=? ORDER BY created_at DESC LIMIT ?`, customerId, limit)
    : all(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`, limit);

export const listWebhookDeliveries = (limit = 50) =>
  all(`SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?`, limit);
