// SD-JWT (RFC 9901) and AP2's delegation chain (draft-gco-oauth-delegate-sd-jwt,
// as implemented by the AP2 reference SDK):
//
//   root     <issuer-jwt>~<disclosure>...~        signed by a trusted key (kid)
//   hop      <kb+sd-jwt>~<disclosure>...~         signed by the previous cnf.jwk,
//                                                 carries sd_hash, iat, aud, nonce
//   chain    root (trailing ~ dropped) + "~~" + hop
//
// Each token's mandate sits in delegate_payload as a selectively disclosable
// array element. Inside a mandate, arrays can be disclosable element by element
// and properties can be disclosable through an _sd array.

import { b64u, b64uJson, salt, sha256b64u, signJws, verifyJws, JoseError } from './jose.js';

const SD_ALG = 'sha-256';
const ROOT_TYP = 'dc+sd-jwt';
export const TYP_TERMINAL = ['kb+sd-jwt', 'kb-sd-jwt'];
export const TYP_INTERMEDIATE = ['kb+sd-jwt+kb', 'kb-sd-jwt+kb'];

// ---- issuing -----------------------------------------------------------------

function discloseElement(value, out) {
  const d = b64u(JSON.stringify([salt(), value]));
  out.push(d);
  return { '...': sha256b64u(d) };
}

function discloseProperty(name, value, out) {
  const d = b64u(JSON.stringify([salt(), name, value]));
  out.push(d);
  return sha256b64u(d);
}

// Builds the disclosable form of a mandate.
//   sdArrays: { key: true } makes every element of arrays under that key
//             disclosable (e.g. acceptable_items, allowed).
//   sdProps:  top-level property names to hide behind _sd (e.g. checkout_jwt).
export function disclosable(mandate, { sdArrays = {}, sdProps = [] } = {}, out) {
  const walk = (value, key) => {
    if (Array.isArray(value)) {
      const items = value.map((v) => walk(v));
      return sdArrays[key] ? items.map((v) => discloseElement(v, out)) : items;
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    return value;
  };
  const body = walk(mandate);
  const sd = [];
  for (const name of sdProps) {
    if (name in body) {
      sd.push(discloseProperty(name, body[name], out));
      delete body[name];
    }
  }
  if (sd.length) body._sd = sd;
  return body;
}

const join = (jwt, disclosures) => `${jwt}~${disclosures.map((d) => `${d}~`).join('')}`;

// Root SD-JWT holding one mandate, signed by a trusted issuer key.
export function issueRoot(mandate, sdOptions, issuerJwk, extraClaims = {}) {
  const disclosures = [];
  const body = disclosable(mandate, sdOptions, disclosures);
  const payload = {
    ...extraClaims,
    iat: Math.floor(Date.now() / 1000),
    _sd_alg: SD_ALG,
    delegate_payload: [discloseElement(body, disclosures)],
  };
  return join(signJws({ typ: ROOT_TYP, kid: issuerJwk.kid }, payload, issuerJwk), disclosures);
}

// Key-bound hop: signed by the holder key named in the previous token's cnf,
// bound to it by sd_hash, and to this verifier by aud and nonce.
export function issueHop(prevToken, mandate, sdOptions, holderJwk, { aud, nonce }) {
  if (!aud || !nonce) throw new Error('aud and nonce are required for KB-SD-JWT hops');
  const disclosures = [];
  const body = disclosable(mandate, sdOptions, disclosures);
  const typ = body.cnf ? TYP_INTERMEDIATE[0] : TYP_TERMINAL[0];
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    aud,
    nonce,
    sd_hash: sdHash(prevToken),
    _sd_alg: SD_ALG,
    delegate_payload: [discloseElement(body, disclosures)],
  };
  return join(signJws({ typ }, payload, holderJwk), disclosures);
}

// ---- parsing and hashing -------------------------------------------------------

export function parseToken(token) {
  const s = String(token);
  if (!s.includes('~') || s.startsWith('~')) throw new JoseError('malformed', 'Not an SD-JWT');
  const parts = s.split('~');
  const issuerJwt = parts[0];
  const tail = parts.slice(1);
  const kb = s.endsWith('~') ? null : tail.pop();
  const disclosures = s.endsWith('~') ? tail.slice(0, -1) : tail;
  if (disclosures.some((d) => !d)) throw new JoseError('malformed', 'Empty disclosure');
  return { issuerJwt, disclosures, kb, sdForm: join(issuerJwt, disclosures) };
}

// sd_hash: hash over "<jwt>~<d1>~...~" (disclosures included, KB-JWT excluded).
export function sdHash(token) {
  return sha256b64u(typeof token === 'string' ? parseToken(token).sdForm : token.sdForm);
}

export function serializeChain(tokens) {
  return tokens.map((t, i) => (i < tokens.length - 1 && t.endsWith('~') ? t.slice(0, -1) : t)).join('~~');
}

export function splitChain(chain) {
  const segs = String(chain).split('~~');
  return segs.map((t, i) => (i < segs.length - 1 && !t.endsWith('~') ? `${t}~` : t));
}

