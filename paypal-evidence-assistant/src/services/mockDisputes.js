/**
 * Synthetic demo disputes. Used only when PayPal credentials are not configured.
 * Clearly labelled 'demo' in the data source badge throughout the UI.
 * All buyers, amounts and cases are fictional.
 */
export const DEMO_DISPUTES = [
  {
    id: 'DEMO-D-1001',
    source: 'demo',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    amount: '79.00',
    currency: 'USD',
    buyer_name: 'A. Example (demo)',
    created_at: daysAgo(4),
    response_due_at: inDays(6),
  },
  {
    id: 'DEMO-D-1002',
    source: 'demo',
    reason: 'UNAUTHORISED',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    amount: '149.50',
    currency: 'USD',
    buyer_name: 'J. Sample (demo)',
    created_at: daysAgo(2),
    response_due_at: inDays(8),
  },
  {
    id: 'DEMO-D-1003',
    source: 'demo',
    reason: 'CANCELED_RECURRING_BILLING',
    status: 'UNDER_REVIEW',
    amount: '19.99',
    currency: 'USD',
    buyer_name: 'R. Placeholder (demo)',
    created_at: daysAgo(12),
    response_due_at: null,
  },
];

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}
function inDays(n) {
  return new Date(Date.now() + n * 86400000).toISOString();
}

/** Seeds demo disputes once (idempotent). */
export function seedDemoDisputes(db) {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO disputes (id, source, reason, status, amount, currency, buyer_name, created_at, response_due_at, updated_at)
     VALUES (?, 'demo', ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const d of DEMO_DISPUTES) {
    insert.run(d.id, d.reason, d.status, d.amount, d.currency, d.buyer_name, d.created_at, d.response_due_at, now);
  }
}
