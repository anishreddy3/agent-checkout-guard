// End-to-end over HTTP: real server, in-memory store, scripted agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.STORE = 'memory';
delete process.env.GEMINI_API_KEY;

const { createApp } = await import('../server/index.js');
const { resetStoreForTests } = await import('../server/store/index.js');
const { verifyMerchantAuthorization } = await import('../server/ap2/mandates.js');
const { verifyJws, b64uJson } = await import('../server/ap2/jose.js');

let server;
let origin;

before(async () => {
  resetStoreForTests();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  process.env.SELF_ORIGIN = origin;
});
after(() => server.close());

const json = (r) => r.json();
const post = (path, body) =>
  fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);

async function waitRun(id) {
  for (let i = 0; i < 200; i++) {
    const run = await fetch(`${origin}/api/runs/${id}`).then(json);
    if (run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not finish');
}

test('health is served under /api (Cloud Run reserves /healthz)', async () => {
  assert.deepEqual(await fetch(`${origin}/api/health`).then(json), { ok: true });
});

test('UCP discovery manifest is served per seller', async () => {
  const m = await fetch(`${origin}/sellers/pelican_mail/.well-known/ucp`).then(json);
  assert.equal(m.ucp.version, '2026-01-11');
  assert.equal(m.ucp.capabilities[0].name, 'dev.ucp.shopping.checkout');
  assert.ok(m.ucp.services['dev.ucp.shopping'].rest.endpoint.endsWith('/sellers/pelican_mail'));
});

test('UCP-Agent header is required', async () => {
  const r = await fetch(`${origin}/sellers/pelican_mail/checkout-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currency: 'USD', line_items: [{ item: { id: 'pm_starter_100k' }, quantity: 1 }], payment: {} }),
  });
  assert.equal(r.status, 400);
});

test('scenarios produce the expected guard outcomes', async () => {
  const expected = { normal: 'approve', over_budget: 'decline', stale_quote: 'step_up', runaway_loop: 'decline', injected_catalog: 'decline', forged_mandate: 'decline', velocity: 'decline' };
  for (const [id, want] of Object.entries(expected)) {
    const started = await post('/api/runs', { scenario_id: id, mode: 'scripted' });
    const run = await waitRun(started.id);
    assert.equal(run.status, 'done', `${id}: ${run.error}`);
    assert.equal(run.final_outcome, want, `${id} -> ${run.final_outcome} (${JSON.stringify(run.outcomes)})`);
  }
});

test('AP2 findings are why each scenario ends the way it does', async () => {
  const decisions = await fetch(`${origin}/api/decisions?limit=100`).then(json);
  const byRequest = (text) => decisions.filter((d) => d.risk_signals?.user_request?.includes(text));
  const codes = (d) => d.findings.map((f) => f.code);

  const [normal] = byRequest('800k emails');
  assert.equal(normal.ap2.status, 'verified');
  assert.equal(normal.ap2.mode, 'human_not_present');
  assert.equal(normal.ap2.approved.max_amount, 19900);

  const [stale] = byRequest('quote I have on file');
  assert.equal(stale.ap2.status, 'unresolved');
  assert.ok(codes(stale).includes('ap2_amount_over_mandate'));

  const [injected] = byRequest('Routing Pro');
  assert.ok(codes(injected).includes('ap2_mandate_violated'), codes(injected).join());

  const [forged] = byRequest('Starter email plan from Pelican Mail.');
  assert.equal(forged.ap2.ucp_code, 'mandate_invalid_signature');
  assert.ok(codes(forged).includes('ap2_mandate_invalid'));

  const loop = byRequest('small vector pod');
  assert.equal(loop.length, 2);
  const second = loop.find((d) => d.outcome === 'decline');
  assert.ok(codes(second).includes('ap2_mandate_violated'), 'reused open mandate is rejected');
  assert.match(second.ap2.violations.map((v) => v.detail).join(' '), /already used/);
});

test('discovery advertises AP2, and checkouts are seller-signed', async () => {
  const m = await fetch(`${origin}/sellers/pelican_mail/.well-known/ucp`).then(json);
  assert.ok(m.ucp.capabilities.some((c) => c.name === 'dev.ucp.shopping.ap2_mandate' && c.extends === 'dev.ucp.shopping.checkout'));
  assert.equal(m.signing_keys[0].crv, 'P-256');
  assert.equal(m.signing_keys[0].d, undefined, 'no private key material');
  const chk = await fetch(`${origin}/sellers/pelican_mail/checkout-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'UCP-Agent': 'profile="https://platform.example/agents/manual-test"' },
    body: JSON.stringify({ currency: 'USD', line_items: [{ item: { id: 'pm_starter_100k' }, quantity: 1 }], payment: {} }),
  }).then(json);
  assert.equal(chk.merchant.id, 'pelican_mail');
  assert.equal(verifyMerchantAuthorization(chk, m.signing_keys).header.kid, m.signing_keys[0].kid);
  assert.throws(() => verifyMerchantAuthorization({ ...chk, totals: [{ type: 'total', amount: 1 }] }, m.signing_keys));
});

