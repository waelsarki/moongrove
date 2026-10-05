/** Smoke-test the HTTP API against a running server. */
const BASE = process.env.BASE || 'http://localhost:3000';
const KEY = 'mg_admin_dev_key';

async function call(path, method = 'GET', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

console.log('\nHTTP API SMOKE TEST\n' + '-'.repeat(52));

// Auth
let r = await call('/api/reference');
check('GET /api/reference', r.status === 200 && Array.isArray(r.data.markets), `${r.data.markets?.length} markets`);

const res = await fetch(`${BASE}/api/reference`);
check('Rejects unauthenticated request', res.status === 401, `status ${res.status}`);

const res2 = await fetch(`${BASE}/api/ledger/trial-balance`, { headers: { 'x-api-key': 'mg_ops_dev_key' } });
check('Enforces RBAC (ops blocked from finance)', res2.status === 403, `status ${res2.status}`);

// Auth runs before routing, so an unknown path is 401 without a key, 404 with one.
const res3 = await fetch(`${BASE}/api/nope`, { headers: { 'x-api-key': KEY } });
check('404 on unknown route', res3.status === 404, `status ${res3.status}`);

// Reference data
r = await call('/api/banks');
check('GET /api/banks', r.status === 200 && r.data.length === 9, `${r.data.length} adapters`);

r = await call('/api/fx/rate/XAF/NGN');
check('GET cross FX rate XAF/NGN', r.status === 200 && r.data.rate > 0, `rate ${r.data.rate}`);

// Payment methods
r = await call('/api/payment-methods');
check('GET /api/payment-methods', r.status === 200 && r.data.some((m) => m.code === 'CARD'), `${r.data.length} methods`);

// Card validation
r = await call('/api/cards/validate', 'POST', { number: '4242424242424242', expMonth: '12', expYear: '29', cvv: '123' });
check('POST /api/cards/validate (Visa)', r.status === 200 && r.data.brand === 'VISA' && r.data.last4 === '4242',
  `${r.data.brand} ****${r.data.last4}`);

r = await call('/api/cards/validate', 'POST', { number: '4242424242424241', expMonth: '12', expYear: '29', cvv: '123' });
check('Rejects invalid card number (Luhn)', r.status === 400, `status ${r.status}`);

r = await call('/api/cards/validate', 'POST', { number: '4242424242424242', expMonth: '01', expYear: '20', cvv: '123' });
check('Rejects expired card', r.status === 400, `status ${r.status}`);

// Quote
r = await call('/api/fx/quotes', 'POST', { sourceCurrency: 'XAF', targetCurrency: 'NGN', amount: 25000 });
check('POST /api/fx/quotes', r.status === 200 && r.data.target_amount > 0 && r.data.margin_amount > 0,
  `${r.data.source_amount} XAF -> ${r.data.target_amount} NGN, margin ${r.data.margin_amount}`);

// GUEST payment - no customerId, no KYC
const key = `smoke-${Date.now()}`;
const p1 = await call('/api/payments', 'POST', {
  marketCode: 'GH', sourceAmount: 2000, paymentMethod: 'CARD',
  email: 'guest@example.com', idempotencyKey: key,
});
check('POST /api/payments without registration', p1.status === 200 && p1.data.payment.customer_id === null,
  `guest checkout, ${p1.data.payment.grand_total} GHS`);

const p2 = await call('/api/payments', 'POST', {
  marketCode: 'GH', sourceAmount: 2000, paymentMethod: 'CARD', idempotencyKey: key,
});
check('Idempotency key replay returns same payment', p1.data.payment.id === p2.data.payment.id, p1.data.payment.reference);

// Full pipeline with card
const proc = await call(`/api/payments/${p1.data.payment.id}/process`, 'POST', {
  card: { number: '4242424242424242', expMonth: '12', expYear: '29', cvv: '123', holderName: 'A OKONKWO' },
});
check('Guest card payment processes', proc.status === 200 && ['COMPLETED', 'FAILED'].includes(proc.data.payment.status),
  `${proc.data.payment.status} via ${proc.data.payment.bank_code ?? 'n/a'}`);
check('Card details stored (brand + last4 only)',
  proc.data.payment.card_brand === 'VISA' && proc.data.payment.card_last4 === '4242',
  `${proc.data.payment.card_brand} ****${proc.data.payment.card_last4}`);
check('Full card number never returned', !JSON.stringify(proc.data).includes('4242424242424242'), 'PAN not echoed');

// Ledger
r = await call('/api/ledger/trial-balance');
const tb = r.data ?? {};
const balanced = Object.values(tb).every((v) => Math.abs(v.difference) < 0.005);
check('GET /api/ledger/trial-balance balances', r.status === 200 && balanced,
  Object.entries(tb).map(([c, v]) => `${c}:${v.difference}`).join(' '));

// Recon + reports + audit
r = await call('/api/reconciliation/matches');
check('GET /api/reconciliation/matches', r.status === 200, `${r.data.length} matches`);

r = await call('/api/reports/dashboard');
check('GET /api/reports/dashboard', r.status === 200 && r.data.volumes, `${r.data.volumes?.count} payments`);

r = await call('/api/reports/banks');
check('GET /api/reports/banks', r.status === 200, `${r.data.length} banks with transfers`);

r = await call('/api/admin/audit');
check('GET /api/admin/audit', r.status === 200 && r.data.length > 0, `${r.data.length} entries`);

r = await call('/api/accounts/banks');
check('GET /api/accounts/banks', r.status === 200 && r.data.length > 0, `${r.data.length} accounts`);

// Static
for (const page of ['/', '/admin.html', '/styles.css', '/portal.js', '/admin.js']) {
  const s = await fetch(`${BASE}${page}`);
  check(`Static ${page}`, s.status === 200, `status ${s.status}`);
}

const passed = results.filter((x) => x.ok).length;
console.log('-'.repeat(52));
console.log(`${passed}/${results.length} checks passed\n`);
process.exit(passed === results.length ? 0 : 1);
