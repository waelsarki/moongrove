const API_KEY = 'mg_admin_dev_key';
const $ = (id) => document.getElementById(id);

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Failed (${res.status})`);
  return data;
}

const money = (n, c) => new Intl.NumberFormat('en-NG', { maximumFractionDigits: 2 }).format(Number(n) || 0) + (c ? ` ${c}` : '');
const tbl = (headers, rows) => rows.length
  ? `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
  : '<div class="empty">No records.</div>';

function pill(s) {
  const good = ['COMPLETED','SETTLED','RECONCILED','ACTIVE','MATCHED','SUCCEEDED','APPROVE','CLEAR','HEALTHY','LOW'];
  const bad = ['FAILED','REJECTED','DECLINE','UNMATCHED','DOWN'];
  const cls = good.includes(s) ? 'ok' : bad.includes(s) ? 'bad'
    : ['UNDER_REVIEW','PENDING_REVIEW','REVIEW','PARTIAL','DEGRADED','MEDIUM'].includes(s) ? 'warn' : 'info';
  return `<span class="pill ${cls}">${s}</span>`;
}

const LOADERS = {
  dash: loadDash, payments: loadPayments, settle: loadSettle, ledger: loadLedger,
  recon: loadRecon, compliance: loadCompliance, audit: loadAudit,
};

