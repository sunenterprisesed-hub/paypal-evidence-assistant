/**
 * Minimal PayPal Disputes API client (sandbox).
 *
 * Grounded in (fetched 2026-11-09):
 * - https://developer.paypal.com/platforms/disputes/integrate-disputes
 * - https://developer.paypal.com/api/customer-disputes/v1/disputes-provide-evidence
 *
 * Notes and limits:
 * - First-party merchant access uses client-credentials OAuth. Acting for a
 *   DIFFERENT merchant requires PayPal-Auth-Assertion with that merchant's
 *   consent; this client does not implement third-party consent.
 * - The Disputes feature must be enabled on the developer app. Keys alone may
 *   not suffice; that enablement is untested until real sandbox access exists.
 * - provide-evidence is only valid while the dispute is
 *   WAITING_FOR_SELLER_RESPONSE and its HATEOAS links offer provide-evidence.
 * - All network calls go through an injected fetch for testability.
 */

export class PayPalError extends Error {
  constructor(message, { status = null, code = 'PAYPAL_ERROR' } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.code = code;
  }
}

const DISPUTE_ID_RE = /^[A-Za-z0-9-]{1,255}$/;

export class PayPalClient {
  constructor({ baseUrl, clientId, clientSecret, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetchImpl = (url, options = {}) => fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    this.token = null; // { value, expiresAt }
  }

  async #getToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60000) return this.token.value;
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        // Basic auth; the secret never appears in URLs, logs or error messages.
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new PayPalError(
        res.status === 401
          ? 'PayPal rejected the credentials (HTTP 401). Check the client ID/secret and that the Disputes feature is enabled on the app.'
          : `PayPal token request failed (HTTP ${res.status}).`,
        { status: res.status, code: 'AUTH' }
      );
    }
    const body = await res.json();
    if (!body.access_token) throw new PayPalError('PayPal token response missing access_token', { code: 'AUTH' });
    const expiresIn = Number(body.expires_in) || 300;
    this.token = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return this.token.value;
  }

  async #request(method, path, { json } = {}) {
    const token = await this.#getToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    if (!res.ok) {
      throw new PayPalError(`PayPal API ${method} ${path} failed (HTTP ${res.status})`, { status: res.status });
    }
    return res.status === 204 ? null : res.json();
  }

  async listDisputes() {
    const body = await this.#request('GET', '/v1/customer/disputes');
    const items = Array.isArray(body?.items) ? body.items : [];
    return items.map((item) => normalizeDispute(item));
  }

  async getDispute(id) {
    if (!DISPUTE_ID_RE.test(id)) throw new PayPalError('Invalid dispute id format', { code: 'VALIDATION' });
    const body = await this.#request('GET', `/v1/customer/disputes/${encodeURIComponent(id)}`);
    return normalizeDispute(body, { detailed: true });
  }

  /**
   * Submits evidence the seller has reviewed. Caller must have verified:
   * dispute status is WAITING_FOR_SELLER_RESPONSE, the provide-evidence
   * HATEOAS link is present, and the seller explicitly confirmed.
   */
  async provideEvidence(id, { evidences, attachments = [] }) {
    if (!DISPUTE_ID_RE.test(id)) throw new PayPalError('Invalid dispute id format', { code: 'VALIDATION' });
    if (!Array.isArray(evidences) || evidences.length === 0) {
      throw new PayPalError('provideEvidence requires at least one evidence entry', { code: 'VALIDATION' });
    }
    // Development transport only: app/service submission remains hard-disabled.
    // Follow the documented input JSON part and file1/file2 binary parts.
    const allowedMime = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif']);
    if (!Array.isArray(attachments) || attachments.length > 20) throw new PayPalError('Invalid attachment list', { code: 'VALIDATION' });
    let total = 0;
    const form = new FormData();
    form.append('input', new Blob([JSON.stringify({ evidences })], { type: 'application/json' }), 'input.json');
    for (const [index, attachment] of attachments.entries()) {
      if (!Buffer.isBuffer(attachment.bytes) || !allowedMime.has(attachment.mime)
        || !/^[A-Za-z0-9-_, ]+[.][A-Za-z]+$/.test(attachment.name)
        || !attachment.bytes.length || attachment.bytes.length >= 10 * 1024 * 1024) {
        throw new PayPalError('Unsupported attachment format, name or size', { code: 'VALIDATION' });
      }
      total += attachment.bytes.length;
      if (total > 50 * 1024 * 1024) throw new PayPalError('Attachment total exceeds PayPal limit', { code: 'VALIDATION' });
      form.append(`file${index + 1}`, new Blob([attachment.bytes], { type: attachment.mime }), attachment.name);
    }
    const token = await this.#getToken();
    const res = await this.fetchImpl(`${this.baseUrl}/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // Content-Type set by FormData
      body: form,
    });
    if (!res.ok) {
      throw new PayPalError(`Provide evidence failed (HTTP ${res.status})`, { status: res.status });
    }
    return res.json().catch(() => ({}));
  }
}

/** Maps a PayPal dispute object to the app's internal shape. */
export function normalizeDispute(raw, { detailed = false } = {}) {
  const amount = raw?.dispute_amount?.value ?? raw?.dispute_amount ?? '';
  const currency = raw?.dispute_amount?.currency_code ?? '';
  const links = Array.isArray(raw?.links) ? raw.links : [];
  const canProvideEvidence = links.some((l) => typeof l?.rel === 'string' && l.rel.includes('provide-evidence'));
  return {
    id: String(raw?.dispute_id ?? ''),
    source: 'paypal-sandbox',
    reason: String(raw?.reason ?? 'OTHER'),
    status: String(raw?.status ?? 'UNKNOWN'),
    amount: String(amount),
    currency: String(currency),
    buyer_name: String(raw?.buyer?.name ?? raw?.customer_name ?? 'Buyer'),
    created_at: raw?.create_time ?? new Date().toISOString(),
    response_due_at: raw?.seller_response_due_date ?? null,
    can_provide_evidence: canProvideEvidence,
    raw: detailed ? raw : null,
  };
}
