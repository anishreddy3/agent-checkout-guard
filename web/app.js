// Agent Checkout Guard dashboard. Vanilla JS, polls the API every 2 seconds.
// API_BASE is empty when served by the same origin (Cloud Run or Firebase
// Hosting rewrites). Set window.API_BASE to point elsewhere.
const API = window.API_BASE || '';
const $ = (s) => document.querySelector(s);
const fmt = (minor, cur = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format((minor || 0) / 100);
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const OUTCOME = {
  approve: { label: 'Approved', icon: 'check', ucp: 'completed' },
  step_up: { label: 'Step-up', icon: 'alert', ucp: 'requires_escalation' },
  decline: { label: 'Declined', icon: 'x', ucp: 'canceled' },
};
const chip = (outcome, cls = '') => {
  const o = OUTCOME[outcome];
  return o ? `<span class="chip ${outcome} ${cls}">${icon(o.icon)}${o.label}</span>` : `<span class="chip neutral ${cls}">${esc(outcome)}</span>`;
};
// Plain-language names for the Guard's finding codes (server/guard/rules.js).
const FINDING = {
  quote_mismatch: 'Charge differs from quote',
  quote_drift: 'Price moved after quote',
  over_transaction_cap: 'Over per-purchase cap',
  over_daily_cap: 'Over daily cap',
  near_daily_cap: 'Near daily cap',
  velocity_exceeded: 'Velocity limit hit',
  velocity_elevated: 'High purchase rate',
  duplicate_purchase: 'Duplicate order',
  quantity_inflated: 'More than the human asked for',
  unrequested_item: 'Item not requested',
  quantity_over_policy: 'Quantity over policy',
  unverified_seller: 'Unverified seller',
  category_not_allowed: 'Category not allowed',
  missing_payment_credential: 'No payment credential',
};
const findingChip = (f) => {
  const code = typeof f === 'string' ? f : f.code;
  const sev = typeof f === 'string' ? '' : f.severity;
  const title = typeof f === 'string' ? code : `${code}: ${f.detail}`;
  return `<span class="finding ${esc(sev)}" title="${esc(title)}"><i></i>${esc(FINDING[code] ?? code)}</span>`;
};
const agentShort = (profile) => String(profile || '').split('/').pop();
const sellerShort = (name) => String(name || '').replace(' (example seller)', '');

async function api(path, opts) {
  const r = await fetch(API + path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  return r.json();
}

let currentRun = null;
let rendered = { id: null, count: 0 };
let scenarios = [];
let sellers = [];
let decisions = [];
let status = null;

// ---- theme -------------------------------------------------------------------
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function paintThemeButton() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  $('#theme').innerHTML = icon(next === 'dark' ? 'moon' : 'sun');
  $('#theme').setAttribute('aria-label', `Switch to ${next} theme`);
}
$('#theme').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('acg-theme', next); } catch {}
  paintThemeButton();
});

// ---- status ------------------------------------------------------------------
async function loadStatus() {
  try {
    status = await api('/api/status');
    const g = status.gemini.configured
      ? `<li class="pill"><span class="dot on"></span><span>Gemini <b>${esc(status.gemini.model)}</b>${status.gemini.vertex ? ' on Vertex AI' : ''}</span></li>`
      : `<li class="pill"><span class="dot off"></span><span>Gemini <b>off</b>, rules-only explanations</span></li>`;
    $('#status').innerHTML = `${g}<li class="pill"><span>Store <b>${status.store === 'firestore' ? 'Firestore' : 'in-memory'}</b></span></li><li class="pill"><span>UCP <b>${esc(status.ucp_version)}</b></span></li>`;
    $('#dec-meta').textContent = `Newest first, ${status.store === 'firestore' ? 'live from Firestore' : 'in-memory store'}`;
  } catch {
    $('#status').innerHTML = '<li class="pill"><span class="dot off"></span><span>API unreachable, retrying</span></li>';
  }
}

