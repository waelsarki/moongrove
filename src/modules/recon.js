import { get, run, all } from '../db/index.js';
import { id, nowIso, round } from '../lib/util.js';
import { notFound } from '../lib/errors.js';
import { dec } from './fx-rates.js';

/**
 * 4-way reconciliation (plan Sec.11): compare
 *   PSP amount  vs  ledger amount  vs  settlement amount  vs  bank statement.
 * Flags unmatched / partial matches into a break queue.
 */
export function reconcilePayment(paymentId) {
  const p = get(`SELECT * FROM payments WHERE id=?`, paymentId);
  if (!p) throw notFound('Payment not found');

  const settlement = p.settlement_id
    ? get(`SELECT * FROM settlements WHERE id=?`, p.settlement_id)
    : get(`SELECT * FROM settlements WHERE payment_id=? ORDER BY created_at DESC LIMIT 1`, paymentId);

  const transfer = settlement
    ? get(`SELECT * FROM bank_transfers WHERE payment_id=? AND status='SUCCEEDED' ORDER BY settled_at DESC LIMIT 1`, paymentId)
    : null;

  // Ledger side: net nostro movement for this payment in target currency,
  // excluding the separate bank-fee expense account (a fee is not part of the
  // principal payout, so it must not be compared against the settlement value).
  const ledgerRow = get(
    `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c
     FROM ledger_entries
     WHERE payment_id=? AND currency=? AND account_code LIKE 'BANK_NOSTRO_%'`,
    paymentId, p.target_currency,
  );
  const ledgerAmount = round(Math.abs(ledgerRow.c - ledgerRow.d), dec(p.target_currency));

  // Bank statement side: match on provider reference.
  const statement = transfer?.provider_ref
    ? get(`SELECT * FROM bank_statements WHERE provider_ref=?`, transfer.provider_ref)
    : null;

  const pspAmount = round(p.source_amount, dec(p.source_currency));
  const settlementAmount = settlement && settlement.status === 'SUCCEEDED'
    ? round(settlement.amount, dec(p.target_currency)) : 0;
  const statementAmount = statement ? round(statement.amount, dec(p.target_currency)) : null;

  let status = 'MATCHED';
  let breakReason = null;

  if (!settlement || settlement.status !== 'SUCCEEDED') {
    status = 'UNMATCHED';
    breakReason = 'No successful settlement found';
  } else if (statementAmount === null) {
    status = 'UNMATCHED';
    breakReason = `Bank statement line missing for provider ref ${transfer?.provider_ref ?? 'n/a'}`;
  } else if (Math.abs(statementAmount - settlementAmount) > 0.01) {
    status = Math.abs(statementAmount) < Math.abs(settlementAmount) ? 'PARTIAL' : 'UNMATCHED';
    breakReason = `Statement ${statementAmount} vs settlement ${settlementAmount}`;
  } else if (Math.abs(ledgerAmount - Math.abs(settlementAmount)) > 0.01) {
    status = 'UNMATCHED';
    breakReason = `Ledger nostro ${ledgerAmount} vs settlement ${settlementAmount}`;
  }

  const matchId = id('rec');
  run(
    `INSERT INTO recon_matches (id, payment_id, settlement_id, bank_transfer_id, psp_amount,
      ledger_amount, settlement_amount, statement_amount, status, break_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    matchId, paymentId, settlement?.id ?? null, transfer?.id ?? null, pspAmount,
    ledgerAmount, settlementAmount, statementAmount, status, breakReason, nowIso(),
  );

  return get(`SELECT * FROM recon_matches WHERE id=?`, matchId);
}

/** Import a bank statement line (normally pulled via the bank adapter). */
export function importStatementLine({ bankCode, valueDate, currency, amount, reference, providerRef }) {
  const stmtId = id('stm');
  run(
    `INSERT INTO bank_statements (id, bank_code, value_date, currency, amount, reference, provider_ref, imported_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    stmtId, bankCode, valueDate, currency, amount, reference ?? null, providerRef ?? null, nowIso(),
  );
  return get(`SELECT * FROM bank_statements WHERE id=?`, stmtId);
}

export function listMatches(limit = 100) {
  return all(`SELECT * FROM recon_matches ORDER BY created_at DESC LIMIT ?`, limit);
}

export function reconBreaks(limit = 100) {
  return all(
    `SELECT r.*, p.reference, p.source_currency, p.target_currency, p.target_amount
     FROM recon_matches r JOIN payments p ON p.id = r.payment_id
     WHERE r.status IN ('PARTIAL','UNMATCHED') ORDER BY r.created_at DESC LIMIT ?`, limit,
  );
}

export const listStatements = (limit = 100) =>
  all(`SELECT * FROM bank_statements ORDER BY imported_at DESC LIMIT ?`, limit);
