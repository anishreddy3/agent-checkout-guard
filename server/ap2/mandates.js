// AP2 v0.2 Checkout and Payment Mandates over UCP's AP2 extension
// (dev.ucp.shopping.ap2_mandate).
//
// Human Not Present (the agent buys on its own):
//   1. Trusted Surface: the human approves open mandates, signed with the
//      platform key, with the agent's key in cnf.
//        open Checkout Mandate  mandate.checkout.open.1  allowed merchant, line items
//        open Payment Mandate   mandate.payment.open.1   amount ceiling, payee, reference
//   2. Seller: signs the checkout (UCP ap2.merchant_authorization).
//   3. Agent: signs closed mandates bound to that exact checkout:
//        closed Checkout Mandate mandate.checkout.1  checkout_jwt, checkout_hash
//        closed Payment Mandate  mandate.payment.1   transaction_id, payee, amount
//   4. Seller (the Guard, here) verifies both chains at Complete Checkout.
// Human Present: the human approves the closed Checkout Mandate directly; we
// use this when a step-up is approved from the dashboard or by voice.
//
// Field names, vct values, constraint types and evaluation follow the AP2
// schemas and reference SDK (google-agentic-commerce/AP2, code/sdk).

import { attach, jcs, sha256b64u, signDetached, signJws, verifyDetached, verifyJws, publicJwk, generateKey } from './jose.js';
import { issueHop, issueRoot, sdHash, serializeChain, splitChain, verifyChain, ChainError } from './sdjwt.js';

export const VCT = {
  openCheckout: 'mandate.checkout.open.1',
  checkout: 'mandate.checkout.1',
  openPayment: 'mandate.payment.open.1',
  payment: 'mandate.payment.1',
};

const now = () => Math.floor(Date.now() / 1000);
const CHECKOUT_SD = { sdArrays: { allowed: true, acceptable_items: true } };
const PAYMENT_SD = { sdArrays: { allowed: true } };

export function merchantOf(seller) {
  return { id: seller.id, name: seller.name, website: `https://${seller.id.replace(/_/g, '-')}.example` };
}

// ---- seller: signed checkout ----------------------------------------------------

// UCP: merchant_authorization is a detached ES256 JWS over JCS(checkout
// without ap2). The same signature with the payload attached is AP2's
// checkout_jwt.
export function signCheckout(checkoutWithoutAp2, sellerJwk) {
  return signDetached({ kid: sellerJwk.kid, typ: 'JWT' }, jcs(checkoutWithoutAp2), sellerJwk);
}

export function checkoutJwtFrom(checkoutResponse) {
  const { ap2, 'x-guard': _g, ...body } = checkoutResponse;
  if (!ap2?.merchant_authorization) return null;
  return attach(ap2.merchant_authorization, jcs(body));
}

export function verifyMerchantAuthorization(checkoutResponse, sellerPublicKeys) {
  const { ap2, 'x-guard': _g, ...body } = checkoutResponse;
  return verifyDetached(ap2.merchant_authorization, jcs(body), (h) => sellerPublicKeys.find((k) => k.kid === h.kid));
}

// ---- trusted surface: open mandates ---------------------------------------------

export function newAgentKey(runId) {
  return generateKey(`agent-${runId}`);
}

