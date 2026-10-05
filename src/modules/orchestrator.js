import { CONFIG, LIFECYCLE, MARKETS, TERMINAL_STATUSES } from '../config.js';
import { get, run, all } from '../db/index.js';
import { id, nowIso, reference, round, sleep } from '../lib/util.js';
import { badRequest, notFound, conflict, forbidden, unprocessable } from '../lib/errors.js';
import { createQuote, getQuote, lockQuote, consumeQuote, attachBankFee } from './fx-quotes.js';
import { dec } from './fx-rates.js';
import { getCustomer } from './kyc.js';
import { validateCard, chargeCard, maskPan } from './cards.js';
import { postJournal, ensureAccounts } from './ledger.js';
import { settle } from './settlement.js';
import { reconcilePayment } from './recon.js';
import { notify, dispatchWebhook } from './notify.js';

/** Allowed forward transitions of the lifecycle (plan Sec.8). */
const TRANSITIONS = {
  INITIATED: ['PAYMENT_PENDING', 'VERIFICATION', 'CANCELLED', 'FAILED'],
  PAYMENT_PENDING: ['PAYMENT_RECEIVED', 'FAILED', 'CANCELLED'],
  PAYMENT_RECEIVED: ['VERIFICATION', 'UNDER_REVIEW', 'FAILED'],
  VERIFICATION: ['FX_QUOTED', 'UNDER_REVIEW', 'FAILED'],
  FX_QUOTED: ['FX_CONVERTED', 'UNDER_REVIEW', 'FAILED', 'EXPIRED'],
  FX_CONVERTED: ['SETTLEMENT_PENDING', 'FAILED'],
  SETTLEMENT_PENDING: ['SETTLED', 'FAILED'],
  SETTLED: ['RECONCILED'],
  RECONCILED: ['COMPLETED'],
  UNDER_REVIEW: ['VERIFICATION', 'FX_QUOTED', 'FAILED', 'CANCELLED'],
};

