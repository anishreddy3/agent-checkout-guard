// UCP checkout capability (dev.ucp.shopping.checkout, version 2026-01-11)
// implemented for the example sellers. Field names follow the public spec:
// Checkout { ucp, id, line_items, buyer, status, currency, totals, messages,
// links, expires_at, continue_url, payment, order }.
//
// The Guard runs inside completeCheckout. Its decision maps onto UCP states:
//   approve  -> completed (order populated)
//   step_up  -> requires_escalation (continue_url for a human to confirm)
//   decline  -> canceled (message explains why)

import { randomUUID } from 'node:crypto';
import { getSeller, getItem, unitPriceFor } from '../sellers/catalog.js';
import { getStore } from '../store/index.js';
import { evaluate } from '../guard/index.js';

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
      ],
    },
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
  const { seller_id, agent_profile, quote_history, guard, ...rest } = session;
  return rest;
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
  return publicView(session);
}

export async function getCheckout(sellerId, id) {
  const s = await getStore().get('sessions', id);
  if (!s || s.seller_id !== sellerId) throw new UcpError(404, 'not_found', 'Checkout not found');
  return publicView(s);
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
  return publicView(updated);
}

export async function cancelCheckout(sellerId, id, reason = 'canceled_by_platform') {
  const s = await getStore().get('sessions', id);
  if (!s || s.seller_id !== sellerId) throw new UcpError(404, 'not_found', 'Checkout not found');
  if (['completed', 'canceled'].includes(s.status)) return publicView(s);
  const updated = { ...s, status: 'canceled', messages: [...(s.messages ?? []), infoMessage(reason)] };
  await getStore().set('sessions', id, updated);
  await logEvent('checkout.canceled', updated, { reason });
  return publicView(updated);
}

function infoMessage(code, content = code) {
  return { type: 'info', code, content, severity: 'recoverable' };
}

export async function completeCheckout(req, sellerId, id, body) {
  const seller = getSeller(sellerId);
  const s = await getStore().get('sessions', id);
  if (!seller || !s || s.seller_id !== sellerId) throw new UcpError(404, 'not_found', 'Checkout not found');
  if (s.status === 'completed') return publicView(s);
  if (s.status === 'canceled') throw new UcpError(409, 'canceled', 'Checkout was canceled');
  if (!body.payment_data) throw new UcpError(400, 'missing_payment_data', 'payment_data is required');
  if (new Date(s.expires_at).getTime() < Date.now()) {
    const expired = { ...s, status: 'canceled', messages: [infoMessage('expired', 'Session expired')] };
    await getStore().set('sessions', id, expired);
    return publicView(expired);
  }

  const origin = baseUrl(req);
  const inProgress = { ...s, status: 'complete_in_progress' };
  await getStore().set('sessions', id, inProgress);

  // The Guard. risk_signals is the UCP-defined slot for exactly this input.
  const decision = await evaluate({
    session: inProgress,
    seller,
    risk_signals: body.risk_signals ?? {},
    payment_data: body.payment_data,
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
  await getStore().set('sessions', id, next);
  await logEvent('checkout.complete_attempt', next, {
    outcome: decision.outcome,
    risk_score: decision.risk_score,
    decision_id: decision.id,
  });
  return { ...publicView(next), 'x-guard': decision };
}