test('a trusted platform that sends no mandate gets mandate_required', async () => {
  const headers = { 'content-type': 'application/json', 'UCP-Agent': 'profile="https://platform.example/agents/procurement-bot"' };
  const chk = await fetch(`${origin}/sellers/granite_vector/checkout-sessions`, {
    method: 'POST', headers, body: JSON.stringify({ currency: 'USD', line_items: [{ item: { id: 'gv_backup' }, quantity: 1 }], payment: {} }),
  }).then(json);
  const done = await fetch(`${origin}/sellers/granite_vector/checkout-sessions/${chk.id}/complete`, {
    method: 'POST', headers, body: JSON.stringify({ payment_data: { handler_id: 'mock_payment_handler', credential: { type: 'PAYMENT_GATEWAY', token: 'success_token' } } }),
  }).then(json);
  assert.equal(done.status, 'canceled');
  assert.ok(done.messages.some((msg) => msg.code === 'mandate_required'));
  assert.ok(done['x-guard'].findings.some((f) => f.code === 'ap2_mandate_missing'));
  const receipt = b64uJson(done.ap2.checkout_receipt.split('.')[1]);
  assert.equal(receipt.status, 'Error');
  assert.equal(receipt.error, 'invalid_mandate');
});

test('step-up can be approved by a reviewer and the session completes', async () => {
  const decisions = await fetch(`${origin}/api/decisions`).then(json);
  const stepUp = decisions.find((d) => d.outcome === 'step_up');
  assert.ok(stepUp, 'a step_up decision exists');
  const session = await fetch(`${origin}/sellers/${stepUp.seller_id}/checkout-sessions/${stepUp.checkout_id}`, {
    headers: { 'UCP-Agent': 'profile="x"' },
  }).then(json);
  assert.equal(session.status, 'requires_escalation');
  assert.ok(session.continue_url);
  const reviewed = await post(`/api/decisions/${stepUp.id}/review`, { action: 'approve' });
  assert.equal(reviewed.review.action, 'approve');
  // AP2 Human Present: the human's approval is a platform-signed closed
  // mandate over this checkout, verified by the seller, with a receipt.
  assert.equal(reviewed.review.ap2.mode, 'human_present');
  assert.equal(reviewed.review.ap2.status, 'verified');
  const m = await fetch(`${origin}/sellers/${stepUp.seller_id}/.well-known/ucp`).then(json);
  const receipt = verifyJws(reviewed.review.ap2.receipt, (h) => m.signing_keys.find((k) => k.kid === h.kid)).payload;
  assert.equal(receipt.status, 'Success');
  assert.equal(receipt.reference, reviewed.review.ap2.reference);
  const after = await fetch(`${origin}/sellers/${stepUp.seller_id}/checkout-sessions/${stepUp.checkout_id}`).then(json);
  assert.equal(after.status, 'completed');
  assert.ok(after.order?.id);
});

test('voice step-up routes validate language, audio and review state', async () => {
  const decisions = await fetch(`${origin}/api/decisions`).then(json);
  const reviewed = decisions.find((d) => d.outcome === 'step_up' && d.review);
  assert.ok(reviewed, 'the reviewed step-up from the previous test');
  const bad = await fetch(`${origin}/api/decisions/${reviewed.id}/voice/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'xx-XX' }),
  });
  assert.equal(bad.status, 400);
  const done = await fetch(`${origin}/api/decisions/${reviewed.id}/voice/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ language: 'hi-IN' }),
  });
  assert.equal(done.status, 409);
  const empty = await fetch(`${origin}/api/decisions/${reviewed.id}/voice/answer?language=ja-JP`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(10),
  });
  assert.equal(empty.status, 400);
});

test('decisions carry explanations and latency', async () => {
  const decisions = await fetch(`${origin}/api/decisions?limit=100`).then(json);
  assert.ok(decisions.length >= 6);
  for (const d of decisions) {
    assert.ok(d.explanation.length > 10);
    assert.equal(d.explanation_source, 'rules');
    assert.ok(Number.isFinite(d.latency_ms));
    assert.ok(Number.isFinite(d.decision_ms) && Number.isFinite(d.explain_ms));
    assert.ok(d.decision_ms + d.explain_ms <= d.latency_ms + 1);
  }
});
