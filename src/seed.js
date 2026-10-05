import { migrate, run, get, all, close } from './db/index.js';
import { CURRENCIES, CONFIG, PAYMENT_METHODS } from './config.js';
import { id, nowIso, round } from './lib/util.js';
import { refreshRates } from './modules/fx-rates.js';
import { ensureAccounts } from './modules/ledger.js';
import { registerCustomer } from './modules/kyc.js';

migrate();

// ---- Ledger chart of accounts for every supported currency (plan Sec.11) ----
for (const code of Object.keys(CURRENCIES)) ensureAccounts(code);

// ---- Bank settlement accounts (plan Sec.4/9) ----
const SETTLEMENT_BALANCE = { NGN: 500_000_000, USD: 2_000_000, EUR: 1_000_000, GBP: 500_000, XOF: 200_000_000, XAF: 100_000_000 };
const CAPACITY = { NGN: 250_000_000, USD: 1_000_000, EUR: 500_000, GBP: 250_000, XOF: 100_000_000, XAF: 50_000_000 };
const COST_BPS = { PROVIDUS: 45, ACCESS: 42, UBA: 48, GTBANK: 44, ZENITH: 43, FIRSTBANK: 50, ECOBANK: 47, JAIZ: 52, STERLING: 46 };

const MATRIX = {
  PROVIDUS: ['NGN', 'USD', 'GBP'], ACCESS: ['NGN', 'USD', 'EUR'], UBA: ['NGN', 'USD', 'EUR', 'GBP', 'GHS'],
  GTBANK: ['NGN', 'USD', 'EUR'], ZENITH: ['NGN', 'USD', 'GBP'], FIRSTBANK: ['NGN'],
  ECOBANK: ['NGN', 'USD', 'EUR', 'XOF', 'XAF'], JAIZ: ['NGN'], STERLING: ['NGN', 'USD'],
};

let acctCount = 0;
for (const [bankCode, currencies] of Object.entries(MATRIX)) {
  for (const currency of currencies) {
    if (get(`SELECT id FROM bank_accounts WHERE bank_code=? AND currency=?`, bankCode, currency)) continue;
    run(
      `INSERT INTO bank_accounts (id, bank_code, currency, account_number, balance, available,
        health, daily_capacity, daily_used, cost_bps, settlement_days, created_at)
       VALUES (?,?,?,?,?,?,'HEALTHY',?,0,?,'T+0',?)`,
      id('bac'), bankCode, currency, `${bankCode.slice(0, 3)}${100000000 + acctCount}`,
      SETTLEMENT_BALANCE[currency] ?? 0, SETTLEMENT_BALANCE[currency] ?? 0,
      CAPACITY[currency] ?? 1_000_000, COST_BPS[bankCode] ?? 45, nowIso(),
    );
    acctCount += 1;
  }
}

// ---- Seed FX rates ----
refreshRates();

// ---- Demo customers are NOT required: checkout is guest/card-only ----
// Optional demo account retained for admin-side reporting tests.
if (!get(`SELECT id FROM customers WHERE email=?`, 'demo.admin@moongrove.test')) {
  registerCustomer({
    type: 'BUSINESS', fullName: 'MOONGROVE Operations',
    email: 'demo.admin@moongrove.test', country: 'NG',
  });
}

const stats = {
  bankAccounts: get(`SELECT COUNT(*) AS n FROM bank_accounts`).n,
  ledgerAccounts: get(`SELECT COUNT(*) AS n FROM ledger_accounts`).n,
  fxRates: get(`SELECT COUNT(*) AS n FROM fx_rates`).n,
  paymentMethods: PAYMENT_METHODS.length,
  supportedCards: CONFIG.cards.brands.join(', '),
};

console.log('Seed complete:', stats);
close();
