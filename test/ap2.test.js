// AP2 primitives and mandate verification, without a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jcs, generateKey, publicJwk, signDetached, verifyDetached, attach, verifyJws, sha256b64u } from '../server/ap2/jose.js';
import { issueRoot, issueHop, serializeChain, splitChain, verifyChain, parseToken, sdHash } from '../server/ap2/sdjwt.js';
import {
  approveOpenMandates,
  closeMandates,
  approveClosedCheckout,
  signCheckout,
  checkoutJwtFrom,
  verifyAtComplete,
  evaluateLineItems,
  checkoutReceipt,
  merchantOf,
  newAgentKey,
} from '../server/ap2/mandates.js';

const platform = generateKey('platform-trusted-surface-1');
const sellerKey = generateKey('pelican_mail-checkout-1');
const rootKeyFor = (h) => (h.kid === platform.kid ? publicJwk(platform) : null);
const merchant = merchantOf({ id: 'pelican_mail', name: 'Pelican Mail (example seller)' });
const AUD = 'https://shop.example/sellers/pelican_mail';

function session({ id = 'chk_1', qty = 1, total = 19900 } = {}) {
  return {
    id,
    merchant,
    currency: 'USD',
    line_items: [{ id: 'li_1', item: { id: 'pm_growth_1m', title: 'Email API, Growth', price: 19900 }, quantity: qty, totals: [{ type: 'total', amount: total }] }],
    totals: [{ type: 'subtotal', amount: total }, { type: 'total', amount: total }],
    status: 'ready_for_complete',
  };
}

// Seller signs the checkout; agent receives it the way UCP returns it.
function signedResponse(s) {
  return { ...s, ap2: { merchant_authorization: signCheckout(s, sellerKey) } };
}

function flow({ qty = 1, approveQty = 1, max = 19900, total = 19900, agent = newAgentKey('t'), signer = platform } = {}) {
  const s = session({ qty, total });
  const open = approveOpenMandates({ platformJwk: signer, agentJwk: agent, merchant, items: [{ id: 'pm_growth_1m', title: 'Email API, Growth', quantity: approveQty }], maxAmount: max, currency: 'USD' });
  const resp = signedResponse(s);
  const closed = closeMandates({ open, agentJwk: agent, checkoutJwt: checkoutJwtFrom(resp), aud: AUD, nonce: s.id, payee: merchant, amount: total, currency: 'USD', instrument: { id: 'card_1', type: 'card' } });
  return { s, open, closed, resp, agent };
}

const verify = (s, closed, extra = {}) =>
  verifyAtComplete({ session: s, sellerJwk: sellerKey, checkoutMandate: closed.checkoutMandate, paymentMandate: closed.paymentMandate, rootKeyFor, aud: AUD, nonce: s.id, isReused: async () => false, ...extra });

test('JCS sorts keys and drops undefined', () => {
  assert.equal(jcs({ b: 1, a: [2, { d: undefined, c: 'x' }] }), '{"a":[2,{"c":"x"}],"b":1}');
});

test('detached JWS verifies, re-attaches to the checkout JWT, and rejects tampering', () => {
  const body = jcs({ id: 'chk_1', total: 100 });
  const det = signDetached({ kid: sellerKey.kid }, body, sellerKey);
  assert.match(det, /^[\w-]+\.\.[\w-]+$/);
  const keyFor = (h) => (h.kid === sellerKey.kid ? publicJwk(sellerKey) : null);
  assert.equal(verifyDetached(det, body, keyFor).payload.total, 100);
  assert.equal(verifyJws(attach(det, body), keyFor).payload.id, 'chk_1');
  assert.throws(() => verifyDetached(det, jcs({ id: 'chk_1', total: 1 }), keyFor), /Signature/);
});

