import crypto from 'node:crypto';
import { randomId } from './util/ids.js';
import { parseCookies, httpError } from './util/http.js';

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const [, nStr, saltHex, keyHex] = parts;
  const n = Number.parseInt(nStr, 10);
  if (!Number.isInteger(n) || n < 1024 || n > 1048576) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: n, r: SCRYPT_R, p: SCRYPT_P });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function createSession(db, config, username) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  // Bound concurrent sessions for this single-admin application.
  db.prepare('DELETE FROM sessions WHERE username = ? AND id NOT IN (SELECT id FROM sessions WHERE username = ? ORDER BY created_at DESC LIMIT 9)').run(username, username);
  const id = randomId(32);
  const storedId = crypto.createHmac('sha256', config.sessionSecret).update(id).digest('hex');
  const csrf = randomId(32);
  const now = new Date();
  const expires = new Date(now.getTime() + config.sessionTtlMs);
  db.prepare('INSERT INTO sessions (id, username, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(storedId, username, csrf, now.toISOString(), expires.toISOString());
  return { id, csrf, username };
}

export function destroySession(db, sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function getSession(req, db, config) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  const storedId = crypto.createHmac('sha256', config.sessionSecret).update(sid).digest('hex');
  const row = db.prepare('SELECT id, username, csrf_token, expires_at FROM sessions WHERE id = ?').get(storedId);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(db, storedId);
    return null;
  }
  return { id: row.id, username: row.username, csrf: row.csrf_token };
}

export function sessionCookie(config, sessionId) {
  const parts = [`sid=${sessionId}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`];
  if (config.isProd) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';
}

/** Timing-safe comparison of a presented CSRF token against the session's. */
export function csrfTokenMatches(session, token) {
  if (typeof token !== 'string' || token.length !== session.csrf.length) return false;
  const a = Buffer.from(token, 'utf8');
  const b = Buffer.from(session.csrf, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verifies the CSRF token on a mutating request. The token is per-session and
 * must arrive in the X-CSRF-Token header (set by the frontend from a meta tag).
 */
export function requireCsrf(req, session) {
  if (!csrfTokenMatches(session, req.headers['x-csrf-token'])) {
    throw httpError(403, 'Missing or invalid CSRF token');
  }
}
