// Pure, testable risk rules. Each rule returns null (no finding) or a finding:
// { code, severity: 'info' | 'warn' | 'block', weight, detail, data }.
//
// Inputs are plain objects so the rules can run without a store or network:
//   ctx = { session, seller, policy, risk_signals, history }
//   history = { recent_attempts: [events], today_completed_total: number,
//               recent_completed_sessions: [sessions] }

export function totalOf(session) {
  return session.totals?.find((t) => t.type === 'total')?.amount ?? 0;
}

export function money(minor, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format((minor || 0) / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function pct(a, b) {
  return b === 0 ? 0 : Math.abs(a - b) / b;
}

export function cartSignature(session) {
  return (session.line_items ?? [])
    .map((li) => `${li.item.id}x${li.quantity}`)
    .sort()
    .join('|');
}

// 1. Quote-to-charge mismatch: the amount the agent expects to pay versus the
//    amount the seller is about to charge. Also flags price drift inside the
//    session (totals changed after the first quote).
export function quoteMismatch({ session, risk_signals }) {
  const charged = totalOf(session);
  const expected = Number(risk_signals?.expected_total);
  const firstQuote = session.quote_history?.[0]?.total;
  if (Number.isFinite(expected) && expected !== charged) {
    const drift = pct(charged, expected);
    const severity = drift > 0.25 ? 'block' : 'warn';
    return {
      code: 'quote_mismatch',
      severity,
      weight: severity === 'block' ? 100 : 45,
      detail: `Agent expected ${money(expected, session.currency)} but seller will charge ${money(charged, session.currency)} (${Math.round(drift * 100)}% apart).`,
      data: { expected, charged },
    };
  }
  if (Number.isFinite(firstQuote) && firstQuote !== charged && !Number.isFinite(expected)) {
    return {
      code: 'quote_drift',
      severity: 'warn',
      weight: 25,
      detail: `Session total moved from ${money(firstQuote, session.currency)} to ${money(charged, session.currency)} since the first quote.`,
      data: { first_quote: firstQuote, charged },
    };
  }
  return null;
}

// 2. Spend policy: per-transaction and daily caps.
export function spendPolicy({ session, policy, history }) {
  const total = totalOf(session);
  if (total > policy.per_transaction_cap) {
    return {
      code: 'over_transaction_cap',
      severity: 'block',
      weight: 100,
      detail: `Total ${money(total, session.currency)} exceeds the per-transaction cap of ${money(policy.per_transaction_cap, session.currency)}.`,
      data: { total, cap: policy.per_transaction_cap },
    };
  }
  const projected = (history?.today_completed_total ?? 0) + total;
  if (projected > policy.daily_cap) {
    return {
      code: 'over_daily_cap',
      severity: 'block',
      weight: 100,
      detail: `This purchase would take today's spend to ${money(projected, session.currency)}, above the daily cap of ${money(policy.daily_cap, session.currency)}.`,
      data: { projected, cap: policy.daily_cap },
    };
  }
  if (projected > policy.daily_cap * 0.8) {
    return {
      code: 'near_daily_cap',
      severity: 'warn',
      weight: 20,
      detail: `Today's spend would reach ${Math.round((projected / policy.daily_cap) * 100)}% of the daily cap.`,
      data: { projected, cap: policy.daily_cap },
    };
  }
  return null;
}

// 3. Velocity: complete attempts by this agent inside the window.
export function velocity({ policy, history }) {
  const n = history?.recent_attempts?.length ?? 0;
  const max = policy.velocity.max_complete_attempts;
  if (n >= max) {
    return {
      code: 'velocity_exceeded',
      severity: 'block',
      weight: 100,
      detail: `${n} checkout completions in the last ${policy.velocity.window_minutes} minutes (limit ${max}). Looks like a loop.`,
      data: { attempts: n, max },
    };
  }
  if (n >= Math.ceil(max / 2)) {
    return {
      code: 'velocity_elevated',
      severity: 'warn',
      weight: 30,
      detail: `${n} checkout completions in the last ${policy.velocity.window_minutes} minutes.`,
      data: { attempts: n, max },
    };
  }
  return null;
}

// 4. Duplicate purchase: same agent, same seller, same cart, recently completed.
export function duplicatePurchase({ session, policy, history }) {
  const sig = cartSignature(session);
  const dup = (history?.recent_completed_sessions ?? []).find(
    (s) => s.id !== session.id && s.seller_id === session.seller_id && cartSignature(s) === sig
  );
  if (!dup) return null;
  return {
    code: 'duplicate_purchase',
    severity: 'block',
    weight: 100,
    detail: `An identical order (${sig}) was already completed at ${dup.updated_at} within ${policy.duplicate.window_minutes} minutes.`,
    data: { duplicate_of: dup.id },
  };
}

// 5. Intent match and tampering: what the user asked for versus what is in the
//    cart. Catches hijacked carts (prompt injection in a catalog) and
//    quantities beyond policy.
export function intentMatch({ session, policy, risk_signals }) {
  const findings = [];
  for (const li of session.line_items ?? []) {
    if (li.quantity > policy.max_quantity_per_line) {
      findings.push({
        code: 'quantity_over_policy',
        severity: 'block',
        weight: 100,
        detail: `Quantity ${li.quantity} of ${li.item.id} exceeds the per-line limit of ${policy.max_quantity_per_line}.`,
        data: { item_id: li.item.id, quantity: li.quantity },
      });
    }
  }
  const intent = risk_signals?.intent;
  if (intent?.items?.length) {
    const wanted = new Map(intent.items.map((i) => [i.item_id, Number(i.quantity) || 1]));
    for (const li of session.line_items ?? []) {
      if (!wanted.has(li.item.id)) {
        findings.push({
          code: 'unrequested_item',
          severity: 'warn',
          weight: 35,
          detail: `${li.item.id} is in the cart but was not in the user's request.`,
          data: { item_id: li.item.id },
        });
      } else if (li.quantity > wanted.get(li.item.id)) {
        findings.push({
          code: 'quantity_inflated',
          severity: 'block',
          weight: 100,
          detail: `User asked for ${wanted.get(li.item.id)} of ${li.item.id}; cart has ${li.quantity}. Possible cart hijack.`,
          data: { item_id: li.item.id, asked: wanted.get(li.item.id), cart: li.quantity },
        });
      }
    }
  }
  return findings.length ? findings : null;
}

// 6. Seller trust and category allow-list.
export function sellerTrust({ session, seller, policy }) {
  const findings = [];
  if (!seller.trust?.verified) {
    findings.push({
      code: 'unverified_seller',
      severity: policy.require_verified_seller ? 'block' : 'warn',
      weight: policy.require_verified_seller ? 100 : 20,
      detail: `${seller.name} has not completed seller verification.`,
      data: { seller_id: seller.id },
    });
  }
  for (const li of session.line_items ?? []) {
    const item = seller.items.find((i) => i.id === li.item.id);
    if (item && !policy.allowed_categories.includes(item.category)) {
      findings.push({
        code: 'category_not_allowed',
        severity: 'block',
        weight: 100,
        detail: `Category ${item.category} is not allowed for this agent.`,
        data: { item_id: item.id, category: item.category },
      });
    }
  }
  return findings.length ? findings : null;
}

// 7. Payment instrument sanity.
export function paymentInstrument({ payment_data }) {
  if (!payment_data?.credential?.token) {
    return {
      code: 'missing_payment_credential',
      severity: 'block',
      weight: 100,
      detail: 'payment_data has no credential token.',
      data: {},
    };
  }
  return null;
}

export const RULES = [
  quoteMismatch,
  spendPolicy,
  velocity,
  duplicatePurchase,
  intentMatch,
  sellerTrust,
  paymentInstrument,
];

export function runRules(ctx) {
  const findings = [];
  for (const rule of RULES) {
    const out = rule(ctx);
    if (!out) continue;
    if (Array.isArray(out)) findings.push(...out);
    else findings.push(out);
  }
  return findings;
}

export function scoreFindings(findings, policy) {
  const score = Math.min(100, findings.reduce((a, f) => a + f.weight, 0));
  const blocked = findings.some((f) => f.severity === 'block');
  let outcome = 'approve';
  if (blocked) outcome = 'decline';
  else if (score >= policy.step_up_threshold) outcome = 'step_up';
  return { risk_score: score, outcome };
}
