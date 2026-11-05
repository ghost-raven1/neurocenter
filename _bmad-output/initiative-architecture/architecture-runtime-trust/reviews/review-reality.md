# Reality-Check Review — Architecture Spine (runtime-trust)

- **Gate:** Reviewer Gate · reality-check (BMad architecture)
- **Spine:** `architecture-runtime-trust.md` (status: draft, purpose: build-substrate, altitude: initiative)
- **Repo:** `/home/region.cbr.ru/69starodubtsevae/projects/neurocenter` (brownfield — existing multi-service monorepo)
- **Date:** 2026-11-05
- **Node used for live checks:** `v24.22.0` (`$HOME/.nvm/versions/node/v24.22.0/bin/node`)

## Mandate

Verify every committed decision was reality-checked against the existing project (brownfield) rather than asserted from training data: stack versions, that each named mechanism/technology actually exists and fits, and (greenfield-only) live starter defaults. Flag anything that could be out of date and was not confirmed. Because this is **brownfield with no external starter and no web-only technology claims**, the verification target is the **existing codebase**, not the web.

## Verdict

**PASS.** Every committed decision in the spine is grounded in real, verified code in the existing repo. The named mechanisms (runtime-limits DB/ceiling/audit/UI + `/internal/runtime-limits`, mcp-host ticket HMAC/TTL/`m/:ticket` + live-binding, proxy route timeouts 60000/85000, tool-import ladder 480/540/550, producer-closure pin, the `process.report` libc fields) all exist and fit. The ADs correctly describe **current-state defects they remediate** (secret fallback C5, triple platform-detection C3, god-module C1, catalog `-unknown` fallback) rather than asserting fictional ones. No external starter is relied upon. **No CRITICAL finding.** The `process.report` fields both exist in Node 24.22.0 (not a critical finding).

## Method