document.querySelectorAll('nav.tabs button[data-tab]').forEach((b) => {
  b.onclick = async () => {
    document.querySelectorAll('nav.tabs button[data-tab]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    for (const t of Object.keys(LOADERS)) $(`tab-${t}`).style.display = t === b.dataset.tab ? 'block' : 'none';
    await LOADERS[b.dataset.tab]();
  };
});

async function loadDash() {
  const d = await api('/api/reports/dashboard');
  $('dashBox').innerHTML = `
    <div class="grid g4">
      <div class="kpi"><div class="l">Total payments</div><div class="v">${d.volumes.count}</div></div>
      <div class="kpi"><div class="l">Completed</div><div class="v">${d.byStatus.find((s) => s.status === 'COMPLETED')?.count ?? 0}</div></div>
      <div class="kpi"><div class="l">Failed</div><div class="v">${d.byStatus.find((s) => s.status === 'FAILED')?.count ?? 0}</div></div>
      <div class="kpi"><div class="l">Settlements ok</div><div class="v">${d.settlements.succeeded ?? 0}/${d.settlements.total ?? 0}</div></div>
    </div>
    <h2 style="margin-top:20px">Payments by status</h2>
    ${tbl(['Status', 'Count'], d.byStatus.map((s) => `<tr><td>${pill(s.status)}</td><td>${s.count}</td></tr>`))}
    <h2 style="margin-top:20px">Corridor performance</h2>
    ${tbl(['Market', 'Count', 'Volume (NGN)'], d.corridors.map((c) => `<tr><td><code>${c.market_code}</code></td><td>${c.count}</td><td>${money(c.volume, 'NGN')}</td></tr>`))}
    <h2 style="margin-top:20px">FX margin earned</h2>
    ${tbl(['Currency', 'Margin'], d.fxMargin.map((f) => `<tr><td>${f.currency}</td><td>${money(f.margin, f.currency)}</td></tr>`))}
    <h2 style="margin-top:20px">Settlement by bank</h2>
    ${tbl(['Bank', 'Payments', 'Settled (NGN)'], d.banks.map((b) => `<tr><td><code>${b.bank_code}</code></td><td>${b.count}</td><td>${money(b.settled, 'NGN')}</td></tr>`))}
    <h2 style="margin-top:20px">Reconciliation health</h2>
    <div class="grid g3">
      <div class="kpi"><div class="l">Matched</div><div class="v">${d.recon.matched ?? 0}</div></div>
      <div class="kpi"><div class="l">Breaks</div><div class="v">${d.recon.breaks ?? 0}</div></div>
      <div class="kpi"><div class="l">Total matches</div><div class="v">${d.recon.total ?? 0}</div></div>
    </div>`;
}

async function loadPayments() {
  const list = await api('/api/payments');
  $('payBox').innerHTML = tbl(
    ['Ref', 'Status', 'Market', 'Paid', 'Received', 'Method / Card', 'Bank', 'Created'],
    list.map((p) => `<tr>
      <td class="mono">${p.reference}</td><td>${pill(p.status)}</td><td><code>${p.market_code}</code></td>
      <td>${money(p.grand_total, p.source_currency)}</td><td>${money(p.target_amount, p.target_currency)}</td>
      <td>${p.payment_method ?? 'CARD'}${p.card_last4 ? `<br><span class="mono muted">${p.card_brand} •••• ${p.card_last4}</span>` : ''}</td>
      <td>${p.bank_code ?? '<span class="muted">—</span>'}</td>
      <td class="mono">${new Date(p.created_at).toLocaleString()}</td></tr>`),
  );
}

async function loadSettle() {
  const [s, perf, accts] = await Promise.all([
    api('/api/settlements'), api('/api/reports/banks'), api('/api/accounts/banks'),
  ]);
  $('stlBox').innerHTML = tbl(
    ['Ref', 'Status', 'Amount', 'Attempts', 'Preferred', 'Final bank'],
    s.map((x) => `<tr><td class="mono">${x.reference}</td><td>${pill(x.status)}</td>
      <td>${money(x.amount, x.currency)}</td><td>${x.attempts}</td>
      <td><code>${x.preferred_bank ?? '—'}</code></td><td><code>${x.final_bank ?? '—'}</code></td></tr>`),
  );
  $('bankPerfBox').innerHTML = tbl(
    ['Bank', 'Attempts', 'Succeeded', 'Failed', 'Success rate', 'Avg latency'],
    perf.map((b) => {
      const rate = b.attempts ? ((b.succeeded / b.attempts) * 100).toFixed(1) : '0.0';
      return `<tr><td><code>${b.bank_code}</code></td><td>${b.attempts}</td><td>${b.succeeded}</td><td>${b.failed}</td>
        <td>${pill(Number(rate) >= 95 ? 'HEALTHY' : Number(rate) >= 80 ? 'DEGRADED' : 'DOWN')} ${rate}%</td>
        <td>${b.avg_latency_ms ?? '—'} ms</td></tr>`;
    }),
  );
  $('bankAcctBox').innerHTML = tbl(
    ['Bank', 'Currency', 'Account', 'Available', 'Health', 'Used today', 'Capacity'],
    accts.map((a) => `<tr><td><code>${a.bank_code}</code></td><td>${a.currency}</td>
      <td class="mono">${a.account_number}</td><td>${money(a.available, a.currency)}</td>
      <td>${pill(a.health)}</td><td>${money(a.daily_used, a.currency)}</td><td>${money(a.daily_capacity, a.currency)}</td></tr>`),
  );
}

async function loadLedger() {
  const [tb, bals] = await Promise.all([api('/api/ledger/trial-balance'), api('/api/ledger/balances')]);
  $('tbBox').innerHTML = tbl(
    ['Currency', 'Total debits', 'Total credits', 'Difference'],
    Object.entries(tb).map(([cur, v]) => `<tr><td><strong>${cur}</strong></td>
      <td>${money(v.debits, cur)}</td><td>${money(v.credits, cur)}</td>
      <td>${pill(Math.abs(v.difference) < 0.005 ? 'BALANCED' : 'OUT OF BALANCE')} ${v.difference}</td></tr>`),
  );
  $('balBox').innerHTML = tbl(
    ['Account', 'Currency', 'Debits', 'Credits', 'Balance'],
    bals.map((b) => `<tr><td class="mono">${b.account}</td><td>${b.currency}</td>
      <td>${money(b.debit, b.currency)}</td><td>${money(b.credit, b.currency)}</td>
      <td><strong>${money(b.balance, b.currency)}</strong></td></tr>`),
  );
}

async function loadRecon() {
  const [breaks, matches] = await Promise.all([api('/api/reconciliation/breaks'), api('/api/reconciliation/matches')]);
  $('breakBox').innerHTML = tbl(
    ['Payment', 'Status', 'Break reason'],
    breaks.map((b) => `<tr><td class="mono">${b.reference}</td><td>${pill(b.status)}</td><td>${b.break_reason}</td></tr>`),
  );
  $('matchBox').innerHTML = tbl(
    ['Payment', 'Status', 'PSP', 'Ledger', 'Settlement', 'Statement'],
    matches.map((m) => `<tr><td class="mono">${m.payment_id.slice(0, 14)}…</td>
      <td>${pill(m.status)}</td><td>${m.psp_amount}</td><td>${m.ledger_amount}</td>
      <td>${m.settlement_amount}</td><td>${m.statement_amount ?? '—'}</td></tr>`),
  );
}

async function loadCompliance() {
  const [queue, customers] = await Promise.all([api('/api/kyc/review-queue'), api('/api/customers')]);
  $('queueBox').innerHTML = tbl(
    ['Ref', 'Name', 'Type', 'Risk', 'KYC', 'Status', 'Action'],
    queue.map((c) => `<tr><td class="mono">${c.reference}</td><td>${c.full_name}</td><td>${c.type}</td>
      <td>${c.risk_score} ${pill(c.risk_band)}</td><td>${c.kyc_status}</td><td>${pill(c.status)}</td>
      <td><button class="ghost" onclick="review('${c.id}','APPROVE')">Approve</button>
          <button class="ghost" onclick="review('${c.id}','REJECT')">Reject</button></td></tr>`),
  );
  $('custBox').innerHTML = tbl(
    ['Ref', 'Name', 'Email', 'Country', 'Status', 'KYC', 'Risk'],
    customers.map((c) => `<tr><td class="mono">${c.reference}</td><td>${c.full_name}</td><td>${c.email}</td>
      <td>${c.country}</td><td>${pill(c.status)}</td><td>${c.kyc_status}</td><td>${c.risk_score} ${pill(c.risk_band)}</td></tr>`),
  );
}

async function review(id, decision) {
  await api(`/api/kyc/${id}/review`, 'POST', { decision });
  await loadCompliance();
}

async function loadAudit() {
  const log = await api('/api/admin/audit');
  $('auditBox').innerHTML = tbl(
    ['Time', 'Actor', 'Role', 'Action', 'Result'],
    log.map((a) => `<tr><td class="mono">${new Date(a.created_at).toLocaleTimeString()}</td>
      <td class="mono">${a.actor}</td><td>${a.role}</td>
      <td class="mono">${a.action}</td><td class="mono muted">${a.details ?? ''}</td></tr>`),
  );
}

(async () => {
  try { await loadDash(); }
  catch (e) { document.body.insertAdjacentHTML('afterbegin', `<div class="msg err">Failed to load dashboard: ${e.message}</div>`); }
})();
