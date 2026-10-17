// Benchmark: runs every scenario N times against a server and reports
// outcome accuracy, guard latency and end-to-end UCP round trips.
// Usage: BASE=http://localhost:8080 ROUNDS=3 node scripts/bench.js
const BASE = process.env.BASE || 'http://localhost:8080';
const ROUNDS = Number(process.env.ROUNDS || 3);
const MODE = process.env.MODE || 'scripted';

const json = (r) => r.json();
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(json);

async function waitRun(id) {
  for (;;) {
    const run = await fetch(`${BASE}/api/runs/${id}`).then(json);
    if (run.status !== 'running') return run;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const scenarios = await fetch(`${BASE}/api/scenarios`).then(json);
const status = await fetch(`${BASE}/api/status`).then(json);
const rows = [];
for (let round = 0; round < ROUNDS; round++) {
  await post('/api/reset', {});
  for (const s of scenarios) {
    const t0 = Date.now();
    const started = await post('/api/runs', { scenario_id: s.id, mode: MODE });
    const run = await waitRun(started.id);
    rows.push({ round, scenario: s.id, expected: s.expected_outcome, got: run.final_outcome, ok: run.matched_expectation, ms: Date.now() - t0, calls: run.http_calls, mode: run.mode });
  }
}
const decisions = await fetch(`${BASE}/api/decisions?limit=500`).then(json);
const lat = decisions.map((d) => d.latency_ms).sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
const gem = decisions.filter((d) => d.explanation_source === 'gemini').length;

console.log(`\nAgent Checkout Guard benchmark  (${BASE}, mode=${rows[0]?.mode}, store=${status.store}, gemini=${status.gemini.configured ? status.gemini.model : 'off'})\n`);
console.table(rows.map(({ round, scenario, expected, got, ok, ms, calls }) => ({ round, scenario, expected, got, ok, 'run ms': ms, 'http calls': calls })));
const acc = rows.filter((r) => r.ok).length / rows.length;
console.log(`Outcome accuracy: ${rows.filter((r) => r.ok).length}/${rows.length} (${(acc * 100).toFixed(0)}%)`);
console.log(`Guard decisions in last round: ${decisions.length}; latency p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${lat[lat.length - 1]} ms`);
console.log(`Explanations by Gemini: ${gem}/${decisions.length}`);
