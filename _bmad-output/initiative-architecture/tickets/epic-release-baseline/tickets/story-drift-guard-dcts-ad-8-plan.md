---
title: 'Drift-guard деклараций .d.cts↔.cjs (AD-8)'
type: 'feature'
ticket: '7'
created: '2026-11-06'
status: ready-for-dev
baseline_revision: '160a4003b4b4f3a3cc218e5cc94438ae104f3a9f'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md
  - _bmad-output/initiative-architecture/architecture-runtime-trust/gap-inventory-v2.md
  - _bmad-output/initiative-architecture/tickets/epic-release-baseline/epic-release-baseline.md
  - _bmad-output/initiative-architecture/tickets/epic-release-baseline/tickets/story-shared-split-targets-facade-ad-7-plan.md
  - _bmad-output/initiative-architecture/tickets/epic-release-baseline/tickets/story-shared-split-limits-archive-ad-7-plan.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** слой `services/shared/` держит конвенцию «каждый `.cjs` имеет декларацию `.d.cts`» + канон целей AD-7 в `runtime/targets.cjs`, но **ничто механически не проверяет соответствие деклараций реальным экспортам и канона целям**. Найденные инвентаризацией реальные расхождения: `capacity.cjs` (4 value-экспорта без деклараций — `createCapacityGuard`, `validateSnapshot`, `resources`, `maxAgeMs`, все реально используются) и `github-release-source.cjs` (`resolveGithubRelease` — публичный, используется `repository-source.cjs:433`). Плюс 5 `.cjs` без деклараций вовсе и «вторые списки» 8 канонических целей в 4 местах (device-report.ts, frontend runtimeArtifacts.ts, 2 label-карты) + type-union `TRuntimeTarget` — все могут сгнить при изменении канона без обнаружения. Это подтверждено `architecture-runtime-trust/gap-inventory-v2.md:79` (AD-8 — источник тикета).

**Approach:** новый guard-тест `scripts/test/shared-declaration-drift.test.mjs` (node --test, **статический parse обеих сторон** — ни `.cjs` ни `.d.cts` не исполняются; обоснование см. Design Notes: 10 из 80 `.cjs` читают env при импорте, `runtime.cjs` — 15 secret/env-переменных, 2 бросают при импорте). Guard сверяет: (1) **drift деклараций↔экспортов** двунаправленно (наличие имён + базовая форма + type-only гигиена) по всем `services/shared/**/*.cjs` с `.d.cts`; (2) **`.cjs` без декларации = фэйл** с явным allowlist; (3) **орфанные/declaration-only/duplicate-pair декларации** с allowlist; (4) **отдельный check равенства TARGETS** — 5 standalone-копий канона сверяются с `runtime/targets.cjs` (защита от гниения канона AD-7). Реальный drift исправлен: capacity.cjs + github-release-source.cjs (декларации, аддитивно, без смены экспортов), 5 пропущенных деклараций дописаны, allowlist'ы зафиксированы.

## Boundaries & Constraints

**Always:**
- Guard — **статический parse** (fs.readFileSync + regex/лёгкий разбор) как `.d.cts`/`.d.ts`/`.d.mts`, так и `module.exports` в `.cjs`. **Никакого `require`/`import` `.cjs` shared-модулей в тесте** (side-effects при импорте — см. Design Notes). Единственный `require` — канон `runtime/targets.cjs` (чистый импорт, верифицировано: не читает env, не бросает).
- Статический парсер **fail-loud**: `.cjs` с не-поддерживаемой формой экспорта (не `module.exports = {…}` / `= ident` / `= require('…')`) → явный фэйл с сообщением, а не тихий pass.
- Allowlist'ы **явные, именованные, в коде теста** (не glob-подстановки): `NO_DECL_ALLOWLIST`, `DECL_ONLY_ALLOWLIST`, `DUP_PAIR_ALLOWLIST`, `TARGETS_COPIES`.
- Guard охватывает **`services/shared/**/*.cjs`** (80 файлов на baseline). `mcp/**/dist/**` (build-копии, AD-10 freshness), `scripts/**/*.cjs` (test/tool), `vendor/**` (AD-15) — вне охвата guard'а (явно задокументировано).
- Guard — **динамический по каталогу** (walk при запуске): автоматически покрывает новые модули 1.6 (`runtime/limits.cjs`, `runtime/archive.cjs` + `.d.cts`) без правки списка.
- Исправления drift'а — **аддитивные** (добавить декларации; `module.exports` не менять): runtime-поведение инвариантно.

