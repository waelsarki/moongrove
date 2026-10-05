/** Core schema: customers, KYC, FX, payments, banking, settlement. */
export const SCHEMA_CORE = `
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('INDIVIDUAL','BUSINESS')),
  full_name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT,
  country TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
  kyc_status TEXT NOT NULL DEFAULT 'PENDING', risk_score INTEGER DEFAULT 0,
  risk_band TEXT DEFAULT 'UNKNOWN', kyc_level INTEGER DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kyc_checks (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id),
  check_type TEXT NOT NULL, status TEXT NOT NULL, provider TEXT,
  hits INTEGER DEFAULT 0, details TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fx_rates (
  id TEXT PRIMARY KEY, base_currency TEXT NOT NULL, quote_currency TEXT NOT NULL,
  rate REAL NOT NULL, source TEXT NOT NULL, captured_at TEXT NOT NULL,
  UNIQUE (base_currency, quote_currency, captured_at)
);
CREATE INDEX IF NOT EXISTS idx_fx_pair ON fx_rates(base_currency, quote_currency, captured_at DESC);
CREATE TABLE IF NOT EXISTS fx_quotes (
  id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  source_currency TEXT NOT NULL, target_currency TEXT NOT NULL,
  source_amount REAL NOT NULL, target_amount REAL NOT NULL,
  rate REAL NOT NULL, reference_rate REAL NOT NULL,
  margin_bps INTEGER NOT NULL, margin_amount REAL NOT NULL,
  partner_fee REAL NOT NULL DEFAULT 0, bank_fee REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN', expires_at TEXT NOT NULL,
  consumed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_history (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, transaction_id TEXT,
  rate REAL NOT NULL, reference_rate REAL NOT NULL, source TEXT NOT NULL,
  locked_at TEXT NOT NULL, applied_at TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL,
  customer_id TEXT REFERENCES customers(id),   -- optional: guest checkout
  guest_email TEXT, guest_name TEXT,
  idempotency_key TEXT UNIQUE, market_code TEXT NOT NULL,
  source_currency TEXT NOT NULL, target_currency TEXT NOT NULL,
  source_amount REAL NOT NULL, target_amount REAL NOT NULL,
  fees_total REAL NOT NULL DEFAULT 0, grand_total REAL NOT NULL,
  quote_id TEXT NOT NULL REFERENCES fx_quotes(id),
  payment_method TEXT,             -- CARD | BANK_TRANSFER | WALLET
  card_brand TEXT, card_last4 TEXT, card_auth_code TEXT,
  status TEXT NOT NULL DEFAULT 'INITIATED',
  risk_score INTEGER, risk_decision TEXT,
  settlement_id TEXT, bank_code TEXT, failure_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pay_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_pay_cust ON payments(customer_id);
CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
  from_status TEXT, to_status TEXT NOT NULL, reason TEXT,
  actor TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evt_pay ON payment_events(payment_id, created_at);
CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY, bank_code TEXT NOT NULL, currency TEXT NOT NULL,
  account_number TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0,
  available REAL NOT NULL DEFAULT 0, health TEXT NOT NULL DEFAULT 'HEALTHY',
  daily_capacity REAL NOT NULL DEFAULT 0, daily_used REAL NOT NULL DEFAULT 0,
  cost_bps INTEGER NOT NULL DEFAULT 40, settlement_days TEXT NOT NULL DEFAULT 'T+0',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_transfers (
  id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id),
  bank_code TEXT NOT NULL, account_id TEXT REFERENCES bank_accounts(id),
  attempt INTEGER NOT NULL DEFAULT 1, amount REAL NOT NULL, currency TEXT NOT NULL,
  direction TEXT NOT NULL, provider_ref TEXT, idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL, error_code TEXT, error_message TEXT, latency_ms INTEGER,
  requested_at TEXT NOT NULL, settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bt_pay ON bank_transfers(payment_id);
CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL,
  payment_id TEXT NOT NULL REFERENCES payments(id), amount REAL NOT NULL,
  currency TEXT NOT NULL, strategy TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, preferred_bank TEXT, final_bank TEXT,
  created_at TEXT NOT NULL, completed_at TEXT
);
`;
