const API_KEY = 'mg_customer_dev_key';
const LIFECYCLE = ['INITIATED','PAYMENT_PENDING','PAYMENT_RECEIVED','VERIFICATION','FX_QUOTED','FX_CONVERTED','SETTLEMENT_PENDING','SETTLED','RECONCILED','COMPLETED'];

const state = { markets: [], methods: [], quote: null, method: 'CARD' };

const $ = (id) => document.getElementById(id);

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

const money = (n, c) => new Intl.NumberFormat('en-NG', { maximumFractionDigits: 2 }).format(Number(n) || 0) + (c ? ` ${c}` : '');
const currentMarket = () => state.markets.find((m) => m.code === $('pMarket').value);

function statusPill(s) {
  const good = ['COMPLETED','SETTLED','RECONCILED','MATCHED','SUCCEEDED'];
  const bad = ['FAILED','REJECTED','DECLINE','UNMATCHED'];
  const cls = good.includes(s) ? 'ok' : bad.includes(s) ? 'bad' : ['UNDER_REVIEW','PARTIAL'].includes(s) ? 'warn' : 'info';
  return `<span class="pill ${cls}">${s}</span>`;
}

function setProgress(step) {
  document.querySelectorAll('.progress li').forEach((li) => {
    const i = Number(li.dataset.step);
    li.classList.toggle('done', i < step);
    li.classList.toggle('current', i === step);
  });
}

function reveal(id, scroll = false) {
  const el = $(id);
  const wasHidden = el.style.display === 'none';
  if (wasHidden) el.style.display = 'block';
  if (scroll && wasHidden) {
    requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }
}

let requoteTimer = null;
function scheduleRequote() {
  if (!state.quote) return;
  clearTimeout(requoteTimer);
  requoteTimer = setTimeout(() => getQuote({ silent: true }).catch(() => {}), 700);
}

document.querySelectorAll('nav.tabs button[data-tab]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav.tabs button[data-tab]').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    ['pay','history','quotes'].forEach((t) => { $(`tab-${t}`).style.display = t === b.dataset.tab ? 'block' : 'none'; });
    if (b.dataset.tab === 'history') loadHistory();
    if (b.dataset.tab === 'quotes') loadRates();
  };
});

async function init() {
  const [ref, methods] = await Promise.all([api('/api/reference'), api('/api/payment-methods')]);
  state.markets = ref.markets;
  state.methods = methods;

  $('statMarkets').textContent = state.markets.length;
  $('statBanks').textContent = ref.banks?.length ?? $('statBanks').textContent;
  setProgress(1);

  $('pMarket').innerHTML = state.markets
    .map((m) => `<option value="${m.code}">${m.country} — pay in ${m.localCurrency}</option>`).join('');
  $('marketBox').innerHTML = `<table><thead><tr><th>Market</th><th>Country</th><th>Local currency</th><th>Corridors</th></tr></thead><tbody>${
    state.markets.map((m) => `<tr><td><code>${m.code}</code></td><td>${m.country}</td><td>${m.localCurrency}</td><td>${m.corridors.join(', ')}</td></tr>`).join('')
  }</tbody></table>`;

  const codes = ref.currencies.map((c) => c.code);
  $('rBase').innerHTML = codes.map((c) => `<option>${c}</option>`).join('');
  $('rQuote').innerHTML = codes.map((c) => `<option>${c}</option>`).join('');
  $('rQuote').value = 'NGN';

  $('methodBox').innerHTML = state.methods.map((m) => `
    <button class="ghost method" data-code="${m.code}" style="text-align:left;padding:15px">
      <div style="font-weight:700;font-size:14px">${m.name}</div>
      <div class="sub" style="margin-top:4px">${m.description}</div>
    </button>`).join('');
  [...document.querySelectorAll('.method')].forEach((b) => {
    b.onclick = () => selectMethod(b.dataset.code);
  });

  $('cNumber').oninput = (e) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 19);
    e.target.value = v.replace(/(.{4})/g, '$1 ').trim();
    detectBrand();
  };
  $('cExp').oninput = (e) => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (v.length > 2) v = `${v.slice(0, 2)}/${v.slice(2)}`;
    e.target.value = v;
  };
  $('cCvv').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); };

  $('btnQuote').onclick = () => getQuote();
  $('btnPay').onclick = pay;
  $('pAmount').addEventListener('input', scheduleRequote);
  $('pAmount').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); getQuote(); }
  });
  ['pMarket', 'pTarget'].forEach((id) => $(id).addEventListener('change', scheduleRequote));
  loadRates();
}

