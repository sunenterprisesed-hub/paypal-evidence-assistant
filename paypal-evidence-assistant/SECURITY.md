# Security model

Every claim below maps to an automated test in `test/` (named in brackets).
Run `npm test` to re-verify. The latest recorded run is in
`docs/TEST_EVIDENCE.md`. This build makes no "unhackable" claims - it lists
what is defended, how, and what remains open.

## Authentication and sessions

- Passwords verified with scrypt (N=16384) and a constant-time comparison;
  the hash is derived from env config at boot and held in memory only - no
  credentials table exists to dump. [`unit.test.js`]
- Sessions use 256-bit random browser tokens; only keyed HMAC digests are stored server-side (12h expiry); the cookie
  is `HttpOnly; SameSite=Lax; Path=/` and `Secure` in production. Logout
  destroys the server-side record. [`security.test.js`]
- Failed logins are rate-limited to 5 per 5 minutes per IP+username;
  successful logins do not consume the budget. Audit log records failures.
  [`security.test.js`]
- Production refuses to boot without `SESSION_SECRET`, explicit admin
  credentials, and rejects the development default password. [`unit.test.js`]

## CSRF

- Every mutating route requires the per-session CSRF token (header for fetch
  calls, form field for the logout form), compared with `timingSafeEqual`.
  Missing or wrong tokens get 403. [`security.test.js`, `e2e.test.js`]

## Uploads

- Raw-body upload with a hard byte cap enforced during streaming; oversized
  bodies get a clean 413 and the connection closes without reading the rest.
  [`security.test.js`]
- Allowlist only: `.pdf`, `.png`, `.jpg/.jpeg`, `.txt`. Extension is checked
  AND magic bytes are sniffed (`%PDF-`, PNG signature, JPEG SOI); `.txt` must
  look like plain text (no NUL bytes, control-char ratio). HTML/SVG/EXE
  content is rejected even with an allowed extension. Client-supplied MIME is
  never trusted. [`security.test.js`]
- Stored under server-generated random names in `DATA_DIR/uploads` (mode
  0600), outside any web root. The client's filename is display-only and
  sanitized. Download resolves through an id allowlist and serves
  `Content-Disposition: attachment` + `application/octet-stream`, so uploaded
  content is never rendered by the browser. [`security.test.js`]
- Per-case file count cap (20) and per-user upload rate limit (30/min).

## Output injection

- All server-rendered values pass through `esc()`; a stored-XSS attempt in
  the case statement is verified escaped in the rendered page.
  [`security.test.js`]
- Strict CSP: `default-src 'self'; script-src 'self'` - no inline scripts or
  styles anywhere (verified by test), `frame-ancestors 'none'`,
  `form-action 'self'`, plus `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer`. [`security.test.js`]

## Data and errors

- SQLite with parameterized prepared statements only; no SQL string building.
- Central error boundary: clients get generic messages; stack traces are
  logged server-side only. Malformed JSON gets a clean 400. [`security.test.js`]
- File/report/dispute ids are format-validated before lookup; a traversal
  attempt against the download route returns 404. [`security.test.js`]

## Secrets and outbound calls

- Secrets arrive only via environment variables; `.env` is git-ignored.
- The PayPal client secret appears only in the Basic-auth header of the token
  request - never in URLs, logs, or error messages (tested). [`paypal.test.js`]
- The PayPal base URL is a fixed constant (`api-m.sandbox.paypal.com`); live
  mode is refused at config validation. Dispute ids are validated before any
  network call. [`unit.test.js`, `paypal.test.js`]
- The AI adapter accepts only `https://` base URLs from env, sends metadata
  and plain-text snippets (never file bytes), times out at 20s, and validates
  the model's JSON against actual case data before use; any failure falls
  back to the labelled heuristic engine. [`unit.test.js`]

## Submission guard rails

- Submitting evidence to PayPal requires ALL of: live sandbox credentials,
  `SUBMISSIONS_ENABLED=true`, a user-reviewed report, dispute status
  `WAITING_FOR_SELLER_RESPONSE`, and PayPal's provide-evidence HATEOAS link
  present. Demo mode refuses with an explicit reason. [`e2e.test.js`]

## Known limitations (honest list)

- Single-process in-memory rate limiters; a multi-instance deployment needs a
  shared store.
- No TLS in the app itself; put it behind a TLS-terminating proxy in
  production (see `docs/DEPLOYMENT.md`).
- `clientIp` uses the direct socket address; behind a proxy, configure trust
  deliberately.
- Login CSRF is mitigated by `SameSite=Lax`; no separate pre-session token.
- node:sqlite is an experimental Node API (runtime warning printed); pin the
  Node version in production.
- The provide-evidence multipart payload shape is implemented from the API
  reference but untested against the real sandbox until credentials exist.
- Demo-mode demo disputes are static; the audit log and uploads are local to
  `DATA_DIR` - protect that directory (mode 0700) on any shared host.


## Independent review remediation

This development revision treats all matches as candidates, never verified proof.
Actual seller-directed PayPal evidence types override generic reason suggestions;
unknown requested types stay unresolved. PDF/PNG/JPEG contents are now extracted locally in an isolated OS process; extraction is not authenticity verification.
Exports are read-only GETs. Source context/upload/delete changes invalidate
analyses and reviewed reports; old reports cannot be re-reviewed or exported.
Reviewed reports are immutable; a new draft can be generated. Submission is
hard-disabled in both the HTTP route and service layer pending real sandbox tests.
Session tokens are HMAC-digested before storage; changing SESSION_SECRET makes
old cookies unusable. Expired sessions are purged at login and active concurrent
sessions per username are bounded to ten. Rate limiter maps have a hard bound.


## Binary parser boundary (new, requires independent retest)

PDF text extraction, first-three-page scanned PDF OCR, and PNG/JPEG OCR use
bubblewrap with separate user/PID/mount/network namespaces, cleared environment,
read-only system binaries/libraries/language data, no application/home/data mounts,
and throwaway tmpfs. prlimit caps address space (512 MiB), CPU (8s), file size
(1 MiB) and open files (64); execFile caps output (128 KiB) and wall time (12s per
phase). Two parser jobs maximum. Output is capped at 40,000 characters. Missing
isolation fails closed. No unrestricted fallback exists. Native parser updates
must come from maintained OS packages; these limits are not proof against every
parser bug. Real documents remain out of scope pending review and deployment.

Extracted text remains untrusted. AI receives text only after an explicit consent
checkbox names its configured provider; original binaries are not sent. Outputs
are escaped, not rendered as HTML, and cannot authorize actions or substitutions.
