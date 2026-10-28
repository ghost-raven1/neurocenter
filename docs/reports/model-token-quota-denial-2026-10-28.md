# Saved chat quota denial

Actual UI acceptance on `d666d0f268e20dd5de7f04603a29def9b7385df1` found that an exhausted personal budget stopped the physical provider request, but the saved failed turn told the user to check the connection. The quota `HttpException` (429, `MODEL_TOKEN_QUOTA_EXCEEDED`) fell outside the saved-chat exception allowlist.

A small helper now preserves actionable budget guidance only for that status/code pair. Unrelated provider error details stay private; cancellation and previously allowed errors retain their behavior. Existing history is not rewritten and the saved-chat terminal failure response contract is unchanged.

Local verification in a separate worktree based on d666:

- Causal regression through production `ModelChatService.send`: unchanged production source gave 12/13 with the expected message failure; identical test bytes after the fix gave 13/13. The test checks the returned failed turn and persisted message, absence of successful publication, and sanitization of an unrelated 429 or a quota code with status500.
- Production Catalog TypeScript passed. Tests used cached Node24/dependencies, one worker and isolated temporary profiles; process groups exited and profiles were removed. No DB, HTTP service or provider was launched for these checks.
- Frontend component suite passed 44/44, including budget guidance, the preserved question and no automatic retry. This is SSR with test UI dependencies, not browser acceptance. That test file was handed to the frontend owner and is excluded from the backend commit.

Raw receipts: `.run/quota-chat-denial-20261028/{red,green,typecheck,frontend}-receipt.json` and `{red,green,frontend}-tests.json`. Per-check source hashes remained stable.

Earlier actual UI checks on d666 confirmed OFF preconfiguration (5000 tokens/2days), planner/final usage accounting, live reserve4613, completion of an already dispatched22-token response after tightening the limit to1 with overrun21, no next provider send, exact saved-request recovery across response loss/reload/OFF-to-ON, and same-profile two-tab conflict recovery with the draft preserved. Request keys, bodies and real server receipts are retained in `output/playwright/quota-ui-b-20261028/` of the served candidate worktree.

The new Catalog has not been built or applied to the live stand. Actual browser acceptance of the corrected denial is still required. Whole quota acceptance remains incomplete: unsupported embedding UI and exact409 across independent browser contexts were interrupted by real standB authentication503; normal dev-login exposes only MainAdmin. Served d666 source/dist, main and unrelated WIP were not changed.
