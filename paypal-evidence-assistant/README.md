# Dispute Evidence Assistant

A single-admin web application for preparing evidence for PayPal seller disputes.
It helps sellers describe their situation, read their documents, compare candidate
evidence with a case request, and review an editable report before exporting it.
It cannot unfreeze balances, substitute PAN for business evidence, decide a dispute
or guarantee that PayPal will accept evidence.

## Run the development build

Tested with Node 22.23.4 on Linux. The JavaScript application uses Node's standard
library and SQLite; binary document extraction also requires these OS packages:

- bubblewrap (`bwrap`), with unprivileged user/mount/network namespaces available
- Poppler (`pdftotext`, `pdftoppm`)
- Tesseract with English language data
- util-linux (`prlimit`)

The current paths target Debian/Ubuntu x86-64 (`/usr/bin`, `/usr/lib`, `/lib`,
`/lib64`, `/usr/share/tesseract-ocr`). A different distribution needs verified
path configuration. Never disable isolation to make parsing work.

```sh
npm start
# Open http://localhost:3000
# Development login: demo / demo-password
npm test
```

Use synthetic documents only. A missing/unusable extraction sandbox produces a
visible extraction failure, not an unsafe parser fallback. Platform deployment,
real-document handling and real provider calls are not approved or verified yet.

`.env.example` documents settings. Environment variables must be exported by the
process manager or shell; this build does not automatically load `.env` files.
Production refuses development credentials and requires a strong session secret.
Never commit credentials or paste them into chat.

## Working local workflow

1. Sign in and choose one of the clearly labelled synthetic dispute cases.
2. Write a factual statement and choose your business type.
3. Upload PDF, PNG, JPEG or plain-text evidence without knowing its label. The default stays Other until you confirm a label. Local content-based suggestions show quoted source excerpts; ambiguous and identity-related text are called out. This identifier is rule-based, not real AI.
4. Read the extraction status and expand the extracted text. Text PDFs are read
   up to 20 pages. Scanned PDFs use OCR on the first 3 pages. PNG/JPEG use English
   OCR. Output is capped at 40,000 characters. OCR can misread facts or identifiers.
5. Analyze. Without an AI configuration, this is clearly labelled local rule-based
   matching, not AI. Labels alone never establish evidence sufficiency. Matches are
   suggestions, never proof of authenticity, delivery or PayPal acceptance.
6. Generate a report, edit it, confirm its truthfulness and export Markdown. A
   reviewed report is immutable; generate a new draft to change it. Input changes
   invalidate previous analyses and reports. Export itself is read-only.

Uploads are outside the web root and downloads require authentication. Original
file names are display-only; stored names are random. Reports and history are
stored in SQLite. This is a single-process, single-admin build, not a multi-tenant
public service.

## AI path

An OpenAI-compatible adapter is implemented. Configure the provider's HTTPS URL,
model and API key through environment secrets. A per-analysis consent checkbox
names the provider before extracted text and the seller statement are sent.
Original binary files are not sent to the model. Provider output is schema checked;
unknown IDs, invalid substitutions and identity-to-fulfilment mappings are rejected.
Provider failure uses an explicitly labelled local fallback.

Real AI inference has NOT been tested with authorized provider credentials. Mock
adapter tests are not proof that a provider accepts a model or request format.
Provider account access and authorization for any API charges remain required.

## PayPal path

The sandbox OAuth/list/get client is implemented. Dispute details use
`evidences.source=REQUESTED_FROM_SELLER` and `evidence_type` to replace generic
suggestions. Unknown requested types remain unresolved. Generic requirements are
sourced from PayPal's reason/evidence guidance, not invented release rules.

The sandbox app needs the Disputes feature enabled. Credentials alone do not prove
access. This build implements first-party merchant access only. Acting for another
merchant requires a separate consent/onboarding integration, not an arbitrary
merchant ID in a dashboard.

Submission is HARD-DISABLED in all modes until actual sandbox request payloads,
attachment transfer and state/replay checks are verified end to end. There is no
account-limitation, KYC or held-balance integration. The app does not display
withdrawable balances or pretend that dispute status is an account review status.

## Structure

- `src/server.js`, `config.js`, `router.js`: application lifecycle and configuration
- `src/auth.js`, `db.js`, `middleware.js`: sessions, persistence, limits
- `src/routes.js`, `views.js`, `public/`: HTTP routes and responsive dashboard
- `src/services/extractor.js`: isolated PDF extraction and image/scanned-PDF OCR
- `src/services/requirements.js`, `analyzer.js`: case-specific suggestions and AI
- `src/services/paypalClient.js`, `disputeService.js`: sandbox integration
- `src/services/reportBuilder.js`: reviewable evidence report
- `test/`: unit, HTTP workflow, security, extraction and mocked adapter regressions

See `SECURITY.md`, `docs/TEST_EVIDENCE.md`, `docs/TEST_RUN.tap`, and
`docs/DEPLOYMENT.md`. Independent review is ongoing. Passing tests are not a
zero-vulnerability guarantee or a production approval.

## Sources checked 2026-11-09

- https://developer.paypal.com/platforms/disputes/integrate-disputes
- https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api
- https://developer.paypal.com/disputes/reasons-evidence
- https://developer.paypal.com/api/customer-disputes/v1/definitions/evidence
- https://developer.paypal.com/platforms/disputes/reference/supported-file-types-sizes

No hosting deployment, repository publication, hackathon submission, or paid
service was created by this local build. Open-source licensing/publication remains
an owner decision.


Development delta after reviewed review4b: document suggestions and label correction route require independent review. Each label change invalidates old analyses and reports. The signed-off review4b archive is preserved separately; no security signoff is inferred for these newer bytes.
