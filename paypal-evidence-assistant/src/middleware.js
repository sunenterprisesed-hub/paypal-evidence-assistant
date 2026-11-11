import { httpError } from './util/http.js';

/**
 * Fixed-window in-memory rate limiter. Suitable for this single-process app.
 * Keys are caller-chosen (e.g. `login:<ip>:<username>`).
 */
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  /** True when the key is already at/over its budget (does not increment). */
  tooMany(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    return Boolean(entry) && now - entry.start < this.windowMs && entry.count >= this.max;
  }

  /** Records one hit for the key (e.g. one failed login attempt). */
  record(key) {
    this.allow(key);
  }

  /** Returns true if the action is allowed, false if the limit is exceeded. */
  allow(key) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (!entry && this.hits.size >= 10000) {
        for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
        if (this.hits.size >= 10000) return false;
      }
      entry = { start: now, count: 0 };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    // Opportunistic cleanup to bound memory.
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) {
        if (now - v.start >= this.windowMs) this.hits.delete(k);
      }
    }
    return entry.count <= this.max;
  }
}

export function clientIp(req) {
  // No proxy is trusted by default; if deployed behind one, set it to append
  // X-Forwarded-For and terminate TLS, and revisit this.
  return req.socket.remoteAddress || 'unknown';
}

export function requireAuth(req, db) {
  const session = req.session;
  if (!session) throw httpError(401, 'Authentication required');
  return session;
}

/** Limits used across the app. */
export function makeLimiters() {
  return {
    login: new RateLimiter({ windowMs: 5 * 60 * 1000, max: 5 }),       // 5 attempts / 5 min
    upload: new RateLimiter({ windowMs: 60 * 1000, max: 30 }),          // 30 uploads / min
    api: new RateLimiter({ windowMs: 60 * 1000, max: 120 }),            // general API budget
  };
}