test('SD-JWT chain: root + key-bound hop verify; disclosures resolve; sd_hash binds', () => {
  const agent = generateKey('agent');
  const root = issueRoot({ vct: 'x.open', constraints: [{ type: 't', allowed: [{ id: 'a' }, { id: 'b' }] }], cnf: { jwk: publicJwk(agent) } }, { sdArrays: { allowed: true } }, platform);
  assert.equal(parseToken(root).disclosures.length, 3); // delegate item + 2 array elements
  const hop = issueHop(root, { vct: 'x', secret: 's3' }, { sdProps: ['secret'] }, agent, { aud: AUD, nonce: 'n1' });
  const chain = serializeChain([root, hop]);
  assert.ok(chain.includes('~~'));
  assert.deepEqual(splitChain(chain), [root, hop]);
  const { mandates } = verifyChain(chain, { rootKeyFor, aud: AUD, nonce: 'n1' });
  assert.deepEqual(mandates[0].constraints[0].allowed, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(mandates[1].secret, 's3');
  assert.throws(() => verifyChain(chain, { rootKeyFor, aud: AUD, nonce: 'other' }), /aud\/nonce/);
  // Hop signed by a key other than the one in cnf
  const rogue = issueHop(root, { vct: 'x' }, {}, generateKey('rogue'), { aud: AUD, nonce: 'n1' });
  assert.throws(() => verifyChain(serializeChain([root, rogue]), { rootKeyFor, aud: AUD, nonce: 'n1' }), (e) => e.code === 'invalid_signature');
  // Hop bound to a different root
  const otherRoot = issueRoot({ vct: 'x.open', cnf: { jwk: publicJwk(agent) } }, {}, platform);
  assert.throws(() => verifyChain(serializeChain([otherRoot, hop]), { rootKeyFor, aud: AUD, nonce: 'n1' }), /not bound/);
});

test('happy path: open + closed mandates verify for the exact checkout', async () => {
  const { s, closed } = flow();
  const r = await verify(s, closed);
  assert.equal(r.status, 'verified', JSON.stringify(r.violations));
  assert.equal(r.mode, 'human_not_present');
  assert.equal(r.approved.max_amount, 19900);
  assert.equal(r.checkout_hash, closed.checkoutHash);
});

test('cart larger than the approved line items fails as invalid_mandate', async () => {
  const { s, closed } = flow({ qty: 40, approveQty: 1, total: 19900 * 40, max: 19900 * 40 });
  const r = await verify(s, closed);
  assert.equal(r.status, 'failed');
  assert.equal(r.ap2_error, 'invalid_mandate');
  assert.match(r.violations[0].detail, /does not authorise/);
});

test('amount above the approved ceiling is unresolved_constraint (human can approve)', async () => {
  const { s, closed } = flow({ max: 17900 });
  const r = await verify(s, closed);
  assert.equal(r.status, 'unresolved');
  assert.equal(r.violations[0].code, 'unresolved_constraint');
});

test('mandate signed by an untrusted key is rejected', async () => {
  const { s, closed } = flow({ signer: generateKey('platform-trusted-surface-1') }); // right kid, wrong key
  const r = await verify(s, closed);
  assert.equal(r.status, 'failed');
  assert.equal(r.ucp_code, 'mandate_invalid_signature');
});

test('mandate for one checkout cannot complete another', async () => {
  const { closed } = flow();
  const other = session({ id: 'chk_2' });
  const r = await verify(other, closed);
  assert.equal(r.status, 'failed');
  assert.equal(r.ucp_code, 'mandate_scope_mismatch');
});

test('missing mandate and reused open mandate', async () => {
  const s = session();
  assert.equal((await verify(s, { checkoutMandate: null })).ucp_code, 'mandate_required');
  const { s: s2, closed } = flow();
  const r = await verify(s2, closed, { isReused: async () => true });
  assert.equal(r.status, 'failed');
  assert.match(r.violations.map((v) => v.detail).join(' '), /already used/);
});

test('human-present closed mandate verifies on its own', async () => {
  const s = session();
  const jwt = checkoutJwtFrom(signedResponse(s));
  const r = await verify(s, { checkoutMandate: approveClosedCheckout({ platformJwk: platform, checkoutJwt: jwt }), paymentMandate: null });
  assert.equal(r.status, 'verified');
  assert.equal(r.mode, 'human_present');
});

test('line items evaluation follows the spec example', () => {
  const reqs = [
    { id: 'shoe', acceptable_items: [{ id: 'RED' }, { id: 'BLUE' }], quantity: 1 },
    { id: 'sock', acceptable_items: [{ id: 'SOCK' }], quantity: 1 },
  ];
  const cart = (...ids) => ids.map((id) => ({ item: { id }, quantity: 1 }));
  assert.deepEqual(evaluateLineItems(cart('RED', 'SOCK'), reqs), []);
  assert.deepEqual(evaluateLineItems(cart('BLUE', 'SOCK'), reqs), []);
  assert.ok(evaluateLineItems(cart('RED', 'BLUE'), reqs).length);
  assert.ok(evaluateLineItems(cart('RED'), reqs).length);
  assert.ok(evaluateLineItems(cart('SOCK'), reqs).length);
});

test('checkout receipt is a seller-signed JWT referencing the closed mandate', () => {
  const jwt = checkoutReceipt({ sellerJwk: sellerKey, iss: AUD, reference: 'abc', status: 'Success', order_id: 'ord_1' });
  const { payload } = verifyJws(jwt, () => publicJwk(sellerKey));
  assert.equal(payload.status, 'Success');
  assert.equal(payload.reference, 'abc');
  assert.equal(payload.order_id, 'ord_1');
  assert.equal(sdHash(jwt + '~'), sha256b64u(jwt + '~'));
});
