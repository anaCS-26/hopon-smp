// Token buckets per (actor, class). In memory: a restart resets them, which is fine.
export const RATE_CLASSES = {
  read: { capacity: 240, refillPerSec: 4 },
  write: { capacity: 30, refillPerSec: 0.5 },
  heavy: { capacity: 20, refillPerSec: 20 / 600 },
  login: { capacity: 20, refillPerSec: 1 / 3 },
  upload: { capacity: 5, refillPerSec: 5 / 600 },
};

export class RateLimiter {
  constructor(classes = RATE_CLASSES) {
    this.classes = classes;
    this.buckets = new Map();
  }
  /** Returns { ok: true } or { ok: false, retryAfter } (seconds). */
  take(actor, cls, now = Date.now()) {
    const spec = this.classes[cls];
    if (!spec) throw new Error(`unknown rate class ${cls}`);
    const key = `${cls}|${actor}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: spec.capacity, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(spec.capacity, b.tokens + ((now - b.at) / 1000) * spec.refillPerSec);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / spec.refillPerSec) };
  }
}
