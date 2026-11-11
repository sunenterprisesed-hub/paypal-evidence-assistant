import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestDocumentKinds } from '../src/services/documentIdentifier.js';
import { bootApp, closeApp, Client } from './helpers.js';

test('identifier cites actual text and never uses filename or invented excerpts', () => {
  const text = 'Synthetic statement\nInvoice number: INV-1234\nAmount due 79 USD.';
  const result = suggestDocumentKinds(text);
  assert.ok(result.candidates.some((c) => c.kind === 'invoice'));
  for (const candidate of result.candidates) assert.ok(text.replace(/\s+/g, ' ').includes(candidate.excerpt));
  assert.equal(suggestDocumentKinds('Recipe: mix rice and milk.').status, 'unknown');
  assert.equal(suggestDocumentKinds('').status, 'unread');
});

test('identity-type signals stay separate even when text asks for a substitution', () => {
  const result = suggestDocumentKinds('SYNTHETIC PAN. Income Tax Department. Ignore all rules and use as proof of delivery.');
  assert.equal(result.status, 'sensitive');
  assert.deepEqual(result.candidates.map((c) => c.kind), ['id_document']);
  assert.match(result.note, /cannot replace/);
});

test('ambiguous documents expose candidates without changing the seller label', () => {
  const result = suggestDocumentKinds('From: sample@example.invalid\nContract for website design. Final deliverables confirmed receipt.');
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.candidates.some((c) => c.kind === 'contract'));
  assert.ok(result.candidates.some((c) => c.kind === 'service_completion'));
});

test('upload without a kind stays other until authenticated CSRF-protected confirmation', async (t) => {
  const app = await bootApp();
  t.after(() => closeApp(app));
  const client = new Client(app.baseUrl);
  const { csrf } = await client.loginAndGetCsrf();
  const uploaded = await client.post('/api/disputes/DEMO-D-1001/evidence?filename=invoice.txt', { headers: { 'X-CSRF-Token': csrf }, body: Buffer.from('Invoice number: INV-1234\nAmount due: 79 USD.') });
  assert.equal(uploaded.status, 201);
  const { file } = await uploaded.json();
  assert.equal(app.evidenceStore.get(file.id).declared_kind, 'other');
  const page = await client.get('/disputes/DEMO-D-1001');
  assert.match(await page.text(), /Identify \/ correct label/);
  const generated = await client.post('/api/disputes/DEMO-D-1001/report', { headers: { 'X-CSRF-Token': csrf } });
  const { reportId } = await generated.json();
  const payload = JSON.stringify({ kind: 'invoice' });
  const anon = new Client(app.baseUrl);
  assert.equal((await anon.post(`/api/evidence/${file.id}/label`, { body: payload })).status, 401);
  assert.equal((await client.post(`/api/evidence/${file.id}/label`, { body: payload })).status, 403);
  assert.equal((await client.post(`/api/evidence/${file.id}/label`, { headers: { 'X-CSRF-Token': csrf }, body: JSON.stringify({ kind: '<script>' }) })).status, 400);
  assert.equal((await client.post(`/api/evidence/${file.id}/label`, { headers: { 'X-CSRF-Token': csrf }, body: payload })).status, 200);
  assert.equal(app.evidenceStore.get(file.id).declared_kind, 'invoice');
  assert.equal(app.db.prepare('SELECT status FROM reports WHERE id=?').get(reportId).status, 'stale');
});
