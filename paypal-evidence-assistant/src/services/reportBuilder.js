import { requirementsForCase } from './requirements.js';

/**
 * Builds a reviewable evidence report (Markdown) from real case data only:
 * the dispute record, the seller's own statement, uploaded file metadata and
 * the latest analysis. The builder never fabricates document contents and
 * always carries the outcome disclaimer.
 */
export function buildReport({ dispute, context, files, analysis }) {
  const req = requirementsForCase(dispute);
  const lines = [];
  const push = (...xs) => lines.push(...xs);

  push(
    `# Evidence package - PayPal dispute ${dispute.id}`,
    '',
    `Prepared: ${new Date().toISOString()}`,
    '',
    '## Case summary',
    '',
    `- Dispute ID: ${dispute.id}`,
    `- Reason: ${req.label} (${dispute.reason})`,
    `- Buyer claim: ${req.buyerClaim}`,
    `- Amount: ${dispute.amount} ${dispute.currency}`,
    `- Case status at preparation: ${dispute.status}`,
    `- Response due: ${dispute.response_due_at || 'not shown by the data source'}`,
    '',
    '## Seller statement',
    '',
    context?.statement?.trim() ? context.statement.trim() : '_(no statement provided)_',
    '',
    `- Business type: ${context?.business_type || 'not specified'}`,
    '',
    '## Evidence checklist (per PayPal dispute reason)',
    ''
  );

  if (analysis) {
    for (const group of analysis.groups) {
      push(`### ${group.title} - ${group.status.toUpperCase()}`, '');
      for (const slot of group.slots) {
        const mark = slot.status === 'candidate' ? '[?] candidate:' : slot.status === 'alternative' ? '[-] alternative:' : '[ ]';
        push(`- ${mark} ${slot.label}`);
        for (const ev of slot.evidence) {
          const file = files.find((f) => f.id === ev.id);
          push(`    - ${ev.name}${file ? ` (sha256 ${file.sha256.slice(0, 12)}...)` : ''}`);
        }
      }
      push('');
    }
  } else {
    push('_(analysis has not been run yet)_', '');
  }

  push('## Uploaded documents', '');
  if (files.length === 0) {
    push('_(none)_', '');
  } else {
    for (const f of files) {
      push(`- ${f.original_name} - ${f.declared_kind}, ${f.size} bytes, sha256 ${f.sha256}`);
    }
    push('');
  }

  const gaps = analysis ? analysis.groups.filter((g) => ['missing', 'partial'].includes(g.status)) : [];
  push('## Gaps and notes', '');
  if (!analysis) {
    push('- Analysis pending.', '');
  } else {
    if (analysis.hasCandidates) push('- Suggested supporting text was found. This does not verify authenticity or satisfy PayPal automatically.');
    for (const g of gaps) {
      const missing = g.slots.filter((s) => s.status === 'missing').map((s) => s.label).join(' or ');
      if (missing) push(`- "${g.title}" path is incomplete. No readable matching text for: ${missing}.`);
    }
    for (const g of analysis.groups.filter((g) => g.status === 'alternative')) push(`- "${g.title}" is an alternative generic response path, not an extra requirement.`);
    push('- Review the current exact case request and every document before responding.', '');
  }
  if (analysis?.warnings?.length) {
    push('## Warnings', '');
    for (const w of analysis.warnings) push(`- ${w.message}`);
    push('');
  }

  push(
    '## Declaration',
    '',
    '- Software suggestions do not verify authenticity, fulfilment, case sufficiency or PayPal acceptance.',
    '- DRAFT: The seller must review this package and confirm its accuracy before submission.',
    '- This package was prepared with software assistance. PayPal reviews the evidence and decides the outcome.',
    '- Submitting evidence does not guarantee the dispute is decided in the seller\'s favour or that any funds are released.',
    `- Evidence requirements reference: ${analysis?.requirementsSource || 'https://developer.paypal.com/disputes/reasons-evidence'}`,
    ''
  );

  return lines.join('\n');
}

/**
 * Builds the provide-evidence API payload from a reviewed report's analysis.
 * Only structured, verifiable fields are sent: tracking info extracted from
 * declared tracking documents is NOT guessed - tracking numbers must be typed
 * by the seller in the report flow (kept in notes) until validated in sandbox.
 */
export function buildEvidencePayload({ analysis, reportContent }) {
  const evidences = [];
  if (!analysis) return evidences;
  // The analyzer emits 'candidate' for seller-reviewable suggested matches
  // ('covered' only exists in legacy snapshots). Candidates are unverified
  // suggestions for the seller to review, never accepted evidence.
  const MATCHED = new Set(['candidate', 'covered']);
  const matchedGroups = analysis.groups.filter((g) => MATCHED.has(g.status));
  const best = matchedGroups[0] || analysis.groups.find((g) => g.status === 'partial') || analysis.groups[0];
  if (!best) return evidences;
  const types = new Set(best.slots.filter((s) => MATCHED.has(s.status)).flatMap((s) => s.evidence.map((e) => e.kind)));
  let evidenceType = 'OTHER';
  if (types.has('tracking') || types.has('delivery_proof')) evidenceType = 'PROOF_OF_FULFILLMENT';
  else if (types.has('refund_record')) evidenceType = 'PROOF_OF_REFUND';
  evidences.push({
    evidence_type: evidenceType,
    notes: String(reportContent || '').slice(0, 2000),
    documents: (analysis.groups.flatMap((g) => g.slots).flatMap((s) => s.evidence) || [])
      .map((e) => ({ name: e.name })),
  });
  return evidences;
}
