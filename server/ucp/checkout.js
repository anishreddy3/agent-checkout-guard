// UCP checkout capability (dev.ucp.shopping.checkout, version 2026-01-11)
// implemented for the example sellers. Field names follow the public spec:
// Checkout { ucp, id, line_items, buyer, status, currency, totals, messages,
// links, expires_at, continue_url, payment, order }.
//
// AP2 (dev.ucp.shopping.ap2_mandate): every checkout response carries
// ap2.merchant_authorization, the seller's detached signature over the
// checkout. When AP2 is negotiated, Complete Checkout must carry
// ap2.checkout_mandate (and the payment mandate in payment_data.token); both
// are verified before the Guard decides, and the response carries a signed
// AP2 Checkout Receipt.
//
// The Guard runs inside completeCheckout. Its decision maps onto UCP states:
//   approve  -> completed (order populated)
//   step_up  -> requires_escalation (continue_url for a human to confirm)
//   decline  -> canceled (message explains why)

import { randomUUID } from 'node:crypto';
import { getSeller, getItem, unitPriceFor } from '../sellers/catalog.js';
import { getStore } from '../store/index.js';
import { evaluate } from '../guard/index.js';
import { merchantOf, signCheckout, verifyAtComplete, checkoutReceipt } from '../ap2/mandates.js';
import { sellerKey, platformKeyById, trustedPlatformFor } from '../ap2/keys.js';
import { publicJwk, sha256b64u } from '../ap2/jose.js';

export const UCP_VERSION = '2026-01-11';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export class UcpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

export function manifest(seller, origin) {
  const root = `${origin}/sellers/${seller.id}`;
  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        'dev.ucp.shopping': {
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/overview/`,
          rest: {
            schema: `https://ucp.dev/${UCP_VERSION}/services/shopping.openapi.json`,
            endpoint: root,
          },
        },
      },
      capabilities: [
        {
          name: 'dev.ucp.shopping.checkout',
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/checkout/`,
          schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/checkout.json`,
        },
        {
          name: 'dev.ucp.shopping.ap2_mandate',
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/ap2-mandates/`,
          extends: 'dev.ucp.shopping.checkout',
          config: { vp_formats_supported: { 'dc+sd-jwt': {} } },
        },
      ],
    },
    // Keys this seller signs checkouts and receipts with (kid lookup).
    signing_keys: [publicJwk(sellerKey(seller.id))],
    payment: {
      handlers: [
        {
          id: 'mock_payment_handler',
          name: 'dev.ucp.mock_payment',
          version: UCP_VERSION,
          spec: `https://ucp.dev/${UCP_VERSION}/specification/payment/`,
          config_schema: `https://ucp.dev/${UCP_VERSION}/schemas/payment/mock_config.json`,
          instrument_schemas: [`https://ucp.dev/${UCP_VERSION}/schemas/payment/card.json`],
          config: { success_token: 'success_token', fail_token: 'fail_token' },
        },
      ],
    },
    // Non-standard, clearly namespaced: lets agents read pricing without
    // scraping a page, and advertises that Complete Checkout is guarded.
    'x-agent-checkout-guard': {
      catalog: `${root}/catalog`,
      guarded_complete: true,
      seller_verified: Boolean(seller.trust?.verified),
    },
  };
}

// Parse UCP-Agent: profile="https://platform.example/profile"
export function agentProfileFrom(req) {
  const h = req.headers['ucp-agent'] || '';
  const m = /profile\s*=\s*"?([^";]+)"?/i.exec(h);
  return m ? m[1].trim() : null;
}

function priceLineItems(seller, lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new UcpError(400, 'invalid_line_items', 'line_items must be a non-empty array');
  }
  return lineItems.map((li, idx) => {
    const itemId = li.item?.id;
    const quantity = Number(li.quantity);
    const item = getItem(seller.id, itemId);
    if (!item) throw new UcpError(400, 'unknown_item', `Unknown item ${itemId}`);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new UcpError(400, 'invalid_quantity', `Invalid quantity for ${itemId}`);
    }
    const unit = unitPriceFor(item, quantity);
    const listTotal = item.price * quantity;
    const total = unit * quantity;
    return {
      id: li.id || `li_${idx + 1}`,
      item: { id: item.id, title: item.title, price: item.price },
      quantity,
      totals: [
        { type: 'subtotal', amount: listTotal },
        ...(listTotal - total > 0
          ? [{ type: 'items_discount', amount: listTotal - total, display_text: 'Volume tier' }]
          : []),
        { type: 'total', amount: total },
      ],
    };
  });
}

function sumTotals(lineItems) {
  const subtotal = lineItems.reduce((a, li) => a + li.item.price * li.quantity, 0);
  const discount = lineItems.reduce(
    (a, li) => a + (li.totals.find((t) => t.type === 'items_discount')?.amount ?? 0),
    0
  );
  const total = subtotal - discount;
  return [
    { type: 'subtotal', amount: subtotal },
    ...(discount > 0 ? [{ type: 'discount', amount: discount, display_text: 'Volume pricing' }] : []),
    { type: 'tax', amount: 0 },
    { type: 'total', amount: total },
  ];
}

