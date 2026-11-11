import test from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../src/util/html.js';
import { hashPassword, verifyPassword, csrfTokenMatches } from '../src/auth.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { REQUIREMENTS, requirementsFor, slotsFor, EVIDENCE_KINDS } from '../src/services/requirements.js';
import { HeuristicEngine } from '../src/services/analyzer.js';
import { buildReport, buildEvidencePayload } from '../src/services/reportBuilder.js';

// ---------- HTML escaping ----------
test('esc neutralises markup, quotes and ampersands', () => {
  assert.equal(esc('<script>alert("x")&\'</script>'), '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

// ---------- Password hashing ----------
test('scrypt hash verifies correct password and rejects wrong ones', () => {
  const hash = hashPassword('correct horse battery');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(verifyPassword('correct horse battery', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('correct horse battery', 'garbage'), false);
  assert.equal(verifyPassword('correct horse battery', 'scrypt$abc$zz$yy'), false);
});

test('csrfTokenMatches is strict about length and value', () => {
  const session = { csrf: 'a'.repeat(64) };
  assert.equal(csrfTokenMatches(session, 'a'.repeat(64)), true);
  assert.equal(csrfTokenMatches(session, 'b'.repeat(64)), false);
  assert.equal(csrfTokenMatches(session, 'a'.repeat(63)), false);
  assert.equal(csrfTokenMatches(session, null), false);
  assert.equal(csrfTokenMatches(session, 'é'.repeat(64)), false);
});

// ---------- Config validation ----------
test('production refuses to boot without secrets', () => {
  assert.throws(
    () => loadConfig({ APP_ENV: 'production' }),
    (err) => err instanceof ConfigError && err.errors.some((e) => e.includes('SESSION_SECRET'))
  );
});

test('production refuses weak/default admin password and short session secret', () => {
  assert.throws(() => loadConfig({
    APP_ENV: 'production',
    SESSION_SECRET: 'short',
    ADMIN_USERNAME: 'x',
    ADMIN_PASSWORD: 'demo-password',
  }), ConfigError);
});

test('live PayPal env is rejected; sandbox passes with both credentials', () => {
  assert.throws(() => loadConfig({
    APP_ENV: 'development', PAYPAL_ENV: 'live',
    PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b',
  }), ConfigError);
  const cfg = loadConfig({ APP_ENV: 'development', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' });
  assert.equal(cfg.paypal.enabled, true);
  assert.equal(cfg.paypal.baseUrl, 'https://api-m.sandbox.paypal.com');
});

test('AI provider requires https base URL and full settings', () => {
  assert.throws(() => loadConfig({
    APP_ENV: 'development', AI_PROVIDER: 'openai-compatible', AI_BASE_URL: 'http://insecure.example',
  }), ConfigError);
  const cfg = loadConfig({
    APP_ENV: 'development', AI_PROVIDER: 'openai-compatible',
    AI_BASE_URL: 'https://api.example.com', AI_API_KEY: 'k', AI_MODEL: 'm',
  });
  assert.equal(cfg.ai.enabled, true);
});

// ---------- Requirements matrix ----------
test('requirements matrix covers all documented PayPal dispute reasons', () => {
  const documented = [
    'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
    'UNAUTHORISED', 'CREDIT_NOT_PROCESSED', 'DUPLICATE_TRANSACTION',
    'INCORRECT_AMOUNT', 'PAYMENT_BY_OTHER_MEANS', 'CANCELED_RECURRING_BILLING', 'OTHER',
  ];
  for (const reason of documented) {
    assert.ok(REQUIREMENTS[reason], `missing ${reason}`);
    assert.ok(slotsFor(reason).length > 0, `no slots for ${reason}`);
  }
  assert.equal(requirementsFor('SOMETHING_UNKNOWN').label, REQUIREMENTS.OTHER.label);
});

test('every slot kind is a known evidence kind', () => {
  for (const reason of Object.keys(REQUIREMENTS)) {
    for (const slot of slotsFor(reason)) {
      for (const kind of slot.kinds) {
        assert.ok(Object.hasOwn(EVIDENCE_KINDS, kind), `unknown kind ${kind} in ${reason}`);
      }
    }
  }
});

// ---------- Heuristic analyzer ----------
const DISPUTE = {
  id: 'DEMO-D-1001', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE',
  amount: '79.00', currency: 'USD',
};

function fakeFile(over) {
  return {
    id: 'f'.repeat(32), original_name: 'doc.txt', mime: 'text/plain',
    declared_kind: 'other', size: 100, sha256: 'ab'.repeat(32), ...over,
  };
}

test('heuristic engine maps declared kinds to required slots and reports gaps', async () => {
  const engine = new HeuristicEngine(() => 'Carrier: DHL\nTracking number 1Z999AA10123456784 delivered');
  const withTracking = await engine.analyze({
    dispute: DISPUTE, context: { business_type: 'individual', statement: '' },
    files: [fakeFile({ declared_kind: 'tracking', original_name: 'dhl-tracking.txt' })],
  });
  assert.equal(withTracking.ready, false);
  assert.equal(withTracking.hasCandidates, true);
  const fulfillment = withTracking.groups.find((g) => g.id === 'fulfillment');
  assert.equal(fulfillment.status, 'candidate');

  const empty = await engine.analyze({ dispute: DISPUTE, context: { statement: '' }, files: [] });
  assert.equal(empty.ready, false);
  assert.ok(empty.suggestions.length > 0);
});

test('candidate anyOf groups mark sibling slots as alternative, not missing', async () => {
  const engine = new HeuristicEngine(() => 'Carrier: DHL\nTracking 1Z999AA10123456784');
  const result = await engine.analyze({
    dispute: DISPUTE, context: { statement: '' },
    files: [fakeFile({ declared_kind: 'tracking', original_name: 'dhl.txt' })],
  });
  const fulfillment = result.groups.find((g) => g.id === 'fulfillment');
  assert.equal(fulfillment.status, 'candidate');
  assert.equal(fulfillment.slots.find((s) => s.key === 'tracking').status, 'candidate');
  const alt = fulfillment.slots.find((s) => s.key === 'delivery_docs');
  assert.equal(alt.status, 'alternative');
  assert.match(alt.note, /Alternative/);
  assert.ok(result.caveat.includes('cached case'));
});

test('heuristic engine warns on declared-kind mismatch and never reclassifies', async () => {
  const engine = new HeuristicEngine(() => 'this is a signed contract for design services');
  const result = await engine.analyze({
    dispute: DISPUTE, context: { statement: '' },
    files: [fakeFile({ declared_kind: 'tracking', original_name: 'contract.txt' })],
  });
  assert.ok(result.warnings.some((w) => w.type === 'kind_mismatch'));
});

test('freelancer statement triggers identity-vs-business-evidence reminder', async () => {
  const engine = new HeuristicEngine(() => '');
  const result = await engine.analyze({
    dispute: DISPUTE,
    context: { business_type: 'individual', statement: 'I am a freelancer, I do not have a company.' },
    files: [],
  });
  assert.ok(result.statementChecks.some((s) => s.includes('identity documents')));
});

// ---------- Report builder ----------
test('report contains case facts, gaps and the outcome disclaimer', () => {
  const analysis = {
    engine: 'heuristic', ready: false,
    groups: [{
      id: 'fulfillment', title: 'Prove fulfilment or delivery', status: 'missing',
      slots: [{ key: 'tracking', label: 'Carrier name and tracking number', status: 'missing', slotRequired: false, evidence: [] }],
    }],
    warnings: [], suggestions: [], requirementsSource: 'https://developer.paypal.com/disputes/reasons-evidence',
  };
  const report = buildReport({
    dispute: DISPUTE,
    context: { business_type: 'individual', statement: 'Delivered the work on time.' },
    files: [fakeFile({ declared_kind: 'tracking' })],
    analysis,
  });
  assert.match(report, /DEMO-D-1001/);
  assert.match(report, /Delivered the work on time\./);
  assert.match(report, /does not guarantee/);
  assert.match(report, /incomplete/);
});

test('evidence payload uses covered evidence kinds and never invents data', () => {
  const analysis = {
    groups: [{
      id: 'fulfillment', title: 't', status: 'covered',
      slots: [{ key: 'tracking', status: 'covered', slotRequired: false, evidence: [{ id: 'x', name: 'dhl.txt', kind: 'tracking' }] }],
    }],
  };
  const payload = buildEvidencePayload({ analysis, reportContent: 'reviewed report' });
  assert.equal(payload.length, 1);
  assert.equal(payload[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.deepEqual(payload[0].documents, [{ name: 'dhl.txt' }]);
  assert.equal(buildEvidencePayload({ analysis: null, reportContent: '' }).length, 0);
});

test('evidence payload maps real analyzer candidate output to the right group and type', async () => {
  const engine = new HeuristicEngine(() => 'Carrier: DHL\nTracking number 1Z999AA10123456784 delivered');
  const analysis = await engine.analyze({
    dispute: DISPUTE,
    context: {},
    files: [fakeFile({ declared_kind: 'tracking', original_name: 'dhl-tracking.txt' })],
  });
  const fulfillment = analysis.groups.find((g) => g.id === 'fulfillment');
  assert.equal(fulfillment.status, 'candidate');
  const payload = buildEvidencePayload({ analysis, reportContent: 'reviewed report' });
  assert.equal(payload.length, 1);
  assert.equal(payload[0].evidence_type, 'PROOF_OF_FULFILLMENT');
  assert.ok(payload[0].documents.some((d) => d.name === 'dhl-tracking.txt'));
});

test('recipes labelled refund and unread binary labels never become evidence candidates', async () => {
  const engine = new HeuristicEngine(() => 'Recipe: mix rice and milk. Bake for 20 minutes.');
  const result = await engine.analyze({ dispute: DISPUTE, context: {}, files: [fakeFile({ declared_kind: 'refund_record', original_name: 'recipe.txt' })] });
  assert.equal(result.ready, false);
  assert.equal(result.hasCandidates, false);
  assert.equal(result.groups.find((g) => g.id === 'refund').status, 'missing');
  const binary = await engine.analyze({ dispute: DISPUTE, context: {}, files: [fakeFile({ declared_kind: 'tracking', mime: 'application/pdf', original_name: 'tracking.pdf' })] });
  assert.equal(binary.hasCandidates, false);
  assert.ok(binary.warnings.some((w) => w.type === 'unverified_binary'));
});

test('actual PayPal seller requests override generic reason suggestions', async () => {
  const engine = new HeuristicEngine(() => 'Carrier: DHL\nTracking number 1Z999AA10123456784 delivered');
  const dispute = { ...DISPUTE, raw_json: JSON.stringify({ evidences: [{ source: 'REQUESTED_FROM_SELLER', evidence_type: 'PROOF_OF_REFUND' }] }) };
  const result = await engine.analyze({ dispute, context: {}, files: [fakeFile({ declared_kind: 'tracking' })] });
  assert.equal(result.caseSpecific, true);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].slots[0].key, 'case_PROOF_OF_REFUND');
  assert.equal(result.hasCandidates, false);
  assert.equal(result.ready, false);
});

test('unknown case-request evidence types stay unresolved, not generic fallback', async () => {
  const engine = new HeuristicEngine(() => 'Refund ID: ABC12345');
  const result = await engine.analyze({ dispute: { ...DISPUTE, raw_json: JSON.stringify({ evidences: [{ source: 'REQUESTED_FROM_SELLER', evidence_type: 'NEW_UNKNOWN_TYPE' }] }) }, context: {}, files: [fakeFile({ declared_kind: 'refund_record' })] });
  assert.equal(result.caseSpecific, true);
  assert.equal(result.hasCandidates, false);
});