function detectBrand() {
  const n = $('cNumber').value.replace(/\D/g, '');
  let brand = '';
  if (/^4/.test(n)) brand = 'Visa';
  else if (/^(5[1-5]|2[2-7])/.test(n)) brand = 'Mastercard';
  else if (/^(5061|50|65|636)/.test(n)) brand = 'Verve';
  $('brandHint').innerHTML = brand
    ? `<strong style="color:var(--brand)">${brand} detected</strong>`
    : 'Visa, Mastercard or Verve';
}

async function getQuote(opts = {}) {
  const silent = Boolean(opts.silent);
  const first = !state.quote;
  const market = currentMarket();
  if (!silent) {
    $('quoteBox').innerHTML = '<div class="msg info">Fetching live rate…</div>';
    $('btnQuote').disabled = true;
    $('btnQuote').classList.add('loading');
  }
  try {
    const q = await api('/api/fx/quotes', 'POST', {
      sourceCurrency: market.localCurrency,
      targetCurrency: $('pTarget').value,
      amount: Number($('pAmount').value),
    });
    state.quote = q;
    const grandTotal = Number($('pAmount').value) + Number(q.partner_fee) + Number(q.bank_fee);
    $('payBtnAmount').textContent = money(grandTotal, q.source_currency);

    $('quoteBox').innerHTML = `<div class="quote-box">
      <div class="spread" style="margin-bottom:10px">
        <strong>Live quote &middot; <code>${q.reference}</code></strong>
        <span class="pill info">rate held 5 min</span>
      </div>
      <div class="row"><span class="muted">You send</span><span>${money(q.source_amount, q.source_currency)}</span></div>
      <div class="row"><span class="muted">Market rate</span><span>${q.reference_rate}</span></div>
      <div class="row"><span class="muted">MOONGROVE rate</span><span>${q.rate}</span></div>
      <div class="row"><span class="muted">Processing fee</span><span>${money(q.partner_fee, q.source_currency)}</span></div>
      <div class="row"><span class="muted">Total to pay</span><span>${money(grandTotal, q.source_currency)}</span></div>
      <div class="row"><span>You receive</span><span>${money(q.target_amount, q.target_currency)}</span></div>
    </div>`;

    if (first) {
      reveal('methodCard', true);
      selectMethod('CARD');
    }
  } catch (e) {
    if (!silent) $('quoteBox').innerHTML = `<div class="msg err">${e.message}</div>`;
  } finally {
    if (!silent) {
      $('btnQuote').disabled = false;
      $('btnQuote').classList.remove('loading');
    }
  }
}

function selectMethod(code) {
  state.method = code;
  [...document.querySelectorAll('.method')].forEach((b) => {
    const on = b.dataset.code === code;
    b.style.borderColor = on ? 'var(--brand)' : 'var(--line-strong)';
    b.style.background = on ? 'var(--brand-soft)' : 'var(--panel)';
    b.style.boxShadow = on ? '0 0 0 1px var(--brand)' : 'var(--shadow-sm)';
  });
  const isCard = code === 'CARD';
  reveal('cardFormCard');
  if (!isCard) $('cardFormCard').style.display = 'none';
  $('methodNote').style.display = isCard ? 'none' : 'block';
  setProgress(isCard ? 3 : 2);
  if (!isCard) {
    const m = state.methods.find((x) => x.code === code);
    $('methodNote').innerHTML = `You chose <strong>${m.name}</strong>. Transfer instructions are issued once the rate is locked.`;
  }
}

