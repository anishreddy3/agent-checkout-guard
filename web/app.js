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
  return new Date(iso).toLocaleTimeString();
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const OUTCOME = {
  approve: { label: 'Approved', icon: '✓' },
  step_up: { label: 'Step-up', icon: '!' },
  decline: { label: 'Declined', icon: '✕' },
};

async function api(path, opts) {
  const r = await fetch(API + path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

let currentRun = null;
let scenarios = [];
let sellers = [];

// ---- status ------------------------------------------------------------------
async function loadStatus() {
  try {
    const s = await api('/api/status');
    const g = s.gemini.configured ? `Gemini <b>${esc(s.gemini.model)}</b>` : 'Gemini <b>not configured</b> (rules-only explanations)';
    $('#status').innerHTML = `UCP <b>${s.ucp_version}</b> · store <b>${s.store}</b> · ${g}`;
  } catch {
    $('#status').textContent = 'API unreachable';
  }
}

// ---- scenarios ---------------------------------------------------------------
async function loadScenarios() {
  scenarios = await api('/api/scenarios');
  $('#scenarios').innerHTML = scenarios
    .map(
      (s) => `
      <div class="scenario" data-id="${s.id}">
        <div class="row"><span class="title">${esc(s.title)}</span><span class="tag">${esc(s.track)}</span></div>
        <p class="req">"${esc(s.request)}"</p>
        <div class="row">
          <span class="meta">expects <b>${OUTCOME[s.expected_outcome].label}</b> · ${s.purchases} purchase${s.purchases > 1 ? 's' : ''}</span>
          <button data-run="${s.id}">Run</button>
        </div>
      </div>`
    )
    .join('');
  $('#scenarios').addEventListener('click', async (e) => {
    const id = e.target.dataset.run;
    if (!id) return;
    setRunning(true);
    try {
      currentRun = await api('/api/runs', { method: 'POST', body: JSON.stringify({ scenario_id: id, mode: $('#mode').value }) });
      renderTrace(currentRun);
    } catch (err) {
      alert(err.message);
      setRunning(false);
    }
  });
}
function setRunning(on) {
  document.querySelectorAll('[data-run]').forEach((b) => (b.disabled = on));
}

// ---- trace -------------------------------------------------------------------
function renderTrace(run) {
  const meta = `${run.mode}${run.model ? ' · ' + esc(run.model) : ''} · ${run.status}${
    run.status === 'done' ? ` · final: ${OUTCOME[run.final_outcome]?.label ?? run.final_outcome} ${run.matched_expectation ? '(as expected)' : '(unexpected)'}` : ''
  }`;
  $('#run-meta').innerHTML = meta;
  const items = run.steps.map((st) => {
    if (st.kind === 'thought') return `<li><span class="k">agent</span><span>${esc(st.text)}</span></li>`;
    if (st.kind === 'intent')
      return `<li><span class="k">intent</span><span>${esc(st.text)} <code>${esc(JSON.stringify(st.result.items))}</code> <span class="meta">(${esc(st.result.source)})</span></span></li>`;
    if (st.kind === 'tool')
      return `<li><span class="k">ucp</span><span><code>${esc(st.name)}${st.args ? ' ' + esc(JSON.stringify(st.args)) : ''}</code>${
        st.result ? `<br><code>→ ${esc(JSON.stringify(st.result))}</code>` : ''
      }</span></li>`;
    if (st.kind === 'guard') {
      const r = st.result;
      const o = OUTCOME[r.outcome] ?? { label: r.status, icon: '·' };
      return `<li><span class="k guard">guard</span><span>
        <span class="chip ${esc(r.outcome)}">${o.icon} ${o.label}</span> risk ${r.risk_score}/100 · session <code>${esc(r.status)}</code>${r.order_id ? ` · order <code>${esc(r.order_id)}</code>` : ''}
        <div class="exp">${esc(r.explanation)}</div>
        ${r.findings.length ? `<div class="findings">${r.findings.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}
      </span></li>`;
    }
    if (st.kind === 'final') return `<li><span class="k">report</span><span>${esc(st.text)}</span></li>`;
    if (st.kind === 'error') return `<li><span class="k">error</span><span>${esc(st.name)}: ${esc(st.text)}</span></li>`;
    return '';
  });
  if (run.status === 'error') items.push(`<li><span class="k">error</span><span>${esc(run.error)}</span></li>`);
  const list = $('#trace');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = items.join('') || '<li class="empty">Starting…</li>';
  if (atBottom) list.scrollTop = list.scrollHeight;
}
async function pollRun() {
  if (!currentRun || currentRun.status !== 'running') return;
  currentRun = await api(`/api/runs/${currentRun.id}`);
  renderTrace(currentRun);
  if (currentRun.status !== 'running') setRunning(false);
}

// ---- decisions and tiles -----------------------------------------------------
function tiles(decisions) {
  const today = decisions;
  const by = (o) => today.filter((d) => d.outcome === o);
  const blocked = by('decline').reduce((a, d) => a + d.total, 0);
  const lat = today.map((d) => d.latency_ms).sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
  const gem = today.filter((d) => d.explanation_source === 'gemini').length;
  const t = [
    ['Decisions', today.length, 'complete checkout calls guarded'],
    ['Approved', by('approve').length, 'went straight to order'],
    ['Step-ups', by('step_up').length, 'sent to a human'],
    ['Declined', by('decline').length, 'blocked before charge'],
    ['Spend blocked', fmt(blocked), 'would have been charged'],
    ['Guard p50', `${p50} ms`, `${gem}/${today.length} explanations by Gemini`],
  ];
  $('#tiles').innerHTML = t
    .map(([l, v, n]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${n}</div></div>`)
    .join('');
}

function agentShort(profile) {
  return String(profile || '').split('/').pop();
}

function renderDecisions(decisions) {
  const rows = decisions.map((d) => {
    const o = OUTCOME[d.outcome];
    const cart = d.cart.map((c) => `${c.quantity} × ${esc(c.title)}`).join('<br>');
    let review = '';
    if (d.outcome === 'step_up') {
      review = d.review
        ? `<span class="reviewed">${d.review.action === 'approve' ? 'approved' : 'rejected'} by reviewer</span>`
        : `<div class="review-btns"><button data-review="approve" data-id="${d.id}">Approve</button><button data-review="reject" data-id="${d.id}">Reject</button></div>`;
    }
    return `<tr id="dec-${d.id}">
      <td title="${esc(d.at)}">${ago(d.at)}</td>
      <td><span class="mono">${esc(agentShort(d.agent_profile))}</span></td>
      <td>${esc(d.seller_name.replace(' (example seller)', ''))}</td>
      <td>${cart}</td>
      <td class="num">${fmt(d.total, d.currency)}</td>
      <td class="num">${d.risk_score}</td>
      <td><span class="chip ${d.outcome}">${o.icon} ${o.label}</span></td>
      <td class="why">${esc(d.explanation)}${d.findings.length ? `<div class="findings">${d.findings.map((f) => `<span>${esc(f.code)}</span>`).join('')}</div>` : ''}</td>
      <td>${review}</td>
    </tr>`;
  });
  $('#decisions tbody').innerHTML = rows.join('') || '<tr><td colspan="9" class="meta">No decisions yet.</td></tr>';
}
$('#decisions').addEventListener('click', async (e) => {
  const action = e.target.dataset.review;
  if (!action) return;
  e.target.disabled = true;
  await api(`/api/decisions/${e.target.dataset.id}/review`, { method: 'POST', body: JSON.stringify({ action, reviewer: 'dashboard' }) });
  refresh();
});

// ---- sellers -----------------------------------------------------------------
function renderSellers(sessions) {
  $('#sellers').innerHTML = sellers
    .map((s) => {
      const mine = sessions.filter((x) => x.seller_id === s.id);
      const done = mine.filter((x) => x.status === 'completed');
      const rev = done.reduce((a, x) => a + (x.totals.find((t) => t.type === 'total')?.amount ?? 0), 0);
      return `<div class="seller">
        <div class="row"><span class="name">${esc(s.name.replace(' (example seller)', ''))}</span><span class="tag">${s.trust.verified ? 'verified' : 'unverified'}</span></div>
        <div class="meta">${esc(s.description)}</div>
        <div class="nums"><span>${mine.length} sessions</span><span>${done.length} orders</span><span>${fmt(rev, s.currency)} completed</span></div>
        <div class="nums"><a href="${API}/sellers/${s.id}/.well-known/ucp" target="_blank" rel="noopener">/.well-known/ucp</a><a href="${API}/sellers/${s.id}/catalog" target="_blank" rel="noopener">catalog</a></div>
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
  await api('/api/policy', { method: 'POST', body: JSON.stringify({ profile: $('#policy-agent').value, policy }) });
  $('#policy-saved').textContent = 'saved';
  setTimeout(() => ($('#policy-saved').textContent = ''), 1500);
});

// ---- refresh loop ------------------------------------------------------------
async function refresh() {
  try {
    const [decisions, sessions] = await Promise.all([api('/api/decisions?limit=100'), api('/api/sessions?limit=200')]);
    tiles(decisions);
    renderDecisions(decisions);
    renderSellers(sessions);
    const hash = new URLSearchParams(location.hash.slice(1));
    const reviewId = hash.get('review');
    if (reviewId) {
      const d = decisions.find((x) => x.checkout_id === reviewId);
      if (d) {
        document.getElementById(`dec-${d.id}`)?.scrollIntoView({ block: 'center' });
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
  $('#trace').innerHTML = '<li class="empty">No run yet. Start a scenario on the left.</li>';
  $('#run-meta').textContent = '';
  refresh();
});

(async function init() {
  $('#policy-agent').innerHTML = AGENTS.map((a) => `<option value="${a}">${agentShort(a)}</option>`).join('');
  $('#policy-agent').addEventListener('change', loadPolicy);
  await loadStatus();
  sellers = await api('/api/sellers');
  await loadScenarios();
  await loadPolicy();
  await refresh();
  setInterval(pollRun, 700);
  setInterval(refresh, 2000);
})();
