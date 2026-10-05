/**
 * MOONGROVE - Platform configuration.
 * Values trace back to the Implementation Plan (Oct 2026).
 * Everything here is meant to be moved to DB-backed admin config in production.
 */

export const CONFIG = {
  company: 'MOONGROVE MARKET HUB LTD',
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  dbFile: process.env.DB_FILE || './data/moongrove.db',

  // Auth: prototype API keys. Production => real IAM + MFA (see plan Sec.14).
  apiKeys: {
    admin: { key: 'mg_admin_dev_key', role: 'ADMIN', label: 'Platform Administrator' },
    ops: { key: 'mg_ops_dev_key', role: 'OPERATIONS', label: 'Operations Officer' },
    compliance: { key: 'mg_compliance_dev_key', role: 'COMPLIANCE', label: 'Compliance Officer' },
    finance: { key: 'mg_finance_dev_key', role: 'FINANCE', label: 'Finance Officer' },
    customer: { key: 'mg_customer_dev_key', role: 'CUSTOMER', label: 'Customer Portal (demo)' },
  },

  security: {
    rateLimit: { windowMs: 60_000, max: 300 },
    webhookSecret: 'mg_whsec_dev_secret_do_not_use_in_prod',
    // Plan Sec.14: transaction signing on sensitive financial ops.
    hmacAlgorithm: 'sha256',
  },

  fx: {
    // Quote validity. Rate is locked at FX_QUOTED and never re-priced.
    quoteTtlSeconds: 300,
    // Plan Sec.7 pricing stack: reference + margin + partner fees + bank fees.
    defaultMarginBps: 150, // 1.50% MOONGROVE margin
    rateSource: 'APPROVED_REFERENCE_FEED',
    rateSourceIntervalMs: 60_000,
  },

  settlement: {
    maxAttemptsPerBank: 2,
    retryBackoffMs: [250, 750, 1500],
    // Plan Sec.9 failover: try next approved bank after max attempts.
    enableFailover: true,
  },

  /**
   * Guest checkout: customers pay by card without registering.
   * KYC/AML screening is intentionally NOT run at payment time.
   */
  guestCheckout: {
    enabled: true,
    requireEmail: false,
    // Optional transaction guardrails for anonymous payments (no customer identity).
    maxSingleTxn: 5_000_000,
    maxDailyTotal: 20_000_000,
  },

  cards: {
    brands: ['VISA', 'MASTERCARD', 'VERVE'],
    // Simulated issuer: share of authorisations that decline.
    declineRate: 0.05,
    authTimeoutMs: 900,
    // Card-not-present online authorisation.
    cnp: true,
  },

  kyc: {
    autoApproveRiskScoreBelow: 30,
    // Plan Sec.10: velocity / limit monitoring.
    limits: {
      individual: { singleTxn: 250_000, dailyTotal: 1_000_000 },
      business: { singleTxn: 25_000_000, dailyTotal: 100_000_000 },
    },
  },
};

/** Plan Sec.16 MVP payment methods available at checkout. */
export const PAYMENT_METHODS = [
  { code: 'CARD', name: 'Debit / Credit card', description: 'Visa, Mastercard, Verve — processed instantly', enabled: true },
  { code: 'BANK_TRANSFER', name: 'Bank transfer', description: 'Transfer to your bank account after FX conversion', enabled: true },
];

/** Plan Sec.5 - country / local currency / settlement currency, kept distinct. */
export const MARKETS = [
  { code: 'CM', country: 'Cameroon', localCurrency: 'XAF', name: 'Central African CFA franc', corridors: ['EUR', 'NGN', 'USD'], enabled: true },
  { code: 'CI', country: "Côte d'Ivoire", localCurrency: 'XOF', name: 'West African CFA franc', corridors: ['EUR', 'NGN', 'USD'], enabled: true },
  { code: 'GH', country: 'Ghana', localCurrency: 'GHS', name: 'Ghanaian cedi', corridors: ['NGN', 'USD'], enabled: true },
  { code: 'NE', country: 'Niger', localCurrency: 'XOF', name: 'West African CFA franc', corridors: ['EUR', 'NGN', 'USD'], enabled: true },
  { code: 'BJ', country: 'Benin', localCurrency: 'XOF', name: 'West African CFA franc', corridors: ['EUR', 'NGN', 'USD'], enabled: true },
];

