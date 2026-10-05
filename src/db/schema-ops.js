/** Ledger, reconciliation, notifications, audit schema. */
export const SCHEMA_OPS = `
CREATE TABLE IF NOT EXISTS ledger_accounts (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  currency TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY, transaction_id TEXT, payment_id TEXT,
  account_code TEXT NOT NULL REFERENCES ledger_accounts(code),
  currency TEXT NOT NULL, debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0, narration TEXT, reference TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_le_txn ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_le_acct ON ledger_entries(account_code, currency);
CREATE TABLE IF NOT EXISTS ledger_journals (
  id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, payment_id TEXT,
  narration TEXT NOT NULL, entry_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'POSTED', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recon_matches (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
  settlement_id TEXT, bank_transfer_id TEXT, psp_amount REAL,
  ledger_amount REAL, settlement_amount REAL, statement_amount REAL,
  status TEXT NOT NULL, break_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_statements (
  id TEXT PRIMARY KEY, bank_code TEXT NOT NULL, value_date TEXT NOT NULL,
  currency TEXT NOT NULL, amount REAL NOT NULL, reference TEXT,
  provider_ref TEXT, imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, customer_id TEXT, channel TEXT NOT NULL,
  recipient TEXT NOT NULL, subject TEXT, body TEXT, payload TEXT,
  status TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, url TEXT NOT NULL,
  payload TEXT NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, role TEXT, action TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT, details TEXT, ip TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id TEXT PRIMARY KEY, bucket TEXT NOT NULL, window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
`;
