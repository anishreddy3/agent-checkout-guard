// End-to-end over HTTP: real server, in-memory store, scripted agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.STORE = 'memory';
delete process.env.GEMINI_API_KEY;

const { createApp } = await import('../server/index.js');
const { resetStoreForTests } = await import('../server/store/index.js');

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
  const expected = { normal: 'approve', over_budget: 'decline', stale_quote: 'step_up', runaway_loop: 'decline', injected_catalog: 'decline', velocity: 'decline' };
  for (const [id, want] of Object.entries(expected)) {
    const started = await post('/api/runs', { scenario_id: id, mode: 'scripted' });
    const run = await waitRun(started.id);
    assert.equal(run.status, 'done', `${id}: ${run.error}`);
    assert.equal(run.final_outcome, want, `${id} -> ${run.final_outcome} (${JSON.stringify(run.outcomes)})`);
  }
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
  const after = await fetch(`${origin}/sellers/${stepUp.seller_id}/checkout-sessions/${stepUp.checkout_id}`).then(json);
  assert.equal(after.status, 'completed');
  assert.ok(after.order?.id);
});

test('decisions carry explanations and latency', async () => {
  const decisions = await fetch(`${origin}/api/decisions`).then(json);
  assert.ok(decisions.length >= 6);
  for (const d of decisions) {
    assert.ok(d.explanation.length > 10);
    assert.equal(d.explanation_source, 'rules');
    assert.ok(Number.isFinite(d.latency_ms));
  }
});
