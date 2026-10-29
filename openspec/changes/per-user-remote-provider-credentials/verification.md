# Verification — 2026-10-29

Implementation candidate; desktop browser acceptance remains task 3.3.

| Boundary | Result | Evidence |
| --- | --- | --- |
| Catalog production TypeScript | PASS | `.run/remote-provider-51-20261029/catalog-production-tsc.log` |
| Frontend production TypeScript | PASS | `.run/remote-provider-51-20261029/frontend-production-tsc.log` |
| Remote API, crypto, wire, admission and existing protocol/quota regressions | 14 files, 218 PASS | `.run/remote-provider-51-20261029/backend-contract-and-admission.log` |
| System-role adapter apply/rollback migration consumer | 3 files, 15 PASS | tool result `aed558`; new strict-boundary regression first failed 4/4 in `b8cfe6` |
| Agent, embedding, project chat, system role and research affected unit regressions | 9 files, 183 PASS | tool result `93420c`; explicit trusted actor assertions in device embedding and agent trial |
| Personal current credentials, CAS, receipts, fresh ACL, locks, schema drift | 14 PASS on owned PostgreSQL database | `.run/remote-provider-51-20261029/postgres-personal-green.log` |
| Historical provider options and ciphertext retention | 4 PASS on owned PostgreSQL databases | `.run/remote-provider-51-20261029/postgres-legacy-repository.log` |
| API client, controller, personal DOM, provider settings, existing focus | 5 files, 43 PASS | tool result `038d26`; existing JSDOM pseudo-element styling warnings remain in the old focus fixture |
| Generated full OpenAPI and personal contract | 2 files, 33 PASS | tool result `61994a` |
| OpenSpec strict validation | PASS | tool result `f985f9` |

The PostgreSQL fixture measured 28 physical schema facts, including all CHECK constraints, both foreign keys and both primary keys. Removing each of the ten relevant CHECK/FK constraints independently makes the readiness assertion reject. Personal ciphertext is bound to actor/provider/revision; the old shared ciphertext remains unchanged. Accepted UUID replay works with the flag OFF. Lost COMMIT acknowledgement and fresh 403 after COMMIT recover through the own masked receipt.

An independent source review found a real pre-dispatch race: losing the leased SQL connection while `claimQuota` waited released its locks without invalidating the decrypted key. The causal test first failed because a successful provider result was returned after terminating that exact owned lease PID and committing key deletion. The fix attaches error/end listeners immediately after checkout, invalidates the lease synchronously and destroys only its owned connection. The same test now confirms status 503, provider fetch count zero, unused quota release count one and dispatch count zero. The independent reviewer then checked the fixed source and found no additional actionable issues in the reviewed scope; this was source review, not an independent test rerun.

The literal fetch test also holds the HTTP response while key deletion completes, proving locks do not live through provider latency. A separate A401/B200 test proves one user's authorization failure does not rewrite the shared verified pin or health fields.

The subsequent read-only execution-chain audit found one old provider setup consumer: system-role adapter apply still forwarded `credential`/`credentialEnv` and omitted `authMode`. Its direct service call failed strict validation, including the `credentialEnv: undefined` property. The approved narrow fix forwards the existing effective `authMode` and omits both legacy fields. The causal test covers required, optional, legacy stored and legacy environment views through the real input validator, for both apply and rollback; no key or environment name enters the write. A bounded search found no other production setup consumer using that obsolete payload.

The fixture cleanup checks zero remaining sessions, drops only its UUID database and verifies absence; see `pg-cleanup-receipt.json`. No Main database, real API key, paid provider request, native bridge, installed OpenCode authentication or application deployment was used. The existing OpenCode import path retains its separate legacy shared-key storage behavior; this change adds no device-key import and the new remote dispatcher never uses that shared credential as fallback.

The browser gate must use two authenticated users and the real public routes to check compact layout, save/delete, provider modes, role denial, OFF reads and receipt recovery. Source build, installed runtime, CI and production are separate pending evidence.
