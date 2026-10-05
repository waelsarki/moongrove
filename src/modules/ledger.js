import { ACCOUNT_TYPES, CURRENCIES } from '../config.js';
import { get, run, all, tx } from '../db/index.js';
import { id, nowIso, reference, round } from '../lib/util.js';
import { conflict, badRequest } from '../lib/errors.js';

const dec = (c) => CURRENCIES[c]?.decimals ?? 2;

/** Create the chart of accounts for a currency (plan Sec.11). */
export function ensureAccounts(currency) {
  const specs = [
    [`CUSTOMER_RECEIVABLE_${currency}`, `Customer receivable (${currency})`, ACCOUNT_TYPES.CUSTOMER_RECEIVABLE, currency],
    [`CUSTOMER_PAYABLE_${currency}`, `Customer payable (${currency})`, ACCOUNT_TYPES.CUSTOMER_PAYABLE, currency],
    [`FX_POSITION_${currency}`, `FX position (${currency})`, ACCOUNT_TYPES.FX_POSITION, currency],
    [`FX_MARGIN_${currency}`, `FX margin revenue (${currency})`, ACCOUNT_TYPES.FX_MARGIN, currency],
    [`PARTNER_CLEARING_${currency}`, `Partner clearing (${currency})`, ACCOUNT_TYPES.PARTNER_CLEARING, currency],
    [`BANK_NOSTRO_${currency}`, `Bank nostro (${currency})`, ACCOUNT_TYPES.BANK_NOSTRO, currency],
    [`BANK_FEES_${currency}`, `Bank fees (${currency})`, ACCOUNT_TYPES.BANK_FEES, currency],
    [`PARTNER_FEES_${currency}`, `Partner fees (${currency})`, ACCOUNT_TYPES.PARTNER_FEES, currency],
    [`SUSPENSE_${currency}`, `Suspense / recon breaks (${currency})`, ACCOUNT_TYPES.SUSPENSE, currency],
  ];
  for (const [code, name, type, cur] of specs) {
    run(
      `INSERT OR IGNORE INTO ledger_accounts (code, name, type, currency, created_at) VALUES (?,?,?,?,?)`,
      code, name, type, cur, nowIso(),
    );
  }
}

export function listAccounts() {
  return all(`SELECT * FROM ledger_accounts ORDER BY currency, type, code`);
}

/**
 * Post a balanced double-entry journal.
 * lines: [{ account, currency, debit, credit, narration }]
 * Enforces: per-currency debits === credits, no empty journals, valid accounts.
 */
export function postJournal({ narration, paymentId, reference: refOverride, lines }) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw badRequest('A journal requires at least two lines');
  }
  const normalized = lines.map((l) => {
    const debit = round(Number(l.debit) || 0, dec(l.currency));
    const credit = round(Number(l.credit) || 0, dec(l.currency));
    if (debit < 0 || credit < 0) throw badRequest('Ledger amounts cannot be negative');
    if (debit > 0 && credit > 0) throw badRequest('A line cannot be both debit and credit');
    return { ...l, debit, credit };
  });

  // Balance check per currency (plan Sec.11 core invariant).
  const perCurrency = new Map();
  for (const l of normalized) {
    const cur = l.currency;
    const acc = perCurrency.get(cur) ?? { debit: 0, credit: 0 };
    acc.debit = round(acc.debit + l.debit, dec(cur));
    acc.credit = round(acc.credit + l.credit, dec(cur));
    perCurrency.set(cur, acc);
  }
  for (const [cur, { debit, credit }] of perCurrency) {
    if (Math.abs(debit - credit) > 0.005) {
      throw conflict(`Journal does not balance in ${cur}: debits ${debit} vs credits ${credit}`, { currency: cur, debit, credit });
    }
  }

  return tx(() => {
    const journalId = id('jnl');
    const journalRef = refOverride ?? reference('JE');
    for (const l of normalized) {
      run(
        `INSERT INTO ledger_entries (id, transaction_id, payment_id, account_code, currency, debit, credit, narration, reference, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id('le'), journalId, paymentId ?? null, l.account, l.currency,
        l.debit, l.credit, l.narration ?? narration, journalRef, nowIso(),
      );
    }
    run(
      `INSERT INTO ledger_journals (id, reference, payment_id, narration, entry_count, status, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      journalId, journalRef, paymentId ?? null, narration, normalized.length, 'POSTED', nowIso(),
    );
    return get(`SELECT * FROM ledger_journals WHERE id=?`, journalId);
  });
}

export function journalEntries(journalId) {
  return all(`SELECT * FROM ledger_entries WHERE transaction_id=? ORDER BY created_at, rowid`, journalId);
}

/** Balance of one account in one currency. */
export function accountBalance(accountCode, currency) {
  const row = get(
    `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c
     FROM ledger_entries WHERE account_code=? AND currency=?`,
    accountCode, currency,
  );
  return round(row.d - row.c, dec(currency));
}

/** All balances for a currency (or all currencies). */
export function balances(currency) {
  const rows = currency
    ? all(`SELECT account_code, currency, SUM(debit) AS debit, SUM(credit) AS credit
           FROM ledger_entries WHERE currency=? GROUP BY account_code, currency`, currency)
    : all(`SELECT account_code, currency, SUM(debit) AS debit, SUM(credit) AS credit
           FROM ledger_entries GROUP BY account_code, currency`);
  return rows.map((r) => ({
    account: r.account_code,
    currency: r.currency,
    debit: round(r.debit, dec(r.currency)),
    credit: round(r.credit, dec(r.currency)),
    balance: round(r.debit - r.credit, dec(r.currency)),
  }));
}

/** Trial balance per currency — must net to zero for a healthy ledger. */
export function trialBalance() {
  const out = {};
  for (const r of all(`SELECT currency, SUM(debit) AS d, SUM(credit) AS c FROM ledger_entries GROUP BY currency`)) {
    out[r.currency] = {
      debits: round(r.d, dec(r.currency)),
      credits: round(r.c, dec(r.currency)),
      difference: round(r.d - r.c, dec(r.currency)),
    };
  }
  return out;
}

export function listJournals(limit = 100) {
  return all(`SELECT * FROM ledger_journals ORDER BY created_at DESC LIMIT ?`, limit);
}