// ---- scenarios ---------------------------------------------------------------
async function loadScenarios() {
  scenarios = await api('/api/scenarios');
  $('#scenarios').innerHTML = scenarios
    .map(
      (s) => `
      <button type="button" class="scenario" data-run="${esc(s.id)}">
        <span class="row"><span class="title">${esc(s.title)}</span><span class="tag">${esc(s.track)}</span></span>
        <span class="req">“${esc(s.request)}”</span>
        <span class="foot-row"><span>Expected ${chip(s.expected_outcome, 'sm')} · ${s.purchases} purchase${s.purchases > 1 ? 's' : ''}</span><span class="go">${icon('play')}Run</span></span>
      </button>`
    )
    .join('');
  $('#scenarios').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-run]');
    if (!btn || btn.disabled) return;
    const mode = document.querySelector('input[name="mode"]:checked')?.value ?? 'auto';
    setRunning(true, btn.dataset.run);
    try {
      currentRun = await api('/api/runs', { method: 'POST', body: JSON.stringify({ scenario_id: btn.dataset.run, mode }) });
      renderRun(currentRun);
      if (matchMedia('(max-width: 920px)').matches) $('#run').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (err) {
      $('#run-body').innerHTML = `<div class="empty-run"><h3>That run could not start</h3><p>${esc(err.message)}. Check that the service is up, then try again.</p></div>`;
      setRunning(false);
    }
  });
}
function setRunning(on, activeId) {
  document.querySelectorAll('[data-run]').forEach((b) => {
    b.disabled = on;
    if (activeId) b.classList.toggle('active', b.dataset.run === activeId);
    const go = b.querySelector('.go');
    if (go) go.innerHTML = on && b.dataset.run === activeId ? 'Running…' : `${icon('play')}Run`;
  });
}

// ---- live run ----------------------------------------------------------------
function renderEmptyRun() {
  $('#run-meta').innerHTML = '';
  $('#run-body').innerHTML = `
    <div class="empty-run">
      <h3>Pick a scenario to watch one agent purchase end to end</h3>
      <ol>
        <li>The agent discovers the seller at <code>/.well-known/ucp</code> and reads its prices.</li>
        <li>It opens a UCP checkout session and calls Complete Checkout.</li>
        <li>The Guard decides before any charge and explains why. Step-ups land in “Needs a human”.</li>
      </ol>
      <button type="button" class="btn primary first" data-start="normal">${icon('play')}Start with a routine purchase</button>
    </div>`;
}
$('#run-body').addEventListener('click', async (e) => {
  const start = e.target.closest('[data-start]');
  if (start) return document.querySelector(`[data-run="${start.dataset.start}"]`)?.click();
  const rv = e.target.closest('[data-review]');
  if (rv) await review(rv);
});

const decisionById = (id) => decisions.find((d) => d.id === id);

function verdictCard(r, { full }) {
  const d = decisionById(r.decision_id);
  const threshold = d?.policy_snapshot?.step_up_threshold ?? 40;
  const findings = d?.findings?.length ? d.findings : r.findings.map((code) => ({ code }));
  const reviewed = d?.review;
  const actions =
    r.outcome === 'step_up' && full
      ? reviewed
        ? `<span class="meta">${reviewed.action === 'approve' ? 'Approved' : 'Rejected'} by a reviewer.</span>`
        : `<div class="actions"><button type="button" class="btn approve" data-review="approve" data-id="${esc(r.decision_id)}">${icon('check')}Approve purchase</button><button type="button" class="btn reject" data-review="reject" data-id="${esc(r.decision_id)}">${icon('x')}Reject</button></div>`
      : '';
  return `<div class="verdict ${esc(r.outcome)}">
    <div class="verdict-top">${chip(r.outcome)}<span class="ucp">UCP status <code translate="no">${esc(r.status)}</code>${r.order_id ? ` · order <code>${esc(r.order_id)}</code>` : ''}</span></div>
    <div class="risk">
      <div class="risk-row"><span>Risk <b>${r.risk_score}</b>/100</span><span>Step-up at ${threshold}</span></div>
      <div class="meter"><span class="fill ${esc(r.outcome)}" style="transform:scaleX(${Math.min(100, r.risk_score) / 100})"></span><span class="tick" style="left:calc(${threshold}% - 1px)"></span></div>
    </div>
    <p class="exp">${esc(r.explanation)}</p>
    ${d?.explanation_source === 'gemini' ? `<span class="by">${icon('spark')}Explanation written by Gemini</span>` : ''}
    ${findings.length ? `<div class="findings">${findings.map(findingChip).join('')}</div>` : ''}
    ${actions}
  </div>`;
}