**Never:**
- Не требовать `require`/`import` shared-`.cjs` в guard-тесте (runtime.cjs/limits — env/secret side-effects при импорте; worker бросает при импорте).
- Не менять `module.exports` capacity.cjs / github-release-source.cjs (экспорты реально используются тестами и production-инструментами — de-export сломал бы `capacity.test.cjs`, `skill-packaging-http.test.mjs`, `scripts/production/resources.mjs`, `repository-source.cjs`).
- Не трогать `vendor/asset-contract` (AD-15), `scripts/opencode-platforms.mjs` `opencodeVariants` (11 вариантов, другое пространство имён), `scripts/catalog-plugins/python-runtime.mjs` (glibc-only, другая семантика).
- Не входить в `PREPARED_SOURCE_INPUTS` cap / pin-каскад (guard — только чтение; новые `.d.cts` подпают в pin автоматически при следующем `catalog-source-pin --write` в 1.6, не в этом тикете).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DRIFT_OVER_EXPORT_BASELINE | baseline 160a4003: capacity.cjs (10 exports / 6 declared), github-release-source.cjs (2 exports / 1 declared) | guard **фэйл** (до исправления) | actionable: список имён «экспортировано, не декларировано» |
| DRIFT_FIXED | capacity.cjs declares +4, github-release-source.cjs declares resolveGithubRelease | guard **зелёный** | No error |
| DRIFT_PHANTOM_DECL | декларация называет имя, которого нет в `module.exports` | guard **фэйл** | actionable: «декларировано, не экспортировано» |
| TYPE_ONLY_LEAK | `export type X` в `.d.cts`, а `X` есть в `module.exports` | guard **фэйл** | actionable |
| NO_DECL_FLAG | `.cjs` с экспортами, нет `.d.cts`, не в allowlist (5 на baseline) | guard **фэйл** до дописи деклараций | actionable: «нет декларации» |
| NO_DECL_ALLOWLIST | chat-document-worker.cjs (worker, 0 экспортов) | guard **pass** | No error |
| DECL_ONLY | gguf-import.d.ts (5 interfaces, нет runtime `.cjs`) | guard **pass** (allowlist) | No error |
| DUP_PAIR | skill-source.d.cts + skill-source.d.mts (shim `.cjs`→`.mjs`) | guard **pass**; shim резолвится в ESM-экспорты `.mjs`, совпадает с `.d.cts` | No error |
| REEXPORT_SHIM | `module.exports = require('./x.mjs')` | guard резолвит и парсит ESM-экспорты цели, **без require** | No error |
| UNSUPPORTED_IDIOM | `.cjs` с `module.exports = buildExports()` | guard **фэйл loud** (не тихий pass) | actionable: «обнови guard или форму экспорта» |
| TARGETS_EQUAL | device-report.ts / runtimeArtifacts.ts / platformLabels.ts / RuntimeArtifactsDetails.tsx / TRuntimeTarget === `TARGETS` | guard **зелёный** | No error |
| TARGETS_ROT | в одной из копий добавили/убрали/переименовали цель | guard **фэйл** (set-расхождение с каноном) | actionable: файл + diff |
| SIDE_EFFECT_SAFE | guard исполняется | не читает `NEUROCENTER_RUNTIME_*`/secret-env при импорте (стат-парс) | No error |
| NEW_MODULE_1_6 | 1.6 добавляет `runtime/{limits,archive}.cjs`+`.d.cts` | guard auto-покрывает (walk); drift по их декларациям ловится | фэйл при расхождении |
| REGRESSION | корневой сьют | без деградации против baseline на 160a4003 | фэйл сьюта |

</frozen-after-approval>

## Code Map

**Guard (NEW):**
- `scripts/test/shared-declaration-drift.test.mjs` — **NEW**. ESM, `import { test } from 'node:test'`, `createRequire` (только для канона). Разделы: `declarations↔exports drift`, `no-declaration flag`, `orphan/decl-only/dup-pair`, `TARGETS canon equality`. Walk `services/shared/**`. Стат-парс, fail-loud, явные allowlist'ы. Регистрация: `scripts/workspace/check-tooling-tests.json` (58→59) + `expectedFiles` в `scripts/test/workspace-check-tooling.test.mjs` (58→59); auto-попадает в «Общие контракты» полного плана через `nodeTestFiles` (dir `scripts/test`).

