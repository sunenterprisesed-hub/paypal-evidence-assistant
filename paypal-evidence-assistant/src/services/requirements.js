/**
 * Evidence requirements per PayPal dispute reason.
 *
 * Source (fetched 2026-11-09): https://developer.paypal.com/disputes/reasons-evidence
 * ("Dispute reasons and evidence", PayPal Developer, last updated June 5, 2026).
 *
 * Model: each reason has one or more GROUPS. A group is one way to respond:
 * the seller typically satisfies the case by covering ANY ONE group fully
 * (e.g. prove fulfilment, OR show a refund was issued). Within a group that
 * lists `anyOf` slots, covering ANY ONE slot counts. Slots without anyOf are
 * all required. This mirrors the "provide one of the following" wording in the
 * PayPal documentation. When PayPal's own case data specifies the requested
 * evidence types (evidences.evidence_type, source REQUESTED_FROM_SELLER), that
 * case-specific data should take precedence over this generic matrix.
 */

export const EVIDENCE_KINDS = {
  tracking: 'Tracking information (carrier + tracking number)',
  delivery_proof: 'Proof of delivery / signature confirmation',
  service_completion: 'Proof of service delivery or completion (e.g. buyer confirmation)',
  receipt: 'Receipt or proof of purchase',
  refund_record: 'Refund record (refund ID or receipt)',
  contract: 'Contract, agreement or affidavit',
  product_description: 'Product/service description or listing',
  return_policy: 'Return / refund policy',
  subscription_agreement: 'Subscription agreement + cancellation terms',
  invoice: 'Invoice or bill',
  correspondence: 'Buyer correspondence (messages, email)',
  id_document: 'Identity document (synthetic/test only)',
  other: 'Other supporting document',
};

export const REQUIREMENTS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: {
    label: 'Merchandise or service not received',
    buyerClaim: 'The buyer says they did not receive the merchandise or service.',
    groups: [
      {
        id: 'fulfillment',
        title: 'Prove fulfilment or delivery',
        anyOf: [
          { key: 'tracking', label: 'Carrier name and tracking number', kinds: ['tracking'] },
          { key: 'delivery_docs', label: 'Documents proving fulfilment (delivery signature, receipt copy, or service completion evidence)', kinds: ['delivery_proof', 'receipt', 'service_completion'] },
        ],
      },
      {
        id: 'refund',
        title: 'Or: show the buyer was already refunded',
        anyOf: [
          { key: 'refund', label: 'Refund ID for the transaction', kinds: ['refund_record'] },
        ],
      },
    ],
  },
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: {
    label: 'Merchandise or service not as described',
    buyerClaim: 'The buyer says the merchandise or service was not as described.',
    groups: [
      {
        id: 'describe',
        title: 'Show what was sold and its terms',
        anyOf: [
          { key: 'description', label: 'Product description, item URL, or service scope', kinds: ['product_description'] },
          { key: 'terms', label: 'Return policy, contract, or affidavit', kinds: ['return_policy', 'contract'] },
        ],
      },
      {
        id: 'refund',
        title: 'Or: show the buyer was already refunded',
        anyOf: [
          { key: 'refund', label: 'Refund ID for the transaction', kinds: ['refund_record'] },
        ],
      },
    ],
  },
  UNAUTHORISED: {
    label: 'Unauthorised transaction',
    buyerClaim: 'The buyer says they did not authorise this purchase.',
    groups: [
      {
        id: 'fulfillment',
        title: 'Prove fulfilment and delivery',
        slots: [
          { key: 'tracking', label: 'Carrier name and tracking number', kinds: ['tracking'] },
        ],
        anyOf: [
          { key: 'delivery_docs', label: 'Documents proving fulfilment (delivery signature, receipt copy, or service completion evidence)', kinds: ['delivery_proof', 'receipt', 'service_completion'] },
        ],
      },
      {
        id: 'refund',
        title: 'Or: show the buyer was already refunded',
        anyOf: [
          { key: 'refund', label: 'Refund ID for the transaction', kinds: ['refund_record'] },
        ],
      },
    ],
  },
  CREDIT_NOT_PROCESSED: {
    label: 'Credit not processed',
    buyerClaim: 'The buyer says an agreed refund or credit was not processed.',
    groups: [
      {
        id: 'refund',
        title: 'Show the refund or credit was issued',
        anyOf: [
          { key: 'refund', label: 'Refund ID for the transaction', kinds: ['refund_record'] },
        ],
      },
      {
        id: 'explain',
        title: 'Or: explain the credit position',
        anyOf: [
          { key: 'reason', label: 'Document explaining the credit due position', kinds: ['correspondence', 'contract', 'other'] },
        ],
      },
    ],
  },
  DUPLICATE_TRANSACTION: {
    label: 'Duplicate transaction',
    buyerClaim: 'The buyer says they were charged twice for the same item.',
    groups: [
      {
        id: 'refund',
        title: 'Show the duplicate was refunded',
        anyOf: [
          { key: 'refund', label: 'Refund ID for the duplicate charge', kinds: ['refund_record'] },
        ],
      },
      {
        id: 'explain',
        title: 'Or: show the charges were distinct',
        anyOf: [
          { key: 'distinct', label: 'Invoices/receipts showing two separate purchases', kinds: ['invoice', 'receipt'] },
        ],
      },
    ],
  },
  INCORRECT_AMOUNT: {
    label: 'Incorrect amount charged',
    buyerClaim: 'The buyer says they were charged the wrong amount.',
    groups: [
      {
        id: 'refund',
        title: 'Show the difference was refunded',
        anyOf: [
          { key: 'refund', label: 'Refund ID for the difference in amount', kinds: ['refund_record'] },
        ],
      },
      {
        id: 'explain',
        title: 'Or: justify the charged amount',
        anyOf: [
          { key: 'reason', label: 'Invoice or price explanation for the charged amount', kinds: ['invoice', 'product_description', 'contract'] },
        ],
      },
    ],
  },
  PAYMENT_BY_OTHER_MEANS: {
    label: 'Payment made by other means',
    buyerClaim: 'The buyer says they also paid for this another way.',
    groups: [
      {
        id: 'refund',
        title: 'Show the duplicate payment was refunded',
        anyOf: [
          { key: 'refund', label: 'Refund ID for the difference', kinds: ['refund_record'] },
        ],
      },
      {
        id: 'explain',
        title: 'Or: document the agreed payment arrangement',
        anyOf: [
          { key: 'arrangement', label: 'Agreement or correspondence about the payment method', kinds: ['contract', 'correspondence'] },
        ],
      },
    ],
  },
  CANCELED_RECURRING_BILLING: {
    label: 'Cancelled recurring billing',
    buyerClaim: 'The buyer says they cancelled a subscription but were still charged.',
    groups: [
      {
        id: 'terms',
        title: 'Show the subscription terms',
        anyOf: [
          { key: 'subscription', label: 'Subscription agreement and cancellation policy', kinds: ['subscription_agreement', 'contract'] },
        ],
      },
      {
        id: 'refund',
        title: 'Or: show the charge was refunded',
        anyOf: [
          { key: 'refund', label: 'Refund ID for the transaction', kinds: ['refund_record'] },
        ],
      },
    ],
  },
  OTHER: {
    label: 'Other',
    buyerClaim: 'The buyer opened a dispute for another reason.',
    groups: [
      {
        id: 'respond',
        title: 'Respond with supporting documents',
        anyOf: [
          { key: 'docs', label: 'Any documents supporting your position', kinds: ['contract', 'correspondence', 'invoice', 'receipt', 'other'] },
        ],
      },
      {
        id: 'refund',
        title: 'Or: show the buyer was refunded',
        anyOf: [
          { key: 'refund', label: 'Refund ID for the transaction', kinds: ['refund_record'] },
        ],
      },
    ],
  },
};

