import { CONFIG, CURRENCIES } from '../config.js';
import { id, nowIso, sleep, round } from '../lib/util.js';
import { badRequest, unprocessable } from '../lib/errors.js';

const dec = (c) => CURRENCIES[c]?.decimals ?? 2;

/** Luhn checksum - standard card-number validation. */
export function luhnValid(number) {
  const digits = String(number).replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Detect card brand from the IIN/BIN range. */
export function detectBrand(number) {
  const n = String(number).replace(/\D/g, '');
  if (/^4/.test(n)) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'MASTERCARD';
  if (/^(5061|50|65|636)/.test(n)) return 'VERVE';
  return 'UNKNOWN';
}

/** Validate a full card payload. Returns a normalised, non-sensitive summary. */
export function validateCard({ number, expMonth, expYear, cvv, holderName }) {
  const digits = String(number ?? '').replace(/\D/g, '');
  if (!luhnValid(digits)) throw badRequest('Card number failed validation');
  if (!CONFIG.cards.brands.includes(detectBrand(digits))) {
    throw badRequest(`Unsupported card brand; accepted: ${CONFIG.cards.brands.join(', ')}`);
  }
  const mm = Number(expMonth);
  const yy = Number(expYear);
  if (!(mm >= 1 && mm <= 12)) throw badRequest('Expiry month must be 01-12');
  const fullYear = yy < 100 ? 2000 + yy : yy;
  const now = new Date();
  if (fullYear < now.getFullYear() || (fullYear === now.getFullYear() && mm < now.getMonth() + 1)) {
    throw badRequest('Card has expired');
  }
  if (fullYear > now.getFullYear() + 20) throw badRequest('Expiry year is too far in the future');
  const expectedCvv = detectBrand(digits) === 'AMEX' ? 4 : 3;
  if (!/^\d{3,4}$/.test(String(cvv ?? ''))) throw badRequest('CVV must be 3 digits');
  if (String(cvv).length !== expectedCvv) throw badRequest(`CVV must be ${expectedCvv} digits`);

  return {
    brand: detectBrand(digits),
    last4: digits.slice(-4),
    expMonth: mm,
    expYear: fullYear,
    holderName: (holderName ?? '').trim().slice(0, 60),
  };
}

/** Mask a PAN for logs/receipts - never store the full number. */
export const maskPan = (number) => {
  const d = String(number).replace(/\D/g, '');
  return `**** **** **** ${d.slice(-4)}`;
};

/**
 * Simulated card authorisation (card-not-present).
 * Stands in for a real acquirer/PSP call. Returns an auth code on approval.
 */
export async function authoriseCard({ card, amount, currency, email }) {
  const started = Date.now();
  await sleep(CONFIG.cards.authTimeoutMs);

  const declined = Math.random() < CONFIG.cards.declineRate;
  if (declined) {
    throw unprocessable('Card declined by issuing bank', {
      declineReason: 'INSUFFICIENT_FUNDS',
      authCode: null,
    });
  }

  return {
    approved: true,
    authCode: `AUTH${id('a').slice(-8).toUpperCase()}`,
    brand: card.brand,
    last4: card.last4,
    amount: round(amount, dec(currency)),
    currency,
    authorisedAt: nowIso(),
    latencyMs: Date.now() - started,
    acquirer: 'PROTOTYPE_ACQUIRER',
    cnp: CONFIG.cards.cnp,
  };
}

/** Build a fresh authorisation for the gross charge (amount + fees). */
export async function chargeCard({ card, amount, currency, email }) {
  const result = await authoriseCard({ card, amount, currency, email });
  return {
    ...result,
    reference: `CHG-${Date.now().toString(36).toUpperCase()}`,
  };
}
