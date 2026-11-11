import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sendHtml, sendJson, redirect, httpError, readRawBody, readJsonBody,
} from './util/http.js';
import {
  verifyPassword, createSession, destroySession, sessionCookie, clearSessionCookie,
  requireCsrf, csrfTokenMatches,
} from './auth.js';
import { clientIp } from './middleware.js';
import { audit, auditForDispute } from './db.js';
import { loginPage, dashboardPage, disputePage, errorPage } from './views.js';
import { buildReport, buildEvidencePayload } from './services/reportBuilder.js';
import { HeuristicEngine, OpenAiCompatibleEngine, runAnalysis } from './services/analyzer.js';
import { extractDocumentText } from './services/extractor.js';
import { EVIDENCE_KINDS } from './services/requirements.js';
import { randomId } from './util/ids.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC_FILES = { '/public/app.css': 'text/css; charset=utf-8', '/public/app.js': 'text/javascript; charset=utf-8' };

async function readFormBody(req, limit = 64 * 1024) {
  const raw = await readRawBody(req, limit);
  const params = new URLSearchParams(raw.toString('utf8'));
  return Object.fromEntries(params.entries());
}

export function registerRoutes(router, { config, db, limiters, disputeService, evidenceStore, logger }) {
  const heuristic = new HeuristicEngine((fileRow) => {
    const { absolutePath } = evidenceStore.resolveForDownload(fileRow.id);
    return fs.readFileSync(absolutePath, 'utf8');
  });
  const aiEngine = config.ai.enabled
    ? new OpenAiCompatibleEngine(config.ai, heuristic)
    : null;
  const aiEngineLabel = config.ai.enabled ? `AI: ${config.ai.model}` : 'Analysis: rule-based fallback (no AI key)';

  // ---------- Static (fixed allowlist; no path traversal surface) ----------
  router.get('/public/:file', (req, res) => {
    const key = `/public/${req.params.file}`;
    const contentType = STATIC_FILES[key];
    if (!contentType) return sendJson(res, 404, { error: 'Not found' });
    const body = fs.readFileSync(path.join(PUBLIC_DIR, req.params.file));
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(body);
  });

  router.get('/favicon.ico', (req, res) => { res.writeHead(204); res.end(); });

  // ---------- Auth ----------
  router.get('/login', (req, res) => {
    if (req.session) return redirect(res, '/');
    sendHtml(res, 200, loginPage({}));
  });

  router.post('/login', async (req, res) => {
    const ip = clientIp(req);
    const form = await readFormBody(req);
    const username = String(form.username || '');
    // Failed attempts are limited per IP+username; successful logins do not
    // consume the budget.
    const limitKey = `login:${ip}:${username.slice(0, 50)}`;
    if (limiters.login.tooMany(limitKey)) {
      logger.warn(`Login rate limit exceeded for ${ip}`);
      return sendHtml(res, 429, loginPage({ error: 'Too many attempts. Try again in a few minutes.' }));
    }
    const password = String(form.password || '');
    const ok = username === config.adminUsername && verifyPassword(password, req.passwordHash);
    if (!ok) {
      limiters.login.record(limitKey);
      audit(db, { actor: username.slice(0, 50) || 'unknown', action: 'auth.login_failed', detail: `ip=${ip}` });
      return sendHtml(res, 401, loginPage({ error: 'Invalid username or password' }));
    }
    const session = createSession(db, config, username);
    res.setHeader('Set-Cookie', sessionCookie(config, session.id));
    audit(db, { actor: username, action: 'auth.login', detail: `ip=${ip}` });
    redirect(res, '/');
  });

  router.post('/logout', async (req, res) => {
    if (req.session) {
      const form = await readFormBody(req);
      if (!csrfTokenMatches(req.session, String(form.csrf || ''))) throw httpError(403, 'Missing or invalid CSRF token');
      audit(db, { actor: req.session.username, action: 'auth.logout' });
      destroySession(db, req.session.id);
    }
    res.setHeader('Set-Cookie', clearSessionCookie());
    redirect(res, '/login');
  });

  // ---------- Pages ----------
  router.get('/', (req, res) => {
    if (!req.session) return redirect(res, '/login');
    const disputes = disputeService.list();
    sendHtml(res, 200, dashboardPage({
      session: req.session,
      disputes,
      dataSource: disputeService.dataSource,
      aiEngine: aiEngineLabel,
      submissionsEnabled: false,
    }));
  });

  router.get('/disputes/:id', (req, res) => {
    if (!req.session) return redirect(res, '/login');
    const dispute = disputeService.get(req.params.id);
    const context = disputeService.getContext(dispute.id);
    const files = evidenceStore.listForDispute(dispute.id);
    const analysis = latestAnalysis(db, dispute.id);
    const report = latestReport(db, dispute.id);
    const auditTrail = auditForDispute(db, dispute.id);
    const canSubmitReason = submitBlockReason(config, disputeService, dispute, report);
    sendHtml(res, 200, disputePage({
      session: req.session, dispute, context, files, analysis, report, auditTrail,
      dataSource: disputeService.dataSource,
      submissionsEnabled: false,
      canSubmitReason,
      aiEnabled: config.ai.enabled,
      aiHost: config.ai.enabled ? new URL(config.ai.baseUrl).hostname : null,
    }));
  });

  // ---------- Authenticated API ----------
  router.post('/api/refresh', async (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    if (!limiters.api.allow(`api:${session.username}`)) throw httpError(429, 'Rate limit exceeded');
    try {
      const result = await disputeService.refresh(session.username);
      if (result.source === 'paypal-sandbox') for (const dispute of disputeService.list()) invalidateDerived(db, dispute.id);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJson(res, 502, { ok: false, error: err.message });
    }
  });

  router.post('/api/disputes/:id/context', async (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    const body = await readJsonBody(req);
    const saved = disputeService.saveContext(session.username, req.params.id, {
      businessType: String(body.business_type || ''),
      statement: String(body.statement || ''),
    });
    invalidateDerived(db, req.params.id);
    sendJson(res, 200, { ok: true, context: saved });
  });

  router.post('/api/disputes/:id/evidence', async (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    if (!limiters.upload.allow(`upload:${session.username}`)) throw httpError(429, 'Too many uploads; slow down');
    const dispute = disputeService.get(req.params.id);
    const filename = String(req.query.get('filename') || '');
    const kind = String(req.query.get('kind') || 'other');
    const notes = String(req.query.get('notes') || '');
    // Cap read at the upload limit (+1 to detect overflow inside the store too).
    const body = await readRawBody(req, config.maxUploadBytes + 1);
    const saved = evidenceStore.save(dispute.id, { originalName: filename, declaredKind: kind, notes }, body);
    evidenceStore.saveExtraction(saved.id, await extractDocumentText(body, saved.mime));
    audit(db, { actor: session.username, action: 'evidence.upload', disputeId: dispute.id, detail: `${saved.original_name} (${saved.size} bytes, ${saved.declared_kind})` });
    invalidateDerived(db, dispute.id);
    sendJson(res, 201, { ok: true, file: publicFile(saved) });
  });

  router.post('/api/evidence/:fileId/label', async (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    const file = evidenceStore.get(req.params.fileId);
    if (!file) throw httpError(404, 'File not found');
    const body = await readJsonBody(req, 4096);
    if (typeof body.kind !== 'string' || !Object.hasOwn(EVIDENCE_KINDS, body.kind)) throw httpError(400, 'Unknown document label');
    db.prepare('UPDATE evidence_files SET declared_kind = ? WHERE id = ?').run(body.kind, file.id);
    invalidateDerived(db, file.dispute_id);
    audit(db, { actor: session.username, action: 'evidence.label_confirmed', disputeId: file.dispute_id, detail: `${file.id}: ${body.kind}` });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/evidence/:fileId/delete', (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    const row = evidenceStore.get(req.params.fileId);
    if (!row) throw httpError(404, 'File not found');
    evidenceStore.remove(row.id);
    invalidateDerived(db, row.dispute_id);
    audit(db, { actor: session.username, action: 'evidence.delete', disputeId: row.dispute_id, detail: row.original_name });
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/evidence/:fileId/download', (req, res) => {
    authed(req);
    const found = evidenceStore.resolveForDownload(req.params.fileId);
    if (!found) throw httpError(404, 'File not found');
    const { row, absolutePath } = found;
    const data = fs.readFileSync(absolutePath);
    const safeName = row.original_name.replace(/[^\w.()\- ]/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': data.length,
    });
    res.end(data);
  });

  router.post('/api/disputes/:id/analyze', async (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    if (!limiters.api.allow(`api:${session.username}`)) throw httpError(429, 'Rate limit exceeded');
    const request = await readJsonBody(req);
    if (config.ai.enabled && request.consentAI !== true) throw httpError(400, 'Confirm sending extracted document text and your statement to the configured AI provider before analysis');
    const dispute = disputeService.get(req.params.id);
    const context = disputeService.getContext(dispute.id);
    const files = evidenceStore.listForDispute(dispute.id);
    const result = await runAnalysis(config, heuristic, aiEngine, { dispute, context, files }, logger);
    const id = randomId(16);
    db.prepare('INSERT INTO analyses (id, dispute_id, engine, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, dispute.id, result.engine, JSON.stringify(result), result.generatedAt);
    audit(db, { actor: session.username, action: 'evidence.analyze', disputeId: dispute.id, detail: `engine=${result.engine} candidates=${result.hasCandidates === true}` });
    sendJson(res, 200, { ok: true, analysis: result });
  });

  router.get('/api/disputes/:id/analysis', (req, res) => {
    authed(req);
    const analysis = latestAnalysis(db, req.params.id);
    if (!analysis) throw httpError(404, 'No analysis yet');
    sendJson(res, 200, { analysis });
  });

  router.post('/api/disputes/:id/report', (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    const dispute = disputeService.get(req.params.id);
    const context = disputeService.getContext(dispute.id);
    const files = evidenceStore.listForDispute(dispute.id);
    const analysis = latestAnalysis(db, dispute.id);
    const content = buildReport({ dispute, context, files, analysis });
    const id = randomId(16);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO reports (id, dispute_id, content, status, analysis_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, dispute.id, content, 'draft', analysis?._id || null, now, now);
    audit(db, { actor: session.username, action: 'report.generate', disputeId: dispute.id });
    sendJson(res, 201, { ok: true, reportId: id });
  });

  router.post('/api/reports/:id', async (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    const report = getReport(db, req.params.id);
    if (report.status !== 'draft') throw httpError(409, 'Only draft reports can be edited');
    const body = await readJsonBody(req);
    const content = String(body.content || '');
    if (content.length < 50) throw httpError(400, 'Report content looks too short');
    if (content.length > 20000) throw httpError(400, 'Report content too long');
    db.prepare('UPDATE reports SET content = ?, updated_at = ? WHERE id = ?')
      .run(content, new Date().toISOString(), report.id);
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/reports/:id/review', async (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    const report = getReport(db, req.params.id);
    if (report.status !== 'draft') throw httpError(409, 'Report is no longer a current draft. Generate and review a new version.');
    const body = await readJsonBody(req);
    if (body.confirmed !== true) throw httpError(400, 'Review confirmation is required');
    db.prepare("UPDATE reports SET status = 'reviewed', reviewed_at = ?, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), report.id);
    audit(db, { actor: session.username, action: 'report.review', disputeId: report.dispute_id });
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/reports/:id/export', (req, res) => {
    const session = authed(req);
    const report = getReport(db, req.params.id);
    if (report.status === 'stale') throw httpError(409, 'Case inputs changed; generate and review a new report');
    const bodyOut = Buffer.from(report.content, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="evidence-report-${report.dispute_id}.md"`,
      'Content-Length': bodyOut.length,
    });
    res.end(bodyOut);
  });

  router.post('/api/reports/:id/submit', async (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    const report = getReport(db, req.params.id);
    const dispute = disputeService.get(report.dispute_id);
    const blocked = submitBlockReason(config, disputeService, dispute, report);
    if (blocked) throw httpError(400, `Submission unavailable: ${blocked}`);
    const analysisRow = report.analysis_id ? db.prepare('SELECT result_json FROM analyses WHERE id = ?').get(report.analysis_id) : null;
    const analysis = analysisRow ? JSON.parse(analysisRow.result_json) : null;
    const evidences = buildEvidencePayload({ analysis, reportContent: report.content });
    try {
      const result = await disputeService.submitEvidence(session.username, dispute.id, evidences);
      db.prepare("UPDATE reports SET status = 'submitted', submitted_at = ?, submission_note = ?, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), 'Submitted to PayPal sandbox', new Date().toISOString(), report.id);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      db.prepare("UPDATE reports SET status = 'failed', submission_note = ?, updated_at = ? WHERE id = ?")
        .run(String(err.message).slice(0, 300), new Date().toISOString(), report.id);
      throw err;
    }
  });

  router.post('/api/disputes/:id/manual-status', async (req, res) => {
    const session = authed(req);
    requireCsrf(req, session);
    const body = await readJsonBody(req);
    disputeService.setManualStatus(session.username, req.params.id, String(body.status || ''));
    sendJson(res, 200, { ok: true });
  });

  function authed(req) {
    if (!req.session) throw httpError(401, 'Authentication required');
    return req.session;
  }
}

function invalidateDerived(db, disputeId) {
  // Preserve audit/history but never reuse a review after its source inputs change.
  db.prepare("UPDATE reports SET status = 'stale', analysis_id = NULL, updated_at = ? WHERE dispute_id = ? AND status != 'submitted'").run(new Date().toISOString(), disputeId);
  db.prepare('DELETE FROM analyses WHERE dispute_id = ? AND id NOT IN (SELECT analysis_id FROM reports WHERE analysis_id IS NOT NULL)').run(disputeId);
}

function latestAnalysis(db, disputeId) {
  const row = db.prepare('SELECT id, engine, result_json, created_at FROM analyses WHERE dispute_id = ? ORDER BY created_at DESC LIMIT 1').get(disputeId);
  if (!row) return null;
  const parsed = JSON.parse(row.result_json);
  parsed._id = row.id;
  return parsed;
}

function latestReport(db, disputeId) {
  return db.prepare("SELECT * FROM reports WHERE dispute_id = ? AND status != 'stale' ORDER BY created_at DESC LIMIT 1").get(disputeId) || null;
}

function getReport(db, id) {
  if (!/^[a-f0-9]{32}$/.test(String(id))) throw httpError(404, 'Report not found');
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!report) throw httpError(404, 'Report not found');
  return report;
}

function publicFile(row) {
  return {
    id: row.id, name: row.original_name, kind: row.declared_kind,
    size: row.size, sha256: row.sha256, uploadedAt: row.uploaded_at,
  };
}

/** Returns null when submission is possible, else a human-readable reason. */
function submitBlockReason(config, disputeService, dispute, report) {
  return 'submission is hard-disabled in every mode pending verified PayPal sandbox payload and attachment tests';
  if (disputeService.dataSource === 'demo') return 'running on synthetic demo data';
  if (!report || report.status !== 'reviewed') return 'only the exact reviewed report version can be submitted';
  if (!report.analysis_id) return 'the reviewed analysis snapshot is unavailable';
  if (!config.submissionsEnabled) return 'SUBMISSIONS_ENABLED is false';
  if (dispute.status !== 'WAITING_FOR_SELLER_RESPONSE') return `dispute status is ${dispute.status}`;
  return 'sandbox submission is disabled until the payload and file transfer are verified end to end';
}

export { errorPage };
