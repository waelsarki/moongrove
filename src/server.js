import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, MARKETS, CURRENCIES, BANKS, LIFECYCLE, PAYMENT_METHODS } from './config.js';
import { migrate, all, get, run } from './db/index.js';
import { authenticate, authorize, rateLimit, audit } from './lib/security.js';
import { AppError } from './lib/errors.js';
import { refreshRates, listRates, referenceRate } from './modules/fx-rates.js';
import { createQuote, getQuote, listRateHistory } from './modules/fx-quotes.js';
import { validateCard } from './modules/cards.js';
import * as kyc from './modules/kyc.js';
import * as orch from './modules/orchestrator.js';
import * as settlement from './modules/settlement.js';
import * as recon from './modules/recon.js';
import * as reporting from './modules/reporting.js';
import * as ledger from './modules/ledger.js';
import { listNotifications, listWebhookDeliveries } from './modules/notify.js';
import { allAdapters } from './modules/banking/adapters.js';
import { recentAudit } from './lib/security.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

migrate();
refreshRates();
const rateTimer = setInterval(refreshRates, CONFIG.fx.rateSourceIntervalMs);
rateTimer.unref();

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError(400, 'BAD_JSON', 'Request body is not valid JSON'); }
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^([/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

const routes = [];
const route = (method, pattern, roles, handler) => {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  })}$`);
  routes.push({ method, regex, keys, roles, handler });
};

// ---- Reference data (authenticated) ----
route('GET', '/api/reference', null, async () => ({
  company: CONFIG.company, markets: MARKETS.filter((m) => m.enabled),
  currencies: Object.values(CURRENCIES), banks: BANKS, lifecycle: LIFECYCLE,
}));

route('GET', '/api/currencies', null, async () => Object.values(CURRENCIES));
route('GET', '/api/banks', null, async () => allAdapters().map((a) => ({
  code: a.code, name: a.name, wave: a.wave, supportedCurrencies: a.supportedCurrencies, costBps: a.costBps,
})));
route('GET', '/api/accounts/banks', ['ADMIN', 'FINANCE', 'OPERATIONS'], async () =>
  all(`SELECT bank_code, currency, account_number, balance, available, health, daily_capacity, daily_used, cost_bps FROM bank_accounts ORDER BY bank_code, currency`));

// ---- FX ----
route('GET', '/api/fx/rates', null, async () => listRates(30));
route('GET', '/api/fx/rate/:base/:quote', null, async ({ params }) => ({
  base: params.base, quote: params.quote, rate: referenceRate(params.base, params.quote), source: CONFIG.fx.rateSource,
}));
route('POST', '/api/fx/quotes', ['CUSTOMER', 'ADMIN', 'OPERATIONS'], async ({ body, principal }) => createQuote({
  customerId: body.customerId, sourceCurrency: body.sourceCurrency,
  targetCurrency: body.targetCurrency, amount: Number(body.amount),
  marginBps: body.marginBps,
}));
route('GET', '/api/fx/quotes/:id', null, async ({ params }) => getQuote(params.id));
route('GET', '/api/fx/rate-history', ['ADMIN', 'FINANCE', 'COMPLIANCE'], async () => listRateHistory(50));

// ---- Customers / KYC ----
route('POST', '/api/customers', ['CUSTOMER', 'ADMIN', 'OPERATIONS'], async ({ body, principal }) =>
  kyc.registerCustomer(body));
route('GET', '/api/customers', ['ADMIN', 'COMPLIANCE', 'OPERATIONS'], async () => kyc.listCustomers());
route('GET', '/api/customers/:id', null, async ({ params, principal }) => {
  const c = kyc.getCustomer(params.id);
  if (principal.role === 'CUSTOMER' && c.email !== principal.actor) {
    const demo = get(`SELECT id FROM customers WHERE email=?`, principal.actor);
    if (!demo || demo.id !== c.id) throw new AppError(403, 'FORBIDDEN', 'Not your record');
  }
  return { customer: c, kycChecks: kyc.listKycChecks(c.id) };
});
route('GET', '/api/kyc/review-queue', ['COMPLIANCE', 'ADMIN'], async () => kyc.reviewQueue());
route('POST', '/api/kyc/:id/review', ['COMPLIANCE', 'ADMIN'], async ({ params, body, principal }) =>
  kyc.manualReview(params.id, body.decision, principal));

// ---- Payments / Orchestrator (guest checkout) ----
route('GET', '/api/payment-methods', null, async () => PAYMENT_METHODS.filter((m) => m.enabled));
route('POST', '/api/cards/validate', ['CUSTOMER', 'ADMIN', 'OPERATIONS'], async ({ body }) => {
  // Returns a safe summary only - the PAN is never echoed back or stored.
  const card = validateCard(body);
  return { valid: true, brand: card.brand, last4: card.last4, expiry: `${card.expMonth}/${String(card.expYear).slice(-2)}` };
});
route('POST', '/api/payments', ['CUSTOMER', 'ADMIN', 'OPERATIONS'], async ({ body, principal }) =>
  orch.initiatePayment({
    customerId: body.customerId ?? null,
    guestEmail: body.email ?? body.guestEmail ?? null,
    guestName: body.name ?? body.guestName ?? null,
    marketCode: body.marketCode,
    sourceAmount: Number(body.sourceAmount),
    paymentMethod: body.paymentMethod,
    idempotencyKey: body.idempotencyKey,
    principal,
  }));
route('GET', '/api/payments', ['ADMIN', 'OPERATIONS', 'COMPLIANCE', 'FINANCE'], async () => orch.listPayments(100));
route('GET', '/api/payments/:id', null, async ({ params }) => {
  const p = orch.getPayment(params.id);
  return { payment: p, timeline: orch.paymentTimeline(p.id), events: orch.paymentTimeline(p.id).length };
});
route('POST', '/api/payments/:id/process', ['CUSTOMER', 'ADMIN', 'OPERATIONS'], async ({ params, body, principal }) =>
  orch.processPayment(params.id, principal, body.card ?? null));
route('POST', '/api/payments/:id/authorise-card', ['CUSTOMER', 'ADMIN', 'OPERATIONS'], async ({ params, body, principal }) =>
  orch.authorisePaymentCard(params.id, body, principal));
route('POST', '/api/payments/:id/confirm-funds', ['ADMIN', 'OPERATIONS'], async ({ params, principal }) =>
  orch.confirmFundsReceived(params.id, principal));
route('POST', '/api/payments/:id/convert', ['ADMIN', 'OPERATIONS'], async ({ params, principal }) =>
  orch.convertFx(params.id, principal));
route('POST', '/api/payments/:id/settle', ['ADMIN', 'OPERATIONS'], async ({ params, principal }) =>
  orch.executeSettlement(params.id, principal));
route('POST', '/api/payments/:id/reconcile', ['ADMIN', 'OPERATIONS', 'FINANCE'], async ({ params, principal }) =>
  orch.completeReconciliation(params.id, principal));
route('GET', '/api/transactions/:id/timeline', null, async ({ params }) => orch.paymentTimeline(params.id));

// ---- Settlement ----
route('GET', '/api/settlements', ['ADMIN', 'FINANCE', 'OPERATIONS'], async () => settlement.listSettlements(100));
route('GET', '/api/settlements/:id', ['ADMIN', 'FINANCE', 'OPERATIONS'], async ({ params }) => settlement.getSettlement(params.id));

// ---- Reconciliation ----
route('GET', '/api/reconciliation/matches', ['ADMIN', 'FINANCE', 'OPERATIONS'], async () => recon.listMatches(100));
route('GET', '/api/reconciliation/breaks', ['ADMIN', 'FINANCE', 'OPERATIONS'], async () => recon.reconBreaks(100));
route('POST', '/api/reconciliation/statements', ['ADMIN', 'FINANCE', 'OPERATIONS'], async ({ body }) =>
  recon.importStatementLine({
    bankCode: body.bankCode, valueDate: body.valueDate ?? new Date().toISOString().slice(0, 10),
    currency: body.currency, amount: Number(body.amount), reference: body.reference, providerRef: body.providerRef,
  }));
route('GET', '/api/reconciliation/statements', ['ADMIN', 'FINANCE'], async () => recon.listStatements(100));

// ---- Ledger ----
route('GET', '/api/ledger/accounts', ['ADMIN', 'FINANCE'], async () => ledger.listAccounts());
route('GET', '/api/ledger/balances', ['ADMIN', 'FINANCE'], async ({ query }) => ledger.balances(query.currency));
route('GET', '/api/ledger/trial-balance', ['ADMIN', 'FINANCE'], async () => ledger.trialBalance());
route('GET', '/api/ledger/journals', ['ADMIN', 'FINANCE'], async () => ledger.listJournals(50));

// ---- Reporting / Admin ----
route('GET', '/api/reports/dashboard', ['ADMIN', 'FINANCE', 'OPERATIONS', 'COMPLIANCE'], async () => reporting.dashboard());
route('GET', '/api/reports/transactions', ['ADMIN', 'FINANCE', 'COMPLIANCE'], async () => reporting.transactionReport(100));
route('GET', '/api/reports/settlements', ['ADMIN', 'FINANCE'], async () => reporting.settlementReport(100));
route('GET', '/api/reports/banks', ['ADMIN', 'FINANCE', 'OPERATIONS'], async () => reporting.bankPerformance());
route('GET', '/api/notifications', null, async ({ query }) => listNotifications(query.customerId, 50));
route('GET', '/api/webhooks/deliveries', ['ADMIN', 'OPERATIONS'], async () => listWebhookDeliveries(50));
route('GET', '/api/admin/audit', ['ADMIN', 'COMPLIANCE'], async () => recentAudit(100));
route('POST', '/api/admin/banks/:code/health', ['ADMIN'], async ({ params, body }) => {
  run(`UPDATE bank_accounts SET health=? WHERE bank_code=?`, body.health, params.code);
  return { bank: params.code, health: body.health };
});

// ---- Dispatcher ----
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);

  const ip = req.socket.remoteAddress;
  const started = Date.now();
  let principal = null;

  try {
    rateLimit(ip ?? 'unknown');
    principal = authenticate(req);

    const match = routes.find((r) => r.method === req.method && r.regex.test(pathname));
    if (!match) {
      const pathExists = routes.some((r) => r.regex.test(pathname));
      return json(res, pathExists ? 405 : 404, {
        error: pathExists ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
        message: `${req.method} ${pathname} is not available`,
      });
    }

    if (match.roles) authorize(principal, ...match.roles);

    const params = {};
    match.regex.exec(pathname).slice(1).forEach((v, i) => { params[match.keys[i]] = decodeURIComponent(v); });
    const query = Object.fromEntries(url.searchParams);
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

    const result = await match.handler({ params, query, body, principal, req });
    audit(principal, `${req.method} ${pathname}`, 'API', null, { status: 200, ms: Date.now() - started }, ip);
    return json(res, 200, result);
  } catch (err) {
    const status = err instanceof AppError ? err.status : 500;
    const payload = {
      error: err.code ?? 'INTERNAL_ERROR',
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    };
    if (status === 500) {
      payload.message = 'Internal server error';
      console.error('[500]', req.method, pathname, err);
    }
    audit(principal, `${req.method} ${pathname}`, 'API', null, { status, error: payload.error }, ip);
    return json(res, status, payload);
  }
});

server.listen(CONFIG.port, () => {
  console.log(`${CONFIG.company} prototype`);
  console.log(`  Customer portal : http://localhost:${CONFIG.port}/`);
  console.log(`  Admin dashboard : http://localhost:${CONFIG.port}/admin.html`);
  console.log(`  API base        : http://localhost:${CONFIG.port}/api`);
  console.log(`  Demo API key    : ${CONFIG.apiKeys.admin.key}`);
});

export { server };

