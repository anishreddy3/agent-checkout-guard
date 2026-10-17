// The Guard: gathers history from the store, runs the rules, asks Gemini for a
// plain-language explanation, and persists the decision.

import { randomUUID } from 'node:crypto';
import { getStore } from '../store/index.js';
import { policyFor } from './policy.js';
import { runRules, scoreFindings, totalOf, money } from './rules.js';
import { generateText } from '../gemini.js';
import { approveClosedCheckout, checkoutJwtFrom, verifyAtComplete, checkoutReceipt } from '../ap2/mandates.js';
import { platformKey, platformKeyById, sellerKey } from '../ap2/keys.js';

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

export async function evaluate({ session, seller, risk_signals = {}, payment_data = {}, ap2 = null }) {
  const started = Date.now();
  const policy = await policyFor(session.agent_profile);
  const history = await loadHistory(session.agent_profile, policy, session.id);
  const findings = runRules({ session, seller, policy, risk_signals, payment_data, history, ap2 });
  const { risk_score, outcome } = scoreFindings(findings, policy);
  const decided = Date.now();
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
    ap2: ap2 && {
      status: ap2.status,
      mode: ap2.mode ?? null,
      ucp_code: ap2.ucp_code ?? null,
      ap2_error: ap2.ap2_error ?? null,
      approved: ap2.approved ?? null,
      violations: (ap2.violations ?? []).slice(0, 3).map(({ code, detail }) => ({ code, detail })),
      technical: ap2.technical ?? null,
      verify_ms: ap2.verify_ms ?? null,
      checkout_hash: ap2.checkout_hash ?? null,
      reference: ap2.reference ?? null,
    },
    // decision_ms: history + rules, the risk decision itself.
    // explain_ms: the Gemini explanation written after the decision.
    decision_ms: decided - started,
    explain_ms: Date.now() - decided,
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

// AP2 Human Present: the human approves this exact checkout on the Trusted
// Surface (the dashboard, by click or by voice). The platform signs a closed
// Checkout Mandate over the seller-signed checkout; the seller verifies it
// before completing, and issues a Checkout Receipt.
async function humanPresentMandate(session, orderId) {
  const { signedView } = await import('../ucp/checkout.js');
  const checkoutJwt = checkoutJwtFrom(signedView(session));
  const mandate = approveClosedCheckout({ platformJwk: platformKey(), checkoutJwt });
  const result = await verifyAtComplete({
    session,
    sellerJwk: sellerKey(session.seller_id),
    checkoutMandate: mandate,
    rootKeyFor: (h) => platformKeyById(h.kid),
  });
  const receipt =
    result.status === 'verified'
      ? checkoutReceipt({ sellerJwk: sellerKey(session.seller_id), iss: `sellers/${session.seller_id}`, reference: result.reference, status: 'Success', order_id: orderId })
      : null;
  return { mode: 'human_present', status: result.status, checkout_hash: result.checkout_hash ?? null, reference: result.reference ?? null, receipt, error: result.violations?.[0]?.detail ?? null };
}

// Human review of a step-up: approve or reject from the dashboard.
export async function resolveReview(decisionId, action, reviewer = 'dashboard', evidence = undefined) {
  const store = getStore();
  const decision = await store.get('decisions', decisionId);
  if (!decision) return null;
  const session = await store.get('sessions', decision.checkout_id);
  if (!session) return null;
  let next;
  let ap2 = null;
  if (action === 'approve' && session.ap2_state) {
    const orderId = `ord_${randomUUID().slice(0, 10)}`;
    ap2 = await humanPresentMandate(session, orderId);
    if (ap2.status !== 'verified') throw new Error(`AP2 human-present mandate did not verify: ${ap2.error}`);
    ap2.order_id = orderId;
  }
  if (action === 'approve') {
    const orderId = ap2?.order_id ?? `ord_${randomUUID().slice(0, 10)}`;
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
  const updated = {
    ...decision,
    review: { action, reviewer, at: new Date().toISOString(), ...(evidence ? { evidence } : {}), ...(ap2 ? { ap2 } : {}) },
  };
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