**Подтверждённый drift (исправление — аддитивные декларации):**
- `services/shared/capacity.cjs` (223–234) — `module.exports` (10 имён): `getCapacityStatus, CapacityError, createCapacityGuard(L226), reserveCapacity, recordCapacityQueue, renderCapacityMetrics, validateSnapshot(L230), resources(L231), maxAgeMs(L232), reserveBytes`. `capacity.d.cts` (1–28) declares только 6: `CapacityError, reserveBytes, reserveCapacity, recordCapacityQueue, renderCapacityMetrics, getCapacityStatus`. **4 over-export:** `createCapacityGuard`, `validateSnapshot`, `resources`, `maxAgeMs`. Все реально используются: `resources`/`maxAgeMs` ← `capacity-collector.cjs:4`; `createCapacityGuard` ← `scripts/test/capacity.test.cjs:8,32…`, `scripts/test/skill-packaging-http.test.mjs:534,627`; `validateSnapshot` ← `capacity.test.cjs:104,149,156`, `scripts/production/resources.mjs:41`. **FIX:** дописать в `capacity.d.cts` `export function createCapacityGuard(...)`, `export function validateSnapshot(...)`, `export const resources: readonly TCapacityResource[];`, `export const maxAgeMs: number;` (`TCapacityResource` уже есть, d.cts:1). `module.exports` не менять.
- `services/shared/github-release-source.cjs` (183) — `module.exports = { validateReleaseInput, resolveGithubRelease }`. `github-release-source.d.cts` (1–32) declares `validateReleaseInput` + interfaces (`IRepositoryRelease`, `IReleaseAsset`, `IReleaseInspection`, `TReleaseInspector`). **1 over-export:** `resolveGithubRelease` (async, L96; используется `repository-source.cjs:433`). **FIX:** дописать `export function resolveGithubRelease(request: …): Promise<…>;` (базовая форма: async-функция; сигнатура по L96-параметрам `{source, parsed, repository, base, githubJson, fetcher, inspectAsset}`; return — результат разрешения, можно новая interface/расширить `IReleaseInspection`). `module.exports` не менять.

**`.cjs` без декларации (6) → 5 дописать + 1 allowlist:**
- `services/shared/chat-document-worker.cjs` — worker, 0 экспортов, **бросает при импорте** («Cannot read properties of null») → `NO_DECL_ALLOWLIST`.
- `services/shared/archive-source.cjs` (43) — `module.exports = { validateArchiveSource }` → **NEW** `archive-source.d.cts`. (consumer: `scripts/catalog-plugins/{archive-source,source-adapters}.mjs` — ESM default-import, `.d.cts` для tsc инертен.)
- `services/shared/bridge-update-lock.cjs` (276) — `{ withInstallMutex, recoverCleanupLock }` → **NEW** `.d.cts`. (consumer: `bridge-update-cleanup.cjs:8`.)
- `services/shared/capacity-collector.cjs` (111) — `{ collectCapacity, publishCapacity }` → **NEW** `.d.cts`.
- `services/shared/package-build-loader.cjs` (4) — `{ loadBuildInspector: (filename) => import(...) }` → **NEW** `.d.cts` (arrow-функция).
- `services/shared/runtime.cjs` (190) — `{ loadSecrets, validateProduction, httpsUrl }`; **15 env при импорте** (secret-file paths, `NEUROCENTER_SERVICE`, `NODE_ENV`) → **NEW** `.d.cts` (guard парсит статически, НЕ требует модуль).
- Ни один из 5 не импортируется `.ts`/`.tsx` (только `.mjs`) → новые `.d.cts` **инертны для tsc**, риск ≈ 0 (guard проверяет только наличие имён).

