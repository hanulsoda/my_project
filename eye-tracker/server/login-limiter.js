'use strict';
// In-memory failed-login limiter. Fixed window per key, started by the key's first failure:
// `max` failures inside `windowMs` blocks the key until that window ends. State is lost on
// restart and is per process, which is fine for the single-container deployment.
//
// The Map stays in window-start order (a key is re-inserted when its window restarts), so
// expired entries are purged lazily from the front and, at the size cap, the oldest goes first.
const DEFAULTS = { max: 10, windowMs: 15 * 60 * 1000, cap: 10_000 };
const MAX_KEY_LEN = 254;

function createLoginLimiter({ now = Date.now, max = DEFAULTS.max, windowMs = DEFAULTS.windowMs, cap = DEFAULTS.cap } = {}) {
  const entries = new Map(); // key -> { count, start }
  const keyOf = (key) => String(key).slice(0, MAX_KEY_LEN);

  function purgeExpired() {
    const t = now();
    for (const [k, e] of entries) {
      if (t - e.start < windowMs) break;
      entries.delete(k);
    }
  }

  function check(key) {
    const k = keyOf(key);
    const e = entries.get(k);
    if (!e) return { blocked: false, retryAfterSec: 0 };
    const left = e.start + windowMs - now();
    if (left <= 0) { entries.delete(k); return { blocked: false, retryAfterSec: 0 }; }
    return e.count >= max ? { blocked: true, retryAfterSec: Math.ceil(left / 1000) } : { blocked: false, retryAfterSec: 0 };
  }

  function recordFailure(key) {
    const k = keyOf(key);
    const t = now();
    const e = entries.get(k);
    if (e && t - e.start < windowMs) { e.count++; return; }
    entries.delete(k);
    purgeExpired();
    while (entries.size >= cap) entries.delete(entries.keys().next().value);
    entries.set(k, { count: 1, start: t });
  }

  const clear = (key) => { entries.delete(keyOf(key)); };

  return { check, recordFailure, clear, size: () => entries.size };
}

module.exports = { createLoginLimiter };