function stepHtml(st, i, lastGuard) {
  if (st.kind === 'intent') {
    const items = st.result.items.map((x) => `${x.quantity} × ${x.item_id}`).join(', ');
    return { cls: 'intent', ic: 'user', k: 'Human intent', body: `<div class="txt">${esc(items)}</div><div class="io">read from the request by ${st.result.source === 'gemini' ? 'Gemini' : 'the scenario'}, sent to the Guard as risk_signals.intent</div>` };
  }
  if (st.kind === 'thought') return { cls: 'agent', ic: 'bot', k: 'Agent', body: `<div class="txt">${esc(st.text)}</div>` };
  if (st.kind === 'tool') {
    const res = st.result ? `<div class="io">→ ${esc(JSON.stringify(st.result))}</div>` : st.note ? `<div class="io">${esc(st.note)}</div>` : '';
    return { cls: 'ucp', ic: 'store', k: `UCP ${st.name.replace(/_/g, ' ')}`, body: `${st.args ? `<div class="io">${esc(JSON.stringify(st.args))}</div>` : ''}${res}` };
  }
  if (st.kind === 'guard') {
    const r = st.result;
    if (i === lastGuard) return { cls: 'guard', ic: 'shield', k: 'Guard decision', body: verdictCard(r, { full: true }), verdict: true };
    return { cls: 'guard', ic: 'shield', k: 'Guard', body: `<div class="txt">${chip(r.outcome, 'sm')} risk ${r.risk_score}/100 · ${esc(r.explanation)}</div>` };
  }
  if (st.kind === 'final') return { cls: 'agent', ic: 'bot', k: 'Agent report', body: `<div class="txt">${esc(st.text)}</div>` };
  if (st.kind === 'error') return { cls: 'error', ic: 'alert', k: `Error in ${esc(st.name)}`, body: `<div class="txt">${esc(st.text)}</div>` };
  return null;
}

function renderRun(run) {
  const firstPaint = rendered.id !== run.id;
  const prev = firstPaint ? 0 : rendered.count;
  const meta = [`<span class="chip neutral sm">${run.mode === 'gemini' ? `Gemini agent${run.model ? ' · ' + esc(run.model) : ''}` : 'Scripted agent'}</span>`];
  if (run.status === 'done') {
    meta.push(
      run.matched_expectation
        ? `<span class="chip approve sm">${icon('check')}As expected</span>`
        : `<span class="chip step_up sm" title="Expected ${esc(OUTCOME[run.expected_outcome]?.label)}">${icon('alert')}Expected ${esc(OUTCOME[run.expected_outcome]?.label ?? run.expected_outcome)}</span>`
    );
    if (run.http_calls) meta.push(`<span class="chip neutral sm">${run.http_calls} UCP calls</span>`);
  }
  $('#run-meta').innerHTML = meta.join('');

  const lastGuard = run.steps.map((s) => s.kind).lastIndexOf('guard');
  const steps = run.steps
    .map((st, i) => {
      const h = stepHtml(st, i, lastGuard);
      if (!h) return '';
      const isNew = i >= prev && !firstPaint ? ' new' : '';
      return h.verdict
        ? `<li class="step ${h.cls}${isNew}"><span class="node">${icon(h.ic)}</span><div><div class="k">${h.k}</div></div></li><li class="step-verdict${isNew}">${h.body}</li>`
        : `<li class="step ${h.cls}${isNew}"><span class="node">${icon(h.ic)}</span><div><div class="k">${h.k}</div>${h.body}</div></li>`;
    })
    .join('');
  const working = run.status === 'running' ? '<div class="working"><i></i>Agent working…</div>' : '';
  const err = run.status === 'error' ? `<ol class="timeline"><li class="step error"><span class="node">${icon('alert')}</span><div><div class="k">Run failed</div><div class="txt">${esc(run.error)}</div></div></li></ol>` : '';
  const body = $('#run-body');
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
  body.innerHTML = `
    <div class="run-head">
      <span class="title">${esc(run.title)}</span>
      <q>${esc(run.request)}</q>
      <span class="who">${icon('bot')}${esc(agentShort(run.agent_profile))}</span>
    </div>
    <ol class="timeline">${steps}</ol>${err}${working}`;
  if (nearBottom || firstPaint) body.scrollTop = body.scrollHeight;
  rendered = { id: run.id, count: run.steps.length };
}

