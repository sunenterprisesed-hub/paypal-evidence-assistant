import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalClient, PayPalError, normalizeDispute } from '../src/services/paypalClient.js';

/**
 * PayPal client tests with a scripted fetch double. No real network calls.
 * These verify request shape, token caching, error mapping and the
 * submission guards - not PayPal's behaviour, which stays untested until
 * real sandbox credentials exist.
 */

function makeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const key = `${options.method || 'GET'} ${url.replace('https://api-m.sandbox.paypal.com', '')}`;
    const route = routes[key];
    if (!route) throw new Error(`Unexpected call: ${key}`);
    const { status = 200, body = {} } = typeof route === 'function' ? route(options) : route;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

const TOKEN_ROUTE = { 'POST /v1/oauth2/token': { body: { access_token: 'tok-1', expires_in: 3600 } } };

const RAW_DISPUTE = {
  dispute_id: 'PP-D-9001',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  dispute_amount: { value: '42.00', currency_code: 'USD' },
  create_time: '2026-11-01T10:00:00Z',
  seller_response_due_date: '2026-11-15T10:00:00Z',
  links: [{ rel: 'provide-evidence', href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-9001/provide-evidence' }],
};

test('token is fetched once and cached across calls', async () => {
  const fetchImpl = makeFetch({
    ...TOKEN_ROUTE,
    'GET /v1/customer/disputes': { body: { items: [RAW_DISPUTE] } },
    'GET /v1/customer/disputes/PP-D-9001': { body: RAW_DISPUTE },
  });
  const client = new PayPalClient({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'id', clientSecret: 'secret', fetchImpl });
  const list = await client.listDisputes();
  const one = await client.getDispute('PP-D-9001');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'PP-D-9001');
  assert.equal(list[0].source, 'paypal-sandbox');
  assert.equal(list[0].can_provide_evidence, true);
  assert.equal(one.reason, 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED');
  const tokenCalls = fetchImpl.calls.filter((c) => c.url.includes('oauth2'));
  assert.equal(tokenCalls.length, 1, 'token cached');
  // Secret travels only in the Basic auth header of the token request.
  const authHeader = tokenCalls[0].options.headers.Authorization;
  assert.ok(authHeader.startsWith('Basic '));
  assert.equal(fetchImpl.calls.some((c) => c.url.includes('secret')), false);
});

test('auth failure produces a credential/enablement hint, never the secret', async () => {
  const fetchImpl = makeFetch({ 'POST /v1/oauth2/token': { status: 401, body: { error: 'invalid_client' } } });
  const client = new PayPalClient({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'bad', clientSecret: 'super-secret-value', fetchImpl });
  await assert.rejects(() => client.listDisputes(), (err) => {
    assert.ok(err instanceof PayPalError);
    assert.match(err.message, /Disputes feature/);
    assert.ok(!err.message.includes('super-secret-value'), 'secret must not leak into errors');
    return true;
  });
});

test('dispute id format is validated before any network call', async () => {
  const fetchImpl = makeFetch({ ...TOKEN_ROUTE });
  const client = new PayPalClient({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'id', clientSecret: 'secret', fetchImpl });
  await assert.rejects(() => client.getDispute('../../admin'), PayPalError);
  await assert.rejects(() => client.getDispute('id with spaces'), PayPalError);
  assert.equal(fetchImpl.calls.length, 0, 'no network call for invalid ids');
});

test('development transport sends multipart JSON and actual attachment bytes', async () => {
  let captured;
  const fetchImpl = makeFetch({
    ...TOKEN_ROUTE,
    'POST /v1/customer/disputes/PP-D-9001/provide-evidence': (options) => {
      captured = options;
      return { status: 200, body: { links: [] } };
    },
  });
  const client = new PayPalClient({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'id', clientSecret: 'secret', fetchImpl });
  await client.provideEvidence('PP-D-9001', {
    evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'Synthetic service confirmation.', documents: [{ name: 'confirmation.pdf' }] }],
    attachments: [{ name: 'confirmation.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF- synthetic-test-bytes') }],
  });
  assert.ok(captured.body instanceof FormData);
  const input = JSON.parse(await captured.body.get('input').text());
  assert.equal(captured.body.get('input').type, 'application/json');
  assert.equal(captured.body.get('file1').name, 'confirmation.pdf');
  assert.equal(await captured.body.get('file1').text(), '%PDF- synthetic-test-bytes');
  assert.equal(input.evidences[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  // Authorization is a Bearer token, not the client secret.
  assert.match(captured.headers.Authorization, /^Bearer tok-1/);
});

test('provideEvidence rejects empty evidence and bad ids', async () => {
  const client = new PayPalClient({ baseUrl: 'https://api-m.sandbox.paypal.com', clientId: 'id', clientSecret: 'secret', fetchImpl: makeFetch({}) });
  await assert.rejects(() => client.provideEvidence('PP-D-1', { evidences: [] }), PayPalError);
  await assert.rejects(() => client.provideEvidence('bad id!', { evidences: [{}] }), PayPalError);
});

test('normalizeDispute tolerates partial payloads', () => {
  const d = normalizeDispute({ dispute_id: 'X-1' });
  assert.equal(d.id, 'X-1');
  assert.equal(d.reason, 'OTHER');
  assert.equal(d.status, 'UNKNOWN');
  assert.equal(d.can_provide_evidence, false);
});