export function transition(paymentId, toStatus, { reason, actor } = {}) {
  const p = getPayment(paymentId);
  if (TERMINAL_STATUSES.includes(p.status)) {
    throw conflict(`Payment already terminal in ${p.status}`);
  }
  const allowed = TRANSITIONS[p.status] ?? [];
  if (!allowed.includes(toStatus)) {
    throw conflict(`Illegal transition ${p.status} -> ${toStatus}`, { allowed });
  }
  run(
    `UPDATE payments SET status=?, updated_at=?, completed_at=? WHERE id=?`,
    toStatus, nowIso(), toStatus === LIFECYCLE.COMPLETED ? nowIso() : p.completed_at, paymentId,
  );
  run(
    `INSERT INTO payment_events (id, payment_id, from_status, to_status, reason, actor, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    id('evt'), paymentId, p.status, toStatus, reason ?? null, actor ?? 'system', nowIso(),
  );
  return getPayment(paymentId);
}

export function getPayment(idOrRef) {
  const p = get(
    `SELECT * FROM payments WHERE id=? OR reference=? OR idempotency_key=?`,
    idOrRef, idOrRef, idOrRef,
  );
  if (!p) throw notFound('Payment not found');
  return p;
}

export const paymentTimeline = (paymentId) =>
  all(`SELECT * FROM payment_events WHERE payment_id=? ORDER BY created_at, rowid`, paymentId);

/**
 * Anonymous transaction guardrails. With no customer identity there is nothing
 * to screen against, so this only enforces platform exposure limits.
 */
function assessGuestTransaction(p) {
  const asNgn = p.target_amount;
  const reasons = [];
  if (asNgn > CONFIG.guestCheckout.maxSingleTxn) {
    reasons.push(`Exceeds maximum single payment of ${CONFIG.guestCheckout.maxSingleTxn} NGN`);
  }
  if (asNgn > CONFIG.guestCheckout.maxSingleTxn * 0.5) {
    reasons.push('Large anonymous transaction');
  }
  return {
    decision: reasons.length ? 'DECLINE' : 'APPROVE',
    score: reasons.length ? 70 : 0,
    reason: reasons.join('; ') || 'Within anonymous payment limits',
  };
}

/**
 * Authorise the customer's card for the gross charge (amount + fees).
 * Only the brand, last 4 and auth code are persisted - never the PAN.
 */
export async function authorisePaymentCard(paymentId, cardDetails, actor) {
  const p = getPayment(paymentId);
  if (p.payment_method !== 'CARD') throw badRequest('Payment method is not CARD');

  const card = validateCard(cardDetails);
  const charge = await chargeCard({
    card,
    amount: p.grand_total,
    currency: p.source_currency,
    email: p.guest_email,
  });

  run(
    `UPDATE payments SET card_brand=?, card_last4=?, card_auth_code=? WHERE id=?`,
    charge.brand, charge.last4, charge.authCode, p.id,
  );
  run(
    `INSERT INTO payment_events (id, payment_id, from_status, to_status, reason, actor, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    id('evt'), p.id, p.status, p.status,
    `Card authorised: ${maskPan(cardDetails.number)} (${charge.brand}) auth ${charge.authCode}`,
    actor?.actor ?? 'guest', nowIso(),
  );
  return { payment: getPayment(p.id), charge, card };
}

/**
 * Create a guest payment (plan Sec.8 from INITIATED).
 * No customer registration or KYC is required. `customerId` is optional; when
 * supplied the account must not be rejected.
 * Idempotency: replaying the same key returns the original payment (Sec.13/20).
 */
export function initiatePayment({ customerId, guestEmail, guestName, marketCode, sourceAmount, paymentMethod, idempotencyKey, actor }) {
  if (customerId) {
    const customer = getCustomer(customerId);
    if (customer.status === 'REJECTED') throw forbidden('Account rejected by compliance');
  } else if (!CONFIG.guestCheckout.enabled) {
    throw forbidden('Guest checkout is disabled');
  }

  if (idempotencyKey) {
    const existing = get(`SELECT * FROM payments WHERE idempotency_key=?`, idempotencyKey);
    if (existing) return { payment: existing, idempotentReplay: true };
  }

  const market = MARKETS.find((m) => m.code === marketCode && m.enabled);
  if (!market) throw badRequest(`Unsupported market ${marketCode}`);
  if (!(sourceAmount > 0)) throw badRequest('sourceAmount must be > 0');
  if (!market.corridors.includes('NGN')) throw badRequest(`Market ${marketCode} has no NGN corridor`);

  const quote = createQuote({
    customerId: customerId ?? null,
    sourceCurrency: market.localCurrency,
    targetCurrency: 'NGN',
    amount: sourceAmount,
  });

  const feesTotal = round(quote.partner_fee + quote.bank_fee, dec(market.localCurrency));
  const grandTotal = round(sourceAmount + feesTotal, dec(market.localCurrency));
  const pid = id('pay');
  const ts = nowIso();

  run(
    `INSERT INTO payments (id, reference, customer_id, guest_email, guest_name, idempotency_key,
      market_code, source_currency, target_currency, source_amount, target_amount, fees_total,
      grand_total, quote_id, payment_method, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid, reference('PAY'), customerId ?? null, guestEmail ?? null, guestName ?? null,
    idempotencyKey ?? null, market.code, market.localCurrency, 'NGN', sourceAmount,
    quote.target_amount, feesTotal, grandTotal, quote.id, paymentMethod ?? 'CARD',
    LIFECYCLE.INITIATED, ts, ts,
  );
  run(
    `INSERT INTO payment_events (id, payment_id, from_status, to_status, reason, actor, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    id('evt'), pid, null, LIFECYCLE.INITIATED, 'Payment created', actor?.actor ?? 'guest', ts,
  );

  return { payment: getPayment(pid), quote, idempotentReplay: false };
}

/** PAYMENT_PENDING -> PAYMENT_RECEIVED; post customer-cash journal. */
export async function confirmFundsReceived(paymentId, actor) {
  const p = getPayment(paymentId);
  const src = p.source_currency;
  ensureAccounts(src);
  const quote = getQuote(p.quote_id);

  // Dr Partner clearing (cash in) / Cr Customer payable (we owe them).
  postJournal({
    paymentId: p.id,
    narration: `Customer funds received for ${p.reference}`,
    lines: [
      { account: `PARTNER_CLEARING_${src}`, currency: src, debit: p.source_amount, narration: 'Cash received from customer' },
      { account: `CUSTOMER_PAYABLE_${src}`, currency: src, credit: p.source_amount, narration: 'Owed to customer' },
    ],
  });

  transition(p.id, LIFECYCLE.PAYMENT_RECEIVED, { reason: 'Funds received', actor: actor?.actor });
  await sleep(10);
  return transition(p.id, LIFECYCLE.VERIFICATION, { reason: 'Payment verified', actor: actor?.actor });
}

/**
 * VERIFICATION -> FX_QUOTED -> FX_CONVERTED.
 * Locks the rate (immutably) and posts conversion + margin journals.
 */
export function convertFx(paymentId, actor) {
  const p = getPayment(paymentId);
  const src = p.source_currency;
  const tgt = p.target_currency;
  ensureAccounts(src);
  ensureAccounts(tgt);

  // Lightweight guardrails only - no identity/KYC screening on guest checkout.
  const risk = assessGuestTransaction(p);
  run(`UPDATE payments SET risk_score=?, risk_decision=? WHERE id=?`, risk.score, risk.decision, p.id);
  if (risk.decision !== 'APPROVE') {
    transition(p.id, LIFECYCLE.UNDER_REVIEW, {
      reason: `Auto-declined: ${risk.reason}`, actor: actor?.actor,
    });
    return { payment: getPayment(p.id), underReview: true, declined: true, risk };
  }

  const locked = lockQuote(p.quote_id, p.id);
  transition(p.id, LIFECYCLE.FX_QUOTED, { reason: `Rate locked ${locked.rate}`, actor: actor?.actor });

  // Source side: extinguish customer payable, book FX position out.
  postJournal({
    paymentId: p.id,
    narration: `FX conversion ${p.source_amount} ${src} -> ${locked.target_amount} ${tgt}`,
    lines: [
      { account: `CUSTOMER_PAYABLE_${src}`, currency: src, debit: p.source_amount, narration: 'Extinguish customer payable (source)' },
      { account: `FX_POSITION_${src}`, currency: src, credit: p.source_amount, narration: 'FX position out (source)' },
    ],
  });

  // Target side: Dr FX position (NGN equivalent acquired), credit margin and
  // fees as revenue, and recognise the customer principal as a NGN payable
  // which is then extinguished when settlement pays out.
  const partnerFeeTgt = locked.partner_fee > 0 ? round(locked.partner_fee * locked.rate, dec(tgt)) : 0;
  const principalTgt = round(locked.target_amount - locked.margin_amount - partnerFeeTgt, dec(tgt));
  const targetLines = [
    { account: `FX_POSITION_${tgt}`, currency: tgt, debit: locked.target_amount, narration: 'FX position in (target)' },
    { account: `CUSTOMER_PAYABLE_${tgt}`, currency: tgt, credit: principalTgt, narration: 'Principal owed to customer (NGN)' },
  ];
  if (locked.margin_amount > 0) {
    targetLines.push({ account: `FX_MARGIN_${tgt}`, currency: tgt, credit: locked.margin_amount, narration: 'MOONGROVE FX margin' });
  }
  if (partnerFeeTgt > 0) {
    targetLines.push({ account: `PARTNER_FEES_${tgt}`, currency: tgt, credit: partnerFeeTgt, narration: 'Partner processing fee' });
  }
  postJournal({ paymentId: p.id, narration: `FX conversion (target) for ${p.reference}`, lines: targetLines });
  consumeQuote(p.quote_id);

  transition(p.id, LIFECYCLE.FX_CONVERTED, { reason: 'FX converted', actor: actor?.actor });
  return { payment: getPayment(p.id), quote: locked, risk };
}

/** FX_CONVERTED -> SETTLEMENT_PENDING -> SETTLED (with bank failover). */
export async function executeSettlement(paymentId, actor) {
  const p = getPayment(paymentId);
  const tgt = p.target_currency;
  ensureAccounts(tgt);

  transition(p.id, LIFECYCLE.SETTLEMENT_PENDING, { reason: 'Settlement requested', actor: actor?.actor });

  const result = await settle({
    paymentId: p.id,
    amount: p.target_amount,
    currency: tgt,
  });

  if (result.status !== 'SUCCEEDED') {
    transition(p.id, LIFECYCLE.FAILED, {
      reason: `Settlement failed across ${result.attempts} attempts`,
      actor: actor?.actor,
    });
    return { settlement: result, payment: getPayment(p.id), success: false };
  }

  // Bank nostro out / customer payable out. The bank fee is a separate journal.
  const fee = result.fee ?? 0;
  postJournal({
    paymentId: p.id,
    narration: `Settlement ${result.settlementRef} via ${result.bank}`,
    lines: [
      { account: `CUSTOMER_PAYABLE_${tgt}`, currency: tgt, debit: p.target_amount, narration: 'Settle to customer (NGN)' },
      { account: `BANK_NOSTRO_${tgt}`, currency: tgt, credit: p.target_amount, narration: `Payout via ${result.bank}` },
    ],
  });

  if (fee > 0) {
    // The bank deducts its charge from the funded amount, so recognise it as an
    // expense against a fees-payable rather than crediting nostro again.
    postJournal({
      paymentId: p.id,
      narration: `Bank fee for ${result.bank}`,
      lines: [
        { account: `BANK_FEES_${tgt}`, currency: tgt, debit: fee, narration: 'Bank charge' },
        { account: `PARTNER_FEES_${tgt}`, currency: tgt, credit: fee, narration: 'Fee payable to bank' },
      ],
    });
  }

  run(`UPDATE payments SET settlement_id=?, bank_code=? WHERE id=?`, result.settlementId, result.bank, p.id);
  transition(p.id, LIFECYCLE.SETTLED, {
    reason: `Settled via ${result.bank}${result.failoverFrom?.length ? ` after failover from ${result.failoverFrom.map((f) => f.bank).join(', ')}` : ''}`,
    actor: actor?.actor,
  });
  return { settlement: result, payment: getPayment(p.id), success: true };
}

/** SETTLED -> RECONCILED -> COMPLETED, with customer receipt. */
export function completeReconciliation(paymentId, actor) {
  const p = getPayment(paymentId);

  const match = reconcilePayment(p.id);
  if (match.status !== 'MATCHED') {
    return { payment: getPayment(p.id), match, completed: false };
  }

  transition(p.id, LIFECYCLE.RECONCILED, {
    reason: `4-way match OK (${match.status})`, actor: actor?.actor,
  });

  // Receipt goes to the registered account, or the guest email if provided.
  const email = p.customer_id ? getCustomer(p.customer_id).email : p.guest_email;
  if (email) {
    notify(p.customer_id ?? null, 'EMAIL', email, `Payment ${p.reference} completed`,
      `You received ${p.target_amount} ${p.target_currency} for your ${p.source_amount} ${p.source_currency} payment.`,
      { paymentId: p.id });
  }
  dispatchWebhook('payment.completed', {
    paymentId: p.id, reference: p.reference, targetAmount: p.target_amount,
    currency: p.target_currency, bank: p.bank_code,
  });

  transition(p.id, LIFECYCLE.COMPLETED, { reason: 'Reconciled and completed', actor: actor?.actor });
  return { payment: getPayment(p.id), match, completed: true };
}

/**
 * End-to-end orchestrated run: card authorisation -> funds -> FX -> settlement
 * -> reconciliation -> completion.
 */
export async function processPayment(paymentId, actor, cardDetails) {
  transition(paymentId, LIFECYCLE.PAYMENT_PENDING, { reason: 'Awaiting card payment', actor: actor?.actor });

  let charge = null;
  if (cardDetails) {
    try {
      ({ charge } = await authorisePaymentCard(paymentId, cardDetails, actor));
    } catch (err) {
      transition(paymentId, LIFECYCLE.FAILED, {
        reason: `Card authorisation failed: ${err.message}`, actor: actor?.actor,
      });
      run(`UPDATE payments SET failure_reason=? WHERE id=?`, err.message, paymentId);
      return { payment: getPayment(paymentId), stage: 'CARD_DECLINED', error: err.message };
    }
  }

  await confirmFundsReceived(paymentId, actor);
  const fx = convertFx(paymentId, actor);
  if (fx.underReview) return { payment: fx.payment, stage: fx.declined ? 'DECLINED' : 'UNDER_REVIEW', risk: fx.risk, charge };
  const st = await executeSettlement(paymentId, actor);
  if (!st.success) return { payment: st.payment, stage: 'SETTLEMENT_FAILED', charge };
  const rc = completeReconciliation(paymentId, actor);
  return { payment: rc.payment, stage: rc.completed ? 'COMPLETED' : 'RECON_BREAK', match: rc.match, charge };
}

export const listPayments = (limit = 100) =>
  all(`SELECT * FROM payments ORDER BY created_at DESC LIMIT ?`, limit);



