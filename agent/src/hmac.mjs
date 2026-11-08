// Request signing between the dashboard (Vercel) and the agent.
//
// Signed string (UTF-8, lines joined with "\n"):
//   v1
//   METHOD
//   /path?query          (exactly as sent)
//   unix-seconds
//   nonce                (16+ random bytes, base64url)
//   actor                ("user:<id>:<epoch>" or "system:login")
//   hex(sha256(body))    (empty body -> sha256 of "")
//
// Headers: x-hop-kid, x-hop-ts, x-hop-nonce, x-hop-actor, x-hop-sig (base64url HMAC-SHA256).
import crypto from 'node:crypto';

export const MAX_SKEW_SECONDS = 60;
const NONCE_TTL_MS = 5 * 60 * 1000;

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf ?? '').digest('hex');
}

export function canonicalString({ method, path, ts, nonce, actor, bodyHash }) {
  return ['v1', method.toUpperCase(), path, String(ts), nonce, actor, bodyHash].join('\n');
}

export function sign(key, fields) {
  return crypto.createHmac('sha256', key).update(canonicalString(fields)).digest('base64url');
}

/** Parse "kid:base64,kid2:base64" into Map<kid, Buffer>. Keys must be >= 32 bytes. */
export function parseKeys(spec) {
  const keys = new Map();
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx < 1) throw new Error('AGENT_HMAC_KEYS entries must look like kid:base64key');
    const kid = part.slice(0, idx);
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(kid)) throw new Error(`bad key id "${kid}"`);
    const key = Buffer.from(part.slice(idx + 1), 'base64');
    if (key.length < 32) throw new Error(`key "${kid}" is shorter than 32 bytes`);
    keys.set(kid, key);
  }
  if (keys.size === 0) throw new Error('no HMAC keys configured');
  return keys;
}

export class NonceCache {
  constructor(ttlMs = NONCE_TTL_MS, max = 50_000) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.seen = new Map();
  }
  /** Returns true if the nonce is fresh (and records it), false if replayed. */
  use(nonce, now = Date.now()) {
    if (this.seen.size > this.max) this.sweep(now);
    const exp = this.seen.get(nonce);
    if (exp && exp > now) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
  sweep(now = Date.now()) {
    for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
  }
}

const ACTOR_RE = /^(user:[a-z0-9]{6,32}:\d{1,9}|system:login)$/;

/**
 * Verify a signed request. Returns { ok: true, actor } or { ok: false, reason }.
 * `headers` is a lower-cased header object, `rawBody` a Buffer.
 */
export function verifyRequest({ keys, nonces, method, path, headers, rawBody, now = Date.now() }) {
  const kid = headers['x-hop-kid'];
  const ts = headers['x-hop-ts'];
  const nonce = headers['x-hop-nonce'];
  const actor = headers['x-hop-actor'];
  const sig = headers['x-hop-sig'];
  if (!kid || !ts || !nonce || !actor || !sig) return { ok: false, reason: 'missing signature headers' };
  const key = keys.get(String(kid));
  if (!key) return { ok: false, reason: 'unknown key id' };
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(now / 1000 - Number(ts)) > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale timestamp' };
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(nonce)) return { ok: false, reason: 'bad nonce' };
  if (!ACTOR_RE.test(actor)) return { ok: false, reason: 'bad actor' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false, reason: 'bad signature format' };

  const expected = sign(key, { method, path, ts, nonce, actor, bodyHash: sha256Hex(rawBody) });
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };
  // Only burn the nonce once the signature is valid, so junk traffic can't fill the cache.
  if (!nonces.use(nonce, now)) return { ok: false, reason: 'replayed nonce' };
  return { ok: true, actor };
}

/** Build signature headers (used by tests and by the dashboard's equivalent TypeScript client). */
export function signHeaders({ kid, key, method, path, actor, body = '', now = Date.now() }) {
  const ts = Math.floor(now / 1000);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const bodyHash = sha256Hex(Buffer.from(body));
  const sig = sign(key, { method, path, ts, nonce, actor, bodyHash });
  return { 'x-hop-kid': kid, 'x-hop-ts': String(ts), 'x-hop-nonce': nonce, 'x-hop-actor': actor, 'x-hop-sig': sig };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
