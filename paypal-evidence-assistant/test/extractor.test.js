import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractDocumentText } from '../src/services/extractor.js';

const fixture = (name) => fs.readFileSync(new URL('./fixtures/' + name, import.meta.url));

test('isolated PDF extraction reads actual synthetic document text', async () => {
  const result = await extractDocumentText(fixture('synthetic-service.pdf'), 'application/pdf');
  assert.equal(result.status, 'pdf_text');
  assert.match(result.text, /Contract for website design/);
  assert.match(result.text, /confirmed receipt/);
});

test('isolated image OCR reads actual synthetic confirmation text', async () => {
  const result = await extractDocumentText(fixture('synthetic-confirmation.png'), 'image/png');
  assert.equal(result.status, 'ocr');
  assert.match(result.text, /confirmed receipt/i);
  assert.match(result.note, /misread/);
});

test('malformed binaries fail closed instead of becoming labelled proof', async () => {
  const result = await extractDocumentText(Buffer.from('%PDF- malformed file with no document'), 'application/pdf');
  assert.equal(result.status, 'failed');
  assert.equal(result.text, '');
});

test('scanned PDF uses isolated first-three-page OCR fallback', async () => {
  const result = await extractDocumentText(fixture('synthetic-scan.pdf'), 'application/pdf');
  assert.equal(result.status, 'ocr');
  assert.match(result.text, /confirmed receipt/i);
  assert.match(result.note, /first 3 pages only/);
});

test('actual parser isolation preflight hides application/home paths and environment', async () => {
  const { extractionPreflight } = await import('../src/services/extractor.js');
  assert.equal(await extractionPreflight(), true);
});
