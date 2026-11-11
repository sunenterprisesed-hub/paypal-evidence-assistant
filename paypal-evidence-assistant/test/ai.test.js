import test from 'node:test';
import assert from 'node:assert/strict';
import { HeuristicEngine, OpenAiCompatibleEngine, runAnalysis } from '../src/services/analyzer.js';

const aiConfig = { baseUrl: 'https://provider.example', apiKey: 'fake-test-key', model: 'test-model', timeoutMs: 100 };
const input = { dispute: { reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', amount: '1.00', currency: 'USD' }, context: {}, files: [{ id: 'identity', original_name: 'pan.txt', declared_kind: 'id_document', mime: 'text/plain' }] };
const heuristic = new HeuristicEngine(() => 'Identity card, not fulfilment evidence.');
const response = (payload) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) });

test('AI cannot substitute identity documents for fulfilment even with valid file IDs', async () => {
  const ai = new OpenAiCompatibleEngine(aiConfig, heuristic, response({ slotMapping: [{ slotKey: 'tracking', fileIds: ['identity'], rationale: 'Replace company proof' }], conflicts: [], suggestions: [] }));
  await assert.rejects(() => ai.analyze(input), /unsupported evidence substitution/);
  const result = await runAnalysis({ ai: { enabled: true } }, heuristic, ai, input, { warn() {} });
  assert.equal(result.engine, 'heuristic (ai fallback)');
  assert.equal(result.hasCandidates, false);
});

test('AI schema rejects unknown IDs, non-string suggestions and duplicate mappings', async () => {
  for (const payload of [
    { slotMapping: [{ slotKey: 'tracking', fileIds: ['invented'], rationale: '' }], conflicts: [], suggestions: [] },
    { slotMapping: [], conflicts: [], suggestions: [{ instruction: 'do something' }] },
    { slotMapping: [{ slotKey: 'tracking', fileIds: [], rationale: '' }, { slotKey: 'tracking', fileIds: [], rationale: '' }], conflicts: [], suggestions: [] },
  ]) {
    await assert.rejects(() => new OpenAiCompatibleEngine(aiConfig, heuristic, response(payload)).analyze(input));
  }
});
