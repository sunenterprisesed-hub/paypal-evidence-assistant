import { suggestDocumentKinds } from './services/documentIdentifier.js';
import { esc, attr } from './util/html.js';
import { requirementsFor, requirementsForCase, EVIDENCE_KINDS } from './services/requirements.js';

/**
 * Server-rendered views. Every dynamic value passes through esc()/attr().
 * The CSP forbids inline scripts and styles, so all behaviour lives in
 * /public/app.js and all styling in /public/app.css.
 */

export function layout({ title, session, badges = [], content, notice = null }) {
  const badgeHtml = badges.map((b) => `<span class="badge badge-${attr(b.tone)}">${esc(b.text)}</span>`).join(' ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${session ? `<meta name="csrf-token" content="${attr(session.csrf)}">` : ''}
<title>${esc(title)} - Dispute Evidence Assistant</title>
<link rel="stylesheet" href="/public/app.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">Dispute Evidence Assistant</a>
  <div class="topbar-right">
    ${badgeHtml}
    ${session ? `<span class="user">${esc(session.username)}</span>
    <form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${attr(session.csrf)}"><button class="link" type="submit">Log out</button></form>` : ''}
  </div>
</header>
<main class="container">
${notice ? `<div class="notice notice-${attr(notice.tone || 'info')}">${esc(notice.text)}</div>` : ''}
${content}
</main>
${session ? '<script src="/public/app.js" defer></script>' : ''}
</body>
</html>`;
}

export function loginPage({ error = null }) {
  return layout({
    title: 'Sign in',
    session: null,
    content: `
<div class="card login-card">
  <h1>Sign in</h1>
  ${error ? `<div class="notice notice-error">${esc(error)}</div>` : ''}
  <form method="post" action="/login">
    <label>Username <input name="username" type="text" autocomplete="username" required maxlength="100"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
    <button class="primary" type="submit">Sign in</button>
  </form>
  <p class="muted">Demo build. Use synthetic documents only - never real identity documents.</p>
</div>`,
  });
}

function statusPill(status) {
  const tone = status === 'WAITING_FOR_SELLER_RESPONSE' ? 'warn' : status === 'UNDER_REVIEW' ? 'info' : 'neutral';
  return `<span class="pill pill-${tone}">${esc(status.replaceAll('_', ' '))}</span>`;
}

export function dashboardPage({ session, disputes, dataSource, aiEngine, submissionsEnabled }) {
  const rows = disputes.map((d) => `
    <tr>
      <td><a href="/disputes/${attr(d.id)}">${esc(d.id)}</a></td>
      <td>${esc(requirementsFor(d.reason).label)}</td>
      <td>${esc(d.amount)} ${esc(d.currency)}</td>
      <td>${statusPill(d.status)}</td>
      <td>${d.response_due_at ? esc(new Date(d.response_due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })) : '-'}</td>
      <td>${d.manual_status ? esc(d.manual_status) : '-'}</td>
    </tr>`).join('');

  return layout({
    title: 'Cases',
    session,
    badges: [
      { text: dataSource === 'demo' ? 'Demo data (synthetic)' : 'PayPal sandbox', tone: dataSource === 'demo' ? 'warn' : 'ok' },
      { text: aiEngine, tone: aiEngine.startsWith('heuristic') ? 'warn' : 'ok' },
      { text: submissionsEnabled ? 'Submissions enabled' : 'Prepare & export only', tone: 'neutral' },
    ],
    content: `
<section class="card setup-panel" aria-label="Build and connection status">
  <h2>Development status</h2>
  <div class="setup-grid">
    <div><strong>Documents</strong><p>Local PDF text and English OCR. Check every extraction result; failures stay unread.</p></div>
    <div><strong>AI</strong><p>${esc(aiEngine)}. ${aiEngine.includes('fallback') ? 'No real AI inference is active.' : 'Configured, not a verified connection. Consent is required before sending text.'}</p></div>
    <div><strong>PayPal</strong><p>${dataSource === 'demo' ? 'Synthetic cases only. Sandbox access has not been tested.' : 'Sandbox credentials configured. Refresh results must establish actual access.'} Evidence submission is disabled in every mode.</p></div>
  </div>
  <p class="muted small">This is a single-admin synthetic-data development build, not an online production service. No held-balance or funds-release access.</p>
</section>
<div class="page-head">
  <h1>Open cases</h1>
  <button id="refresh-btn" class="secondary" type="button">Refresh from ${dataSource === 'demo' ? 'demo store' : 'PayPal'}</button>
</div>
${disputes.length === 0 ? '<p class="muted">No cases found.</p>' : `
<table class="table">
  <thead><tr><th>Case</th><th>Reason</th><th>Amount</th><th>Status</th><th>Respond by</th><th>Your note</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`}
<p class="muted small">Preparing evidence helps you respond clearly. PayPal decides the outcome; a complete package does not guarantee a decision in your favour or the release of funds.</p>`,
  });
}

export function disputePage({ session, dispute, context, files, analysis, report, auditTrail, dataSource, submissionsEnabled, canSubmitReason, aiEnabled = false, aiHost = null }) {
  const req = requirementsForCase(dispute);

  const checklist = req.groups.map((group) => {
    const analyzed = analysis?.groups?.find((g) => g.id === group.id);
    const slots = (group.slots || []).map((s) => slotLine(s, analyzed, true))
      .concat((group.anyOf || []).map((s) => slotLine(s, analyzed, false)));
    return `
    <section class="req-group" data-group="${attr(group.id)}">
      <h3>${esc(group.title)} ${analyzed ? `<span class="pill pill-${analyzed.status === 'covered' ? 'ok' : analyzed.status === 'partial' ? 'warn' : 'neutral'}">${esc(analyzed.status === 'candidate' ? 'suggested match, unverified' : analyzed.status)}</span>` : ''}</h3>
      <ul class="slots">${slots.join('')}</ul>
    </section>`;
  }).join('');

  const fileRows = files.map((f) => `
    <tr>
      <td>${esc(f.original_name)}<br><span class="muted small">Text extraction: ${esc(f.extraction_status || 'pending')}. ${esc(f.extraction_note || '')}</span>${f.extracted_text ? `<details><summary>Review extracted text (unverified)</summary><pre class="extracted-text">${esc(f.extracted_text)}</pre></details>` : ''}</td>
      <td>${esc(EVIDENCE_KINDS[f.declared_kind] || f.declared_kind)}${documentSuggestions(f)}</td>
      <td>${esc(formatSize(f.size))}</td>
      <td><code>${esc(f.sha256.slice(0, 12))}</code></td>
      <td class="actions">
        <a href="/api/evidence/${attr(f.id)}/download" class="link">Download</a>
        <button class="link danger" type="button" data-delete-file="${attr(f.id)}">Delete</button>
      </td>
    </tr>`).join('');

  const kindOptions = Object.entries(EVIDENCE_KINDS)
    .map(([value, label]) => `<option value="${attr(value)}">${esc(label)}</option>`).join('');

  const analysisPanel = analysis ? `
    <div class="analysis-result" data-engine="${attr(analysis.engine)}">
      <p><strong>Engine:</strong> ${esc(analysis.engine)} · <strong>Suggested evidence match:</strong> ${analysis.hasCandidates ? 'found - review its contents and PayPal\'s exact request' : 'not found - add supporting evidence'}</p>
      ${analysis.caveat ? `<p class="muted small">${esc(analysis.caveat)}</p>` : ''}
      ${analysis.warnings.length ? `<div class="notice notice-warn"><strong>Warnings</strong><ul>${analysis.warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></div>` : ''}
      ${analysis.suggestions.length ? `<div class="notice notice-info"><strong>Suggestions</strong><ul>${analysis.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
      ${analysis.statementChecks.length ? `<div class="notice notice-info"><strong>Statement checks</strong><ul>${analysis.statementChecks.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
    </div>` : '<p class="muted">No analysis yet. Upload documents, then run the analysis.</p>';

  const reportSection = report ? `
    <label for="report-content">Report draft (edit before review)</label>
    <textarea id="report-content" rows="18" maxlength="20000" ${report.status !== 'draft' ? 'readonly' : ''}>${esc(report.content)}</textarea>
    <div class="review-row">
      <label class="check"><input type="checkbox" id="reviewed-check" ${report.status !== 'draft' ? 'checked disabled' : ''}>
      I reviewed this report and confirm it is truthful and accurate.</label>
    </div>
    <div class="button-row">
      <button id="save-report" class="secondary" type="button" data-report="${attr(report.id)}" ${report.status !== 'draft' ? 'disabled' : ''}>Save draft</button>
      <button id="review-report" class="secondary" type="button" data-report="${attr(report.id)}" ${report.status !== 'draft' ? 'disabled' : ''}>Mark reviewed</button>
      <button id="export-report" class="secondary" type="button" data-report="${attr(report.id)}">Export package (.md)</button>
      <button id="submit-report" class="primary" type="button" data-report="${attr(report.id)}" ${canSubmitReason ? 'disabled' : ''}>Submit to PayPal</button>
    </div>
    ${canSubmitReason ? `<p class="muted small">Submission unavailable: ${esc(canSubmitReason)}</p>` : '<p class="muted small">Submission sends the reviewed evidence to PayPal sandbox. PayPal decides the outcome.</p>'}
    <p class="muted small">Report status: ${esc(report.status)}</p>
    <button id="generate-report" class="secondary" type="button">Create a new report draft</button>`
    : '<button id="generate-report" class="secondary" type="button">Generate report draft</button>';

  const auditRows = auditTrail.map((a) => `<tr><td>${esc(a.ts.slice(0, 19).replace('T', ' '))}</td><td>${esc(a.action)}</td><td>${esc(a.detail || '')}</td></tr>`).join('');

  return layout({
    title: `Case ${dispute.id}`,
    session,
    badges: [
      { text: dataSource === 'demo' ? 'Demo data (synthetic)' : 'PayPal sandbox', tone: dataSource === 'demo' ? 'warn' : 'ok' },
    ],
    content: `
<div class="page-head"><a href="/" class="link">&larr; All cases</a></div>
<div class="case-head card">
  <h1>${esc(dispute.id)}</h1>
  <div class="case-meta">
    <span>${esc(req.label)}</span> ·
    <span>${esc(dispute.amount)} ${esc(dispute.currency)}</span> ·
    ${statusPill(dispute.status)} ·
    <span>Respond by ${dispute.response_due_at ? esc(new Date(dispute.response_due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })) : 'n/a'}</span>
  </div>
  <p class="muted">${esc(req.buyerClaim)}</p>
</div>

<div class="grid">
  <div class="card">
    <h2>Your situation</h2>
    <form id="context-form" data-dispute="${attr(dispute.id)}">
      <label>Business type
        <select name="business_type">
          ${['individual', 'sole_proprietorship', 'company'].map((v) => `<option value="${v}" ${context.business_type === v ? 'selected' : ''}>${v.replaceAll('_', ' ')}</option>`).join('')}
        </select>
      </label>
      <label>Short factual statement
        <textarea name="statement" rows="4" maxlength="4000" placeholder="e.g. I am a freelancer and delivered the design work on 2 Nov; the buyer confirmed receipt by email.">${esc(context.statement)}</textarea>
      </label>
      <button class="secondary" type="submit">Save</button>
      <span id="context-saved" class="muted small"></span>
    </form>
  </div>

  <div class="card">
    <h2>Required evidence</h2>
    ${checklist}
    <p class="muted small">${req.caseSpecific ? 'Actual seller-directed evidence types from the cached PayPal case' : 'Generic suggestions for this dispute reason, not case-specific requirements'} (<a href="https://developer.paypal.com/disputes/reasons-evidence" rel="noopener noreferrer">PayPal docs</a>). If PayPal's case data lists specific requested evidence, that takes precedence.</p>
  </div>
</div>

<div class="card">
  <h2>Your documents <span class="muted small">(synthetic only)</span></h2>
  ${files.length ? `<table class="table"><thead><tr><th>File</th><th>Kind</th><th>Size</th><th>SHA-256</th><th></th></tr></thead><tbody>${fileRows}</tbody></table>` : '<p class="muted">No documents uploaded yet.</p>'}
  <form id="upload-form" data-dispute="${attr(dispute.id)}" class="upload-row">
    <input type="file" id="upload-input" accept=".pdf,.png,.jpg,.jpeg,.txt" required>
    <select id="upload-kind" required><option value="other">Identify after upload (recommended)</option>${kindOptions}</select>
    <button class="primary" type="submit">Upload</button>
  </form>
  <progress id="upload-progress" max="100" value="0" hidden></progress>
  <p id="upload-error" class="notice notice-error" hidden></p>
  ${aiEnabled ? `<label class="check"><input type="checkbox" id="ai-consent"> Send extracted text and my statement to ${esc(aiHost)} for AI analysis. Use synthetic documents only; check all extracted text and AI suggestions.</label>` : '<p class="muted small">Local rule-based suggestions only. AI is not configured.</p>'}
  <button id="analyze-btn" class="primary" type="button" data-dispute="${attr(dispute.id)}">Analyze evidence</button>
  <div id="analysis-panel">${analysisPanel}</div>
</div>

<div class="card">
  <h2>Evidence report</h2>
  ${reportSection}
</div>

<div class="card">
  <h2>Case activity</h2>
  ${auditTrail.length ? `<table class="table"><thead><tr><th>Time (UTC)</th><th>Action</th><th>Detail</th></tr></thead><tbody>${auditRows}</tbody></table>` : '<p class="muted">No activity yet.</p>'}
</div>`,
  });
}

function slotLine(slot, analyzedGroup, required) {
  const analyzed = analyzedGroup?.slots?.find((s) => s.key === slot.key);
  const status = analyzed ? analyzed.status : 'pending';
  const icons = { candidate: '?' , covered: '&#10003;', missing: '&#10007;', alternative: '&#8212;', pending: '&#8226;' };
  const classes = { candidate: 'pending', covered: 'ok', missing: 'missing', alternative: 'alternative', pending: 'pending' };
  const icon = icons[status] || icons.pending;
  const cls = classes[status] || 'pending';
  const evidenceList = analyzed?.evidence?.length
    ? `<span class="muted small"> - ${analyzed.evidence.map((e) => esc(e.name)).join(', ')}</span>` : '';
  const note = status === 'alternative' && analyzed?.note ? `<span class="muted small"> (${esc(analyzed.note)})</span>` : '';
  return `<li class="slot ${cls}"><span class="slot-icon">${icon}</span> ${esc(slot.label)}${required ? ' <span class="muted small">(required)</span>' : ''}${evidenceList}${note}</li>`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function errorPage({ status, message }) {
  return layout({
    title: `Error ${status}`,
    session: null,
    content: `<div class="card"><h1>Error ${esc(status)}</h1><p>${esc(message)}</p><p><a href="/" class="link">Back to cases</a></p></div>`,
  });
}


function documentSuggestions(file) {
  const result = suggestDocumentKinds(file.extracted_text);
  return `<details class="document-suggestion" ${file.declared_kind === 'other' ? 'open' : ''}>
    <summary>Identify / correct label</summary>
    <p class="small">${esc(result.note)}</p>
    ${result.candidates.map((c) => `<div class="suggestion-source"><strong>${esc(c.label)}</strong><blockquote>${esc(c.excerpt)}</blockquote><span class="muted small">Extracted text offset ${c.offset}; compare with the original.</span></div>`).join('')}
    <form class="label-form" data-file="${attr(file.id)}">
      <label>Confirmed document label<select name="kind">${Object.entries(EVIDENCE_KINDS).map(([key, value]) => `<option value="${attr(key)}" ${file.declared_kind === key ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select></label>
      <button class="secondary" type="submit">Save label</button>
    </form>
  </details>`;
}
