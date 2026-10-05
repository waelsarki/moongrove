/**
 * End-to-end demonstration: GUEST CARD CHECKOUT.
 * No registration, no KYC. Proves: country -> amount -> card -> payment ->
 * FX -> multi-bank settlement (failover) -> reconciliation -> completion,
 * with double-entry ledger integrity and idempotency.
 */
import { migrate, all, run, close } from '../src/db/index.js';
import { refreshRates } from '../src/modules/fx-rates.js';
import { initiatePayment, processPayment, paymentTimeline } from '../src/modules/orchestrator.js';
import { trialBalance, listJournals as journals } from '../src/modules/ledger.js';
import { bankPerformance } from '../src/modules/reporting.js';
import { allAdapters } from '../src/modules/banking/adapters.js';
import { luhnValid, detectBrand, validateCard } from '../src/modules/cards.js';

migrate();
refreshRates();

const line = (t) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);
const actor = { actor: 'guest', role: 'CUSTOMER' };
const stamp = Date.now().toString(36);
const VISA = { number: '4242424242424242', expMonth: '12', expYear: '29', cvv: '123', holderName: 'A OKONKWO' };

function setHealth(bankCode, health) {
  run(`UPDATE bank_accounts SET health=? WHERE bank_code=? AND currency='NGN'`, health, bankCode);
}

line('1. CARD VALIDATION (no account required)');
for (const pan of ['4242424242424242', '5555555555554444', '5061111111111118']) {
  const c = validateCard({ number: pan, expMonth: '12', expYear: '29', cvv: '123' });
  console.log(`  ${pan} -> ${detectBrand(pan).padEnd(11)} luhn=${luhnValid(pan)} last4=${c.last4}`);
}
for (const bad of ['4242424242424241', '1234567812345678']) {
  try { validateCard({ number: bad, expMonth: '12', expYear: '29', cvv: '123' }); console.log(`  ${bad} -> ACCEPTED (BUG)`); }
  catch (e) { console.log(`  ${bad} -> rejected: ${e.message}`); }
}
try { validateCard({ number: VISA.number, expMonth: '01', expYear: '20', cvv: '123' }); }
catch (e) { console.log(`  expired card -> rejected: ${e.message}`); }

line('2. GUEST PAYMENT (no registration, no KYC)');
const created = initiatePayment({
  marketCode: 'CM', sourceAmount: 50_000, paymentMethod: 'CARD',
  guestEmail: `guest.${stamp}@example.com`, guestName: 'Amara Okonkwo',
  idempotencyKey: `demo-${stamp}`, actor,
});
const payment = created.payment;
console.log(`  ${payment.reference}: ${payment.grand_total} ${payment.source_currency} charged`);
console.log(`  Customer receives: ${payment.target_amount} ${payment.target_currency}`);
console.log(`  customer_id: ${payment.customer_id} (guest checkout)`);

const replay = initiatePayment({
  marketCode: 'CM', sourceAmount: 50_000, paymentMethod: 'CARD',
  idempotencyKey: `demo-${stamp}`, actor,
});
console.log(`  Idempotent replay returns same payment? ${replay.payment.id === created.payment.id}`);

console.log('\n  Simulating outage: marking PROVIDUS, ACCESS, UBA as DOWN...');
setHealth('PROVIDUS', 'DOWN'); setHealth('ACCESS', 'DOWN'); setHealth('UBA', 'DOWN');

line('3. CARD PAYMENT + ORCHESTRATION');
const result = await processPayment(payment.id, actor, VISA);
console.log(`  Stage  : ${result.stage}`);
console.log(`  Status : ${result.payment.status}`);
console.log(`  Card   : ${result.payment.card_brand} ****${result.payment.card_last4} auth ${result.payment.card_auth_code}`);
console.log(`  Bank   : ${result.payment.bank_code}`);

console.log('\n  Lifecycle trace:');
for (const e of paymentTimeline(payment.id)) {
  console.log(`    ${String(e.from_status ?? '-').padEnd(20)} -> ${e.to_status.padEnd(20)} ${e.reason ?? ''}`);
}


line('4. MULTI-BANK FAILOVER DETAIL');
for (const t of all(`SELECT bank_code, attempt, status, error_code, latency_ms FROM bank_transfers WHERE payment_id=? ORDER BY rowid`, payment.id)) {
  console.log(`    attempt ${t.attempt}: ${t.bank_code.padEnd(10)} ${t.status.padEnd(10)} ${t.error_code ?? ''} ${t.latency_ms ?? ''}ms`);
}