// items: [{ id, title, quantity }]. maxAmount in minor units.
export function approveOpenMandates({ platformJwk, agentJwk, merchant, items, maxAmount, currency, ttlSeconds = 1800 }) {
  const iat = now();
  const exp = iat + ttlSeconds;
  const cnf = { jwk: publicJwk(agentJwk) };
  const openCheckout = issueRoot(
    {
      vct: VCT.openCheckout,
      constraints: [
        { type: 'checkout.allowed_merchants', allowed: [merchant] },
        {
          type: 'checkout.line_items',
          items: items.map((it, i) => ({ id: `line_${i + 1}`, acceptable_items: [{ id: it.id, title: it.title }], quantity: it.quantity })),
        },
      ],
      cnf,
      iat,
      exp,
    },
    CHECKOUT_SD,
    platformJwk
  );
  const openPayment = issueRoot(
    {
      vct: VCT.openPayment,
      constraints: [
        { type: 'payment.amount_range', currency, max: maxAmount },
        { type: 'payment.allowed_payees', allowed: [merchant] },
        { type: 'payment.reference', conditional_transaction_id: sdHash(openCheckout) },
      ],
      cnf,
      iat,
      exp,
    },
    PAYMENT_SD,
    platformJwk
  );
  return { openCheckout, openPayment, summary: { merchant: merchant.name, items, maxAmount, currency, exp } };
}

// ---- agent: closed mandates for one checkout ----------------------------------------

// aud: the seller's UCP endpoint. nonce: the checkout id, so a closed mandate
// only ever authorises this session.
export function closeMandates({ open, agentJwk, checkoutJwt, aud, nonce, payee, amount, currency, instrument }) {
  const checkoutHash = sha256b64u(checkoutJwt);
  const iat = now();
  const exp = iat + 600;
  const checkoutMandate = serializeChain([
    open.openCheckout,
    issueHop(open.openCheckout, { vct: VCT.checkout, checkout_jwt: checkoutJwt, checkout_hash: checkoutHash, iat, exp }, { sdProps: ['checkout_jwt'] }, agentJwk, { aud, nonce }),
  ]);
  const paymentMandate = serializeChain([
    open.openPayment,
    issueHop(
      open.openPayment,
      { vct: VCT.payment, transaction_id: checkoutHash, payee, payment_amount: { amount, currency }, payment_instrument: instrument, iat, exp },
      {},
      agentJwk,
      { aud, nonce }
    ),
  ]);
  return { checkoutMandate, paymentMandate, checkoutHash };
}

// ---- human present: the human approves the closed checkout directly ----------------------

export function approveClosedCheckout({ platformJwk, checkoutJwt }) {
  const iat = now();
  return issueRoot({ vct: VCT.checkout, checkout_jwt: checkoutJwt, checkout_hash: sha256b64u(checkoutJwt), iat, exp: iat + 600 }, { sdProps: ['checkout_jwt'] }, platformJwk);
}

// ---- constraint evaluation ----------------------------------------------------------

// AP2 merchant matching: by id when both have one, else name + website.
export function merchantMatches(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return Boolean(a.name) && a.name === b.name && Boolean(a.website) && a.website === b.website;
}

// checkout.line_items, per the AP2 Checkout Mandate spec: build a flow network
// source -> requirement (capacity = quantity) -> checkout item (if acceptable)
// -> sink (capacity = cart quantity). Met when max flow equals both the total
// required quantity and the total cart quantity: every cart unit is
// authorised and every requirement is filled.
export function evaluateLineItems(cartItems, requirements) {
  const cart = new Map();
  for (const li of cartItems) cart.set(li.item.id, (cart.get(li.item.id) ?? 0) + li.quantity);
  if (!cart.size) return ['Empty cart does not satisfy line_items constraint'];
  const skus = [...cart.keys()];
  const nReq = requirements.length;
  const N = 2 + nReq + skus.length;
  const S = 0;
  const T = N - 1;
  const cap = Array.from({ length: N }, () => new Array(N).fill(0));
  requirements.forEach((r, i) => {
    cap[S][1 + i] = r.quantity;
    const ok = new Set((r.acceptable_items ?? []).map((a) => a.id));
    skus.forEach((sku, j) => {
      if (ok.has(sku)) cap[1 + i][1 + nReq + j] = Number.MAX_SAFE_INTEGER;
    });
  });
  skus.forEach((sku, j) => (cap[1 + nReq + j][T] = cart.get(sku)));
  let flow = 0;
  for (;;) {
    const prev = new Array(N).fill(-1);
    prev[S] = S;
    const queue = [S];
    while (queue.length && prev[T] === -1) {
      const u = queue.shift();
      for (let v = 0; v < N; v++) if (prev[v] === -1 && cap[u][v] > 0) (prev[v] = u), queue.push(v);
    }
    if (prev[T] === -1) break;
    let push = Infinity;
    for (let v = T; v !== S; v = prev[v]) push = Math.min(push, cap[prev[v]][v]);
    for (let v = T; v !== S; v = prev[v]) (cap[prev[v]][v] -= push), (cap[v][prev[v]] += push);
    flow += push;
  }
  const required = requirements.reduce((a, r) => a + r.quantity, 0);
  const inCart = [...cart.values()].reduce((a, q) => a + q, 0);
  const out = [];
  if (flow < inCart) {
    const unauthorised = skus.map((sku, j) => [sku, cap[1 + nReq + j][T]]).filter(([, left]) => left > 0);
    out.push(`Cart has items the mandate does not authorise: ${unauthorised.map(([s, q]) => `${q} x ${s}`).join(', ')}`);
  }
  if (flow < required) out.push(`Cart does not fill the mandate's line items (${flow} of ${required} units matched)`);
  return out;
}

