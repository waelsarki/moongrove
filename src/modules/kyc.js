import { CONFIG } from '../config.js';
import { get, run, all } from '../db/index.js';
import { id, nowIso, reference } from '../lib/util.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { referenceRate } from './fx-rates.js';

/** Simulated watchlists (plan Sec.10). */
const SANCTIONS_LIST = new Set(['ivan petrov', 'ahmed al-khatib', 'denis volkov']);
const PEP_LIST = new Set('adebayo ogundipe,maria dos santos,oliver grant'.split(','));
const HIGH_RISK_COUNTRIES = new Set(['NG', 'IR', 'KP', 'SY', 'RU', 'BY']);

export function logCheck(customerId, checkType, status, provider, hits, details) {
  run(
    `INSERT INTO kyc_checks (id, customer_id, check_type, status, provider, hits, details, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id('kyc'), customerId, checkType, status, provider, hits ?? 0,
    details ? JSON.stringify(details) : null, nowIso(),
  );
}

/** Identity + sanctions + PEP + geography checks -> risk score & band. */
export function runScreening(customerId) {
  const c = getCustomer(customerId);
  const name = c.full_name.toLowerCase();
  let score = 0;

  const identityComplete = Boolean(c.full_name && c.email && c.country);
  logCheck(customerId, 'IDENTITY', identityComplete ? 'CLEAR' : 'FAIL', 'MOONGROVE_IDV',
    identityComplete ? 0 : 1, { email: c.email, country: c.country });
  if (!identityComplete) score += 35;

  const sanctionsHit = [...SANCTIONS_LIST].some((n) => name.includes(n));
  logCheck(customerId, 'SANCTIONS', sanctionsHit ? 'FAIL' : 'CLEAR', 'SANCTIONS_FEED',
    sanctionsHit ? 1 : 0, { matched: sanctionsHit });
  if (sanctionsHit) score += 60;

  const pepHit = [...PEP_LIST].some((n) => name === n);
  logCheck(customerId, 'PEP', pepHit ? 'REVIEW' : 'CLEAR', 'PEP_FEED', pepHit ? 1 : 0, { matched: pepHit });
  if (pepHit) score += 30;

  if (HIGH_RISK_COUNTRIES.has(c.country)) {
    score += 20;
    logCheck(customerId, 'GEOGRAPHY', 'REVIEW', 'INTERNAL', 1, { country: c.country });
  } else {
    logCheck(customerId, 'GEOGRAPHY', 'CLEAR', 'INTERNAL', 0, { country: c.country });
  }

  if (c.type === 'BUSINESS') score += 10;

  score = Math.min(score, 100);
  const sanctionsClear = !sanctionsHit;
  // PEP matches always require manual review, regardless of total score.
  const decision = sanctionsHit ? 'DECLINE' : pepHit ? 'REVIEW' : (score < 40 ? 'APPROVE' : 'REVIEW');
  return {
    riskScore: score,
    riskBand: score < 30 ? 'LOW' : score < 60 ? 'MEDIUM' : 'HIGH',
    sanctionsClear,
    pepHit,
    kycStatus: sanctionsHit ? 'FAILED' : pepHit ? 'REVIEW' : 'VERIFIED',
    decision,
  };
}

/** Register a customer and run onboarding KYC (plan Sec.10). */
export function registerCustomer({ type, fullName, email, phone, country }) {
  if (!fullName || !email || !country) throw badRequest('fullName, email and country are required');
  if (!['INDIVIDUAL', 'BUSINESS'].includes(type)) throw badRequest('type must be INDIVIDUAL or BUSINESS');
  if (get(`SELECT id FROM customers WHERE email=?`, email)) throw conflict('Email already registered');

  const cid = id('cus');
  const ts = nowIso();
  run(
    `INSERT INTO customers (id, reference, type, full_name, email, phone, country, status, kyc_status, risk_score, risk_band, kyc_level, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'PENDING','PENDING',0,'UNKNOWN',0,?,?)`,
    cid, reference('CUS'), type, fullName, email, phone ?? null, country, ts, ts,
  );

  const s = runScreening(cid);
  const status = s.decision === 'DECLINE' ? 'REJECTED'
    : s.decision === 'APPROVE' ? 'ACTIVE' : 'PENDING_REVIEW';
  run(
    `UPDATE customers SET status=?, kyc_status=?, risk_score=?, risk_band=?, kyc_level=?, updated_at=? WHERE id=?`,
    status, s.kycStatus, s.riskScore, s.riskBand, type === 'BUSINESS' ? 2 : 1, ts, cid,
  );
  return getCustomer(cid);
}

/** Transaction-level risk + velocity/limit monitoring (plan Sec.10). */
export function assessTransaction({ customerId, amount, currency }) {
  const c = getCustomer(customerId);
  if (c.status === 'REJECTED') return { decision: 'DECLINE', score: 100, reason: 'Customer rejected by compliance' };
  if (c.status === 'PENDING_REVIEW') return { decision: 'REVIEW', score: 50, reason: 'KYC pending manual review' };

  const limit = c.type === 'BUSINESS' ? CONFIG.kyc.limits.business : CONFIG.kyc.limits.individual;
  // Normalise to NGN using the real reference rate (not a fixed multiplier),
  // so limits are applied on true economic value across all currencies.
  let asNgn = amount;
  if (currency !== 'NGN') {
    try { asNgn = amount * referenceRate(currency, 'NGN'); }
    catch { asNgn = amount * 1600; } // fallback if no rate available
  }
  const today = new Date().toISOString().slice(0, 10);
  const daily = get(
    `SELECT COALESCE(SUM(target_amount),0) AS t FROM payments
     WHERE customer_id=? AND created_at LIKE ? AND status NOT IN ('FAILED','CANCELLED')`,
    customerId, `${today}%`,
  );

  let score = c.risk_score ?? 0;
  const reasons = [];
  if (asNgn > limit.singleTxn) { score += 40; reasons.push('Exceeds single-transaction limit'); }
  if (daily.t + asNgn > limit.dailyTotal) { score += 45; reasons.push('Exceeds daily cumulative limit'); }
  if (asNgn > limit.singleTxn * 0.5) { score += 10; reasons.push('Large transaction monitoring'); }

  score = Math.min(score, 100);
  return {
    decision: score >= 70 ? 'DECLINE' : score >= 30 ? 'REVIEW' : 'APPROVE',
    score,
    reason: reasons.join('; ') || 'Within risk appetite',
    dailyUsed: daily.t,
  };
}

export function getCustomer(idOrRef) {
  const c = get(`SELECT * FROM customers WHERE id=? OR reference=?`, idOrRef, idOrRef);
  if (!c) throw notFound('Customer not found');
  return c;
}

export const listCustomers = (limit = 100) =>
  all(`SELECT * FROM customers ORDER BY created_at DESC LIMIT ?`, limit);

export const listKycChecks = (customerId) =>
  all(`SELECT * FROM kyc_checks WHERE customer_id=? ORDER BY created_at DESC`, customerId);

export function manualReview(customerId, decision, actor) {
  const status = decision === 'APPROVE' ? 'ACTIVE' : decision === 'REJECT' ? 'REJECTED' : 'PENDING_REVIEW';
  run(`UPDATE customers SET status=?, updated_at=? WHERE id=?`, status, nowIso(), customerId);
  logCheck(customerId, 'MANUAL_REVIEW', decision, actor?.actor ?? 'compliance', 0, { decision });
  return getCustomer(customerId);
}

export const reviewQueue = () =>
  all(`SELECT * FROM customers WHERE status IN ('PENDING_REVIEW','PENDING') ORDER BY risk_score DESC`);
