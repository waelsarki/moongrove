import { get, all } from '../db/index.js';
import { round } from '../lib/util.js';
import { dec } from './fx-rates.js';

/** Plan Sec.12 admin dashboard aggregates. */
export function dashboard() {
  const volumes = get(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(source_amount),0) AS source_total,
            COUNT(DISTINCT source_currency) AS currencies
     FROM payments`,
  );
  const byStatus = all(`SELECT status, COUNT(*) AS count FROM payments GROUP BY status`);
  const byCurrency = all(
    `SELECT source_currency, target_currency, COUNT(*) AS count, COALESCE(SUM(source_amount),0) AS source_total
     FROM payments GROUP BY source_currency, target_currency`,
  );
  const banks = all(
    `SELECT bank_code, COUNT(*) AS count, COALESCE(SUM(target_amount),0) AS settled
     FROM payments WHERE bank_code IS NOT NULL GROUP BY bank_code ORDER BY settled DESC`,
  );
  const fxMargin = all(
    `SELECT currency, COALESCE(SUM(credit - debit),0) AS margin
     FROM ledger_entries WHERE account_code LIKE 'FX_MARGIN_%' GROUP BY currency`,
  );
  const fees = all(
    `SELECT currency, account_code, COALESCE(SUM(debit - credit),0) AS amount
     FROM ledger_entries WHERE account_code LIKE 'BANK_FEES_%' OR account_code LIKE 'PARTNER_FEES_%'
     GROUP BY currency, account_code`,
  );
  const corridors = all(
    `SELECT market_code, COUNT(*) AS count, COALESCE(SUM(target_amount),0) AS volume
     FROM payments GROUP BY market_code ORDER BY volume DESC`,
  );
  const recon = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='MATCHED' THEN 1 ELSE 0 END) AS matched,
            SUM(CASE WHEN status IN ('PARTIAL','UNMATCHED') THEN 1 ELSE 0 END) AS breaks
     FROM recon_matches`,
  );
  const settlements = get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status='SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) AS failed
     FROM settlements`,
  );

  return { volumes, byStatus, byCurrency, banks, fxMargin, fees, corridors, recon, settlements };
}

export const transactionReport = (limit = 100) =>
  all(
    `SELECT p.reference, p.status, p.source_currency, p.source_amount, p.target_currency,
            p.target_amount, p.fees_total, p.risk_score, p.bank_code, p.created_at, p.completed_at
     FROM payments p ORDER BY p.created_at DESC LIMIT ?`, limit,
  );

export const settlementReport = (limit = 100) =>
  all(
    `SELECT s.reference, s.payment_id, s.amount, s.currency, s.status, s.attempts,
            s.preferred_bank, s.final_bank, s.created_at
     FROM settlements s ORDER BY s.created_at DESC LIMIT ?`, limit,
  );

export const bankPerformance = () =>
  all(
    `SELECT bt.bank_code,
            COUNT(*) AS attempts,
            SUM(CASE WHEN bt.status='SUCCEEDED' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN bt.status='FAILED' THEN 1 ELSE 0 END) AS failed,
            ROUND(AVG(bt.latency_ms),0) AS avg_latency_ms
     FROM bank_transfers bt GROUP BY bt.bank_code ORDER BY attempts DESC`,
  );