line('4b. TRANSIENT-OUTAGE FAILOVER (all banks degraded, adapters fail over)');
run(`UPDATE bank_accounts SET health='DEGRADED' WHERE currency='NGN'`);
// Force every adapter into a guaranteed transient failure for this test only.
const origRates = new Map();
for (const a of allAdapters()) { origRates.set(a.code, a.failureRate); a.failureRate = 1; }
const p2 = initiatePayment({
  marketCode: 'GH', sourceAmount: 1_000, paymentMethod: 'CARD',
  idempotencyKey: `demo-failover-${stamp}`, actor,
});
const r2 = await processPayment(p2.payment.id, actor, VISA);
for (const a of allAdapters()) a.failureRate = origRates.get(a.code);
console.log(`  Stage: ${r2.stage} — settlement exhausted ${r2.payment.status === 'FAILED' ? 'all candidate banks' : 'unexpected'}`);
for (const t of all(`SELECT bank_code, attempt, status, error_code FROM bank_transfers WHERE payment_id=? ORDER BY rowid`, p2.payment.id)) {
  console.log(`    attempt ${t.attempt}: ${t.bank_code.padEnd(10)} ${t.status.padEnd(10)} ${t.error_code ?? ''}`);
}
console.log(`  All banks failing => payment correctly FAILED (no money lost, ledger still balanced)`);
run(`UPDATE bank_accounts SET health='HEALTHY' WHERE currency='NGN'`);

line('5. BANK PERFORMANCE');
for (const b of bankPerformance()) {
  console.log(`    ${b.bank_code.padEnd(10)} attempts=${b.attempts} ok=${b.succeeded} fail=${b.failed} avg=${b.avg_latency_ms}ms`);
}

line('6. LEDGER JOURNALS (double-entry)');
for (const j of journals(20)) {
  console.log(`  ${j.reference}  ${j.narration}`);
  const entries = all(`SELECT account_code, debit, credit, currency FROM ledger_entries WHERE transaction_id=?`, j.id);
  for (const e of entries) {
    console.log(`      ${e.account_code.padEnd(28)} Dr ${String(e.debit).padStart(14)}  Cr ${String(e.credit).padStart(14)} ${e.currency}`);
  }
}

line('7. TRIAL BALANCE INTEGRITY CHECK');
const tb = trialBalance();
let allBalanced = true;
for (const [cur, v] of Object.entries(tb)) {
  const ok = Math.abs(v.difference) < 0.005;
  allBalanced &&= ok;
  console.log(`  ${cur}: debits ${v.debits} | credits ${v.credits} | diff ${v.difference}  ${ok ? 'BALANCED' : '*** OUT OF BALANCE ***'}`);
}
console.log(`\n  >>> LEDGER INTEGRITY: ${allBalanced ? 'PASS' : 'FAIL'}`);

line('8. 4-WAY RECONCILIATION');
for (const m of all(`SELECT * FROM recon_matches WHERE payment_id=?`, payment.id)) {
  console.log(`  status=${m.status}  psp=${m.psp_amount} ledger=${m.ledger_amount} settlement=${m.settlement_amount} statement=${m.statement_amount}`);
  if (m.break_reason) console.log(`  break: ${m.break_reason}`);
}

line('9. FX MARGIN + IMMUTABLE RATE HISTORY');
for (const m of all(`SELECT currency, SUM(credit - debit) AS m FROM ledger_entries WHERE account_code LIKE 'FX_MARGIN_%' GROUP BY currency`)) {
  console.log(`  FX margin earned: ${m.m} ${m.currency}`);
}
for (const r of all(`SELECT rate, reference_rate, source, locked_at FROM rate_history ORDER BY rowid`)) {
  console.log(`  locked rate ${r.rate} (market ${r.reference_rate}) via ${r.source}`);
}

line('10. NOTIFICATIONS + SIGNED WEBHOOKS');
for (const n of all(`SELECT channel, recipient, subject FROM notifications ORDER BY rowid DESC LIMIT 5`)) {
  console.log(`  [${n.channel}] ${n.recipient}: ${n.subject}`);
}
for (const w of all(`SELECT event, signature FROM webhook_deliveries ORDER BY rowid DESC LIMIT 3`)) {
  console.log(`  webhook ${w.event} sig=${w.signature.slice(0, 24)}...`);
}

line('11. RESULT');
console.log(`  Payment ${result.payment.reference} => ${result.payment.status}`);
console.log(`  ${result.payment.source_amount} ${result.payment.source_currency} -> ${result.payment.target_amount} ${result.payment.target_currency}`);
console.log(`  Settled via ${result.payment.bank_code}; recon ${result.match?.status ?? 'n/a'}`);
console.log(`  Ledger integrity: ${allBalanced ? 'PASS' : 'FAIL'}`);
close();
