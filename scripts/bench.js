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
const pct = (field) => {
  const get = (d) => field.split('.').reduce((o, k) => o?.[k], d);
  const v = decisions.map(get).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const at = (q) => v[Math.min(v.length - 1, Math.floor(v.length * q))];
  return v.length ? `p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${v[v.length - 1]} ms` : 'n/a';
};
const gem = decisions.filter((d) => d.explanation_source === 'gemini').length;

console.log(`\nAgent Checkout Guard benchmark  (${BASE}, mode=${rows[0]?.mode}, store=${status.store}, gemini=${status.gemini.configured ? status.gemini.model : 'off'})\n`);
console.table(rows.map(({ round, scenario, expected, got, ok, ms, calls }) => ({ round, scenario, expected, got, ok, 'run ms': ms, 'http calls': calls })));
const acc = rows.filter((r) => r.ok).length / rows.length;
console.log(`Outcome accuracy: ${rows.filter((r) => r.ok).length}/${rows.length} (${(acc * 100).toFixed(0)}%)`);
console.log(`Guard decisions stored: ${decisions.length}`);
console.log(`  AP2 mandate verification:        ${pct('ap2.verify_ms')}`);
console.log(`  risk decision (history + rules): ${pct('decision_ms')}`);
console.log(`  Gemini explanation:              ${pct('explain_ms')}`);
console.log(`  total inside Complete Checkout:  ${pct('latency_ms')}`);
console.log(`Explanations by Gemini: ${gem}/${decisions.length}`);
