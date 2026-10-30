# Header and chat desktop acceptance — 2026-10-30

The computer popover now separates hostname, connection status, bridge version,
OpenCode observation and actions with wrapping and explicit spacing. Team chat
keeps personal dialogs, service roles and settings visible in its compact header.
Returning from personal mode restores the selected project room and its draft.
The agent model error uses the full message width and places its small retry below.

The changes reuse Ant Design and existing chat APIs, authorization, room-list
validation and draft ownership. No provider call is triggered by navigation/retry.

## Evidence

- Header: 23 existing tests in three suites, frontend TypeScript and LESS passed.
- Chat: causal navigation regression reproduced, then 91 affected tests in eight
  suites, frontend TypeScript and both LESS files passed.
- Independent review of all 12 changed source/test files found no P1/P2.
- Root used actual Playwright at 1440×1000 with real Catalog/Gateway/Skills/RAG
  services, an isolated PostgreSQL database and standalone Native bridge 0.9.28.
  Frozen backend source was dbea310c5ccc8794484de1c1fdd205a06a41db7e; its
  executable artifacts were separately verified equivalent to Main 24841f13.
- Eleven desktop checks passed: long hostname/version/date layout; expanded
  observation; Escape/focus; compact team controls and settings; personal saved
  history; private room/draft roundtrip; draft recovery after closing/reopening;
  actual unassigned-model error; retry/error recovery retaining unchecked agent.
  The red alert measured 436×67px, with its message on one line at this viewport.
- Frontend receipt SHA: 024898f7da542616826930fc8df18c1feb4b030376afe9da41e80fa0b81a4054.
  Receipts and four screenshots: `.run/header-chat-browser-20261030/`.
- Model and external calls: zero. All three owned databases and both owned PIDs
  were independently verified absent after normal cleanup.

## Boundaries

Authentication, OS opener and synthetic saved conversation/model verification
were fixture setup. Context preview was deliberately blocked (503); inference
was not tested. Ant Design 4 emitted its existing findDOMNode deprecation.
Room recall is within one overlay lifetime; after closing/reopening, selecting
the private room restores its draft. These checks do not prove CI, remote server,
other operating systems, model responses or whole-application acceptance.