async function pollRun() {
  if (!currentRun || currentRun.status !== 'running') return;
  try {
    currentRun = await api(`/api/runs/${currentRun.id}`);
  } catch {
    return;
  }
  if (currentRun.status !== 'running') {
    setRunning(false, currentRun.scenario_id);
    const o = OUTCOME[currentRun.final_outcome]?.label ?? currentRun.status;
    $('#run-announce').textContent = `${currentRun.title}: ${o}.`;
    await refresh();
  }
  renderRun(currentRun);
}

async function review(btn) {
  const row = btn.closest('.actions');
  row?.querySelectorAll('button').forEach((b) => (b.disabled = true));
  btn.textContent = btn.dataset.review === 'approve' ? 'Approving…' : 'Rejecting…';
  try {
    await api(`/api/decisions/${btn.dataset.id}/review`, { method: 'POST', body: JSON.stringify({ action: btn.dataset.review, reviewer: 'dashboard' }) });
  } catch (err) {
    btn.textContent = 'Failed, try again';
    row?.querySelectorAll('button').forEach((b) => (b.disabled = false));
    return;
  }
  await refresh();
  if (currentRun) renderRun(currentRun);
}

// ---- metrics -----------------------------------------------------------------
function renderMetrics() {
  const by = (o) => decisions.filter((d) => d.outcome === o);
  const blocked = by('decline').reduce((a, d) => a + d.total, 0);
  const median = (field) => {
    const v = decisions.map((d) => d[field]).filter((x) => typeof x === 'number').sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const ms = (n) => (n === null ? '–' : n < 1 ? '<1 ms' : `${n.toLocaleString()} ms`);
  const decideMs = median('decision_ms') ?? median('latency_ms');
  const explainMs = median('explain_ms');
  const gem = decisions.filter((d) => d.explanation_source === 'gemini').length;
  const pending = by('step_up').filter((d) => !d.review).length;
  const items = [
    ['Checkouts guarded', decisions.length, 'Complete Checkout calls', ''],
    ['Approved', by('approve').length, 'went straight to order', 'approve'],
    ['Step-ups', by('step_up').length, pending ? `${pending} waiting for a human` : 'all reviewed', 'step_up'],
    ['Declined', by('decline').length, 'stopped before any charge', 'decline'],
    ['Spend blocked', fmt(blocked), 'would have been charged', '', 'lead'],
    ['Risk decision, median', ms(decideMs), gem ? `+ ${ms(explainMs)} for Gemini's explanation (${gem} of ${decisions.length})` : 'rules only, no Gemini explanations', ''],
  ];
  $('#metric-list').innerHTML = items
    .map(([l, v, n, sw, cls]) => `<div class="metric ${cls ?? ''}"><div class="label">${sw ? `<i class="sw-${sw}"></i>` : ''}${l}</div><div class="value">${v}</div><div class="note">${n}</div></div>`)
    .join('');
  const total = decisions.length || 1;
  const mix = ['approve', 'step_up', 'decline'].map((o) => [o, by(o).length]);
  $('#mix').innerHTML = decisions.length ? mix.map(([o, n]) => `<span class="sw-${o}" style="flex-grow:${n / total}"></span>`).join('') : '';
  $('#mix').setAttribute('aria-label', decisions.length ? `Outcome mix: ${mix.map(([o, n]) => `${n} ${OUTCOME[o].label.toLowerCase()}`).join(', ')}` : 'No decisions yet');
}

// ---- review queue ------------------------------------------------------------
function renderQueue() {
  const waiting = decisions.filter((d) => d.outcome === 'step_up' && !d.review);
  $('#queue-count').hidden = !waiting.length;
  $('#queue-count').textContent = waiting.length;
  $('#queue-list').innerHTML = waiting.length
    ? waiting
        .map(
          (d) => `<div class="qitem" id="q-${esc(d.checkout_id)}">
        <div>
          <div class="what"><span class="amt">${fmt(d.total, d.currency)}</span><span>${esc(sellerShort(d.seller_name))}</span><span class="meta">${d.cart.map((c) => `${c.quantity} × ${esc(c.title)}`).join(', ')}</span><span class="meta">by ${esc(agentShort(d.agent_profile))}, ${ago(d.at)}</span></div>
          <p class="why">${esc(d.explanation)}</p>
        </div>
        <div class="actions"><button type="button" class="btn approve" data-review="approve" data-id="${esc(d.id)}">${icon('check')}Approve</button><button type="button" class="btn reject" data-review="reject" data-id="${esc(d.id)}">${icon('x')}Reject</button></div>
      </div>`
        )
        .join('')
    : `<p class="queue-empty">${icon('check')}Nothing waiting. Purchases the Guard is unsure about appear here with Approve and Reject.</p>`;
}
$('#queue-list').addEventListener('click', (e) => {
  const rv = e.target.closest('[data-review]');
  if (rv) review(rv);
});

// ---- decision log ------------------------------------------------------------
function renderDecisions() {
  const rows = decisions.map((d) => {
    const cart = d.cart.map((c) => `${c.quantity} × ${esc(c.title)}`).join('<br>');
    const rv = d.outcome === 'step_up' ? `<span class="rv">${d.review ? `${d.review.action === 'approve' ? 'Approved' : 'Rejected'} by reviewer` : 'Waiting for a human'}</span>` : '';
    return `<tr id="dec-${esc(d.id)}">
      <td class="when" title="${esc(d.at)}">${ago(d.at)}</td>
      <td class="ag"><span class="agent">${esc(agentShort(d.agent_profile))}</span></td>
      <td class="sc"><div class="sname">${esc(sellerShort(d.seller_name))}</div><div class="cart">${cart}</div></td>
      <td class="num">${fmt(d.total, d.currency)}</td>
      <td class="rk"><div class="risk-cell"><div class="meter"><span class="fill ${esc(d.outcome)}" style="transform:scaleX(${Math.min(100, d.risk_score) / 100})"></span></div><span>${d.risk_score}</span></div></td>
      <td class="oc">${chip(d.outcome, 'sm')}${rv}</td>
      <td class="why">${esc(d.explanation)}${d.findings.length ? `<div class="findings">${d.findings.map(findingChip).join('')}</div>` : ''}</td>
    </tr>`;
  });
  $('#decisions tbody').innerHTML =
    rows.join('') || '<tr class="empty-row"><td colspan="7">No decisions yet. Run a scenario and every Complete Checkout the Guard sees lands here.</td></tr>';
}

// ---- sellers -----------------------------------------------------------------
function renderSellers(sessions) {
  $('#sellers').innerHTML = sellers
    .map((s) => {
      const mine = sessions.filter((x) => x.seller_id === s.id);
      const done = mine.filter((x) => x.status === 'completed');
      const rev = done.reduce((a, x) => a + (x.totals.find((t) => t.type === 'total')?.amount ?? 0), 0);
      return `<div class="seller">
        <div class="row"><span class="name">${icon('store')}${esc(sellerShort(s.name))}</span><span class="tag ${s.trust.verified ? 'ok' : 'no'}">${s.trust.verified ? 'Verified' : 'Unverified'}</span></div>
        <div class="meta">${esc(s.description)}</div>
        <div class="nums"><span>${mine.length} sessions</span><span>${done.length} orders</span><span>${fmt(rev, s.currency)} completed</span></div>
        <div class="links"><a href="${API}/sellers/${esc(s.id)}/.well-known/ucp" target="_blank" rel="noopener">/.well-known/ucp</a><a href="${API}/sellers/${esc(s.id)}/catalog" target="_blank" rel="noopener">Catalog JSON</a></div>
      </div>`;
    })
    .join('');
}

// ---- policy ------------------------------------------------------------------
const AGENTS = ['https://platform.example/agents/procurement-bot', 'https://platform.example/agents/marketing-ops-bot'];
async function loadPolicy() {
  const profile = $('#policy-agent').value;
  const p = await api(`/api/policy?profile=${encodeURIComponent(profile)}`);
  const f = $('#policy-form');
  f.per_transaction_cap.value = p.per_transaction_cap / 100;
  f.daily_cap.value = p.daily_cap / 100;
  f.max_quantity_per_line.value = p.max_quantity_per_line;
  f.step_up_threshold.value = p.step_up_threshold;
  f.require_verified_seller.checked = Boolean(p.require_verified_seller);
}
$('#policy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const policy = {
    per_transaction_cap: Math.round(Number(f.per_transaction_cap.value) * 100),
    daily_cap: Math.round(Number(f.daily_cap.value) * 100),
    max_quantity_per_line: Number(f.max_quantity_per_line.value),
    step_up_threshold: Number(f.step_up_threshold.value),
    require_verified_seller: f.require_verified_seller.checked,
  };
  const btn = $('#policy-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await api('/api/policy', { method: 'POST', body: JSON.stringify({ profile: $('#policy-agent').value, policy }) });
    $('#policy-saved').textContent = `Saved for ${agentShort($('#policy-agent').value)}`;
  } catch (err) {
    $('#policy-saved').textContent = `Not saved: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save policy';
    setTimeout(() => ($('#policy-saved').textContent = ''), 2500);
  }
});

// ---- refresh loop ------------------------------------------------------------
async function refresh() {
  try {
    const [d, sessions] = await Promise.all([api('/api/decisions?limit=100'), api('/api/sessions?limit=200')]);
    decisions = d;
    renderMetrics();
    renderQueue();
    renderDecisions();
    renderSellers(sessions);
    const reviewId = new URLSearchParams(location.hash.slice(1)).get('review');
    if (reviewId) {
      const el = document.getElementById(`q-${reviewId}`) ?? document.getElementById(`dec-${decisions.find((x) => x.checkout_id === reviewId)?.id}`);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.classList.add('flash');
        history.replaceState(null, '', location.pathname);
      }
    }
  } catch (err) {
    console.warn(err);
  }
}

$('#reset').addEventListener('click', async () => {
  if (!confirm('Clear all demo sessions and decisions?')) return;
  await api('/api/reset', { method: 'POST', body: '{}' });
  currentRun = null;
  rendered = { id: null, count: 0 };
  setRunning(false, '__none');
  renderEmptyRun();
  refresh();
});

(async function init() {
  paintThemeButton();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', paintThemeButton);
  renderEmptyRun();
  $('#policy-agent').innerHTML = AGENTS.map((a) => `<option value="${a}">${agentShort(a)}</option>`).join('');
  $('#policy-agent').addEventListener('change', loadPolicy);
  await loadStatus();
  try {
    sellers = await api('/api/sellers');
    await loadScenarios();
    await loadPolicy();
  } catch (err) {
    $('#scenarios').innerHTML = `<p class="hint">Could not load scenarios: ${esc(err.message)}. Reload once the service is reachable.</p>`;
  }
  await refresh();
  setInterval(pollRun, 700);
  setInterval(refresh, 2000);
  setInterval(loadStatus, 30000);
})();