**Declaration-only / duplicate-pair (allowlist, без runtime-модуля-партнёра нужной формы):**
- `services/shared/gguf-import.d.ts` — **declaration-only** (5 interfaces: `IGgufMetadata`, `IGgufFileImport`, `IGgufImportIntent`, `IGgufImportReceipt`, `IGgufImportAccept`; `import type { IGgufImportPolicy } from './gguf-import-policy.cjs'`; нет `gguf-import.cjs`) → `DECL_ONLY_ALLOWLIST`.
- `services/shared/skill-source.{cjs,d.cts,d.mts,mjs}` — **dual-format**: `skill-source.cjs:2 = require('./skill-source.mjs')` (CJS shim→ESM); `skill-source.d.cts` (CJS-сторона, declares `parseSkillSource, skillSourceEntrypoints, validateSkillLinks`), `skill-source.d.mts` (ESM-сторона, те же 3) → **DUP_PAIR**. Guard: shim резолвится в ESM-экспорты `skill-source.mjs` (стат-парс `export function/const`), сверяется с `skill-source.d.cts`; обе декларации «paired» (`.d.cts`↔`.cjs`, `.d.mts`↔`.mjs`) → орфана нет.
- `services/shared/test-coverage.{mjs,d.mts}` — ESM-модуль + декларация (парный, вне основного `.cjs`-охвата; guard не флагает).

**Канон TARGETS (AD-7) + «вторые списки» (equality-check):**
- **КАНОН:** `services/shared/runtime/targets.cjs:3–12` — `TARGETS` (8: `darwin-arm64, darwin-x64, linux-arm64-glibc, linux-x64-glibc, linux-arm64-musl, linux-x64-musl, win32-arm64, win32-x64`). `require` через `createRequire` (чистый импорт). Таблицы `WINDOWS_TARGET_BY_CANONICAL`/`CANONICAL_TARGET_BY_WINDOWS`/`PACKAGE_TARGET_BY_CANONICAL`/`CANONICAL_TARGET_BY_PACKAGE` + `toWindowsTarget/toCanonicalTarget/toPackageTarget`.
- **Standalone-копии канона (8) — equality vs `TARGETS` (source-scan строковых литералов в якорной области):**
  1. `services/catalog-service/src/devices/device-report.ts:92–101` — хардкод-массив 8 в `![…].includes(report.runtimeArtifactTarget)`.
  2. `frontend/src/features/McpBridge/runtimeArtifacts.ts:5–14` — `export const artifactTargets = [ …8… ] as const;`
  3. `frontend/src/modules/Store/packaging/platformLabels.ts:1–10` — `packagingPlatformLabels: Record<…> = { …8 ключей… }`.
  4. `frontend/src/modules/Store/installPlans/RuntimeArtifactsDetails.tsx:10–19` — `platformLabels: Record<…> = { …8 ключей… }`.
  5. `services/shared/tool-runtime-source.d.cts:5–10` — `export type TRuntimeTarget = '…' | …8…;` (type-level копия).
- **Производные / другое пространство имён (НЕ `=== TARGETS`; consistency-заметки, не equality-фэйл):**
  - `services/shared/opencode-cli-install.cjs:7` — `TARGETS = Object.keys(CANONICAL_TARGET_BY_PACKAGE)` (6 package-имён, derived) = `OPENCODE_CLI_INSTALL_TARGETS`.
  - `services/shared/opencode-rag-source.cjs:11` — `supportedTargets = TARGETS.filter(≠'darwin-x64')` (7, derived).
  - `scripts/prepare-bridge-runtimes.mjs:19–28` — `supported` (8 bridge-имён: package-linux + `windows-*`) → после 1.6 должно `=== BRIDGE_TARGETS`/`toBridgeTarget(TARGETS)`. **Подтвердить по коммиту 1.6.**
  - (1.6) `BRIDGE_TARGETS`/`toBridgeTarget`/`BRIDGE_TARGET_BY_CANONICAL` в `targets.cjs` — 8 bridge-имён. **Подтвердить по коммиту 1.6** (add consistency: `new Set(BRIDGE_TARGETS) === new Set(TARGETS.map(toBridgeTarget))`).
  - **EXCLUDED** (другое пространство/вендор/семантика): `scripts/opencode-platforms.mjs:3` `opencodeVariants` (11, `-baseline`); `scripts/catalog-plugins/python-runtime.mjs:33–39` (glibc-only hostTarget); `vendor/asset-contract/lib/asset.mjs:7` + `index.d.ts:3` (вендор, AD-15); `scripts/catalog-plugins/recipes/{verify-artifacts,opencode-snip,upstream}.mjs` (карты build-имён/загрузок, derived).