async function pay() {
  const market = currentMarket();
  if (!(Number($('pAmount').value) > 0)) {
    $('payMsg').innerHTML = '<div class="msg err">Enter an amount greater than zero</div>';
    return;
  }

  let card = null;
  if (state.method === 'CARD') {
    const [mm, yy] = $('cExp').value.split('/');
    card = {
      number: $('cNumber').value,
      expMonth: mm, expYear: yy, cvv: $('cCvv').value,
      holderName: $('cNameOnCard').value || $('pName').value,
    };
  }

  $('btnPay').disabled = true;
  $('btnPay').classList.add('loading');
  $('payMsg').innerHTML = '<div class="msg info">Authorising your card…</div>';
  try {
    const created = await api('/api/payments', 'POST', {
      marketCode: market.code,
      sourceAmount: Number($('pAmount').value),
      paymentMethod: state.method,
      email: $('pEmail').value || null,
      name: $('pName').value || null,
      idempotencyKey: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    const paymentId = created.payment.id;

    const result = await api(`/api/payments/${paymentId}/process`, 'POST', card ? { card } : {});

    if (result.stage === 'CARD_DECLINED') {
      $('payMsg').innerHTML = `<div class="msg err"><strong>Card declined.</strong> ${result.error}. Please try another card.</div>`;
      return;
    }
    $('payMsg').innerHTML = '';
    renderFlow(result.payment, result);
    $('flowCard').style.display = 'block';
  } catch (e) {
    $('payMsg').innerHTML = `<div class="msg err">${e.message}</div>`;
  } finally {
    $('btnPay').disabled = false;
    $('btnPay').classList.remove('loading');
  }
}

async function renderFlow(payment, result) {
  setProgress(4);
  const idx = LIFECYCLE.indexOf(payment.status);
  $('flow').innerHTML = LIFECYCLE.map((s, i) => {
    const cls = payment.status === s ? 'current' : (idx > i && idx >= 0 ? 'done' : '');
    return `<div class="step ${cls}">${s.replace(/_/g, ' ')}</div>`;
  }).join('');

  const ok = payment.status === 'COMPLETED';
  const failed = ['FAILED', 'REVERSED', 'REFUNDED', 'CANCELLED', 'UNDER_REVIEW'].includes(payment.status);
  $('receiptBox').innerHTML = `<div class="quote-box ${ok ? 'ok' : failed ? 'bad' : ''}">
    <div class="spread" style="margin-bottom:10px">
      <strong>${ok ? 'Payment successful' : `Payment ${payment.status}`}</strong>
      <code>${payment.reference}</code>
    </div>
    <div class="row"><span class="muted">You paid</span><span>${money(payment.grand_total, payment.source_currency)}</span></div>
    <div class="row"><span class="muted">Card</span><span>${payment.card_brand ?? '—'} •••• ${payment.card_last4 ?? '—'}</span></div>
    <div class="row"><span class="muted">Auth code</span><span class="mono">${payment.card_auth_code ?? '—'}</span></div>
    <div class="row"><span class="muted">Rate applied</span><span>${state.quote?.rate ?? '—'}</span></div>
    <div class="row"><span>You received</span><span>${money(payment.target_amount, payment.target_currency)}</span></div>
    <div class="row"><span class="muted">Settled via</span><span>${payment.bank_code ?? '—'}</span></div>
  </div>`;

  const detail = await api(`/api/payments/${payment.id}`);
  $('timeline').innerHTML = `<table><thead><tr><th>Status</th><th>Detail</th><th>Time</th></tr></thead><tbody>${
    detail.timeline.map((e) => `<tr><td>${statusPill(e.to_status)}</td><td>${e.reason ?? ''}</td>
      <td class="mono">${new Date(e.created_at).toLocaleTimeString()}</td></tr>`).join('')
  }</tbody></table>
  ${result?.settlement?.failoverFrom?.length ? `<div class="msg info">Routed past ${result.settlement.failoverFrom.map((f) => f.bank).join(', ')} to <strong>${result.settlement.bank}</strong>.</div>` : ''}
  ${result?.match ? `<div class="msg ${result.match.status === 'MATCHED' ? 'ok' : 'err'}">Reconciliation: <strong>${result.match.status}</strong></div>` : ''}`;
  requestAnimationFrame(() => $('flowCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

async function loadHistory() {
  $('historyBox').innerHTML = '<div class="empty">Payments are private to each session in guest checkout mode. Check your admin console for the full ledger.</div>';
}

async function loadRates() {
  const base = $('rBase').value, quote = $('rQuote').value;
  try {
    const r = await api(`/api/fx/rate/${base}/${quote}`);
    $('rateBox').innerHTML = `<div class="kpi"><div class="l">${base} / ${quote}</div><div class="v">${r.rate}</div><div class="sub">source: ${r.source}</div></div>`;
  } catch (e) {
    $('rateBox').innerHTML = `<div class="msg err">${e.message}</div>`;
  }
}
$('rBase').onchange = loadRates;
$('rQuote').onchange = loadRates;

init().catch((e) => {
  document.body.insertAdjacentHTML('afterbegin', `<div class="msg err">Startup failed: ${e.message}</div>`);
});