- Read the spine in full; extracted each testable assertion (stack table, ADs, consistency conventions, deferred items, structural seed).
- Verified each against the **actual files** (package.json's, shared `.cjs`, api-gateway/mcp-host + proxy TS, catalog-service runtime-limits, pinning scripts, frontend, vendor contract).
- Ran live Node checks for `process.report.getReport()` fields.
- Searched for external starter/template dependencies.
- Did **not** re-run the full root test suite (regression baseline number, out of scope for a reality-check gate — noted in F-13).

Legend: ✅ confirmed against code · ⚠️ accurate target (not yet current state) · ℹ️ informational / out-of-scope note.

---

## Stack table

### F-1 · Node.js 24 — ✅
- **Spine:** `Stack` — "Node.js | 24 (vendor-контракт: `>=24`)".
- **How verified:** `.nvmrc` = `24`; `vendor/asset-contract/package.json` → `engines: {"node":">=24"}`; root `package.json` and `services/api-gateway/package.json` have **no** `engines` field.
- **Result:** Confirmed. The spine correctly attributes `>=24` to the **vendor contract**, not to a repo-wide `engines` field. (Task wording "engines в package.json'ах" is imprecise — only the vendor declares it; the spine's phrasing is accurate, so no defect.)
- **Severity:** — (pass)

### F-2 · NestJS 11.2.7 — ✅
- **Spine:** `Stack` — "NestJS | 11.2.7".
- **How verified:** `services/api-gateway/package.json` → `@nestjs/common` 11.2.7, `@nestjs/core` 11.2.7, `@nestjs/platform-express` 11.2.7 (the framework core). Ecosystem packages are on their own (normal) versions: `@nestjs/config` 4.0.4, `@nestjs/swagger` 11.4.7, `@nestjs/cli` 11.0.24, `@nestjs/schematics` 11.1.0.
- **Result:** Confirmed — the core NestJS framework version is 11.2.7 as stated.
- **Severity:** — (pass)

### F-3 · @neurocenter/asset-contract 1.2.1 (byte-pinned) — ✅
- **Spine:** `Stack` — "1.2.1 (byte-pinned vendor)"; Consistency Conventions "vendor: SHA256SUMS + SOURCE.json".
- **How verified:** `vendor/asset-contract/package.json` → `name: @neurocenter/asset-contract, version: 1.2.1`; `engines >=24`; both `vendor/asset-contract/SHA256SUMS` and `vendor/asset-contract/SOURCE.json` present (byte-pin evidence); root consumes it as `"file:vendor/asset-contract"`.
- **Result:** Confirmed, including the byte-pinning artifacts.
- **Severity:** — (pass)

### F-4 · No external starter / template reliance (brownfield) — ✅
- **Spine:** (implicit — no greenfield starter claimed anywhere).
- **How verified:** Root `dependencies` = only `@neurocenter/asset-contract: file:vendor/asset-contract`. No `create-nest`/`create-next`/`vite`/`react-app`/`remix`/`nest new`/generator/template deps in any `package.json`. `opencode.json` is a local Ollama provider config, not a starter. Established multi-service monorepo (`services/*`, `frontend`, `mcp`, `bridge-dist`, `catalog-source`, `vendor`, `scripts`).
- **Result:** Confirmed — no external starter to check "live defaults" against.
- **Severity:** — (pass)

---

## Named mechanisms the ADs rely on

### F-5 · AD-1 — runtime-limits (DB + ceiling + аудит + UI + `/internal/runtime-limits`) — ✅
- **Spine:** AD-1 "политика … хранится в runtime-limits"; Consistency Conventions "Политики | секция в runtime-limits: default + ceiling + DB + `/internal/runtime-limits` + UI + аудит".
- **How verified:**
  - **DB:** `services/catalog-service/src/runtime-limits/runtime-limits.service.ts` → `runtime_limit_settings` (singleton, revision bump) + `runtime_limit_requests` (idempotency/receipt, `request_key`/`request_hash`) via `this.models.pool` (PostgreSQL).
  - **ceiling:** `services/shared/runtime-limits.cjs` → `RUNTIME_LIMIT_CEILINGS`.
  - **audit:** `save()` calls `securityEvent(db, { action: 'runtime.limits.update', resourceId: 'runtime-limits', before, after })` (explicit audit row) + main-admin gate (`is_main_admin`) + feature flag `runtime_limit_configuration`.
  - **UI:** `frontend/src/features/RuntimeLimits/{RuntimeLimitsSettings.tsx,fields.ts,hooks/useRuntimeLimits.ts}`, wired into `frontend/src/modules/Settings/Settings.tsx`.
  - **`/internal/runtime-limits`:** `runtime-limits.controller.ts` → `@Controller('internal/runtime-limits')` guarded by `assertInternal(req.headers['x-neurocenter-internal'])`; plus public/admin `@Controller('api/runtime-limits')` (GET/`admin`/PATCH/`admin/requests/:key`).
- **Result:** All five sub-claims confirmed present in real code.
- **Severity:** — (pass)

### F-6 · AD-1/AD-7 — artifact limit defaults (256 MiB / 1 GiB / 20000 / 2 GiB cache) — ✅
- **Spine:** AD-1 "Default-политика — контрактные дефолты: 256 MiB / 1 GiB / 20000 / 2 GiB cache".
- **How verified:** `services/shared/runtime-artifacts.cjs` → `LIMIT_DEFAULTS = { compressedBytes: 256 * 1024 ** 2, unpackedBytes: 1024 ** 3, filesCount: 20000, cacheBytes: 2 * 1024 ** 3 }` = exactly 256 MiB / 1 GiB / 20000 / 2 GiB.
- **Result:** Exact match.
- **Severity:** — (pass)

### F-7 · mcp-host ticket flow (HMAC + TTL + `m/:ticket` + claim≤ceiling + artifactSha256↔descriptor) — ✅
- **Spine:** AD-3 "verifyHostedMcpTicket = HMAC + exp + форма + `claim ≤ ceiling` + связка `claim.artifactSha256` с дескриптором"; AD-4 "mcp-host канал `m/:ticket`".
- **How verified:** `services/api-gateway/src/features/mcp-host/`:
  - **HMAC:** `ticket.ts` → `createHmac('sha256', guard)` + `timingSafeEqual`.
  - **TTL/exp:** `HOSTED_MCP_TTL_MS = 30 * 86400 * 1000` (30 d); `exp: Date.now() + TTL`; verify rejects `exp < Date.now()`.
  - **`m/:ticket`:** `mcp-host.controller.ts` → `@All('m/:ticket')` `channel()` → `verifyHostedMcpTicket(ticket)` → `host.handle(claim, …)`; `connect()` returns `{ path: '/api/mcp-host/m/' + ticket }`.
  - **claim ≤ ceiling:** verify checks `compressedBytes/unpackedBytes/filesCount` against `LIMITS.*`.
  - **artifactSha256↔descriptor binding + live-binding:** `host.ts` binds on `claim.artifactSha256 + claim.session.projectId + claim.session.deviceId` (lines 69–71, 350); `artifact-cache.ts` materializes by `claim.artifactSha256`; `host.ts` has `IDLE_TTL_MS = 30 min` and a `60 * 1000` (60 s) lookup interval → matches AD-4 "lookup с кэшем ≤ 60s".
- **Result:** All sub-mechanisms confirmed present. (Note: "связка с дескриптором" is enforced in `host.handle`/`artifact-cache` via sha256 lookup, not inside `verifyHostedMcpTicket` itself — the AD's wording bundles both; the capability is real.)
- **Severity:** — (pass)

### F-8 · AD-4 — revocation live-binding by device — ⚠️ (accurate target; partially current)
- **Spine:** AD-4 "билет остаётся stateless (HMAC + exp), но при соединении gateway проверяет привязку device↔project и активность устройства (lookup с кэшем ≤ 60s). Отзыв = отвязка или деактивация устройства; per-ticket denylist не вводится."
- **How verified:** The stateless ticket + 60 s lookup interval + `deviceId/projectId` binding exist (see F-7). The "отзыв = отвязка/деактивация" and "no per-ticket denylist" are the policy being codified; the runtime lookup path exists in `host.ts`.
- **Result:** Grounded in real current mechanism; the revocation semantics are the AD's normative target.
- **Severity:** INFO (target framed honestly)

### F-9 · AD-5 — independent secret, no fallback (remediation of C5) — ⚠️ (AD accurately describes a real current defect)
- **Spine:** AD-5 "`NEUROCENTER_MCP_HOST_SECRET` обязателен …; **fallback на `NEUROCENTER_INTERNAL_TOKEN` отсутствует**; отсутствие секрета = fail-fast на старте."
- **How verified:** **Current code still has the fallback:** `ticket.ts:52` → `const secret = () => process.env.NEUROCENTER_MCP_HOST_SECRET || process.env.NEUROCENTER_INTERNAL_TOKEN || '';`. And "fail-fast" is currently at call-time (`guard.length < 16` → throw/return undefined), not at module start.
- **Result:** This is **not a defect in the spine** — C5 ("secret fallback") is the problem AD-5 exists to fix. The AD correctly identifies the real, present fallback and proposes removing it + moving to startup fail-fast. Reality-grounded; the removal is pending build work.
- **Severity:** INFO (accurate remediation of a real current state; flag so the build removes the fallback)

### F-10 · AD-6 — gateway route-policy timeouts 60000/85000 — ⚠️ (values confirmed; declarative table is the target)
- **Spine:** AD-6 "gateway владеет таблицей роут-политики (данные: route → {timeoutMs, maxContentLength, allowed}), прокси — чистый механизм".
- **How verified:** `services/api-gateway/src/proxy/proxy.service.ts` → `{ timeout: 60000 }` for `POST /api/bridge-source/check` (line 367) and `{ timeout: 85000 }` for `GET /api/tool-builds/(repository|npm)` (line 370). Both values present. **But** they are currently hardcoded inline in `forward()`'s dispatch logic, not in a declarative route→policy table.
- **Result:** The named 60000/85000 budgets are real; extracting them into a declarative table is the AD-6 refactor target.
- **Severity:** INFO (target framed honestly)

### F-11 · AD-6/C4 — tool-import deadline ladder 480/540/550 — ✅
- **Spine:** AD-6 "лестница дедлайнов tool-import выводится из `base + margins`; порядок `client > gateway > catalog`"; C4 "лестница дедлайнов 480/540/550".
- **How verified:** `services/shared/tool-import-deadline.cjs` → `TOOL_IMPORT_TIMEOUT_MS = 480000` (base/catalog), `TOOL_IMPORT_GATEWAY_TIMEOUT_MS = 480000 + 60000 = 540000`, `TOOL_IMPORT_CLIENT_TIMEOUT_MS = 540000 + 10000 = 550000` → 480 s / 540 s / 550 s. Order: client (550) > gateway (540) > catalog (480). Derived from base + margins exactly as stated.
- **Result:** Exact match, including the derivation and ordering invariant.
- **Severity:** — (pass)

### F-12 · AD-7/C1/C3 — shared god-module + triple platform detection + catalog fallback — ⚠️ (all three current-state problems confirmed; split is the target)
- **Spine:** AD-7 "сплит … `runtime-paths` / `runtime-platform` (TARGETS + единственный `getHostTarget()`) / `runtime-archive`; **fallback catalog'а `linux-x64-unknown` отменён**"; C1 "god-модуль | services/shared"; C3 "тройная platform-детекция | shared + 3 call-site".
- **How verified:**
  - **god-module (C1):** `services/shared/runtime-artifacts.cjs` (14 KB) is monolithic — exports `TARGETS` (8 platforms), `LIMITS`/`LIMIT_DEFAULTS`, `portablePath`, `normalizeRuntimeArtifacts`, `validateRuntimeArtifactEntrypoints`, `inspectRuntimeArchive` (zip/tar + anti-zip-bomb).
  - **triple platform detection (C3):** three divergent copies confirmed — (1) client `mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts`; (2) catalog `services/catalog-service/src/devices/runtime-host-target.ts`; (3) gateway `services/api-gateway/src/features/mcp-host/host-target.ts` (`hostRuntimeTarget`, already consumes `process.report`).
  - **catalog `-unknown` fallback:** `catalog-service/.../runtime-host-target.ts:30` → `return base + '-unknown';` — present, exactly what AD-7 says will be removed (unknown libc → throw).
  - **`getHostTarget()`:** does **not** exist anywhere yet — it is the new canonical name AD-7 introduces in a new `runtime-platform.cjs`. Target split files (`runtime-paths.cjs`/`runtime-platform.cjs`/`runtime-archive.cjs`) do not exist yet.
- **Result:** AD-7 accurately describes the real current god-module, the three divergent platform-detection copies, and the catalog `-unknown` fallback; the split + canonical `getHostTarget()` is the proposed refactor.
- **Severity:** INFO (accurate diagnosis; split is pending build work)

### F-13 · process.report fields (AD-7 canon + Deferred "хрупкость process.report") — ✅ (NOT a critical finding)
- **Spine:** AD-7 "glibc по `glibcVersionRuntime`, musl по `sharedObjects`, неизвестная libc — throw"; Deferred "Хрупкость `process.report` (не стабильный публичный API…)".
- **How verified (live, Node v24.22.0):**
  - `process.report.getReport().header` → **`glibcVersionRuntime: "2.36"`** present (also `glibcVersionCompiler: "2.28"`, `platform: linux`, `arch: x64`, `nodejsVersion: v24.22.0`).
  - `process.report.getReport().sharedObjects` → **array of 8** (`linux-vdso.so.1`, `libdl.so.2`, `libstdc++.so.6`, …).
  - Current consumer `mcp-host/host-target.ts` already reads `header.glibcVersionRuntime` (regex-validated) + `sharedObjects` (musl pattern match) inside a `try/catch`, then `assertTarget()` against the `TARGETS` whitelist, throwing on unknown — exactly the AD-7 canon.
- **Result:** **Both fields exist in this Node version** → the hypothetical "CRITICAL if missing" does **not** trigger. The Deferred "хрупкость process.report" note is self-aware and accurate (it is a semi-stable/internal API); the code already guards it with try/catch.
- **Severity:** — (pass)

### F-14 · AD-8/C2 — CJS↔TS drift guard target (`.d.cts` mirrors) — ✅ (current state confirmed)
- **Spine:** AD-8 "тест сверяет каждую декларацию `.d.cts` с фактическими экспортами `.cjs`"; C2 ".d.cts зеркала".
- **How verified:** `services/shared/` has extensive paired `.cjs`/`.d.cts` (e.g., `runtime-artifacts.cjs`+`.d.cts`, `runtime-limits.cjs`+`.d.cts`, `tool-import-deadline.cjs`+`.d.cts`, `project-text-knowledge.cjs`+`.d.cts`, …). The manual-mirror condition C2 describes is real. The drift-guard test itself is the AD-8 target.
- **Result:** Current mirror state confirmed; the guard test is the pending target.
- **Severity:** INFO (target framed honestly)

### F-15 · AD-2 — descriptor `limits` field (contract extension) — ⚠️ (extension is the target; current contract has no descriptor `limits`)
- **Spine:** AD-2 "клиент узнаёт … лимиты только из поля `limits` верифицированного asset-дескриптора (**контракт расширяется на это поле**; значения вне `[1..ceiling]` — fail-closed)".
- **How verified:** `vendor/asset-contract/index.d.ts` descriptor shape — `RuntimeArtifact { sha256, compressedBytes, unpackedBytes, filesCount, entrypoint, executable? }` and `ToolAsset.delivery: { type:'runtime-artifacts'; artifacts: Array<{url?, descriptor: RuntimeArtifact}> }` — has **no** `limits` field. The contract's `limits` (`vendor/asset-contract/lib/asset.mjs:10`) are **client-side env-driven constants** (`NEUROCENTER_RUNTIME_MAX_*`), used to validate each artifact's size (line 45), not server policy carried in the descriptor.
- **Result:** The descriptor `limits` field is a **target extension** — and the spine explicitly frames it as "контракт расширяется на это поле", so the honesty is correct. (Byte-pinning means any such extension forces a re-pin via tooling — consistent with the Pinned-артефакты convention.)
- **Severity:** INFO (accurate extension; must be re-pinned on change)

### F-16 · Pinned-артефакты (vendor + producer-closure) — ✅
- **Spine:** Consistency Conventions "Pinned-артефакты | vendor: SHA256SUMS + SOURCE.json; producer-closure: `catalog-source/producer.json`; любая правка → пересчёт пина официальным тулингом".
- **How verified:**
  - **vendor:** `vendor/asset-contract/{SHA256SUMS,SOURCE.json}` present (F-3).
  - **producer-closure:** `scripts/assets/catalog-source-pin.mjs` builds `catalog-source/producer.json` (per-file sha256 over `PREPARED_SOURCE_INPUTS`) → updates `catalog-source/manifest.json` (adds producer.json entry) → updates `services/shared/bundled-catalog.lock.json` (manifest sha256); has a **stale-check** ("Producer source pin is stale … run `node scripts/assets/catalog-source-pin.mjs --write`"). `scripts/catalog-plugins/prepared-source-snapshot.mjs` defines `PREPARED_SOURCE_INPUTS` (includes `catalog-source/producer.json`, `producer`, etc.) and snapshots UTF-8 source bytes with a sha256 revision + file/size budgets.
  - `catalog-source/producer.json` exists.
- **Result:** Both pinning regimes confirmed with real tooling and stale-detection.
- **Severity:** — (pass)

---

## Items noted but out of scope for a reality-check gate

### F-17 · Regression baseline "287 файлов, 3693 pass / 0 fail / 38 skipped" — ℹ️ not independently re-run
- **Spine:** Consistency Conventions "Регрессионный эталон | корневой сьют: 287 файлов, 3693 pass / 0 fail / 38 skipped".
- **Note:** This is a test-suite **baseline number**, not a version/technology/starter claim. Re-running the full root suite is out of scope for a reality-check gate (and expensive). It should be asserted by the bmad-build test-baseline step, not re-derived here. No contradiction found; flagged only for transparency.
- **Severity:** INFO

### F-18 · Deferred "Конкретные значения ceiling (2 GiB / 8 GiB / 200000 / 16 GiB)" — ℹ️
- **Spine:** Deferred "Конкретные значения ceiling — рекомендация …; подтвердить при реализации".
- **Note:** Correctly deferred. Current `RUNTIME_LIMIT_CEILINGS` (shared) only covers `textKnowledge` + `ggufImport`; a `runtimeArtifacts` ceiling does not exist yet (see F-19). The recommendation is a proposal to confirm at implementation — appropriately flagged.
- **Severity:** INFO

### F-19 · AD-1 "runtimeArtifacts" ceiling/policy section in `runtime-limits.cjs` — ⚠️ (target section, not yet present)
- **Spine:** AD-1 "каждый лимит имеет ровно два уровня: ceiling … и политика … хранится в runtime-limits"; Structural Seed "runtime-limits.cjs # + секция runtimeArtifacts: default/policy/ceiling".
- **How verified:** `services/shared/runtime-limits.cjs` currently contains **only** `textKnowledge` and `ggufImport` ceiling/policy groups — **no** `runtimeArtifacts` section. The artifact limits (compressedBytes/unpackedBytes/filesCount/cacheBytes) currently live in `runtime-artifacts.cjs` (`LIMITS`/`LIMIT_DEFAULTS`, env-bootstrap, no separate ceiling, no clamping to default).
- **Result:** The two-level (default/policy/ceiling) model for runtime artifacts, and the "env bootstrap never above default / clamp to ceiling" rule (AD-1 "никогда выше дефолта"), are **targets**. The default values themselves are confirmed real (F-6). This is expected for a build-substrate spine.
- **Severity:** INFO (target framed honestly)

---

## Summary of findings

| ID | Claim (spine) | Verified against | Result | Severity |
| --- | --- | --- | --- | --- |
| F-1 | Node 24 (vendor `>=24`) | `.nvmrc`, vendor pkg | ✅ | pass |
| F-2 | NestJS 11.2.7 | api-gateway pkg (common/core/platform-express) | ✅ | pass |
| F-3 | asset-contract 1.2.1 byte-pinned | vendor pkg + SHA256SUMS/SOURCE.json | ✅ | pass |
| F-4 | No external starter (brownfield) | root deps, all pkg.json | ✅ | pass |
| F-5 | AD-1 runtime-limits DB/ceiling/audit/UI/`/internal` | catalog-service + shared + frontend | ✅ | pass |
| F-6 | defaults 256MiB/1GiB/20000/2GiB | `runtime-artifacts.cjs` LIMIT_DEFAULTS | ✅ | pass |
| F-7 | mcp-host HMAC/TTL/`m/:ticket`/claim≤ceiling | mcp-host `ticket.ts`/`controller.ts`/`host.ts` | ✅ | pass |
| F-8 | AD-4 revocation live-binding ≤60s | `host.ts` (60 s interval, IDLE 30 min) | ⚠️ target | INFO |
| F-9 | AD-5 no secret fallback | `ticket.ts:52` (fallback **still present**) | ⚠️ accurate remediation | INFO |
| F-10 | AD-6 route timeouts 60000/85000 declarative | `proxy.service.ts` 367/370 (hardcoded) | ⚠️ target | INFO |
| F-11 | ladder 480/540/550 base+margins | `tool-import-deadline.cjs` | ✅ | pass |
| F-12 | AD-7 god-module + triple detection + `-unknown` fallback | `runtime-artifacts.cjs`, 3 copies, `runtime-host-target.ts:30` | ⚠️ accurate diagnosis | INFO |
| F-13 | `process.report` glibc/sharedObjects in Node 24 | live `v24.22.0` (both present) | ✅ | pass (not critical) |
| F-14 | AD-8 `.d.cts` mirrors | `services/shared/*.cjs`+`.d.cts` pairs | ✅ / target | INFO |
| F-15 | AD-2 descriptor `limits` field | vendor `index.d.ts` (absent; contract constants present) | ⚠️ extension | INFO |
| F-16 | pinned artifacts (vendor + producer) | SHA256SUMS/SOURCE.json + `catalog-source-pin.mjs` | ✅ | pass |
| F-17 | baseline 287/3693/0/38 | (full suite not re-run) | ℹ️ | INFO |
| F-18 | ceiling values deferred | `runtime-limits.cjs` (no runtimeArtifacts ceiling yet) | ℹ️ | INFO |
| F-19 | AD-1 runtimeArtifacts section in runtime-limits | `runtime-limits.cjs` (absent) | ⚠️ target | INFO |

## Bottom line

No decision is asserted from training data; each is checkable and checked against the real brownfield code. The stack versions, the six named mechanisms, the Node `process.report` libc fields, and the absence of any external starter are all **confirmed**. The items marked ⚠️ are **build-substrate targets** the spine frames honestly (split, secret-fallback removal, declarative route table, descriptor `limits` extension, runtimeArtifacts ceiling section) — they describe real current state accurately and are the work bmad-build will execute. **No CRITICAL, no out-of-date/unconfirmed technology.**
