# Actual test evidence, reconstructed build with candidate-payload fix

2026-11-11 IST. `npm test`, Node v22.23.4.

```
# tests 46
# pass 46
# fail 0
# duration_ms 2688.764562
```

Tests executed:

```
ok 1 - AI cannot substitute identity documents for fulfilment even with valid file IDs
ok 2 - AI schema rejects unknown IDs, non-string suggestions and duplicate mappings
ok 3 - full dispute evidence workflow in demo mode
ok 4 - exports are read-only and source changes invalidate reviewed report snapshots
ok 5 - real PDF and PNG uploads extract text through the HTTP workflow
ok 6 - isolated PDF extraction reads actual synthetic document text
ok 7 - isolated image OCR reads actual synthetic confirmation text
ok 8 - malformed binaries fail closed instead of becoming labelled proof
ok 9 - scanned PDF uses isolated first-three-page OCR fallback
ok 10 - actual parser isolation preflight hides application/home paths and environment
ok 11 - identifier cites actual text and never uses filename or invented excerpts
ok 12 - identity-type signals stay separate even when text asks for a substitution
ok 13 - ambiguous documents expose candidates without changing the seller label
ok 14 - upload without a kind stays other until authenticated CSRF-protected confirmation
ok 15 - token is fetched once and cached across calls
ok 16 - auth failure produces a credential/enablement hint, never the secret
ok 17 - dispute id format is validated before any network call
ok 18 - development transport sends multipart JSON and actual attachment bytes
ok 19 - provideEvidence rejects empty evidence and bad ids
ok 20 - normalizeDispute tolerates partial payloads
ok 21 - auth, CSRF, sessions and rate limiting
ok 22 - upload validation rejects dangerous files
ok 23 - security headers, body limits and error hygiene
ok 24 - demo disputes are clearly labelled and login page carries the synthetic-data notice
ok 25 - malformed percent-encoded cookies do not crash the server
ok 26 - session store holds digests, secret rotation rejects old tokens, expiry is purged
ok 27 - concurrent session count is bounded for the single-admin login
ok 28 - esc neutralises markup, quotes and ampersands
ok 29 - scrypt hash verifies correct password and rejects wrong ones
ok 30 - csrfTokenMatches is strict about length and value
ok 31 - production refuses to boot without secrets
ok 32 - production refuses weak/default admin password and short session secret
ok 33 - live PayPal env is rejected; sandbox passes with both credentials
ok 34 - AI provider requires https base URL and full settings
ok 35 - requirements matrix covers all documented PayPal dispute reasons
ok 36 - every slot kind is a known evidence kind
ok 37 - heuristic engine maps declared kinds to required slots and reports gaps
ok 38 - candidate anyOf groups mark sibling slots as alternative, not missing
ok 39 - heuristic engine warns on declared-kind mismatch and never reclassifies
ok 40 - freelancer statement triggers identity-vs-business-evidence reminder
ok 41 - report contains case facts, gaps and the outcome disclaimer
ok 42 - evidence payload uses covered evidence kinds and never invents data
ok 43 - evidence payload maps real analyzer candidate output to the right group and type
ok 44 - recipes labelled refund and unread binary labels never become evidence candidates
ok 45 - actual PayPal seller requests override generic reason suggestions
ok 46 - unknown case-request evidence types stay unresolved, not generic fallback
```

Includes the regression test for buildEvidencePayload mapping real analyzer candidate output to the correct group and PROOF_OF_FULFILLMENT type (previously filtered a "covered" status the analyzer no longer emits, yielding OTHER/wrong group).

Browser: real Chromium workflow - login, case context, synthetic PDF/PNG uploads without pre-identifying kind, readable local suggestions with source excerpts, seller label confirmations, analysis and report review, on desktop and mobile viewports.