function totalOf(session) {
  return session.totals.find((t) => t.type === 'total')?.amount ?? 0;
}

function links(origin, seller) {
  return [
    { type: 'privacy_policy', url: `${origin}/sellers/${seller.id}/legal/privacy`, title: 'Privacy policy' },
    { type: 'terms_of_service', url: `${origin}/sellers/${seller.id}/legal/terms`, title: 'Terms of service' },
  ];
}

function publicView(session) {
  // Strip internal fields before returning to the platform.
  const { seller_id, agent_profile, quote_history, guard, ap2_state, ...rest } = session;
  return rest;
}

// What the platform receives: the checkout plus the seller's signature over it.
export function signedView(session) {
  const body = publicView(session);
  return { ...body, ap2: { merchant_authorization: signCheckout(body, sellerKey(session.seller_id)) } };
}

async function logEvent(type, session, extra = {}) {
  await getStore().add('events', {
    type,
    at: new Date().toISOString(),
    seller_id: session.seller_id,
    agent_profile: session.agent_profile,
    checkout_id: session.id,
    status: session.status,
    total: totalOf(session),
    currency: session.currency,
    ...extra,
  });
}

export async function createCheckout(req, sellerId, body) {
  const seller = getSeller(sellerId);
  if (!seller) throw new UcpError(404, 'unknown_seller', 'Unknown seller');
  const agent = agentProfileFrom(req);
  if (!agent) throw new UcpError(400, 'missing_ucp_agent', 'UCP-Agent header is required');
  if (body.currency && body.currency !== seller.currency) {
    throw new UcpError(400, 'unsupported_currency', `Seller only quotes in ${seller.currency}`);
  }
  const origin = baseUrl(req);
  const line_items = priceLineItems(seller, body.line_items);
  const totals = sumTotals(line_items);
  const now = new Date();
  const session = {
    ucp: { version: UCP_VERSION },
    id: `chk_${randomUUID().slice(0, 12)}`,
    seller_id: seller.id,
    merchant: merchantOf(seller),
    agent_profile: agent,
    line_items,
    buyer: body.buyer ?? null,
    status: 'ready_for_complete',
    currency: seller.currency,
    totals,
    messages: [],
    links: links(origin, seller),
    expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    payment: {
      handlers: manifest(seller, origin).payment.handlers.map(({ id, name, version }) => ({ id, name, version })),
      instruments: body.payment?.instruments ?? [],
      selected_instrument_id: body.payment?.selected_instrument_id ?? null,
    },
    quote_history: [{ at: now.toISOString(), total: totals.find((t) => t.type === 'total').amount }],
    created_at: now.toISOString(),
  };
  await getStore().set('sessions', session.id, session);
  await logEvent('checkout.created', session);
  return signedView(session);
}

export async function getCheckout(sellerId, id) {
  const s = await getStore().get('sessions', id);
  if (!s || s.seller_id !== sellerId) throw new UcpError(404, 'not_found', 'Checkout not found');
  return signedView(s);
}

export async function updateCheckout(req, sellerId, id, body) {
  const seller = getSeller(sellerId);
  const s = await getStore().get('sessions', id);
  if (!seller || !s || s.seller_id !== sellerId) throw new UcpError(404, 'not_found', 'Checkout not found');
  if (['completed', 'canceled'].includes(s.status)) {
    throw new UcpError(409, 'immutable', `Checkout is ${s.status}`);
  }
  const line_items = priceLineItems(seller, body.line_items);
  const totals = sumTotals(line_items);
  const updated = {
    ...s,
    line_items,
    buyer: body.buyer ?? s.buyer,
    payment: { ...s.payment, ...(body.payment ?? {}) },
    totals,
    status: 'ready_for_complete',
    messages: [],
    continue_url: undefined,
    quote_history: [
      ...(s.quote_history ?? []),
      { at: new Date().toISOString(), total: totals.find((t) => t.type === 'total').amount },
    ],
  };
  await getStore().set('sessions', id, updated);
  await logEvent('checkout.updated', updated);
  return signedView(updated);
}

export async function cancelCheckout(sellerId, id, reason = 'canceled_by_platform') {
  const s = await getStore().get('sessions', id);
  if (!s || s.seller_id !== sellerId) throw new UcpError(404, 'not_found', 'Checkout not found');
  if (['completed', 'canceled'].includes(s.status)) return signedView(s);
  const updated = { ...s, status: 'canceled', messages: [...(s.messages ?? []), infoMessage(reason)] };
  await getStore().set('sessions', id, updated);
  await logEvent('checkout.canceled', updated, { reason });
  return signedView(updated);
}

function infoMessage(code, content = code) {
  return { type: 'info', code, content, severity: 'recoverable' };
}

