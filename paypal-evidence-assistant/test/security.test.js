import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeApp, Client } from './helpers.js';

/**
 * Security regression tests. Every test here is a real attack shape executed
 * against the running server; the claims in SECURITY.md trace back to these.
 */

test('auth, CSRF, sessions and rate limiting', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const client = new Client(app.baseUrl);

  // API requires auth.
  const anon = await client.post('/api/disputes/DEMO-D-1001/analyze');
  assert.equal(anon.status, 401);

  // Login works and the session cookie carries the hardening flags.
  const login = await client.login();
  assert.equal(login.status, 303);
  const setCookie = login.headers.getSetCookie().join(';');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);

  // Mutations without a CSRF token are refused.
  const noCsrf = await client.post('/api/disputes/DEMO-D-1001/context', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ business_type: 'individual', statement: '' }),
  });
  assert.equal(noCsrf.status, 403);

  // Mutations with a wrong CSRF token are refused.
  const badCsrf = await client.post('/api/disputes/DEMO-D-1001/context', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'x'.repeat(64) },
    body: JSON.stringify({ business_type: 'individual', statement: '' }),
  });
  assert.equal(badCsrf.status, 403);

  // Login rate limiting: 5 attempts per 5 minutes per IP.
  const limited = new Client(app.baseUrl);
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const res = await limited.login('demo', 'wrong-password');
    statuses.push(res.status);
    await res.text();
  }
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.deepEqual(statuses.slice(5), [429, 429]);

  // A forged session id is not accepted.
  const forged = new Client(app.baseUrl);
  forged.cookies.set('sid', 'a'.repeat(64));
  const forgedRes = await forged.get('/');
  assert.equal(forgedRes.status, 303); // redirected to login
});

test('upload validation rejects dangerous files', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const client = new Client(app.baseUrl);
  const { csrf } = await client.loginAndGetCsrf();

  const upload = (query, body) => client.post(`/api/disputes/DEMO-D-1001/evidence?${query}`, {
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf },
    body,
  });

  // Disallowed extension (HTML could carry script if ever rendered).
  const html = await upload('filename=evil.html&kind=other', Buffer.from('<script>alert(1)</script>'));
  assert.equal(html.status, 400);

  // SVG is refused even though browsers treat it as an image.
  const svg = await upload('filename=evil.svg&kind=other', Buffer.from('<svg onload=alert(1)></svg>'));
  assert.equal(svg.status, 400);

  // Executable content with an allowed extension fails the magic-byte check.
  const fakePdf = await upload('filename=fake.pdf&kind=other', Buffer.from('MZ not a real pdf'));
  assert.equal(fakePdf.status, 400);

  // Unknown evidence kind is refused.
  const badKind = await upload('filename=ok.txt&kind=../../etc', Buffer.from('hello'));
  assert.equal(badKind.status, 400);

  // Binary junk as .txt is refused.
  const junk = await upload('filename=junk.txt&kind=other', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  assert.equal(junk.status, 400);

  // Path-traversal filename is neutralised to a display name only.
  const traversal = await upload('filename=..%2F..%2Fevil.txt&kind=other', Buffer.from('harmless text'));
  assert.equal(traversal.status, 201);
  const file = (await traversal.json()).file;
  assert.ok(!file.name.includes('/'), 'stored display name contains no path separators');

  // Unknown file ids cannot be downloaded or deleted.
  const missing = await client.get(`/api/evidence/${'0'.repeat(32)}/download`);
  assert.equal(missing.status, 404);
  const badId = await client.get('/api/evidence/..%2F..%2Fapp.db/download');
  assert.equal(badId.status, 404);

  // Downloaded files are forced attachments, never rendered inline.
  const dl = await client.get(`/api/evidence/${file.id}/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
});

test('security headers, body limits and error hygiene', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const client = new Client(app.baseUrl);
  const { csrf } = await client.loginAndGetCsrf();

  const res = await client.get('/');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('referrer-policy'), /no-referrer/);

  // No inline scripts in any page (CSP would block them; verify we emit none).
  const html = await res.text();
  assert.ok(!/<script(?![^>]*src=)/i.test(html), 'no inline <script> blocks');

  // JSON body cap: >256KB rejected.
  const big = Buffer.alloc(300 * 1024, 'a');
  const tooBig = await client.post('/api/disputes/DEMO-D-1001/context', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: big,
  });
  assert.equal(tooBig.status, 413);

  // Malformed JSON gets a clean 400, not a stack trace.
  const malformed = await client.post('/api/disputes/DEMO-D-1001/context', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /Malformed JSON/);

  // Stored-XSS attempt in case statement is escaped on render.
  await client.post('/api/disputes/DEMO-D-1002/context', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ business_type: 'individual', statement: '<img src=x onerror=alert(1)>' }),
  });
  const page = await client.get('/disputes/DEMO-D-1002');
  const pageHtml = await page.text();
  assert.ok(!pageHtml.includes('<img src=x'), 'statement is escaped in the page');
  assert.match(pageHtml, /&lt;img src=x/);

  // Unknown routes return JSON 404 without internals.
  const notFound = await client.get('/api/../../etc/passwd');
  assert.equal(notFound.status, 404);
});

test('demo disputes are clearly labelled and login page carries the synthetic-data notice', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const client = new Client(app.baseUrl);
  const loginPage = await client.get('/login');
  assert.match(await loginPage.text(), /synthetic/i);
  const { html } = await client.loginAndGetCsrf();
  assert.match(html, /Demo data \(synthetic\)/);
});


test('malformed percent-encoded cookies do not crash the server', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const response = await fetch(app.baseUrl + '/login', { headers: { Cookie: 'sid=%E0%A4%A' } });
  assert.equal(response.status, 200);
  const healthy = await fetch(app.baseUrl + '/login');
  assert.equal(healthy.status, 200);
});

test('session store holds digests, secret rotation rejects old tokens, expiry is purged', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const client = new Client(app.baseUrl);
  await client.login();
  const token = client.cookies.get('sid');
  const row = app.db.prepare('SELECT id, expires_at FROM sessions').get();
  assert.notEqual(row.id, token, 'raw browser token must not be stored');
  const { getSession } = await import('../src/auth.js');
  assert.equal(getSession({ headers: { cookie: `sid=${token}` } }, app.db, { ...app.config, sessionSecret: 'changed-secret-012345678901234567890' }), null);
  app.db.prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00Z');
  await client.login();
  assert.equal(app.db.prepare("SELECT count(*) n FROM sessions WHERE expires_at < '2001-01-01'").get().n, 0);
});

test('concurrent session count is bounded for the single-admin login', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const { createSession } = await import('../src/auth.js');
  for (let n = 0; n < 15; n++) createSession(app.db, app.config, 'demo');
  assert.equal(app.db.prepare('SELECT count(*) n FROM sessions').get().n, 10);
});
