// AP2 signing keys for the parties in the simulated workflow.
//
//   sellers[id]  each illustrative seller signs its checkouts (UCP merchant_authorization,
//                AP2 checkout_jwt) and its Checkout Receipts.
//   platform     the buyer platform's Trusted Surface: signs mandates after the
//                human approves them (AP2 "Trusted Agent Provider" model).
//
// Keys come from AP2_KEYS (JSON, from Secret Manager in production) so every
// Cloud Run instance signs and verifies with the same keys. Without it, fresh
// keys are generated per process, which is fine for tests and local runs.
// Agent keys are not here: the buyer agent makes a new one for every run.

import { generateKey, publicJwk } from './jose.js';
import { SELLERS } from '../sellers/catalog.js';

let keys = null;

export function generateKeySet() {
  return {
    platform: generateKey('platform-trusted-surface-1'),
    sellers: Object.fromEntries(Object.keys(SELLERS).map((id) => [id, generateKey(`${id}-checkout-1`)])),
  };
}

function load() {
  if (keys) return keys;
  if (process.env.AP2_KEYS) {
    keys = { ...JSON.parse(process.env.AP2_KEYS), source: 'configured' };
  } else {
    keys = { ...generateKeySet(), source: 'ephemeral' };
  }
  return keys;
}

export const sellerKey = (sellerId) => load().sellers[sellerId] ?? null;
export const platformKey = () => load().platform;
export const keySource = () => load().source;

// Buyer platforms this deployment trusts as AP2 Trusted Agent Providers, by the
// UCP-Agent profile they present. AP2 is negotiated for these profiles: their
// Complete Checkout must carry mandates signed by the platform's key.
const TRUSTED_PLATFORM_PROFILES = new Set([
  'https://platform.example/agents/procurement-bot',
  'https://platform.example/agents/marketing-ops-bot',
]);

export function trustedPlatformFor(profile) {
  return TRUSTED_PLATFORM_PROFILES.has(profile) ? { profile, signing_keys: [publicJwk(platformKey())] } : null;
}

export function platformKeyById(kid) {
  const k = platformKey();
  return k.kid === kid ? publicJwk(k) : null;
}

export function publicKeys() {
  const k = load();
  return {
    source: k.source,
    platform: { signing_keys: [publicJwk(k.platform)] },
    sellers: Object.fromEntries(Object.entries(k.sellers).map(([id, jwk]) => [id, { signing_keys: [publicJwk(jwk)] }])),
  };
}

export function resetKeysForTests() {
  keys = null;
}
