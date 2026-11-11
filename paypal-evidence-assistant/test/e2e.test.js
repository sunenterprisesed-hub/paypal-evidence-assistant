import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeApp, Client } from './helpers.js';

/**
 * End-to-end flow against the real server: login, view demo disputes, save
 * context, upload evidence, analyze, generate + edit + review + export a
 * report, and verify submission is refused in demo mode.
 */

test('full dispute evidence workflow in demo mode', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const client = new Client(app.baseUrl);

  // Unauthenticated users are redirected to login.
  const anon = await client.get('/');
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.get('location'), '/login');

  // Wrong password fails with a generic message.
  const bad = await client.login('demo', 'wrong-password');
  assert.equal(bad.status, 401);
  assert.match(await bad.text(), /Invalid username or password/);

  // Correct login sets a session cookie and lands on the dashboard.
  const { csrf, html } = await client.loginAndGetCsrf();
  assert.ok(csrf, 'csrf token present on dashboard');
  assert.match(html, /DEMO-D-1001/);
  assert.match(html, /Demo data \(synthetic\)/);
  assert.match(html, /rule-based fallback/);

  // Save case context (freelancer statement).
  const ctx = await client.post('/api/disputes/DEMO-D-1001/context', {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ business_type: 'individual', statement: 'I am a freelancer and delivered the work on 2 Nov.' }),
  });
  assert.equal(ctx.status, 200);

  // Upload synthetic service-completion evidence (coherent for a freelancer).
  const confirmationText = 'From: buyer@example.com\nThe website is live and I have confirmed receipt of the final deliverables.\n';
  const upload = await client.post('/api/disputes/DEMO-D-1001/evidence?filename=buyer-confirmation.txt&kind=service_completion', {
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf },
    body: Buffer.from(confirmationText, 'utf8'),
  });
  assert.equal(upload.status, 201);
  const uploaded = (await upload.json()).file;
  assert.equal(uploaded.name, 'buyer-confirmation.txt');
  assert.equal(uploaded.sha256.length, 64);

  // Upload a second document that does not match its declared kind.
  const mismatch = await client.post('/api/disputes/DEMO-D-1001/evidence?filename=scope.txt&kind=refund_record', {
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf },
    body: Buffer.from('Contract for landing page design. Scope: 5 pages. Signed by both parties.', 'utf8'),
  });
  assert.equal(mismatch.status, 201);

  // Run the analysis.
  const analysisRes = await client.post('/api/disputes/DEMO-D-1001/analyze', {
    headers: { 'X-CSRF-Token': csrf },
  });
  assert.equal(analysisRes.status, 200);
  const analysis = (await analysisRes.json()).analysis;
  assert.equal(analysis.engine, 'heuristic');
  assert.equal(analysis.ready, false); // matching text is not verified proof
  assert.equal(analysis.hasCandidates, true);
  const fulfillment = analysis.groups.find((g) => g.id === 'fulfillment');
  assert.equal(fulfillment.status, 'candidate');
  const docsSlot = fulfillment.slots.find((s) => s.key === 'delivery_docs');
  const trackingSlot = fulfillment.slots.find((s) => s.key === 'tracking');
  assert.equal(docsSlot.status, 'candidate');
  assert.equal(trackingSlot.status, 'alternative', 'uncovered alternative is not shown as missing');
  assert.ok(analysis.caveat.includes('cached case'), 'precedence caveat present');
  assert.ok(analysis.warnings.some((w) => w.type === 'kind_mismatch'), 'mismatch warning raised');
  assert.ok(analysis.statementChecks.some((s) => s.includes('freelancer')), 'freelancer statement check present');

  // Generate a report.
  const gen = await client.post('/api/disputes/DEMO-D-1001/report', { headers: { 'X-CSRF-Token': csrf } });
  assert.equal(gen.status, 201);
  const reportId = (await gen.json()).reportId;

  // Edit it.
  const detail = await client.get('/disputes/DEMO-D-1001');
  const detailHtml = await detail.text();
  assert.match(detailHtml, /Evidence package - PayPal dispute DEMO-D-1001/);

  // Review requires confirmation.
  const reviewNoConfirm = await client.post(`/api/reports/${reportId}/review`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ confirmed: false }),
  });
  assert.equal(reviewNoConfirm.status, 400);

  const review = await client.post(`/api/reports/${reportId}/review`, {
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ confirmed: true }),
  });
  assert.equal(review.status, 200);

  // Export downloads the package.
  const exported = await client.get(`/api/reports/${reportId}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.match(await exported.text(), /does not guarantee/);

  // Submission must be refused in demo mode.
  const submit = await client.post(`/api/reports/${reportId}/submit`, { headers: { 'X-CSRF-Token': csrf } });
  assert.equal(submit.status, 400);
  assert.match((await submit.json()).error, /hard-disabled/);

  // The case page shows the audit trail.
  const finalPage = await client.get('/disputes/DEMO-D-1001');
  const finalHtml = await finalPage.text();
  assert.match(finalHtml, /evidence\.upload/);
  assert.match(finalHtml, /report\.review/);
});

test('exports are read-only and source changes invalidate reviewed report snapshots', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const client = new Client(app.baseUrl);
  const { csrf } = await client.loginAndGetCsrf();
  const headers = { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
  await client.post('/api/disputes/DEMO-D-1001/analyze', { headers });
  const generated = await client.post('/api/disputes/DEMO-D-1001/report', { headers });
  const { reportId } = await generated.json();
  await client.post(`/api/reports/${reportId}/review`, { headers, body: JSON.stringify({ confirmed: true }) });
  const before = app.db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  const auditBefore = app.db.prepare('SELECT count(*) n FROM audit_log').get().n;
  await (await client.get(`/api/reports/${reportId}/export`)).text();
  assert.deepEqual(app.db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId), before);
  assert.equal(app.db.prepare('SELECT count(*) n FROM audit_log').get().n, auditBefore);
  const change = await client.post('/api/disputes/DEMO-D-1001/context', { headers, body: JSON.stringify({ business_type: 'individual', statement: 'Corrected factual context' }) });
  assert.equal(change.status, 200);
  const oldExport = await client.get(`/api/reports/${reportId}/export`);
  assert.equal(oldExport.status, 409);
  assert.equal(app.db.prepare('SELECT status FROM reports WHERE id = ?').get(reportId).status, 'stale');
  assert.equal((await client.post(`/api/reports/${reportId}/review`, { headers, body: JSON.stringify({ confirmed: true }) })).status, 409);
});

test('real PDF and PNG uploads extract text through the HTTP workflow', async (t) => {
  const fs = await import('node:fs');
  const app = await bootApp();
  t.after(() => closeApp(app));
  const client = new Client(app.baseUrl);
  const { csrf } = await client.loginAndGetCsrf();
  for (const fixture of [
    { name: 'synthetic-service.pdf', kind: 'contract', expected: 'pdf_text' },
    { name: 'synthetic-confirmation.png', kind: 'service_completion', expected: 'ocr' },
  ]) {
    const bytes = fs.readFileSync(new URL('./fixtures/' + fixture.name, import.meta.url));
    const response = await client.post(`/api/disputes/DEMO-D-1001/evidence?filename=${fixture.name}&kind=${fixture.kind}`, {
      headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    assert.equal(response.status, 201);
    const { file } = await response.json();
    const stored = app.evidenceStore.get(file.id);
    assert.equal(stored.extraction_status, fixture.expected);
    assert.match(stored.extracted_text, /confirmed receipt/);
  }
  const result = await client.post('/api/disputes/DEMO-D-1001/analyze', { headers: { 'X-CSRF-Token': csrf } });
  const { analysis } = await result.json();
  assert.equal(analysis.hasCandidates, true);
  assert.equal(analysis.ready, false);
  assert.ok(analysis.warnings.some((w) => w.type === 'ocr_unverified'));
  const page = await client.get('/disputes/DEMO-D-1001');
  assert.match(await page.text(), /Review extracted text \(unverified\)/);
});