export const CURRENCIES = {
  NGN: { code: 'NGN', name: 'Nigerian Naira', decimals: 2, settlement: true },
  USD: { code: 'USD', name: 'US Dollar', decimals: 2, settlement: true },
  EUR: { code: 'EUR', name: 'Euro', decimals: 2, settlement: true },
  GBP: { code: 'GBP', name: 'Pound Sterling', decimals: 2, settlement: true },
  GHS: { code: 'GHS', name: 'Ghanaian Cedi', decimals: 2, settlement: false },
  XAF: { code: 'XAF', name: 'Central African CFA Franc', decimals: 0, settlement: false },
  XOF: { code: 'XOF', name: 'West African CFA Franc', decimals: 0, settlement: false },
};

/** Plan Sec.4 - target Nigerian banking network. */
export const BANKS = [
  { code: 'PROVIDUS', name: 'Providus Bank', wave: 1 },
  { code: 'ACCESS', name: 'Access Bank', wave: 1 },
  { code: 'UBA', name: 'United Bank for Africa', wave: 1 },
  { code: 'GTBANK', name: 'GTBank', wave: 2 },
  { code: 'ZENITH', name: 'Zenith Bank', wave: 2 },
  { code: 'FIRSTBANK', name: 'First Bank of Nigeria', wave: 2 },
  { code: 'ECOBANK', name: 'Ecobank', wave: 3 },
  { code: 'JAIZ', name: 'Jaiz Bank', wave: 3 },
  { code: 'STERLING', name: 'Sterling Bank', wave: 3 },
];

/** Plan Sec.8 - payment transaction lifecycle. */
export const LIFECYCLE = {
  INITIATED: 'INITIATED',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  VERIFICATION: 'VERIFICATION',
  FX_QUOTED: 'FX_QUOTED',
  FX_CONVERTED: 'FX_CONVERTED',
  SETTLEMENT_PENDING: 'SETTLEMENT_PENDING',
  SETTLED: 'SETTLED',
  RECONCILED: 'RECONCILED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED',
  REFUNDED: 'REFUNDED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  CANCELLED: 'CANCELLED',
};

export const EXCEPTION_STATUSES = [
  LIFECYCLE.FAILED,
  LIFECYCLE.REVERSED,
  LIFECYCLE.REFUNDED,
  LIFECYCLE.UNDER_REVIEW,
  LIFECYCLE.CANCELLED,
];

export const TERMINAL_STATUSES = [
  LIFECYCLE.COMPLETED,
  LIFECYCLE.FAILED,
  LIFECYCLE.REVERSED,
  LIFECYCLE.REFUNDED,
  LIFECYCLE.CANCELLED,
];

/** Plan Sec.11 - chart of accounts (per-currency accounting positions). */
export const ACCOUNT_TYPES = {
  CUSTOMER_RECEIVABLE: 'CUSTOMER_RECEIVABLE', // money owed to us by customers
  CUSTOMER_PAYABLE: 'CUSTOMER_PAYABLE', // money we owe to customers
  FX_POSITION: 'FX_POSITION', // currency exposure
  FX_MARGIN: 'FX_MARGIN', // revenue from spread
  PARTNER_CLEARING: 'PARTNER_CLEARING', // in-flight with PSP
  BANK_NOSTRO: 'BANK_NOSTRO', // at settlement bank
  BANK_FEES: 'BANK_FEES',
  PARTNER_FEES: 'PARTNER_FEES',
  REVENUE: 'REVENUE',
  SUSPENSE: 'SUSPENSE', // recon breaks
};

/** Plan Sec.13 - API domains. */
export const API_DOMAINS = [
  'auth', 'customers', 'kyc', 'payments', 'transactions', 'currencies', 'fx',
  'quotes', 'banks', 'accounts', 'settlements', 'reconciliation', 'refunds',
  'webhooks', 'reports', 'admin', 'compliance',
];