export const REQUIREMENTS_SOURCE = 'https://developer.paypal.com/disputes/reasons-evidence';

/** Returns the requirement set for a dispute reason, falling back to OTHER. */
export function requirementsFor(reason) {
  return REQUIREMENTS[reason] || REQUIREMENTS.OTHER;
}

/**
 * Flattens a reason's groups into slots with a stable shape for analysis:
 * [{ groupId, groupTitle, key, label, kinds, groupIsAnyOf }]
 */
export function slotsFor(reason) {
  const req = requirementsFor(reason);
  const out = [];
  for (const group of req.groups) {
    for (const slot of group.slots || []) {
      out.push({ groupId: group.id, groupTitle: group.title, key: slot.key, label: slot.label, kinds: slot.kinds, slotRequired: true });
    }
    for (const slot of group.anyOf || []) {
      out.push({ groupId: group.id, groupTitle: group.title, key: slot.key, label: slot.label, kinds: slot.kinds, slotRequired: false });
    }
  }
  return out;
}


/** Actual seller-directed case requests override generic reason suggestions. */
export function requirementsForCase(dispute) {
  let raw = {};
  try { raw = typeof dispute.raw_json === 'string' ? JSON.parse(dispute.raw_json) : dispute.raw || {}; } catch { /* unknown payload: generic suggestions only */ }
  const evidence = Array.isArray(raw.evidences) ? raw.evidences : [];
  const requested = evidence.filter((e) => e?.source === 'REQUESTED_FROM_SELLER');
  if (requested.length === 0) return { ...requirementsFor(dispute.reason), caseSpecific: false };
  const kinds = {
    PROOF_OF_FULFILLMENT: ['tracking', 'delivery_proof', 'service_completion', 'receipt'],
    PROOF_OF_REFUND: ['refund_record'],
    OTHER: ['contract', 'product_description', 'return_policy', 'subscription_agreement', 'invoice', 'correspondence', 'other'],
  };
  const types = [...new Set(requested.map((e) => String(e.evidence_type || 'UNKNOWN')))];
  return {
    ...requirementsFor(dispute.reason),
    caseSpecific: true,
    groups: [{
      id: 'case_requested', title: 'Evidence requested in this PayPal case',
      slots: types.map((type) => ({
        key: 'case_' + type,
        label: type === 'UNKNOWN' ? 'Unrecognized case request: inspect the case in PayPal' : type.replaceAll('_', ' '),
        kinds: kinds[type] || [],
      })),
    }],
  };
}

export function slotsForCase(dispute) {
  const out = [];
  for (const group of requirementsForCase(dispute).groups) {
    for (const slot of group.slots || []) out.push({ ...slot, groupId: group.id, groupTitle: group.title, slotRequired: true });
    for (const slot of group.anyOf || []) out.push({ ...slot, groupId: group.id, groupTitle: group.title, slotRequired: false });
  }
  return out;
}
