/* Frontend behaviour. All mutations go to the JSON API with the per-session
   CSRF token from the meta tag. The CSP blocks inline scripts; this file is
   the only script on the page. */
(function () {
  'use strict';

  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute('content') : '';

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'X-CSRF-Token': csrf }, options.headers || {});
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.error || ('Request failed (HTTP ' + res.status + ')'));
        return body;
      });
    });
  }

  function postJson(path, data) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    });
  }

  function showError(el, message) {
    if (!el) { window.alert(message); return; }
    el.textContent = message;
    el.hidden = false;
  }

  function reload() { window.location.reload(); }

  // --- Dashboard refresh ---
  var refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      refreshBtn.disabled = true;
      postJson('/api/refresh').then(reload).catch(function (err) {
        window.alert(err.message);
        refreshBtn.disabled = false;
      });
    });
  }

  // --- Context form ---
  var contextForm = document.getElementById('context-form');
  if (contextForm) {
    contextForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var disputeId = contextForm.getAttribute('data-dispute');
      postJson('/api/disputes/' + encodeURIComponent(disputeId) + '/context', {
        business_type: contextForm.elements.business_type.value,
        statement: contextForm.elements.statement.value,
      }).then(function () {
        var mark = document.getElementById('context-saved');
        if (mark) mark.textContent = 'Saved.';
      }).catch(function (err) { window.alert(err.message); });
    });
  }

  // --- Evidence upload (raw body, XHR for progress) ---
  var uploadForm = document.getElementById('upload-form');
  if (uploadForm) {
    uploadForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var disputeId = uploadForm.getAttribute('data-dispute');
      var input = document.getElementById('upload-input');
      var kind = document.getElementById('upload-kind');
      var progress = document.getElementById('upload-progress');
      var errorEl = document.getElementById('upload-error');
      errorEl.hidden = true;
      if (!input.files || input.files.length === 0) { showError(errorEl, 'Choose a file first.'); return; }

      var file = input.files[0];

      var xhr = new XMLHttpRequest();
      var url = '/api/disputes/' + encodeURIComponent(disputeId) + '/evidence'
        + '?filename=' + encodeURIComponent(file.name)
        + '&kind=' + encodeURIComponent(kind.value);
      xhr.open('POST', url);
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) {
          progress.hidden = false;
          progress.value = Math.round((e.loaded / e.total) * 100);
        }
      };
      xhr.onload = function () {
        progress.hidden = true;
        if (xhr.status >= 200 && xhr.status < 300) { reload(); return; }
        var message = 'Upload failed (HTTP ' + xhr.status + ')';
        try { message = JSON.parse(xhr.responseText).error || message; } catch (ignore) { /* keep default */ }
        showError(errorEl, message);
      };
      xhr.onerror = function () { progress.hidden = true; showError(errorEl, 'Upload failed (network error).'); };
      xhr.send(file);
    });
  }

  // The user confirms a label after inspecting local text suggestions.
  Array.prototype.forEach.call(document.querySelectorAll('.label-form'), function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      postJson('/api/evidence/' + encodeURIComponent(form.getAttribute('data-file')) + '/label', { kind: form.elements.kind.value })
        .then(reload).catch(function (err) { window.alert(err.message); });
    });
  });

  // --- Delete evidence ---
  Array.prototype.forEach.call(document.querySelectorAll('[data-delete-file]'), function (btn) {
    btn.addEventListener('click', function () {
      if (!window.confirm('Delete this document?')) return;
      postJson('/api/evidence/' + encodeURIComponent(btn.getAttribute('data-delete-file')) + '/delete')
        .then(reload)
        .catch(function (err) { window.alert(err.message); });
    });
  });

  // --- Analyze ---
  var analyzeBtn = document.getElementById('analyze-btn');
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', function () {
      analyzeBtn.disabled = true;
      analyzeBtn.textContent = 'Analyzing...';
      postJson('/api/disputes/' + encodeURIComponent(analyzeBtn.getAttribute('data-dispute')) + '/analyze', { consentAI: Boolean(document.getElementById('ai-consent') && document.getElementById('ai-consent').checked) })
        .then(reload)
        .catch(function (err) {
          window.alert(err.message);
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = 'Analyze evidence';
        });
    });
  }

  // --- Report flow ---
  var generateBtn = document.getElementById('generate-report');
  if (generateBtn) {
    generateBtn.addEventListener('click', function () {
      generateBtn.disabled = true;
      var disputeId = document.getElementById('context-form').getAttribute('data-dispute');
      postJson('/api/disputes/' + encodeURIComponent(disputeId) + '/report').then(reload)
        .catch(function (err) { window.alert(err.message); generateBtn.disabled = false; });
    });
  }

  var saveBtn = document.getElementById('save-report');
  if (saveBtn) {
    saveBtn.addEventListener('click', function () {
      postJson('/api/reports/' + encodeURIComponent(saveBtn.getAttribute('data-report')), {
        content: document.getElementById('report-content').value,
      }).then(function () { saveBtn.textContent = 'Saved.'; })
        .catch(function (err) { window.alert(err.message); });
    });
  }

  var reviewBtn = document.getElementById('review-report');
  if (reviewBtn) {
    reviewBtn.addEventListener('click', function () {
      var checked = document.getElementById('reviewed-check');
      if (!checked || !checked.checked) {
        window.alert('Confirm that you reviewed the report and that it is truthful first.');
        return;
      }
      postJson('/api/reports/' + encodeURIComponent(reviewBtn.getAttribute('data-report')), {
        content: document.getElementById('report-content').value,
      }).then(function () {
        return postJson('/api/reports/' + encodeURIComponent(reviewBtn.getAttribute('data-report')) + '/review', { confirmed: true });
      }).then(reload).catch(function (err) { window.alert(err.message); });
    });
  }

  var exportBtn = document.getElementById('export-report');
  if (exportBtn) {
    exportBtn.addEventListener('click', function () {
      window.location = '/api/reports/' + encodeURIComponent(exportBtn.getAttribute('data-report')) + '/export';
    });
  }

  var submitBtn = document.getElementById('submit-report');
  if (submitBtn) {
    submitBtn.addEventListener('click', function () {
      if (!window.confirm('Submit the reviewed evidence to PayPal sandbox? This sends the report to PayPal. PayPal decides the outcome; submission does not guarantee a decision in your favour or release of funds.')) return;
      submitBtn.disabled = true;
      postJson('/api/reports/' + encodeURIComponent(submitBtn.getAttribute('data-report')) + '/submit')
        .then(function () { window.alert('Submitted. PayPal will review the evidence.'); reload(); })
        .catch(function (err) { window.alert(err.message); submitBtn.disabled = false; });
    });
  }
})();
