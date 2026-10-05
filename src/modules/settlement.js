import { CONFIG } from '../config.js';
import { get, run, all } from '../db/index.js';
import { id, nowIso, reference, round, sleep } from '../lib/util.js';
import { conflict, badRequest } from '../lib/errors.js';
import { getAdapter } from './banking/adapters.js';
import { dec } from './fx-rates.js';

/** Candidate nostro accounts for a currency, ranked by health/cost/capacity. */
export function rankBanks(currency, amount) {
  const accounts = all(
    `SELECT * FROM bank_accounts WHERE currency=? ORDER BY cost_bps ASC`, currency,
  );
  return accounts
    .map((a) => {
      const capacityLeft = a.daily_capacity - a.daily_used;
      const healthScore = a.health === 'HEALTHY' ? 100 : a.health === 'DEGRADED' ? 50 : 0;
      const capacityScore = capacityLeft > 0 ? 100 : 0;
      // Lower is better.
      const rank = -healthScore - capacityScore + a.costBps / 100 + a.wave * 0.5;
      return { ...a, capacityLeft, rank };
    })
    .filter((a) => a.capacityLeft >= amount && a.health !== 'DOWN')
    .sort((x, y) => x.rank - y.rank);
}

/**
 * Execute settlement with multi-bank failover (plan Sec.9):
 * preferred -> secondary -> next approved bank -> confirm.
 */
export async function settle({ paymentId, amount, currency, preferredBank, maxAttempts }) {
  const settlementId = id('stl');
  const settlementRef = reference('STL');
  const candidates = rankBanks(currency, amount);
  if (!candidates.length) {
    throw conflict(`No healthy bank with capacity to settle ${amount} ${currency}`);
  }

  run(
    `INSERT INTO settlements (id, reference, payment_id, amount, currency, strategy, status, attempts, preferred_bank, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    settlementId, settlementRef, paymentId, amount, currency,
    CONFIG.settlement.enableFailover ? 'FAILOVER' : 'DIRECT', 'PENDING', 0,
    preferredBank ?? candidates[0].bank_code, nowIso(),
  );

  // Order: preferred first (if viable), then ranked remainder.
  const ordered = [
    ...candidates.filter((c) => c.bank_code === preferredBank),
    ...candidates.filter((c) => c.bank_code !== preferredBank),
  ];

  const attemptLimit = Math.min(maxAttempts ?? CONFIG.settlement.maxAttemptsPerBank + 4, ordered.length);
  let attempts = 0;
  const failures = [];

  for (const account of ordered) {
    if (attempts >= attemptLimit) break;
    const adapter = getAdapter(account.bank_code);
    attempts += 1;
    const transferId = id('btx');
    const idempotencyKey = `settle:${paymentId}:${account.bank_code}`;
    const requestedAt = nowIso();

    try {
      const result = await adapter.transfer({
        paymentId, amount, currency,
        accountNumber: account.account_number,
        idempotencyKey,
      });

      run(
        `INSERT INTO bank_transfers (id, payment_id, bank_code, account_id, attempt, amount, currency, direction, provider_ref, idempotency_key, status, latency_ms, requested_at, settled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        transferId, paymentId, account.bank_code, account.id, attempts,
        amount, currency, 'OUTBOUND', result.providerRef, idempotencyKey,
        'SUCCEEDED', result.latencyMs, requestedAt, result.settledAt,
      );
      run(
        `UPDATE bank_accounts SET daily_used = daily_used + ?, balance = balance - ?, available = MAX(0, available - ?) WHERE id=?`,
        amount, amount, amount, account.id,
      );
      run(
        `UPDATE settlements SET status='SUCCEEDED', attempts=?, final_bank=?, completed_at=? WHERE id=?`,
        attempts, account.bank_code, nowIso(), settlementId,
      );
      return { settlementId, settlementRef, status: 'SUCCEEDED', bank: account.bank_code, transferId, attempts, fee: result.fee, providerRef: result.providerRef, failoverFrom: failures };
    } catch (err) {
      failures.push({ bank: account.bank_code, error: err.code ?? 'BANK_ERROR', message: err.message });
      run(
        `INSERT INTO bank_transfers (id, payment_id, bank_code, account_id, attempt, amount, currency, direction, idempotency_key, status, error_code, error_message, requested_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        transferId, paymentId, account.bank_code, account.id, attempts, amount, currency, 'OUTBOUND',
        idempotencyKey, 'FAILED', err.errorCode ?? 'BANK_ERROR', err.message, requestedAt,
      );
      // Back off before trying the next bank.
      const backoff = CONFIG.settlement.retryBackoffMs[Math.min(failures.length - 1, CONFIG.settlement.retryBackoffMs.length - 1)];
      await sleep(backoff);
    }
  }

  run(`UPDATE settlements SET status='FAILED', attempts=?, completed_at=? WHERE id=?`, attempts, nowIso(), settlementId);
  return { settlementId, settlementRef, status: 'FAILED', attempts, failures };
}

export function getSettlement(idOrRef) {
  const s = get(`SELECT * FROM settlements WHERE id=? OR reference=?`, idOrRef, idOrRef);
  if (!s) throw badRequest('Settlement not found');
  return s;
}

export const listSettlements = (limit = 100) =>
  all(`SELECT * FROM settlements ORDER BY created_at DESC LIMIT ?`, limit);
