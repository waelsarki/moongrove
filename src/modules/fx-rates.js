import { CONFIG, CURRENCIES } from '../config.js';
import { get, run, all } from '../db/index.js';
import { id, nowIso, round } from '../lib/util.js';
import { badRequest } from '../lib/errors.js';

export const dec = (code) => CURRENCIES[code]?.decimals ?? 2;

/** Indicative mid-market rates per 1 unit of base, expressed in quote. */
const SEED_RATES = {
  EUR: { NGN: 1785.5, USD: 1.0850, GBP: 0.8530 },
  USD: { NGN: 1645.0, EUR: 0.9217, GBP: 0.7860 },
  GBP: { NGN: 2093.0, USD: 1.2725, EUR: 1.1720 },
  GHS: { NGN: 218.4, USD: 0.1328, EUR: 0.1224 },
  XAF: { EUR: 0.00152, NGN: 2.7140, USD: 0.00165 },
  XOF: { EUR: 0.00152, NGN: 2.7140, USD: 0.00165 },
  NGN: { USD: 0.000608, EUR: 0.000560, GBP: 0.000478 },
};

/** Partner processing fee per currency (per transaction, in source currency). */
const PARTNER_FEES = { NGN: 100, USD: 0.6, EUR: 0.55, GBP: 0.45, GHS: 4, XAF: 250, XOF: 250 };

export const partnerFeeFor = (currency) => PARTNER_FEES[currency] ?? 0;

/** Deterministic jitter so rates breathe between polls (reproducible in tests). */
function jitter(pair, tick) {
  const seed = [...pair.join('')].reduce((a, c) => a + c.charCodeAt(0), 0);
  const amp = (seed % 7) / 10000; // up to ~0.07%
  return 1 + Math.sin((tick + seed) / 3) * amp;
}

let tickCounter = 0;

/**
 * Pull fresh rates from the approved feed and persist them.
 * Production: swap for a licensed FX/liquidity provider integration.
 */
export function refreshRates() {
  tickCounter += 1;
  const capturedAt = nowIso();
  const created = [];
  for (const [base, quotes] of Object.entries(SEED_RATES)) {
    for (const [quote, raw] of Object.entries(quotes)) {
      const rate = round(raw * jitter([base, quote], tickCounter), 6);
      run(
        `INSERT OR IGNORE INTO fx_rates (id, base_currency, quote_currency, rate, source, captured_at)
         VALUES (?,?,?,?,?,?)`,
        id('fxr'), base, quote, rate, CONFIG.fx.rateSource, capturedAt,
      );
      created.push({ base, quote, rate });
    }
  }
  return created;
}

/** Latest persisted reference rate for a direct pair, else cross via USD. */
export function referenceRate(source, target) {
  if (source === target) return 1;
  const direct = get(
    `SELECT rate FROM fx_rates WHERE base_currency=? AND quote_currency=? ORDER BY captured_at DESC LIMIT 1`,
    source, target,
  );
  if (direct) return direct.rate;
  const sUsd = get(`SELECT rate FROM fx_rates WHERE base_currency=? AND quote_currency='USD' ORDER BY captured_at DESC LIMIT 1`, source);
  const tUsd = get(`SELECT rate FROM fx_rates WHERE base_currency='USD' AND quote_currency=? ORDER BY captured_at DESC LIMIT 1`, target);
  if (sUsd && tUsd) return round(sUsd.rate / tUsd.rate, 6);
  const rev = get(
    `SELECT rate FROM fx_rates WHERE base_currency=? AND quote_currency=? ORDER BY captured_at DESC LIMIT 1`,
    target, source,
  );
  if (rev) return round(1 / rev.rate, 6);
  throw badRequest(`No FX rate available for ${source}/${target}`);
}

export const listRates = (limit = 50) =>
  all(`SELECT * FROM fx_rates ORDER BY captured_at DESC LIMIT ?`, limit);
