import { PayPalClient, PayPalError } from './paypalClient.js';
import { seedDemoDisputes } from './mockDisputes.js';
import { audit } from '../db.js';
import { httpError } from '../util/http.js';

const DISPUTE_ID_RE = /^[A-Za-z0-9-]{1,255}$/;

/**
 * One interface over two data sources:
 * - demo: synthetic disputes stored locally (clearly labelled in the UI)
 * - paypal-sandbox: live reads from the sandbox Disputes API, upserted into
 *   the local cache so evidence/reports attach to stable records
 */
export class DisputeService {
  constructor(db, config, fetchImpl = fetch) {
    this.db = db;
    this.config = config;
    this.paypal = config.paypal.enabled
      ? new PayPalClient({ baseUrl: config.paypal.baseUrl, clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, fetchImpl })
      : null;
    if (!this.paypal) seedDemoDisputes(db);
  }

  get dataSource() {
    return this.paypal ? 'paypal-sandbox' : 'demo';
  }

  list() {
    return this.db.prepare(
      'SELECT id, source, reason, status, amount, currency, buyer_name, created_at, response_due_at, manual_status FROM disputes ORDER BY created_at DESC'
    ).all();
  }

  get(id) {
    if (!DISPUTE_ID_RE.test(id)) throw httpError(400, 'Invalid dispute id');
    const row = this.db.prepare('SELECT * FROM disputes WHERE id = ?').get(id);
    if (!row) throw httpError(404, 'Case not found');
    return row;
  }

  /** Pulls fresh dispute data from PayPal (live mode only) and updates the cache. */
  async refresh(actor) {
    if (!this.paypal) return { refreshed: 0, source: 'demo' };
    const listed = await this.paypal.listDisputes();
    const remote = [];
    for (const item of listed.slice(0, 100)) remote.push(await this.paypal.getDispute(item.id));
    const now = new Date().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO disputes (id, source, reason, status, amount, currency, buyer_name, created_at, response_due_at, raw_json, updated_at)
       VALUES (@id, 'paypal-sandbox', @reason, @status, @amount, @currency, @buyer_name, @created_at, @response_due_at, @raw_json, @now)
       ON CONFLICT(id) DO UPDATE SET reason=@reason, status=@status, amount=@amount, currency=@currency, buyer_name=@buyer_name, response_due_at=@response_due_at, raw_json=@raw_json, updated_at=@now`
    );
    for (const d of remote) {
      upsert.run({ id: d.id, reason: d.reason, status: d.status, amount: d.amount, currency: d.currency, buyer_name: d.buyer_name, created_at: d.created_at, response_due_at: d.response_due_at, raw_json: JSON.stringify(d.raw ?? {}), now });
    }
    audit(this.db, { actor, action: 'disputes.refresh', detail: `${remote.length} dispute(s) pulled from PayPal sandbox` });
    return { refreshed: remote.length, source: 'paypal-sandbox' };
  }

  async refreshOne(actor, id) {
    const local = this.get(id);
    if (!this.paypal || local.source !== 'paypal-sandbox') return local;
    const remote = await this.paypal.getDispute(id);
    this.db.prepare('UPDATE disputes SET status = ?, response_due_at = ?, raw_json = ?, updated_at = ? WHERE id = ?')
      .run(remote.status, remote.response_due_at, JSON.stringify(remote.raw ?? {}), new Date().toISOString(), id);
    audit(this.db, { actor, action: 'dispute.refresh', disputeId: id, detail: `status=${remote.status}` });
    return this.get(id);
  }

  setManualStatus(actor, id, statusText) {
    this.get(id); // validates existence
    const clean = String(statusText || '').slice(0, 200);
    this.db.prepare('UPDATE disputes SET manual_status = ?, updated_at = ? WHERE id = ?')
      .run(clean, new Date().toISOString(), id);
    audit(this.db, { actor, action: 'dispute.manual_status', disputeId: id, detail: clean });
  }

  getContext(disputeId) {
    return this.db.prepare('SELECT business_type, statement, updated_at FROM case_context WHERE dispute_id = ?').get(disputeId)
      || { business_type: 'individual', statement: '', updated_at: null };
  }

  saveContext(actor, disputeId, { businessType, statement }) {
    this.get(disputeId);
    const allowed = ['individual', 'sole_proprietorship', 'company'];
    if (!allowed.includes(businessType)) throw httpError(400, 'Unknown business type');
    const cleanStatement = String(statement || '').slice(0, 4000);
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO case_context (dispute_id, business_type, statement, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(dispute_id) DO UPDATE SET business_type=excluded.business_type, statement=excluded.statement, updated_at=excluded.updated_at`
    ).run(disputeId, businessType, cleanStatement, now);
    audit(this.db, { actor, action: 'context.save', disputeId });
    return this.getContext(disputeId);
  }

  /**
   * Submits a reviewed report's evidence payload to PayPal.
   * Hard guards: live mode, SUBMISSIONS_ENABLED, report reviewed, dispute in
   * WAITING_FOR_SELLER_RESPONSE with a provide-evidence link.
   */
  async submitEvidence(actor, disputeId, evidences) {
    throw new PayPalError('Sandbox submission is hard-disabled until end-to-end payload and attachment validation passes.', { code: 'UNVERIFIED' });
    if (!this.paypal) throw new PayPalError('Submissions need PayPal sandbox credentials; running in demo mode.', { code: 'DEMO_MODE' });
    if (!this.config.submissionsEnabled) throw new PayPalError('Submissions are disabled (SUBMISSIONS_ENABLED=false).', { code: 'DISABLED' });
    const fresh = await this.refreshOne(actor, disputeId);
    if (fresh.status !== 'WAITING_FOR_SELLER_RESPONSE') {
      throw new PayPalError(`Dispute status is ${fresh.status}; evidence can only be provided while WAITING_FOR_SELLER_RESPONSE.`, { code: 'STATE' });
    }
    const raw = JSON.parse(fresh.raw_json || '{}');
    const links = Array.isArray(raw?.links) ? raw.links : [];
    if (!links.some((l) => String(l?.rel || '').includes('provide-evidence'))) {
      throw new PayPalError('PayPal does not currently offer a provide-evidence action for this dispute.', { code: 'STATE' });
    }
    const result = await this.paypal.provideEvidence(disputeId, { evidences });
    audit(this.db, { actor, action: 'evidence.submit', disputeId, detail: 'Submitted reviewed evidence to PayPal sandbox' });
    return result;
  }
}