export function checkCheckoutConstraints(open, checkout) {
  const v = [];
  for (const c of open.constraints ?? []) {
    if (c.type === 'checkout.allowed_merchants') {
      if (!checkout.merchant) v.push({ code: 'invalid_mandate', detail: 'Checkout has no merchant' });
      else if (!(c.allowed ?? []).some((m) => merchantMatches(m, checkout.merchant))) v.push({ code: 'invalid_mandate', detail: `Merchant ${checkout.merchant.name} is not allowed by the mandate` });
    } else if (c.type === 'checkout.line_items') {
      for (const d of evaluateLineItems(checkout.line_items ?? [], c.items ?? [])) v.push({ code: 'invalid_mandate', detail: d });
    } else {
      v.push({ code: 'unresolved_constraint', detail: `Unknown checkout constraint ${c.type}` });
    }
  }
  return v;
}

// amount_range over the ceiling is unresolved_constraint, not invalid_mandate:
// AP2 lets the verifier fall back to a mandate the human approves directly.
export function checkPaymentConstraints(open, closed, openCheckoutHash) {
  const v = [];
  if (open.payee && !merchantMatches(open.payee, closed.payee)) v.push({ code: 'invalid_mandate', detail: 'Pre-set payee changed' });
  if (open.payment_amount && jcs(open.payment_amount) !== jcs(closed.payment_amount)) v.push({ code: 'invalid_mandate', detail: 'Pre-set amount changed' });
  for (const c of open.constraints ?? []) {
    const amt = closed.payment_amount ?? {};
    if (c.type === 'payment.amount_range') {
      if (c.currency && amt.currency !== c.currency) v.push({ code: 'invalid_mandate', detail: `Currency ${amt.currency} is not ${c.currency}` });
      if (c.max != null && amt.amount > c.max) v.push({ code: 'unresolved_constraint', detail: `Amount ${amt.amount} exceeds the approved maximum ${c.max}`, amount: amt.amount, max: c.max });
      if (c.min != null && amt.amount < c.min) v.push({ code: 'unresolved_constraint', detail: `Amount ${amt.amount} below the approved minimum ${c.min}` });
    } else if (c.type === 'payment.allowed_payees') {
      if (!(c.allowed ?? []).some((m) => merchantMatches(m, closed.payee))) v.push({ code: 'invalid_mandate', detail: `Payee ${closed.payee?.name} is not allowed by the mandate` });
    } else if (c.type === 'payment.reference') {
      if (c.conditional_transaction_id !== openCheckoutHash) v.push({ code: 'invalid_mandate', detail: 'Payment mandate is not linked to this checkout mandate' });
    } else {
      v.push({ code: 'unresolved_constraint', detail: `Unknown payment constraint ${c.type}` });
    }
  }
  return v;
}

