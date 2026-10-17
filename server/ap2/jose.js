// Minimal JOSE for AP2 and the UCP AP2 extension, on Node's built-in crypto:
// ES256 (P-256) keys as JWK, compact and detached JWS (RFC 7515), and JSON
// Canonicalization (RFC 8785) for the signed checkout body.
//
// ECDSA signatures here are randomised, as AP2 requires for the checkout JWT
// (a deterministic scheme would let anyone confirm a guessed checkout by hash).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export const b64u = (input) => Buffer.from(input).toString('base64url');
export const b64uDecode = (s) => Buffer.from(String(s), 'base64url');
export const b64uJson = (s) => JSON.parse(b64uDecode(s).toString('utf8'));
export const salt = () => b64u(randomBytes(16));

// base64url(SHA-256(ascii)), the hash AP2 uses for checkout_hash and sd_hash.
export const sha256b64u = (ascii) => createHash('sha256').update(String(ascii), 'ascii').digest('base64url');

// RFC 8785 JCS. Keys sorted by UTF-16 code units (the default string sort),
// numbers and strings serialised as ECMAScript JSON does, undefined dropped.
export function jcs(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : jcs(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
}

export function generateKey(kid) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...privateKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
}

export function publicJwk(jwk) {
  const { d, ...pub } = jwk;
  return pub;
}

const toPrivate = (jwk) => createPrivateKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, format: 'jwk' });
const toPublic = (jwk) => createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });

function es256Sign(signingInput, privateJwk) {
  return sign('sha256', Buffer.from(signingInput, 'ascii'), { key: toPrivate(privateJwk), dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

function es256Verify(signingInput, signatureB64u, publicJwkValue) {
  try {
    return verify('sha256', Buffer.from(signingInput, 'ascii'), { key: toPublic(publicJwkValue), dsaEncoding: 'ieee-p1363' }, b64uDecode(signatureB64u));
  } catch {
    return false;
  }
}

// Compact JWS. payload is a string (already serialised) or an object (JSON).
export function signJws(header, payload, privateJwk) {
  const h = b64u(JSON.stringify({ alg: 'ES256', ...header }));
  const p = b64u(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return `${h}.${p}.${es256Sign(`${h}.${p}`, privateJwk)}`;
}

export class JoseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Verifies a compact JWS. keyFor(header) returns the public JWK to use.
// Returns { header, payload (parsed JSON), payloadB64 }.
export function verifyJws(compact, keyFor) {
  const parts = String(compact).split('.');
  if (parts.length !== 3) throw new JoseError('malformed', 'JWS must have three parts');
  const [h, p, s] = parts;
  let header;
  try {
    header = b64uJson(h);
  } catch {
    throw new JoseError('malformed', 'JWS header is not JSON');
  }
  if (header.alg !== 'ES256') throw new JoseError('unsupported_alg', `Unsupported alg ${header.alg}`);
  const key = keyFor(header);
  if (!key) throw new JoseError('unknown_key', `No key for kid ${header.kid ?? '(none)'}`);
  if (!es256Verify(`${h}.${p}`, s, key)) throw new JoseError('bad_signature', 'Signature does not verify');
  let payload;
  try {
    payload = b64uJson(p);
  } catch {
    throw new JoseError('malformed', 'JWS payload is not JSON');
  }
  return { header, payload, payloadB64: p };
}

// Detached JWS (RFC 7515 Appendix F): "<header>..<signature>" over a payload
// carried elsewhere. Used for UCP ap2.merchant_authorization over JCS(checkout).
export function signDetached(header, payloadString, privateJwk) {
  const [h, , s] = signJws(header, payloadString, privateJwk).split('.');
  return `${h}..${s}`;
}

export function verifyDetached(detached, payloadString, keyFor) {
  const parts = String(detached).split('.');
  if (parts.length !== 3 || parts[1] !== '') throw new JoseError('malformed', 'Detached JWS must look like header..signature');
  return verifyJws(`${parts[0]}.${b64u(payloadString)}.${parts[2]}`, keyFor);
}

// Re-attaches the payload to a detached JWS, giving the compact checkout JWT
// AP2 puts in checkout_jwt. Same signature, payload now carried inline.
export function attach(detached, payloadString) {
  const [h, , s] = String(detached).split('.');
  return `${h}.${b64u(payloadString)}.${s}`;
}
