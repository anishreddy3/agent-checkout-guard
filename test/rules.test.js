import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRules, scoreFindings, quoteMismatch, spendPolicy, velocity, duplicatePurchase, intentMatch } from '../server/guard/rules.js';
import { DEFAULT_POLICY } from '../server/guard/policy.js';
import { SELLERS, unitPriceFor } from '../server/sellers/catalog.js';

const seller = SELLERS.pelican_mail;
const policy = { ...DEFAULT_POLICY };

function session({ items = [{ id: 'pm_growth_1m', quantity: 1 }], total } = {}) {
  const line_items = items.map((i, idx) => {
    const item = seller.items.find((x) => x.id === i.id);
    const t = unitPriceFor(item, i.quantity) * i.quantity;
    return { id: `li_${idx}`, item: { id: item.id, title: item.title, price: item.price }, quantity: i.quantity, totals: [{ type: 'total', amount: t }] };
  });
  const sum = total ?? line_items.reduce((a, li) => a + li.totals[0].amount, 0);
  return { id: 'chk_1', seller_id: seller.id, agent_profile: 'p', line_items, totals: [{ type: 'total', amount: sum }], quote_history: [{ total: sum }] };
}

const emptyHistory = { recent_attempts: [], today_completed_total: 0, recent_completed_sessions: [] };
const card = { credential: { token: 'success_token' } };

test('volume tiers pick the lowest eligible price', () => {
  const item = seller.items.find((i) => i.id === 'pm_growth_1m');
  assert.equal(unitPriceFor(item, 1), 19900);
  assert.equal(unitPriceFor(item, 3), 17900);
  assert.equal(unitPriceFor(item, 10), 14900);
});

test('clean purchase approves with score 0', () => {
  const s = session();
  const findings = runRules({ session: s, seller, policy, risk_signals: { expected_total: 19900 }, payment_data: card, history: emptyHistory });
  assert.deepEqual(findings, []);
  assert.deepEqual(scoreFindings(findings, policy), { risk_score: 0, outcome: 'approve' });
});

test('quote mismatch within 25% steps up, beyond blocks', () => {
  const s = session();
  const warn = quoteMismatch({ session: s, risk_signals: { expected_total: 17900 } });
  assert.equal(warn.severity, 'warn');
  assert.equal(scoreFindings([warn], policy).outcome, 'step_up');
  const block = quoteMismatch({ session: s, risk_signals: { expected_total: 2900 } });
  assert.equal(block.severity, 'block');
});

test('spend caps block and near-cap warns', () => {
  assert.equal(spendPolicy({ session: session({ total: 100001 }), policy, history: emptyHistory }).code, 'over_transaction_cap');
  assert.equal(spendPolicy({ session: session(), policy, history: { ...emptyHistory, today_completed_total: 240000 } }).code, 'over_daily_cap');
  assert.equal(spendPolicy({ session: session(), policy, history: { ...emptyHistory, today_completed_total: 185000 } }).code, 'near_daily_cap');
  assert.equal(spendPolicy({ session: session(), policy, history: emptyHistory }), null);
});

test('velocity blocks at the policy limit', () => {
  const attempts = (n) => ({ ...emptyHistory, recent_attempts: Array.from({ length: n }, () => ({})) });
  assert.equal(velocity({ policy, history: attempts(2) }), null);
  assert.equal(velocity({ policy, history: attempts(3) }).severity, 'warn');
  assert.equal(velocity({ policy, history: attempts(6) }).severity, 'block');
});

test('identical recent order is a duplicate', () => {
  const s = session();
  const prior = { ...session(), id: 'chk_0', updated_at: new Date().toISOString() };
  const f = duplicatePurchase({ session: s, policy, history: { ...emptyHistory, recent_completed_sessions: [prior] } });
  assert.equal(f.code, 'duplicate_purchase');
  const other = { ...session({ items: [{ id: 'pm_growth_1m', quantity: 2 }] }), id: 'chk_2', updated_at: new Date().toISOString() };
  assert.equal(duplicatePurchase({ session: s, policy, history: { ...emptyHistory, recent_completed_sessions: [other] } }), null);
});

test('cart hijack: quantity above intent and above policy both block', () => {
  const s = session({ items: [{ id: 'pm_growth_1m', quantity: 40 }] });
  const f = intentMatch({ session: s, policy, risk_signals: { intent: { items: [{ item_id: 'pm_growth_1m', quantity: 1 }] } } });
  const codes = f.map((x) => x.code).sort();
  assert.deepEqual(codes, ['quantity_inflated', 'quantity_over_policy']);
});

test('unrequested item only warns', () => {
  const s = session({ items: [{ id: 'pm_growth_1m', quantity: 1 }, { id: 'pm_dedicated_ip', quantity: 1 }] });
  const f = intentMatch({ session: s, policy, risk_signals: { intent: { items: [{ item_id: 'pm_growth_1m', quantity: 1 }] } } });
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'unrequested_item');
  assert.equal(scoreFindings(f, policy).outcome, 'approve');
});
