// A small UCP platform client. The buyer agent uses it to talk to sellers
// over plain HTTP exactly as an external platform would: discovery at
// /.well-known/ucp, then the checkout REST binding.

import { randomUUID } from 'node:crypto';

export class UcpClient {
  constructor({ origin, agentProfile }) {
    this.origin = origin.replace(/\/$/, '');
    this.agentProfile = agentProfile;
    this.calls = [];
  }

  headers() {
    return {
      'content-type': 'application/json',
      'UCP-Agent': `profile="${this.agentProfile}"`,
      'Request-Id': randomUUID(),
      'Idempotency-Key': randomUUID(),
      // Not verified in this simulation. A production platform signs the request body.
      'Request-Signature': 'demo',
    };
  }

  async request(method, path, body) {
    const url = `${this.origin}${path}`;
    const started = Date.now();
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    this.calls.push({ method, path, status: res.status, ms: Date.now() - started });
    if (!res.ok) {
      const err = new Error(json.error?.message || json.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  listSellers() {
    return this.request('GET', '/api/sellers');
  }
  discover(sellerId) {
    return this.request('GET', `/sellers/${sellerId}/.well-known/ucp`);
  }
  catalog(sellerId) {
    return this.request('GET', `/sellers/${sellerId}/catalog`);
  }
  createCheckout(sellerId, body) {
    return this.request('POST', `/sellers/${sellerId}/checkout-sessions`, body);
  }
  updateCheckout(sellerId, id, body) {
    return this.request('PUT', `/sellers/${sellerId}/checkout-sessions/${id}`, body);
  }
  completeCheckout(sellerId, id, body) {
    return this.request('POST', `/sellers/${sellerId}/checkout-sessions/${id}/complete`, body);
  }
  cancelCheckout(sellerId, id) {
    return this.request('POST', `/sellers/${sellerId}/checkout-sessions/${id}/cancel`, {});
  }
}

export function mockCard(token = 'success_token') {
  return {
    id: 'instr_demo_card',
    handler_id: 'mock_payment_handler',
    type: 'card',
    brand: 'visa',
    last_digits: '4242',
    billing_address: {
      street_address: '1 Example Street',
      address_locality: 'Bengaluru',
      address_region: 'KA',
      address_country: 'IN',
      postal_code: '560001',
    },
    credential: { type: 'PAYMENT_GATEWAY', token },
  };
}
