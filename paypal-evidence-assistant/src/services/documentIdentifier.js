import { EVIDENCE_KINDS } from './requirements.js';

/** Local suggestions, never an authenticity or sufficiency decision. */
const RULES = [
  ['id_document', /\b(?:permanent account number|income tax department|aadhaar|aadhar|passport|identity card)\b/i],
  ['refund_record', /\brefund\s*(?:id|transaction)\s*:\s*[a-z0-9-]{6,}/i],
  ['tracking', /\b(?:carrier\s*:|tracking\s*(?:number|no\.?|id)\s*:)/i],
  ['service_completion', /\b(?:confirmed receipt|approved the (?:work|design|website)|final deliverables|service completed|handover)\b/i],
  ['contract', /\b(?:scope of work|signed agreement|contract for|service agreement)\b/i],
  ['invoice', /\b(?:invoice\s*(?:number|no\.?|#|:)|bill to|amount due)\b/i],
  ['subscription_agreement', /\b(?:subscription agreement|recurring billing|subscription cancellation)\b/i],
  ['return_policy', /\b(?:return policy|refund policy)\b/i],
  ['product_description', /\b(?:product description|item specification|service description)\b/i],
  ['delivery_proof', /\b(?:proof of delivery|delivery confirmation|signed for by)\b/i],
  ['correspondence', /\b(?:from\s*:|dear customer|email correspondence)\b/i],
];

export function suggestDocumentKinds(text) {
  const source = String(text || '').slice(0, 40000);
  if (!source.trim()) return { status: 'unread', candidates: [], note: 'No readable text. Choose a label only after reviewing the original.' };
  const candidates = [];
  for (const [kind, rule] of RULES) {
    const match = rule.exec(source);
    if (!match) continue;
    const start = Math.max(0, match.index - 50);
    const end = Math.min(source.length, match.index + match[0].length + 100);
    candidates.push({ kind, label: EVIDENCE_KINDS[kind], excerpt: source.slice(start, end).replace(/\s+/g, ' '), offset: start });
  }
  if (candidates.some((c) => c.kind === 'id_document')) {
    return { status: 'sensitive', candidates: candidates.filter((c) => c.kind === 'id_document'), note: 'Identity-related text detected. Use synthetic documents only. Identity proof cannot replace evidence about this sale.' };
  }
  return {
    status: candidates.length === 1 ? 'suggested' : candidates.length ? 'ambiguous' : 'unknown',
    candidates: candidates.slice(0, 4),
    note: candidates.length ? 'Local text-based suggestions, not AI or verification. Review the source excerpt, then confirm or correct the label.' : 'No dependable type signal found. Review the original; do not invent a label to satisfy the checklist.',
  };
}
