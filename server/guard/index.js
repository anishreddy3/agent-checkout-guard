// The Guard: gathers history from the store, runs the rules, asks Gemini for a
// plain-language explanation, and persists the decision.

import { randomUUID } from 'node:crypto';
import { getStore } from '../store/index.js';
import { policyFor } from './policy.js';
import { runRules, scoreFindings, totalOf, money } from './rules.js';
import { generateText } from '../gemini.js';

function minutesAgo(min) {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

function startOfTodayIso() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function loadHistory(agentProfile, policy, excludeId) {
  const store = getStore();
  const attempts = await store.query(
    'events',
    [
      ['agent_profile', '==', agentProfile],
      ['type', '==', 'checkout.complete_attempt'],
      ['at', '>=', minutesAgo(policy.velocity.window_minutes)],
    ],
    { orderBy: 'at', limit: 200 }
  );
  const completedToday = await store.query(
    'sessions',
    [
      ['agent_profile', '==', agentProfile],
      ['status', '==', 'completed'],
      ['updated_at', '>=', startOfTodayIso()],
    ],
    { orderBy: 'updated_at', limit: 500 }
  );
  const recentCompleted = completedToday.filter(
    (s) => s.id !== excludeId && s.updated_at >= minutesAgo(policy.duplicate.window_minutes)
  );
  return {
    recent_attempts: attempts.filter((e) => e.checkout_id !== excludeId),
    today_completed_total: completedToday.filter((s) => s.id !== excludeId).reduce((a, s) => a + totalOf(s), 0),
    recent_completed_sessions: recentCompleted,
  };
}

function fallbackExplanation(outcome, findings, session, seller) {
  const total = money(totalOf(session), session.currency);
  if (outcome === 'approve') {
    return `Approved. ${seller.name} will charge ${total}, which matches the quote and sits inside this agent's spend policy.`;
  }
  const top = findings
    .filter((f) => (outcome === 'decline' ? f.severity === 'block' : true))
    .slice(0, 2)
    .map((f) => f.detail)
    .join(' ');
  return outcome === 'decline'
    ? `Declined. ${top}`
    : `Needs a human to confirm. ${top}`;
}

async function explain(outcome, findings, session, seller, risk_score) {
  const fallback = fallbackExplanation(outcome, findings, session, seller);
  const prompt = [
    `You write one short, plain explanation of a checkout risk decision for a finance reviewer.`,
    `Max 2 sentences. No hype. Use the amounts as given (minor units, convert to ${session.currency} with two decimals).`,
    `Outcome: ${outcome}. Risk score: ${risk_score}/100.`,
    `Seller: ${seller.name}. Total: ${totalOf(session)} minor units.`,
    `Cart: ${session.line_items.map((li) => `${li.quantity} x ${li.item.title}`).join('; ')}.`,
    `Findings: ${findings.length ? findings.map((f) => `${f.code} (${f.severity}): ${f.detail}`).join(' | ') : 'none'}.`,
  ].join('\n');
  const text = await generateText(prompt, { timeoutMs: 6000 });
  return { text: text || fallback, source: text ? 'gemini' : 'rules' };
}

export async function evaluate({ session, seller, risk_signals = {}, payment_data = {} }) {
  const started = Date.now();
  const policy = await policyFor(session.agent_profile);
  const history = await loadHistory(session.agent_profile, policy, session.id);
  const findings = runRules({ session, seller, policy, risk_signals, payment_data, history });
  const { risk_score, outcome } = scoreFindings(findings, policy);
  const explanation = await explain(outcome, findings, session, seller, risk_score);
  const decision = {
    id: `dec_${randomUUID().slice(0, 10)}`,
    at: new Date().toISOString(),
    checkout_id: session.id,
    seller_id: seller.id,
    seller_name: seller.name,
    agent_profile: session.agent_profile,
    agent_id: policy.agent_id,
    outcome,
    risk_score,
    findings,
    explanation: explanation.text,
    explanation_source: explanation.source,
    total: totalOf(session),
    currency: session.currency,
    cart: session.line_items.map((li) => ({ item_id: li.item.id, title: li.item.title, quantity: li.quantity })),
    risk_signals,
    latency_ms: Date.now() - started,
    policy_snapshot: {
      per_transaction_cap: policy.per_transaction_cap,
      daily_cap: policy.daily_cap,
      max_quantity_per_line: policy.max_quantity_per_line,
      step_up_threshold: policy.step_up_threshold,
    },
  };
  await getStore().set('decisions', decision.id, decision);
  return decision;
}

// Human review of a step-up: approve or reject from the dashboard.
export async function resolveReview(decisionId, action, reviewer = 'dashboard') {
  const store = getStore();
  const decision = await store.get('decisions', decisionId);
  if (!decision) return null;
  const session = await store.get('sessions', decision.checkout_id);
  if (!session) return null;
  let next;
  if (action === 'approve') {
    const orderId = `ord_${randomUUID().slice(0, 10)}`;
    next = {
      ...session,
      status: 'completed',
      messages: [],
      continue_url: undefined,
      order: { id: orderId, permalink_url: `/sellers/${session.seller_id}/orders/${orderId}` },
    };
  } else {
    next = {
      ...session,
      status: 'canceled',
      continue_url: undefined,
      messages: [{ type: 'error', code: 'rejected_by_reviewer', content: 'Rejected during human review', severity: 'requires_buyer_input' }],
    };
  }
  await store.set('sessions', session.id, next);
  const updated = { ...decision, review: { action, reviewer, at: new Date().toISOString() } };
  await store.set('decisions', decisionId, updated);
  await store.add('events', {
    type: 'review.resolved',
    at: new Date().toISOString(),
    seller_id: session.seller_id,
    agent_profile: session.agent_profile,
    checkout_id: session.id,
    status: next.status,
    total: totalOf(next),
    currency: next.currency,
    action,
  });
  return updated;
}
