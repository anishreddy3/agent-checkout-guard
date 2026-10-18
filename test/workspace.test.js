// Per-browser workspaces: two visitors never see or affect each other.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.STORE = 'memory';
delete process.env.GEMINI_API_KEY;

const { createApp } = await import('../server/index.js');
const { resetStoreForTests } = await import('../server/store/index.js');

let server;
let origin;
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

before(async () => {
  resetStoreForTests();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  process.env.SELF_ORIGIN = origin;
});
after(() => server.close());

const call = (ws, path, body) =>
  fetch(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(ws ? { 'x-acg-workspace': ws } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

async function run(ws, scenario) {
  const started = await call(ws, '/api/runs', { scenario_id: scenario, mode: 'scripted' });
  for (let i = 0; i < 300; i++) {
    const r = await call(ws, `/api/runs/${started.id}`);
    if (r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('run did not finish');
}

test("one workspace's velocity burst does not touch another's routine purchase", async () => {
  const burst = await run(A, 'velocity');
  assert.equal(burst.final_outcome, 'decline');
  assert.match(burst.agent_profile, /\?ws=aaaaaaaa-/);

  const routine = await run(B, 'normal');
  assert.equal(routine.final_outcome, 'approve');
  const [d] = await call(B, '/api/decisions');
  assert.deepEqual(d.findings.map((f) => f.code), [], 'no velocity or duplicate findings from the other workspace');
  assert.equal(d.ap2.status, 'verified');
});

test('lists only show the caller workspace', async () => {
  assert.equal((await call(A, '/api/decisions')).length, 7);
  assert.equal((await call(B, '/api/decisions')).length, 1);
  assert.equal((await call(null, '/api/decisions')).length, 0, 'public workspace is separate');
  assert.ok((await call(A, '/api/runs')).every((r) => r.workspace === A));
  assert.ok((await call(B, '/api/sessions')).every((s) => s.workspace === B));
});

test('a spend policy saved in one workspace applies only there', async () => {
  const profile = (ws) => `https://platform.example/agents/procurement-bot?ws=${ws}`;
  await call(A, '/api/policy', { profile: profile(A), policy: { per_transaction_cap: 1000 } });
  assert.equal((await run(A, 'normal')).final_outcome, 'decline');
  assert.equal((await call(B, `/api/policy?profile=${encodeURIComponent(profile(B))}`)).per_transaction_cap, 100000);
});

test('reset clears only the caller workspace', async () => {
  const out = await call(B, '/api/reset', {});
  assert.equal(out.workspace, B);
  assert.equal((await call(B, '/api/decisions')).length, 0);
  assert.equal((await call(A, '/api/decisions')).length, 8);
});

test('a malformed workspace id falls back to the public workspace', async () => {
  assert.equal((await call('NOT valid!', '/api/decisions')).length, 0);
  const r = await call('x', '/api/reset', {});
  assert.equal(r.workspace, 'public');
});