// ---- verification at Complete Checkout ------------------------------------------------

// UCP AP2 error codes, mapped from what failed.
const UCP_CODE = {
  invalid_signature: 'mandate_invalid_signature',
  expired: 'mandate_expired',
  scope_mismatch: 'mandate_scope_mismatch',
  malformed: 'mandate_invalid_signature',
};

function sameCheckout(embedded, session) {
  const items = (c) => jcs((c.line_items ?? []).map((li) => ({ id: li.item?.id, q: li.quantity })));
  const totals = (c) => jcs((c.totals ?? []).map((t) => ({ type: t.type, amount: t.amount })));
  return embedded.id === session.id && embedded.currency === session.currency && items(embedded) === items(session) && totals(embedded) === totals(session);
}

const fail = (ucp_code, ap2_error, detail, extra = {}) => ({ status: 'failed', ucp_code, ap2_error, violations: [{ code: ap2_error, detail }], ...extra });

// Plain-language reason for a chain failure, with the technical cause kept.
const CHAIN_REASON = {
  invalid_signature: 'The AP2 approval is not signed by a trusted platform key, so there is no proof a human approved this purchase.',
  expired: 'The AP2 approval has expired.',
  scope_mismatch: 'The AP2 mandate was signed for a different seller or checkout.',
  malformed: 'The AP2 mandate is malformed.',
};
function chainFail(err, mode, prefix = '') {
  const code = err instanceof ChainError ? err.code : 'malformed';
  return fail(UCP_CODE[code] ?? 'mandate_invalid_signature', 'invalid_credential', `${prefix}${CHAIN_REASON[code] ?? CHAIN_REASON.malformed}`, { mode, technical: err.message });
}