// Replaces disclosure digests with their values. Undisclosed array elements
// are dropped, as RFC 9901 requires. Every disclosure must be referenced once.
function resolve(payload, disclosures) {
  const byDigest = new Map(disclosures.map((d) => [sha256b64u(d), d]));
  const used = new Set();
  const take = (digest) => {
    const d = byDigest.get(digest);
    if (!d) return undefined;
    if (used.has(digest)) throw new JoseError('malformed', 'Disclosure referenced twice');
    used.add(digest);
    return b64uJson(d);
  };
  const walk = (value) => {
    if (Array.isArray(value)) {
      const out = [];
      for (const v of value) {
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '...' in v) {
          const arr = take(v['...']);
          if (arr) {
            if (arr.length !== 2) throw new JoseError('malformed', 'Array disclosure must be [salt, value]');
            out.push(walk(arr[1]));
          }
        } else out.push(walk(v));
      }
      return out;
    }
    if (value && typeof value === 'object') {
      const obj = {};
      for (const [k, v] of Object.entries(value)) if (k !== '_sd') obj[k] = walk(v);
      for (const digest of value._sd ?? []) {
        const arr = take(digest);
        if (!arr) continue;
        if (arr.length !== 3) throw new JoseError('malformed', 'Property disclosure must be [salt, name, value]');
        if (arr[1] in obj) throw new JoseError('malformed', `Disclosed claim ${arr[1]} already present`);
        obj[arr[1]] = walk(arr[2]);
      }
      return obj;
    }
    return value;
  };
  const out = walk(payload);
  if (used.size !== byDigest.size) throw new JoseError('malformed', 'Disclosure not referenced by the token');
  delete out._sd_alg;
  return out;
}

// ---- chain verification -------------------------------------------------------

export class ChainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // invalid_signature | expired | scope_mismatch | malformed
  }
}

function checkTimes(obj, index, now, skew) {
  if (obj.exp != null && (typeof obj.exp !== 'number' || now > obj.exp + skew)) {
    throw new ChainError('expired', `Token ${index} expired at ${obj.exp}`);
  }
  if (obj.iat != null && (typeof obj.iat !== 'number' || obj.iat > now + skew)) {
    throw new ChainError('malformed', `Token ${index} iat is in the future`);
  }
}

// Verifies a "~~" chain. rootKeyFor(header) returns the trusted public JWK for
// the root token. aud and nonce are enforced on the terminal hop.
// Returns { mandates: [effective mandate per token], tokens: [parsed tokens] }.
export function verifyChain(chain, { rootKeyFor, aud, nonce, now = Math.floor(Date.now() / 1000), skew = 300 }) {
  let segments;
  try {
    segments = splitChain(chain).map(parseToken);
  } catch (err) {
    throw new ChainError('malformed', err.message);
  }
  const mandates = [];
  let prevKey = null;
  segments.forEach((tok, i) => {
    const isRoot = i === 0;
    const isLast = i === segments.length - 1;
    if (tok.kb) throw new ChainError('malformed', 'AP2 hops carry no separate KB-JWT');
    let verified;
    try {
      verified = verifyJws(tok.issuerJwt, (header) => (isRoot ? rootKeyFor(header) : prevKey));
    } catch (err) {
      throw new ChainError(err.code === 'malformed' ? 'malformed' : 'invalid_signature', `Token ${i}: ${err.message}`);
    }
    const { header, payload } = verified;
    if (!isRoot) {
      const terminal = TYP_TERMINAL.includes(header.typ);
      if (!terminal && !TYP_INTERMEDIATE.includes(header.typ)) throw new ChainError('malformed', `Token ${i}: unexpected typ ${header.typ}`);
      // Exactly one binding claim: sd_hash (over the previous SD-JWT with its
      // disclosures) or issuer_jwt_hash (over its issuer JWT alone).
      const prev = segments[i - 1];
      if (('sd_hash' in payload) === ('issuer_jwt_hash' in payload)) {
        throw new ChainError('malformed', `Token ${i}: needs exactly one of sd_hash or issuer_jwt_hash`);
      }
      const bound = 'sd_hash' in payload ? payload.sd_hash === sha256b64u(prev.sdForm) : payload.issuer_jwt_hash === sha256b64u(prev.issuerJwt);
      if (!bound) throw new ChainError('invalid_signature', `Token ${i}: not bound to the previous token`);
      if (typeof payload.iat !== 'number') throw new ChainError('malformed', `Token ${i}: missing iat`);
      if (isLast && (payload.aud !== aud || payload.nonce !== nonce)) {
        throw new ChainError('scope_mismatch', `Token ${i}: bound to a different verifier or checkout (aud/nonce)`);
      }
    }
    let resolved;
    try {
      resolved = resolve(payload, tok.disclosures);
    } catch (err) {
      throw new ChainError('malformed', `Token ${i}: ${err.message}`);
    }
    const items = (resolved.delegate_payload ?? []).filter((x) => x && typeof x === 'object');
    if (items.length !== 1) throw new ChainError('malformed', `Token ${i}: expected exactly one disclosed mandate`);
    const mandate = items[0];
    checkTimes(resolved, i, now, skew);
    checkTimes(mandate, i, now, skew);
    if (!isLast && !mandate.cnf?.jwk) throw new ChainError('malformed', `Token ${i}: open mandate needs cnf.jwk`);
    if (isLast && !isRoot && mandate.cnf) throw new ChainError('malformed', `Token ${i}: terminal mandate must not carry cnf`);
    prevKey = mandate.cnf?.jwk ?? null;
    mandates.push(mandate);
  });
  return { mandates, tokens: segments };
}