export async function completeCheckout(req, sellerId, id, body) {
  const seller = getSeller(sellerId);
  const s = await getStore().get('sessions', id);
  if (!seller || !s || s.seller_id !== sellerId) throw new UcpError(404, 'not_found', 'Checkout not found');
  if (s.status === 'completed') return signedView(s);
  if (s.status === 'canceled') throw new UcpError(409, 'canceled', 'Checkout was canceled');
  if (!body.payment_data) throw new UcpError(400, 'missing_payment_data', 'payment_data is required');
  if (new Date(s.expires_at).getTime() < Date.now()) {
    const expired = { ...s, status: 'canceled', messages: [infoMessage('expired', 'Session expired')] };
    await getStore().set('sessions', id, expired);
    return signedView(expired);
  }

  const origin = baseUrl(req);
  const inProgress = { ...s, status: 'complete_in_progress' };
  await getStore().set('sessions', id, inProgress);

  // AP2. Negotiated when the platform is a trusted Agent Provider (or sends
  // mandates anyway). Mandates are bound to this seller's endpoint (aud) and
  // to this checkout (nonce).
  const aud = `${origin}/sellers/${seller.id}`;
  const trusted = trustedPlatformFor(s.agent_profile);
  let ap2 = null;
  if (trusted || body.ap2) {
    const started = Date.now();
    ap2 = await verifyAtComplete({
      session: s,
      sellerJwk: sellerKey(seller.id),
      checkoutMandate: body.ap2?.checkout_mandate,
      paymentMandate: body.payment_data?.token,
      rootKeyFor: (h) => (trusted ? platformKeyById(h.kid) : null),
      aud,
      nonce: s.id,
      isReused: async (hash) =>
        (await getStore().query('events', [['open_checkout_hash', '==', hash]], { limit: 20 })).some((e) => e.type === 'ap2.mandate_used'),
    });
    ap2.verify_ms = Date.now() - started;
  }

  // The Guard. risk_signals is the UCP-defined slot for exactly this input.
  const decision = await evaluate({
    session: inProgress,
    seller,
    risk_signals: body.risk_signals ?? {},
    payment_data: body.payment_data,
    ap2,
  });

  let next;
  if (decision.outcome === 'approve') {
    const mockFail = body.payment_data?.credential?.token === 'fail_token';
    if (mockFail) {
      next = {
        ...inProgress,
        status: 'ready_for_complete',
        messages: [
          { type: 'error', code: 'payment_declined', content: 'Payment was declined by the handler', severity: 'recoverable' },
        ],
      };
    } else {
      const orderId = `ord_${randomUUID().slice(0, 10)}`;
      next = {
        ...inProgress,
        status: 'completed',
        messages: [],
        order: { id: orderId, permalink_url: `${origin}/sellers/${seller.id}/orders/${orderId}` },
      };
    }
  } else if (decision.outcome === 'step_up') {
    next = {
      ...inProgress,
      status: 'requires_escalation',
      continue_url: `${origin}/review/${inProgress.id}`,
      messages: [
        {
          type: 'error',
          code: 'guard_step_up',
          content: decision.explanation,
          severity: 'requires_buyer_review',
        },
      ],
    };
  } else {
    next = {
      ...inProgress,
      status: 'canceled',
      messages: [
        { type: 'error', code: 'guard_declined', content: decision.explanation, severity: 'requires_buyer_input' },
      ],
    };
  }
  next.guard = { decision_id: decision.id, outcome: decision.outcome, risk_score: decision.risk_score };
  let receipt = null;
  if (ap2) {
    if (ap2.status === 'failed') {
      next.messages = [...next.messages, { type: 'error', code: ap2.ucp_code, content: ap2.violations?.[0]?.detail ?? 'AP2 mandate rejected', severity: 'requires_buyer_input' }];
    }
    next.ap2_state = { status: ap2.status, mode: ap2.mode ?? null, open_checkout_hash: ap2.open_checkout_hash ?? null };
    const completedNow = next.status === 'completed';
    // AP2 Checkout Receipt. Failures caused by the mandate carry the AP2 error;
    // Guard decisions on a valid mandate carry this service's own codes.
    receipt = checkoutReceipt({
      sellerJwk: sellerKey(seller.id),
      iss: aud,
      reference: ap2.reference ?? sha256b64u(body.ap2?.checkout_mandate ?? ''),
      status: completedNow ? 'Success' : 'Error',
      order_id: next.order?.id,
      error: ap2.ap2_error ?? (decision.outcome === 'step_up' ? 'risk_step_up' : 'risk_declined'),
      error_description: completedNow ? undefined : decision.explanation,
    });
    if (completedNow && ap2.open_checkout_hash) {
      await getStore().add('events', { type: 'ap2.mandate_used', at: new Date().toISOString(), open_checkout_hash: ap2.open_checkout_hash, checkout_id: id, agent_profile: s.agent_profile });
    }
  }
  await getStore().set('sessions', id, next);
  await logEvent('checkout.complete_attempt', next, {
    outcome: decision.outcome,
    risk_score: decision.risk_score,
    decision_id: decision.id,
  });
  const out = signedView(next);
  if (receipt) out.ap2.checkout_receipt = receipt;
  return { ...out, 'x-guard': decision };
}