// Verifies ap2.checkout_mandate (and the payment mandate from payment_data.token)
// for a session. Pure apart from the reuse check, which the caller supplies.
//   session          the stored checkout (internal view)
//   sellerJwk        this seller's key (its own signature on checkout_jwt)
//   rootKeyFor       trusted platform key lookup for root tokens
//   aud, nonce       this seller's endpoint and the checkout id
//   isReused(hash)   true if this open checkout mandate already bought something
export async function verifyAtComplete({ session, sellerJwk, checkoutMandate, paymentMandate, rootKeyFor, aud, nonce, isReused }) {
  if (!checkoutMandate) return fail('mandate_required', 'invalid_mandate', 'AP2 was negotiated but no ap2.checkout_mandate was sent');
  const segments = splitChain(checkoutMandate);
  const mode = segments.length === 1 ? 'human_present' : 'human_not_present';

  let checkout;
  try {
    checkout = verifyChain(checkoutMandate, { rootKeyFor, aud, nonce });
  } catch (err) {
    return chainFail(err, mode);
  }
  const closed = checkout.mandates.at(-1);
  const open = segments.length > 1 ? checkout.mandates[0] : null;
  if (closed.vct !== VCT.checkout || (open && open.vct !== VCT.openCheckout)) {
    return fail('mandate_invalid_signature', 'invalid_credential', `Unexpected mandate type ${open?.vct ?? ''} ${closed.vct}`.trim(), { mode });
  }
  if (!closed.checkout_jwt || sha256b64u(closed.checkout_jwt) !== closed.checkout_hash) {
    return fail('mandate_scope_mismatch', 'invalid_credential', 'checkout_hash does not match checkout_jwt', { mode });
  }

  // The checkout inside the mandate must be one this seller signed, and the
  // same checkout as this session.
  let embedded;
  try {
    embedded = verifyJws(closed.checkout_jwt, (h) => (h.kid === sellerJwk.kid ? publicJwk(sellerJwk) : null)).payload;
  } catch (err) {
    return fail('merchant_authorization_invalid', 'invalid_credential', `Seller signature on the checkout: ${err.message}`, { mode });
  }
  if (!sameCheckout(embedded, session)) {
    return fail('mandate_scope_mismatch', 'invalid_mandate', 'Mandate was signed for a different checkout (id, items or totals differ)', { mode });
  }

  const result = {
    status: 'verified',
    mode,
    checkout_hash: closed.checkout_hash,
    reference: sdHash(segments.at(-1)),
    open_checkout_hash: open ? sdHash(segments[0]) : null,
    violations: [],
  };
  if (!open) return result; // Human Present: the human approved this exact checkout.

  result.violations.push(...checkCheckoutConstraints(open, embedded));
  result.approved = {
    items: open.constraints.find((c) => c.type === 'checkout.line_items')?.items.map((r) => ({ id: r.acceptable_items?.[0]?.id, title: r.acceptable_items?.[0]?.title, quantity: r.quantity })) ?? [],
    exp: open.exp,
  };

  if (await isReused?.(result.open_checkout_hash)) {
    result.violations.push({ code: 'invalid_mandate', detail: 'This open mandate was already used for a completed purchase; an agent must not present it again' });
  }

  // Payment Mandate: the Guard verifies it on behalf of the seller's payment
  // processor (AP2 allows the merchant to delegate verification).
  if (!paymentMandate) {
    result.violations.push({ code: 'invalid_mandate', detail: 'No payment mandate in payment_data.token' });
  } else {
    try {
      const pay = verifyChain(paymentMandate, { rootKeyFor, aud, nonce });
      const [openPay, closedPay] = pay.mandates;
      if (pay.mandates.length !== 2 || openPay.vct !== VCT.openPayment || closedPay.vct !== VCT.payment) {
        result.violations.push({ code: 'invalid_credential', detail: 'Payment mandate chain has unexpected types' });
      } else {
        if (closedPay.transaction_id !== closed.checkout_hash) result.violations.push({ code: 'invalid_mandate', detail: 'Payment mandate is bound to a different checkout' });
        const total = session.totals.find((t) => t.type === 'total')?.amount;
        if (closedPay.payment_amount?.amount !== total || closedPay.payment_amount?.currency !== session.currency) {
          result.violations.push({ code: 'invalid_mandate', detail: 'Payment mandate amount differs from the checkout total' });
        }
        if (JSON.stringify(openPay.cnf) !== JSON.stringify(open.cnf)) result.violations.push({ code: 'invalid_mandate', detail: 'Payment and checkout mandates name different agents' });
        result.violations.push(...checkPaymentConstraints(openPay, closedPay, result.open_checkout_hash));
        const range = openPay.constraints.find((c) => c.type === 'payment.amount_range');
        result.approved.max_amount = range?.max ?? null;
        result.approved.currency = range?.currency ?? null;
      }
    } catch (err) {
      return chainFail(err, mode, 'Payment mandate: ');
    }
  }

  if (result.violations.some((v) => v.code !== 'unresolved_constraint')) {
    const first = result.violations.find((v) => v.code !== 'unresolved_constraint');
    // UCP has no code for a constraint violation, so the AP2 code is used.
    return { ...result, status: 'failed', ucp_code: first.code === 'invalid_credential' ? 'mandate_invalid_signature' : first.code, ap2_error: first.code };
  }
  if (result.violations.length) return { ...result, status: 'unresolved', ap2_error: 'unresolved_constraint' };
  return result;
}

// ---- receipts -------------------------------------------------------------------------

// AP2 Checkout Receipt: seller-signed JWT, reference = hash of the closed
// mandate (computed like sd_hash).
export function checkoutReceipt({ sellerJwk, iss, reference, status, error, error_description, order_id }) {
  const body = { iss, iat: now(), reference, status };
  if (status === 'Error') Object.assign(body, { error, error_description });
  if (status === 'Success' && order_id) body.order_id = order_id;
  return signJws({ kid: sellerJwk.kid, typ: 'JWT' }, body, sellerJwk);
}
