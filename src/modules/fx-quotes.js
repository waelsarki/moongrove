import { CONFIG } from '../config.js';
import { get, run, all } from '../db/index.js';
import { id, nowIso, addSeconds, round, bpsFactor } from '../lib/util.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { dec, referenceRate, partnerFeeFor } from './fx-rates.js';

/**
 * Build an OPEN quote (plan Sec.7 pricing stack):
 *   reference rate -> margin -> partner fee -> bank fee -> customer quote
 */
export function createQuote({ customerId, sourceCurrency, targetCurrency, amount, marginBps }) {
  if (!(amount > 0)) throw badRequest('Amount must be greater than zero');

  const ref = referenceRate(sourceCurrency, targetCurrency);
  const bps = marginBps ?? CONFIG.fx.defaultMarginBps;
  // MOONGROVE's margin reduces what the customer receives: customer rate is
  // BELOW market by the markup (Sec.7: reference rate + margin -> customer quote).
  const customerRate = round(ref / bpsFactor(bps), 6);

  const partnerFee = round(partnerFeeFor(sourceCurrency), dec(sourceCurrency));
  const targetAmount = round(amount * customerRate, dec(targetCurrency));
  // Margin = market value of the source currency minus what the customer receives.
  const marginAmount = round(amount * ref - targetAmount, dec(targetCurrency));

  const quoteId = id('qte');
  const quoteRef = `Q-${Date.now().toString(36).toUpperCase().slice(-6)}`;

  run(
    `INSERT INTO fx_quotes (id, reference, customer_id, source_currency, target_currency,
      source_amount, target_amount, rate, reference_rate, margin_bps, margin_amount,
      partner_fee, bank_fee, status, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    quoteId, quoteRef, customerId ?? null, sourceCurrency, targetCurrency,
    amount, targetAmount, customerRate, ref, bps, marginAmount,
    partnerFee, 0, 'OPEN', addSeconds(nowIso(), CONFIG.fx.quoteTtlSeconds), nowIso(),
  );
  return getQuote(quoteId);
}

export function getQuote(quoteId) {
  const q = get(`SELECT * FROM fx_quotes WHERE id=? OR reference=?`, quoteId, quoteId);
  if (!q) throw notFound('Quote not found');
  return q;
}

export function attachBankFee(quoteId, bankFee, targetCurrency) {
  run(`UPDATE fx_quotes SET bank_fee=? WHERE id=?`, round(bankFee, dec(targetCurrency)), quoteId);
  return getQuote(quoteId);
}

/** Lock the rate: OPEN -> LOCKED, writing immutable rate_history. */
export function lockQuote(quoteId, paymentId) {
  const q = getQuote(quoteId);
  if (q.status === 'CONSUMED') throw conflict('Quote already consumed');
  if (q.status === 'EXPIRED') throw conflict('Quote expired');
  if (new Date(q.expires_at) < new Date()) {
    run(`UPDATE fx_quotes SET status='EXPIRED' WHERE id=?`, quoteId);
    throw conflict('Quote expired');
  }
  run(`UPDATE fx_quotes SET status='LOCKED' WHERE id=?`, quoteId);
  run(
    `INSERT INTO rate_history (id, quote_id, transaction_id, rate, reference_rate, source, locked_at)
     VALUES (?,?,?,?,?,?,?)`,
    id('rh'), quoteId, paymentId ?? null, q.rate, q.reference_rate,
    CONFIG.fx.rateSource, nowIso(),
  );
  return getQuote(quoteId);
}

export function consumeQuote(quoteId) {
  run(`UPDATE fx_quotes SET status='CONSUMED', consumed_at=? WHERE id=?`, nowIso(), quoteId);
  run(`UPDATE rate_history SET applied_at=? WHERE quote_id=? AND applied_at IS NULL`, nowIso(), quoteId);
  return getQuote(quoteId);
}

export const listRateHistory = (limit = 100) =>
  all(`SELECT * FROM rate_history ORDER BY locked_at DESC LIMIT ?`, limit);
