# MOONGROVE — Cross-Border Payment & Multi-Bank Settlement Platform

Working prototype of the *International Payment & Multi-Bank Settlement Platform*
technical implementation plan (MOONGROVE MARKET HUB LTD, October 2026).

All ten modules from the plan are implemented and wired into one running system.

---

## Customer journey: guest card checkout

**No registration. No KYC screening at payment time.** The customer arrives at the
landing page and:

1. **Selects their country** (Cameroon, Côte d'Ivoire, Ghana, Niger, Benin)
2. **Selects a payment method** (card, or bank transfer)
3. **Enters an amount** and sees a live locked FX quote
4. **Enters card details** — Visa, Mastercard or Verve
5. **Pays** — the card is authorised, FX applied, settled via a Nigerian bank

Card details are validated with the Luhn algorithm, brand-detected from the
BIN range, and expiry/CVV checked server-side. Only the **brand, last 4 digits
and authorisation code** are ever stored — the full PAN is never persisted or
echoed back.

Test cards:

| Card | Brand |
|---|---|
| `4242 4242 4242 4242` | Visa |
| `5555 5555 5555 4444` | Mastercard |
| `5061 1111 1111 1118` | Verve |

> **Regulatory note:** guest checkout removes customer identification from the
> payment path. The KYC/AML modules still exist in `src/modules/kyc.js` but are
> **not invoked** during checkout. Before live processing, Nigerian legal and
> compliance advisers must confirm whether this operating model is permissible —
> cross-border FX without customer identification may breach AML obligations.
> This is a prototype decision, not a compliance position.

---

## Quick start

```bash
node src/seed.js      # create DB, bank accounts, chart of accounts, rates, demo customers
node src/server.js    # start on http://localhost:3000
```

| Surface | URL |
|---|---|
| Customer payment portal | http://localhost:3000/ |
| Administration console | http://localhost:3000/admin.html |
| API base | http://localhost:3000/api |

**Zero dependencies** — Node 22.5+ built-ins only (`node:http`, `node:sqlite`). No `npm install`.

### Demo API keys

| Role | Key |
|---|---|
| ADMIN | `mg_admin_dev_key` |
| OPERATIONS | `mg_ops_dev_key` |
| COMPLIANCE | `mg_compliance_dev_key` |
| FINANCE | `mg_finance_dev_key` |
| CUSTOMER | `mg_customer_dev_key` |

Pass as `x-api-key` header. RBAC is enforced per route.

---

## Verification

```bash
node scripts/demo-e2e.js    # guest card flow + failover + ledger integrity proof
node scripts/smoke.js       # 27 HTTP API checks (needs server running)
node scripts/run-smoke.js   # starts server on a free port, runs smoke, stops it
node scripts/reset.js       # wipe the SQLite database
```

Latest run: **27/27 smoke checks passed**; demo reaches `COMPLETED`
with `recon = MATCHED` and trial balance `diff = 0` in every currency.

---

## Architecture

```
Customer → Portal → Orchestrator → FX Engine / Risk Engine / Banking Engine
        → Approved Payment Partner or Bank → Settlement Account
        → Reconciliation & Reporting
```

### Modules (plan §6)

| Module | File | What it does |
|---|---|---|
| Customer Payment Portal | `public/index.html`, `public/portal.js` | Country → method → amount → card → pay (guest) |
| Card Processing | `src/modules/cards.js` | Luhn validation, brand detection, simulated authorisation |
| Payment Orchestrator | `src/modules/orchestrator.js` | 10-state lifecycle, idempotency, ledger wiring |
| FX Engine | `src/modules/fx-rates.js`, `fx-quotes.js` | Rate feed, margin stack, **rate locking**, rate history |
| Bank Integration Layer | `src/modules/banking/adapter.js`, `adapters.js` | One adapter contract, **9 bank adapters** |
| Settlement Engine | `src/modules/settlement.js` | Bank ranking + **failover** across waves |
| Internal Ledger | `src/modules/ledger.js` | **Double-entry**, per-currency, balance-enforced |
| Reconciliation | `src/modules/recon.js` | **4-way match** + break queue |
| Administration | `public/admin.html`, `public/admin.js` | Dashboard, settlement, ledger, recon, audit |
| Reporting | `src/modules/reporting.js` | Volumes, corridors, FX margin, bank performance |
| Notifications | `src/modules/notify.js` | Email/in-app + **HMAC-signed webhooks** |
| Security & Audit | `src/lib/security.js` | API-key auth, RBAC, rate limiting, append-only audit |

> `src/modules/kyc.js` (KYC/AML screening) is retained for compliance review but is
> **not called** in the guest checkout path.


---

## The three load-bearing design decisions

### 1. Bank adapter pattern
`BankAdapter` defines one contract (`transfer`, `doTransfer`, `statement`,
`supports`, `estimateFee`). Nine banks implement it with **deliberately different
currencies, costs, latency and failure rates** — modelling the capability variance
the plan warns about in §4. Adding Wave 2/3 banks is configuration, not a rewrite.

| Bank | Wave | Currencies | Cost |
|---|---|---|---|
| Providus | 1 | NGN, USD, GBP | 45 bps |
| Access | 1 | NGN, USD, EUR | 42 bps |
| UBA | 1 | NGN, USD, EUR, GBP, GHS | 48 bps |
| GTBank | 2 | NGN, USD, EUR | 44 bps |
| Zenith | 2 | NGN, USD, GBP | 43 bps |
| FirstBank | 2 | NGN only | 50 bps |
| Ecobank | 3 | NGN, USD, EUR, XOF, XAF | 47 bps |
| Jaiz | 3 | NGN only | 52 bps |
| Sterling | 3 | NGN, USD | 46 bps |

### 2. Double-entry ledger as source of truth
`postJournal()` **rejects any journal where debits ≠ credits per currency**
(throws, rolls back, never posts). Trial balance must net to zero.

### 3. Immutable rate locking
The rate is captured at `FX_QUOTED` and written to `rate_history`. A completed
transaction can never be re-priced.

---

## Lifecycle (plan §8)

```
INITIATED → PAYMENT_PENDING → PAYMENT_RECEIVED → VERIFICATION
→ FX_QUOTED → FX_CONVERTED → SETTLEMENT_PENDING → SETTLED
→ RECONCILED → COMPLETED
```
Exceptions: `FAILED`, `REVERSED`, `REFUNDED`, `UNDER_REVIEW`, `CANCELLED`.

`RECONCILED` sits **before** `COMPLETED` — a payment is not complete until it is
matched against the bank statement. Illegal transitions are rejected by
`TRANSITIONS` in `orchestrator.js`.

## FX pricing (plan §7)

```
reference rate → MOONGROVE margin (150 bps) → partner fee → bank fee → customer quote
```

Margin **reduces** what the customer receives: `customerRate = ref / (1 + bps/10000)`,
`margin = amount × ref − targetAmount`.

## Corridors (plan §5)

| Market | Country | Local currency | Corridors |
|---|---|---|---|
| CM | Cameroon | XAF | EUR, NGN, USD |
| CI | Côte d'Ivoire | XOF | EUR, NGN, USD |
| GH | Ghana | GHS | NGN, USD |
| NE | Niger | XOF | EUR, NGN, USD |
| BJ | Benin | XOF | EUR, NGN, USD |

## Project layout

```
src/
  config.js                 markets, currencies, banks, waves, limits, lifecycle
  server.js                 HTTP server + route table + RBAC
  seed.js                   database bootstrap
  db/
    index.js                node:sqlite connection, helpers, transactions
    schema-core.js          customers, KYC, FX, payments, banking, settlement
    schema-ops.js           ledger, reconciliation, notifications, audit
  lib/
    util.js                 ids, references, rounding, bps
    errors.js               typed HTTP errors
    security.js             auth, RBAC, rate limit, HMAC, audit
  modules/
    fx-rates.js             rate feed + cross-rate resolution
    fx-quotes.js            quote pricing, locking, rate history
    orchestrator.js         lifecycle state machine + pipeline
    settlement.js           bank ranking + failover
    ledger.js               double-entry engine
    kyc.js                  onboarding, screening, limits
    recon.js                4-way reconciliation
    reporting.js            dashboards + reports
    notify.js               notifications + signed webhooks
    banking/
      adapter.js            BankAdapter base class
      adapters.js           9 bank adapters
public/                     customer portal + admin console
scripts/                    demo, smoke tests, reset
```

---

## Prototype limitations

This is a **functional prototype**, not production software:

- **Bank adapters are simulated** — latency and failures are synthetic. Real
  deployments replace each `doTransfer` body with that bank's API. Per plan §4,
  capabilities must be confirmed with each bank first.
- **FX rates are indicative seeds**, not a licensed rate feed.
- **API keys are static** and stored in `config.js`; production needs real IAM,
  MFA, secret management and key rotation (plan §14).
- **No persistence tier beyond SQLite**; no queue, cache, or retry scheduler.
- **Screening is rule-based** with hardcoded watchlists — production requires a
  real sanctions/PEP provider and documented tuning.
- **Regulatory perimeter is undetermined** per the plan. Whether MOONGROVE
  collects funds for itself, merchants or third parties changes the licensing
  path and must be settled by Nigerian legal/compliance advisers before live use.
- **No refunds/reversals UI**, though statuses are modelled.