**Регистрация / инфраструктура:**
- `scripts/workspace/check-tooling-tests.json` — 58→59 записей (union+sort), добавить `scripts/test/shared-declaration-drift.test.mjs`. Regex валидации `^scripts\/(?:test|agent-kit\/test)\/[a-z0-9-]+\.test\.mjs$` (check-plan.mjs:124) — имя соответствует.
- `scripts/test/workspace-check-tooling.test.mjs:16–75` — `expectedFiles` 58→59 (добавить ту же запись, `.sort()`).
- `scripts/workspace/check-plan.mjs:67–87` `nodeTestFiles` — auto-покрытие `scripts/test` (guard исполняется и в «Общих контрактах» полного плана, и в `--tooling`).

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/test/shared-declaration-drift.test.mjs` (NEW) — guard: стат-парс `module.exports` (.cjs) + `export` (.d.cts/.d.ts/.d.mts); walk `services/shared/**`; разделы (1) drift деклараций↔экспортов (двунаправленное наличие имён + базовая форма + type-only гигиена, fail-loud на не-поддерживаемую форму), (2) no-declaration flag + `NO_DECL_ALLOWLIST`, (3) orphan/decl-only/dup-pair + `DECL_ONLY_ALLOWLIST`/`DUP_PAIR_ALLOWLIST`, (4) **отдельный** TARGETS canon equality (require канон + source-scan 5 копий). `createRequire` только для `runtime/targets.cjs`.
- [ ] `capacity.d.cts` — +4 декларации: `createCapacityGuard`, `validateSnapshot`, `resources: readonly TCapacityResource[]`, `maxAgeMs: number` (базовая форма по capacity.cjs; `module.exports` не трогать).
- [ ] `github-release-source.d.cts` — +1 декларация: `resolveGithubRelease` (async-функция, сигнатура по L96; `module.exports` не трогать).
- [ ] NEW `.d.cts` × 5: `archive-source.d.cts` (`validateArchiveSource`), `bridge-update-lock.d.cts` (`withInstallMutex`, `recoverCleanupLock`), `capacity-collector.d.cts` (`collectCapacity`, `publishCapacity`), `package-build-loader.d.cts` (`loadBuildInspector`), `runtime.d.cts` (`loadSecrets`, `validateProduction`, `httpsUrl`) — имя экспорта точное (для guard), типы best-effort (tsc-инертен).
- [ ] Allowlist'ы в коде guard'а: `NO_DECL_ALLOWLIST = [chat-document-worker.cjs]`, `DECL_ONLY_ALLOWLIST = [gguf-import.d.ts]`, `DUP_PAIR_ALLOWLIST = [skill-source]`, `TARGETS_COPIES` (5 якорей).
- [ ] Регистрация: `check-tooling-tests.json` (58→59) + `expectedFiles` (58→59).
- [ ] (после 1.6) включить в coverage: `runtime/{limits,archive}.cjs`+`.d.cts` (auto через walk), consistency `BRIDGE_TARGETS` vs `toBridgeTarget(TARGETS)` — подтвердить имена/декларации по коммиту 1.6.

**Acceptance Criteria:**
- Given baseline 160a4003 (до фиксов), when guard, then **фэйл** на capacity.cjs (4) + github-release-source.cjs (1) + 5 no-decl — воспроизводит реальный drift.
- Given фиксы (декларации), when guard, then **зелёный**: декларации соответствуют экспортам; no-decl закрты декларациями/allowlist; allowlist'ы явные.
- Given искусственная разбитая декларация (убрать имя из `.d.cts` / добавить phantom / переименовать цель в копии), when guard, then **фэйл сьюта** с actionable-сообщением.
- Given TARGETS-копии, when equality-check, then все 5 === канону; equality-check зелёный.
- Given корневой сьют, when полный `check.mjs`, then без деградации против baseline (160a4003).

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **Стратегия — статический parse (НЕ require .cjs). Обоснование по фактам (прогон import-probe, 80 `.cjs`):** (1) **декларации — TS**, их нельзя `require` → парсим статически в любом случае; (2) **10 из 80 `.cjs` читают env при импорте** — 9 читают 4 `NEUROCENTER_RUNTIME_MAX_*`/`CACHE_BYTES` (через `runtime-artifacts.cjs` LIMITS-снимок: archive-source, github-release-source, opencode-rag-source, package-build-plan, python-source-plan, repository-source, runtime-artifacts, source-candidates, tool-runtime-source), и **`runtime.cjs` читает 15 env** (secret-file paths `CHAT_S3_*`, `SNAPSHOT_*`, токены, `CATALOG_PG_URL_FILE`, `RAG_PG_URL_FILE`, `NEUROCENTER_SERVICE`, `NODE_ENV`) — require-based guard связал бы тест с окружением и прикоснулся бы к secret-config при импорте; **именно поэтому 1.6 делает `runtime/limits.cjs` ленивым**; (3) **2 из 80 бросают при импорте** — `chat-document-worker.cjs` (worker делает работу при импорте → «Cannot read properties of null»), `skill-source.cjs` (CJS `require` ESM shim — невалидно до Node 22) — require-based guard упал бы; (4) **все 74 non-shim `.cjs` используют унифицированный `module.exports = { … }`** → стат-парс надёжен (прогон sweep: 72 чистые пары, 2 реальных drift, **0 ложных срабатываний**). (5) **fail-loud**: не-поддерживаемая форма экспорта → явный фэйл (не тихий pass), чтобы смена стиля не ослабила guard'а. (6) shim `skill-source.cjs` → резолв + стат-парс ESM-экспортов `.mjs` (без require).
- **Базовая форма (ticket: «наличие имён и базовая форма»):** твёрдое ядро = **двунаправленное наличие имён** (value-экспорты `.cjs` ↔ value-декларации `.d.cts`) + **type-only гигиена** (`type`/`interface` не должны быть runtime-экспортом). Дополнительно — консервативный стат-кросс-чек формы: `export class X` в `.d.cts` ⇒ `class X` в `.cjs`; `export function X` ⇒ `X` callable в `.cjs` (не `const X = {…}`-объект). Форм-чек best-effort/separable (при false-positive понижается до warn); **гарантированное ядро = наличие имён** (реальные drift'ы capacity/github-release-source — именно name-presence).
- **Почему drift-фикс аддитивный (декларации), а не de-export:** все 5 over-экспортов реально используются (см. Code Map) — de-export сломал бы `capacity.test.cjs`, `skill-packaging-http.test.mjs`, `scripts/production/resources.mjs`, `repository-source.cjs`. Декларирование = 0 смены runtime, риск ≈ 0. Подтверждено `gap-inventory-v2.md:79` («реально используются»).
- **Скоуп guard'а — `services/shared/**` только.** `mcp/**/dist/**` = build-копии (flat-copy, AD-10 freshness, `.d.cts` не генерируются) — покрывает `bridge-build-integrity`; `scripts/**/*.cjs` = test/tool (не «декларируемые модули»); `vendor/**` = AD-15. Guard по каталогу **динамический** → 1.6-модули подпадают автоматически.
- **No-declaration default = дописать 5 `.d.cts`** (не allowlist): allowlist в тикете мал и специфичен (worker/decl-only/dup-pair); 5 — полноценные shared-модули с реальными экспортами, не импортируются `.ts`/`.tsx` → tsc-инертен, риск ≈ 0. Альтернатива — allowlist (см. Q1).
- **TARGETS equality = source-scan + require канона.** Канон `TARGETS` берётся `require` (чистый). Копии (device-report.ts, runtimeArtifacts.ts, 2 label-карты, `TRuntimeTarget` union) — source-scan строковых литералов target-name формы `^[a-z]+-[a-z0-9]+(-[a-z0-9]+)+$` в якорной области, **set-equality** с каноном → ловит add/remove/rename. Якоря фиксированы в `TARGETS_COPIES`. Это та же техника source-scan, что `runtime-canonical-uniqueness.test.ts` из 1.6.
- **Один коммит (risk=low):** guard + 2 drift-фикса + 5 деклараций + allowlist'ы + регистрация. Всё аддитивное/механическое; корневой сьют без деградации.

## Verification

**Commands:** (Node 24 обязателен; `check.mjs` резолвит сам; системный node v16 не использовать; точечные `node --test` — node 24 из `NODE_BIN`/`.run/toolchains`)

**До коммита (baseline):**
- `node scripts/workspace/check.mjs` (или «Общие контракты») — снять счётчики pass/fail/skipped на 160a4003, зафиксировать в PR.

**Точечно:**
- `node --test scripts/test/shared-declaration-drift.test.mjs` — expected: **зелёный** (drift-фиксы + 5 деклараций + TARGETS equality).
- Отрицательные прогонки (локально, перед коммитом, вернуть назад): удалить имя из `capacity.d.cts` → фэйл; добавить phantom-имя → фэйл; переименовать цель в `device-report.ts` → фэйл; убрать `.d.cts` у `capacity.cjs` → фэйл (no-decl); `module.exports = buildExports()` → фэйл loud.
- `node --test scripts/test/workspace-check-tooling.test.mjs` — expected: зелёный (expectedFiles 59, fixture стабы).
- `node --test scripts/catalog-plugins/test/prepared-source-snapshot.test.mjs` — expected: closure зелёный (новые `.d.cts` не нарушают).

**Полно:**
- `node scripts/workspace/check.mjs --tooling` — expected: зелёный (guard в фиксированном наборе).
- `node scripts/workspace/check.mjs` — expected: полный план зелёный; корневой сьют **без деградации** против baseline (160a4003).
- `npm run lint:root && npm run format:root:check` — expected: 0 ошибок.
- catalog-service + api-gateway: typecheck/build/test — expected: зелёно (новые `.d.cts` tsc-инертен; `device-report.ts` не тронут).
- frontend: `npm --prefix frontend run build` + `test` — expected: зелёно (копии TARGETS не тронуты — guard только читает).

**Чек-лист регрессии (risk=low, прогнать до мержа):**
1. Guard зелёный: drift-фиксы (capacity +4, github-release-source +1) + 5 no-decl закрыты.
2. Искусственная разбитая декларация → фэйл сьюта (3+ сценария из Verification).
3. TARGETS equality: 5 копий === канону; переименование в копии → фэйл.
4. Guard не читает `NEUROCENTER_RUNTIME_*`/secret-env при запуске (стат-парс; проверочно — запуск с очищенным env).
5. check-tooling-tests.json = 59, expectedFiles = 59, `--tooling` зелёный.
6. Корневой сьют без деградации против baseline (160a4003).
7. Лint/format 0.

## Open Questions

- **Q1 (no-declaration: декларировать vs allowlist).** Default (Tasks) = **дописать 5 `.d.cts`** (завершает инвариант «каждый `.cjs` имеет декларацию», tsc-инертен, риск ≈ 0). Альтернатива: 5 в `NO_DECL_ALLOWLIST` (guard зелёный без новых файлов, но allowlist растёт до 6 и ослабляет конвенцию). **Рекомендация: декларировать (default).**
- **Q2 (базовая форма: твёрдый vs warn).** Форм-чек (class/function vs const-object) как **твёрдый консервативный** (default) vs **warn-only**. **Рекомендация: твёрдый, но separable** (при false-positive — warn); ядро (наличие имён) всегда твёрдое.
- **Q3 (scope TARGETS equality: label-карты и TRuntimeTarget).** Включать 4 frontend-копии (runtimeArtifacts, platformLabels, RuntimeArtifactsDetails) + `TRuntimeTarget` union (default, всё standalone-8) vs только device-report.ts + runtimeArtifacts.ts (min). **Рекомендация: все 5** (полная защита канона; source-scan якорей).
- **Q4 (prepare-bridge-runtimes + BRIDGE_TARGETS).** equality vs `BRIDGE_TARGETS`/`toBridgeTarget` — **после 1.6** (BRIDGE_TARGETS ещё не в каноне на 160a4003). **Рекомендация:** в этом тикете — только 5 канонических копий; consistency `BRIDGE_TARGETS` добавить в follow-up-задачу по коммиту 1.6 (указано в Tasks).
- **Q5 (baseline).** Снять счётчики корневого сьюта на **160a4003** до коммита (1.6 в работе — числа сменит). **Рекомендация:** прогнать на 160a4003, зафиксировать в PR.
- **Q6 (регистрация guard'а).** Guard в `scripts/test/*.test.mjs` → auto-попадает и в «Общие контракты» (полный план, `nodeTestFiles`), и в `--tooling` (фиксированный набор). **Рекомендация:** одна регистрация в `check-tooling-tests.json` + `expectedFiles`; двойное исполнение в разных инвокциях приемлемо (идемпотентно).
