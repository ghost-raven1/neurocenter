# OpenCode version detection — 2026-10-30

OpenCode 1 prints a bare semantic version; the actual official OpenCode 2.2.2
binary prints `opencode v2.2.2`. CLI observation and absent-only installation
now share a bounded parser for those complete lines. Public receipts still
contain only canonical semantic versions; logs, banners and ANSI output fail.

The existing first-PATH rule is preserved when two CLI files are present.
Installation preserves both files, the manual default model and auth/config
bytes; it does not replace the selected existing CLI with the bundled version.

Evidence: the official-output regression failed in observation and installation,
then 35 affected cases passed; 25 related auth-owner/worker/recovery cases and
Native TypeScript passed. The official 2.2.2 executable was downloaded into an
owned QA directory, verified against npm integrity, and observed through the
production owned-process path with macOS network denial. Result: installed,
version2.2.2, closed process receipt and unchanged executable SHA256.
Source/evidence receipt: `.run/opencode-v1-v2-20261030/parser-freeze.json`.

This slice confirms detection and preservation, not full V2 support. A separate
isolated real V2 server confirmed owned JSON/Markdown agents, skill and MCP
discovery while retaining legacy config bytes. Its API and plugin contracts
differ from V1; adapter and file-editing acceptance remains open in section6
of `bridge-first-local-setup`. The actual installed bridge archive, UI selection,
credentials editing, RAG/plugin execution, CI and remote server were not updated
or accepted by these checks.

Primary contracts: [official migration](https://opencode.ai/v2/docs/migrate-v1/)
and [pinned V2 source](https://github.com/anomalyco/opencode/tree/098aa7fd6e02b03d6fc410f0b052038c7d4c5e81).
