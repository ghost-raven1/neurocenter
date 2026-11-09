---
title: 'Shared-сплит: limits + archive + switch детекций (AD-7, entry 6)'
type: 'refactor'
ticket: '6'
created: '2026-11-06'
status: done
baseline_revision: 'a946a7b2718bd57ad8e747b27866f127690dd022'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md
  - _bmad-output/initiative-architecture/tickets/epic-release-baseline/epic-release-baseline.md
  - _bmad-output/initiative-architecture/tickets/epic-release-baseline/tickets/story-shared-split-targets-facade-ad-7-plan.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `services/shared/runtime-artifacts.cjs` после entry 5 (1.5, 552fb2c6) всё ещё несёт (а) **жадный env-снимок** `LIMITS` при импорте (`runtime-artifacts.cjs:29-31` — `for (…) LIMITS[key] = limitValue(name, …)` читает `process.env` на этапе `require`) и (б) **весь USTAR-парсер** `inspectRuntimeArchive` (`runtime-artifacts.cjs:80-251`) с захватом глобального `LIMITS` (L136, L165). Параллельно логика детекции цели хоста продублирована в **25 локациях**: 4 сильные копии (строгой regex glibc + `sharedObjects`-проверка musl), 17 слабых bridge-копий (`!glibc⇒musl`, прямой `getReport().header` без try/catch, «тихая» подстановка чужого артефакта при неизвестной libc и падение при сбое `getReport()`), 1 спецкопия (glibc-only сборщик Python), 3 frontend-конверсии (regex `win32→windows`/`-glibc`-срез + слабое `platform-arch`).

**Approach:** канон в `services/shared/runtime/`: **`limits.cjs`** — ленивый `getLimits()` (env НЕ читается при импорте, результат `Object.freeze`, те же 4 env-имени/дефолты/валидация) и **`archive.cjs`** — USTAR-парсер дословно из `runtime-artifacts.cjs:80-251`, но **лимиты — обязательный параметр** (парсер = чистая функция от `(file, descriptor, limits)`). Фасад `runtime-artifacts.cjs` становится identity-реэкспортом (поверхность экспортов и сигнатуры ~56 call-site инвариантны; единственный тонкий wrapper — `inspectRuntimeArchive`, который подставляет `limits: getLimits()`). В `runtime/targets.cjs` появляется канон bridge-имён `BRIDGE_TARGET_BY_CANONICAL`/`toBridgeTarget()` (unix→package-имя, win32→windows-имя) + `BRIDGE_TARGETS`. **Все 25 детекций переключаются на канон**: сильные → `getHostTarget({mode})`, слабые bridge → `toBridgeTarget(getHostTarget({mode:'throw'}))`, frontend → `@neurocenter/runtime-targets` + `toBridgeTarget`/`BRIDGE_TARGETS`. **Всё — одним коммитом**: смена семантики лимитов (жадно→лениво) и switch детекций атомарны, в одном бинарии две семантики не допускаются. Канонический тест «нет второго getHostTarget / второго списка TARGETS» замыкает switch.

## Boundaries & Constraints

**Always:**
- Поверхность экспортов фасада инвариантна: `TARGETS, LIMIT_DEFAULTS, LIMITS, portablePath, normalizeRuntimeArtifacts, validateRuntimeArtifactEntrypoints, inspectRuntimeArchive` (те же имена и сигнатуры). Identity-реэкспорт там, где возможно; тонкий wrapper — только `inspectRuntimeArchive` (подставляет `limits: getLimits()`, сигнатура для потребителей не меняется).
- `limits.cjs` не читает `process.env` при импорте. `getLimits()` возвращает **свежий** `Object.freeze({compressedBytes, unpackedBytes, filesCount, cacheBytes})` на каждый вызов; те же 4 env-имени (`NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES/_UNPACKED_BYTES/_MAX_FILES`, `NEUROCENTER_RUNTIME_CACHE_BYTES`), те же дефолты (256 МиБ / 1 ГиБ / 20000 / 2 ГиБ) и та же валидация (`/^[1-9][0-9]*$/`, `Number.isSafeInteger`).
- `archive.cjs` = USTAR-парсер дословно (`text`/`octal` + `inspectRuntimeArchive`), но `limits` — **обязательный параметр** (заменяет глобальный `LIMITS` на L136/L165). Новые тар-функции (PAX/ссылки/устройства) — нет.
- Новые shared-модули не пишут в `process.env` и не валидируют при импорте (загрузка секретов — config-модуль сервиса).
- Каждый relative-импорт файла из `PREPARED_SOURCE_INPUTS` сам входит в него (closure-тест автоматически ловит новый `require`).
- Канонический тест уникальности: второй `getHostTarget`/второй канонический список из 8 целей вне `runtime/{host-target,targets}.cjs` — нет (source-scan).

**Never:**
- Не менять плоский путь и публичную сигнатуру `services/shared/runtime-artifacts.cjs`; не менять значения `LIMIT_DEFAULTS` и 4 env-имени.
- Не менять `OPENCODE_CLI_INSTALL_TARGETS` (6 package-имён, `opencode-cli-install.cjs:7`) и поведение `openCodeInstallRuntimeTarget`.
- Не сливать в `archive.cjs` **другие** тар-ридеры (`services/catalog-service/src/asset-sources/source-archive-reader-tar.ts` / `source-archive-reader-zip.ts` / `scripts/catalog-plugins/python-trusted-archive.mjs`) — другая цель и модель лимитов (инжест asset-source / Python wheel).
- Не трогать `vendor/asset-contract/lib/{asset.mjs:7, native-delivery.mjs:70}` и `index.d.ts:3` (вендор, AD-15) и `scripts/opencode-platforms.mjs` `opencodeVariants` (11 opencode-вариантов с `-baseline` — другое пространство имён).
- Не расширять фасадную поверхность новыми API (новые канон — в `runtime/`, потребители entry 6 импортируют их напрямую).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LAZY_LIMITS_IMPORT | `require('runtime/limits.cjs')`, env пуст | env НЕ читается при импорте; `getLimits()` = замороженные дефолты | No error |
| LAZY_LIMITS_ENV | `NEUROCENTER_RUNTIME_MAX_FILES=5`, 2×`getLimits()` | оба вызова → 5 (env читается на каждый call, не при import) | No error |
| LAZY_LIMITS_BAD | `NEUROCENTER_RUNTIME_MAX_FILES=0/-1/abc` | `getLimits()` бросает (те же сообщения, что сейчас) | actionable |
| LAZY_LIMITS_FREEZE | `getLimits()` | `Object.isFrozen === true`; мутация падает в strict | No error |
| ARCHIVE_LIMITS_PARAM | `archive.cjs inspectRuntimeArchive(file, desc, {limits})` | использует `limits.unpackedBytes/filesCount`; без `limits` — бросает | throw |
| ARCHIVE_OVER_LIMIT | валидный USTAR, `limits.filesCount` меньше, чем в desc | «Архив превышает одобренный…» (как сейчас) | throw |
| FACADE_INSPECT_WRAP | фасад `inspectRuntimeArchive(file, desc, {destination, signal})` | подставляет `getLimits()`; поведение byte-идентично baseline; consumers без изменений | No error |
| FACADE_LIMITS_BACKCOMPAT | `ticket.ts:126,130,132`, `cache.ts:80`, `runtime-artifact-download.ts:29` читают `LIMITS.X` | работает (ленивый accessor), env при импорте не читается | No error |
| NORMALIZE_LAZY | `normalizeRuntimeArtifacts([…])` | читает `getLimits()` на момент вызова (L63); accept/reject как сейчас | throw как сейчас |
| STRONG_SWITCH | 4 сильные копии → `getHostTarget({mode})` | идентичные результаты (throw/unknown по сайту сохранены) | как сейчас |
| WEAK_SWITCH_GLIBC | glibc-host → `toBridgeTarget(getHostTarget({mode:'throw'}))` | `linux-x64` (как было) | No error |
| WEAK_SWITCH_MUSL | musl-host (ld-musl в sharedObjects) | `linux-x64-musl` (как было) | No error |
| WEAK_UNKNOWN_THROW | linux, неизвестная libc, bridge build/install | **throw** (было тихое `linux-x64`/`linux-x64-musl`) | «тихая установка чужого артефакта запрещена» |
| GETREPORT_GUARD | `getReport()` бросает | канон try/catch → unknown → throw(`throw`)/`base-unknown`(`unknown`) | не падает unhandled |
| FRONTEND_CANONICAL | `bridgeArchive.ts:19`/`bridgeInstallerConfig.ts:15`/`bridgeSource.ts:85` | `BRIDGE_TARGETS` membership / `toBridgeTarget(target)` | throw/undefined как сейчас |
| NO_SECOND_DETECTION | source-scan теста | вне allowlist нет idiom `getReport().header.glibcVersionRuntime` (прямой) и блока `glibcVersionRuntime`+`sharedObjects`+strict-regex | тест-фэйл |
| NO_SECOND_TARGETS | source-scan теста | standalone-массив из 8 канон. целей только в `runtime/targets.cjs`; `device-report.ts`/`frontend runtimeArtifacts.ts` импортируют | тест-фэйл |
| BRIDGE_BUILD | `npm --prefix mcp/neurocenter-asset-sync run build` | `dist/shared/runtime/{limits,archive}.cjs` на месте; buildId пересчитан; `verifyBridgeBuild` зелёный | No error |
| CLOSURE | `PREPARED_SOURCE_INPUTS` = 178 | ≤ cap 180; pin-каскад свежий | stale = фэйл |
| REGRESSION | корневой сьют | без деградации против baseline, снятого на a946a7b2 | фэйл сьюта |

</frozen-after-approval>

## Code Map

**Новые канонические модули (AD-7 entry 6):**
- `services/shared/runtime/limits.cjs` + `limits.d.cts` — **NEW**. `LIMIT_DEFAULTS` (Object.freeze, 4 значения как `runtime-artifacts.cjs:9-14`), `LIMIT_ENV` (private), `limitValue` (private), `getLimits()` (ленивый, per-call env + `Object.freeze`). Никакого env при импорте.
- `services/shared/runtime/archive.cjs` + `archive.d.cts` — **NEW**. `text`/`octal`/`inspectRuntimeArchive` дословно из `runtime-artifacts.cjs:80-251`; `limits` — обязательный параметр (L136→`limits.unpackedBytes+limits.filesCount*1536+1024*1024`, L165→`limits.filesCount*2`). Реquires только `./portable-path.cjs`.
- `services/shared/runtime/targets.cjs` (+ `targets.d.cts`) — **ADD**. `BRIDGE_TARGET_BY_CANONICAL` (Object.freeze; darwin→darwin, linux-*-glibc→linux-*, linux-*-musl→linux-*-musl, win32-*→windows-*), `toBridgeTarget(canonical)`, `BRIDGE_TARGETS` (Object.freeze, 8 bridge-имён = `Object.values`).
- `services/shared/runtime-artifacts.cjs` (260 строк) — фасад: L7-8 уже реэкспорт targets/portablePath (entry 5); **L9-28** (LIMIT_DEFAULTS/LIMIT_ENV/limitValue) → уходят в limits.cjs; **L29-31** жадный `LIMITS`-снимок → заменяется ленивым back-compat `LIMITS` (accessor-объект, delegates к `getLimits()`); **L32-71** `normalizeRuntimeArtifacts` остаётся (L63 `LIMITS`→`getLimits()` на вызове); **L72-79** `validateRuntimeArtifactEntrypoints` остаётся; **L80-251** (text/octal/inspectRuntimeArchive) → уходит в archive.cjs; фасадный `inspectRuntimeArchive` = тонкий wrapper: `normalizeRuntimeArtifacts([descriptor])` + `archiveInspect(file, descriptor, {destination, signal, limits: getLimits()})`. **L252-260** exports — поверхность без изменений.
- `services/shared/runtime-artifacts.d.cts` — поверхность без изменений; doc-коммент L18-19 у `LIMITS` обновить под ленивую семантику.

**Сильные копии детекции (→ тонкий `getHostTarget({mode})`):**
- `services/api-gateway/src/features/mcp-host/host-target.ts:11-40` — `hostRuntimeTarget()` (mode=throw, local `assertTarget` L3-8, local `TARGETS` import L1) → `getHostTarget({mode:'throw'})`.
- `services/catalog-service/src/devices/runtime-host-target.ts:2-31` — `runtimeArtifactTarget()` (mode=unknown) → `getHostTarget({mode:'unknown'})`.
- `mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts:26-61` — `runtimeArtifactTarget(platform, arch, suppliedReport)` (injectable, mode=unknown) → `getHostTarget({platform, arch, report: suppliedReport, mode:'unknown'})`; injectable-сигнатура сохраняется для тестов.
- `scripts/catalog-plugins/verify-runtime.mjs:76-100` — `hostTarget()` (mode=throw, local `assertHostTarget` L70-74) → `getHostTarget({mode:'throw'})` (файл уже импортирует фасад `runtime` L9).

**Слабые bridge-копии, install-detection (`!glibc⇒musl`, прямой `getReport().header`, часто без try/catch; → `toBridgeTarget(getHostTarget({mode:'throw'}))`):**
- `scripts/prepare-bridge-runtimes.mjs:29-31` — `host` (L221 `opencodePackageName(…, libc==='musl')` — вывести `musl` из канона).
- `scripts/package-bridge-runtime.mjs:27-31` — `target` (L28 arch-guard).
- `scripts/bridge-runtime-probe.mjs:17` — `musl` → `probeArchiveName`/`opencodePackageName` (`scripts/opencode-platforms.mjs:19`).
- `scripts/workspace/dev-bridge-install.mjs:47` — target.
- `scripts/workspace/dev-bridge-runtime.mjs:10-12` — `musl`-флаг (L87 `target.endsWith('-musl')`).
- `services/api-gateway/src/bridge/dev-bridge-runtime.ts:29-40` — `hostTarget()` (platform-map + arch-guard L30-34; используется в `pointer()` L118).
- Тесты/фикстуры: `scripts/test/bridge-dev-supply-gateway.test.cjs:16-19`, `bridge-config-gateway.test.cjs:18`, `package-runtime-verification.test.mjs:20` (вариант ternary `glibc?'glibc':'musl'`), `package-probe-engine.test.mjs:17`, `bridge-native-installer.mjs:21`, `bridge-runtime-sdk.test.mjs:18`, `bridge-dev-abort-race.test.cjs:21`, `bridge-download-gateway.test.cjs:53`, `bridge-runtime-smoke.mjs:21`, `bridge-installer-lifecycle.fixture.mjs:19`, `dev-bridge-install.fixture.mjs:21`.

**Слабые (диагностика/специальные — решить по Design Notes):**
- `scripts/test/production-runtime-artifact.fixture.mjs:47` — probe в spawned-child, assert `^linux-(arm64|x64)-(glibc|musl)$` (принимает оба) → вычислять через канон, ассерт-диапазон сохранить.
- `scripts/catalog-plugins/python-runtime.mjs:32-41` — `hostTarget()` glibc-only (darwin-arm64 | linux-x64-glibc, иначе throw) → **ОСТАВИТЬ** (другая семантика сборщика, не install-detection).

**Frontend-конверсии (→ `@neurocenter/runtime-targets`):**
- `frontend/src/features/McpBridge/bridgeSource.ts:83-88` — `bridgeDeviceTarget()`: L85 `replace(/^win32-/,'windows-').replace(/-glibc$/,'')` → `toBridgeTarget(target)`; L87 слабое `${win32?windows:platform}-${arch}` → канон (display-fallback).
- `frontend/src/features/McpBridge/bridgeArchive.ts:19` — `targetPattern` regex → membership в `BRIDGE_TARGETS`.
- `frontend/src/features/McpBridge/bridgeInstallerConfig.ts:15` — `target` regex → membership в `BRIDGE_TARGETS`.
- `frontend/vite.config.ts:53-68` — **ADD** alias `@neurocenter/runtime-targets` → `services/shared/runtime/targets.cjs` + запись в `optimizeDeps.exclude`.

**«Второй список TARGETS» (в-репо дубликаты канонических 8 → импортировать):**
- `services/catalog-service/src/devices/device-report.ts:90-103` — standalone-массив 8 целей для валидации `report.runtimeArtifactTarget` → `TARGETS.includes(...)` (catalog-service уже импортирует `TARGETS` из shared: `package-build/npm-source.ts:3`, `package-build/package-build.model.ts:11`).
- `frontend/src/features/McpBridge/runtimeArtifacts.ts:5-14` — `artifactTargets` (as const, TS-тип `(typeof artifactTargets)[number]`) → импортировать; тип — см. Design Notes (open detail).

**Регистр / closure / pin / flat-copy (infra):**
- `mcp/neurocenter-asset-sync/scripts/runtime-shared-files.mjs:2-31` — **ADD** `runtime/limits.cjs`, `runtime/archive.cjs` (в `BRIDGE_SHARED_RUNTIME_FILES`).
- `mcp/neurocenter-asset-sync/scripts/build.mjs:27-32` — копит список в `dist/shared/` (mkdir родителя уже L30; buildId = рекурсивный digest, подпапки учитываются).
- `scripts/catalog-plugins/prepared-source-snapshot.mjs:142-144` — **ADD** `services/shared/runtime/{limits,archive}.{cjs,d.cts}` (174→178 ≤ MAX 180; cap поднят в entry 5, комментарий L9).
- `scripts/assets/catalog-source-pin.mjs` — пересчитать pin-каскад (`catalog-source/producer.json` → `catalog-source/manifest.json` → `services/shared/bundled-catalog.lock.json`) `--write`/`--check`.
- `services/catalog-service/Dockerfile` (`COPY services/shared/ /tools/services/shared/`) — подпапку `runtime/` покрывает автоматически (как в entry 5).
- Flat-copy фикстуры (entry 5): `mcp/neurocenter-asset-sync/integration/test/bridge-cli-profile.fixture.ts:57-63`, `scripts/test/bridge-build.test.mjs:29-33` (fixture) / `:80-84` (byte-equality), `scripts/test/bridge-installer-lifecycle.fixture.mjs:146-172` — копировать подпапку `runtime/` с новыми файлами.

**Новые тесты (корневой node-сьют, `services/shared/tests/`):**
- `runtime-limits.test.ts` — ленивость `getLimits()` (нет env при импорте; per-call env; дефолты; regex-валидация; `Object.freeze`).
- `runtime-archive.test.ts` — archive.cjs с лимитами-параметром (валидный USTAR round-trip; limits-параметр обязателен; oversize → throw).
- `runtime-bridge-target.test.ts` — `toBridgeTarget` (8 канон → 8 bridge-имён), взаимодействие с `toPackageTarget`/`toWindowsTarget`, неизвестное → throw.
- `runtime-canonical-uniqueness.test.ts` — **SOURCE-SCAN**: (a) вне allowlist нет прямого `getReport().header.glibcVersionRuntime`; (b) вне allowlist нет блока `glibcVersionRuntime`+`sharedObjects`+strict-regex `/^\d+\.\d+(?:\.\d+)?$/`; (c) standalone-массив 8 канон. целей только в `runtime/targets.cjs` (+ его тест как данные). Allowlist фиксируется явно.

## Tasks & Acceptance

**Execution:**
- [ ] `services/shared/runtime/limits.cjs` + `limits.d.cts` — `LIMIT_DEFAULTS`/`getLimits()` (лениво, `Object.freeze`, те же env/дефолты/валидация; env НЕ при импорте).
- [ ] `services/shared/runtime/archive.cjs` + `archive.d.cts` — USTAR-парсер дословно, `limits` — обязательный параметр.
- [ ] `services/shared/runtime/targets.cjs` (+`.d.cts`) — `BRIDGE_TARGET_BY_CANONICAL`/`toBridgeTarget`/`BRIDGE_TARGETS`.
- [ ] `services/shared/runtime-artifacts.cjs` — фасад: identity-реэкспорт targets/portablePath/limits(normalize+validate остаются, LIMITS→ленивый accessor); тонкий wrapper `inspectRuntimeArchive` (подставляет `getLimits()`); поверхность экспортов без изменений; doc `runtime-artifacts.d.cts` у `LIMITS` обновить.
- [ ] 4 сильные копии → `getHostTarget({mode})` (api-gateway `host-target.ts`, catalog `runtime-host-target.ts`, bridge `model.ts` injectable, `verify-runtime.mjs`); удалить локальные assertTarget/regex/sharedObjects-блоки.
- [ ] 12 install-слабых bridge (6 скриптов + 6 тест-фикстур) → `toBridgeTarget(getHostTarget({mode:'throw'}))`; `opencodePackageName`/`prepare-opencode` получают `musl` из канона; diagnostic `production-runtime-artifact.fixture.mjs` — через канон, диапазон сохранить.
- [ ] Frontend: alias `@neurocenter/runtime-targets` (+ `optimizeDeps.exclude`); `bridgeSource.ts:85/87`, `bridgeArchive.ts:19`, `bridgeInstallerConfig.ts:15` → `toBridgeTarget`/`BRIDGE_TARGETS`.
- [ ] «Второй TARGETS»: `device-report.ts:90-103` → `TARGETS`; `frontend runtimeArtifacts.ts:5-14` → импортировать (тип — Design Notes).
- [ ] Регистр: `runtime-shared-files.mjs` +`runtime/{limits,archive}.cjs`; `prepared-source-snapshot.mjs` +4 (→178); flat-copy фикстуры; `catalog-source-pin.mjs --write`.
- [ ] Тесты: `runtime-limits.test.ts`, `runtime-archive.test.ts`, `runtime-bridge-target.test.ts`, `runtime-canonical-uniqueness.test.ts`.

**Acceptance Criteria:**
- Given фасад на плоском пути, when импорт из любого из ~56 call-site, then поверхность, значения и сигнатуры идентичны baseline (корневой сьют зелёный, `LIMITS.X` в `ticket.ts`/`cache.ts`/`runtime-artifact-download.ts` без правок).
- Given чистый импорт `runtime/limits.cjs`, when env пуст, then `process.env` не читается при импорте (тест); `getLimits()` — свежие замороженные значения на каждый вызов.
- Given корневой node-сьют, when source-scan уникальности, then второй `getHostTarget`/второй канонический список из 8 целей нигде нет (тест зелёный); слабые `!glibc⇒musl` bridge-копии удалены.
- Given glibc-хост, when bridge build/install, then результат как в baseline; given linux с неизвестной libc, then throw (тихая установка чужого артефакта запрещена).
- Given `PREPARED_SOURCE_INPUTS` = 178, when pin-каскад, then `--check` зелёный (без stale); `dist/shared/runtime/` с `limits`/`archive` на месте, `verifyBridgeBuild` зелёный.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- **ОДИН КОММИТ (risk=high).** Коммит атомарно содержит: (1) `limits.cjs` ленивый `getLimits()` + фасадный ленивый `LIMITS`; (2) `archive.cjs` + фасадный wrapper; (3) switch всех детекций (4 сильные + 12 install-слабых + 3 frontend + 2 «второй TARGETS»); (4) `toBridgeTarget`-канон; (5) регистр/closure/pin/flat-copy; (6) тесты. Частичных коммитов нет. Обоснование: фасад, который всё ещё жадно снимает `LIMITS`, при том что `archive.cjs` читает лимиты-параметром = **две семантики лимитов в одном бинарии**; bridge-скрипт с `!glibc⇒musl` рядом с каноническим = **две семантики детекции**. Тест `runtime-canonical-uniqueness` падает, если хоть одна локация осталась не переключённой → механически принудит атомарность. До коммита снять baseline корневого сьюта на `a946a7b2` (числа из плана 1.5 «287 файлов, 3693 pass / 0 fail / 38 skipped» были на `90b92af`) и зафиксировать в PR.
- **`getLimits()`:** те же 4 env-имени, дефолты (256 МиБ compressed, 1 ГиБ unpacked, 20000 files, 2 ГиБ cache), валидация. Разница — чтение на момент вызова, а не при импорте. Процесс, меняющий env между импортом и использованием, теперь это видит (намеренно).
- **Ленивый back-compat `LIMITS` (facade):** `Object.freeze`-accessor-объект (getters → `getLimits()`), чтобы `ticket.ts:126,130,132`, `cache.ts:80`, `runtime-artifact-download.ts:29` читали `LIMITS.X` **без правок** и **без env при импорте**. Альтернатива — миграция этих 3 потребителей на `getLimits()` (рекомендована как опциональный фоллоу-ап, но не обязательна для приёмки).
- **`archive.cjs` limits-параметр — обязательный** (бросает при отсутствии/невалидном). Фасадный wrapper подставляет `getLimits()`. Это держит проверку «одобренный descriptor ≤ limits» внутри парсера, но отделяет источник лимитов от парсера (парсер = чистая функция).
- **Циклический require исключён:** `archive.cjs` требует только `./portable-path.cjs`; `limits` — параметр, не импорт; `normalizeRuntimeArtifacts` остаётся в фасаде, фасадный `inspectRuntimeArchive` сам делает guard `normalizeRuntimeArtifacts([descriptor])`, а `archive.cjs` парсит «уже нормализованный» descriptor.
- **`toBridgeTarget`:** чистая таблица. win32-*→windows-*, linux-*-glibc→linux-* (срез -glibc), linux-*-musl→linux-*-musl, darwin→darwin. Объединяет все 17 слабых копий + 3 frontend-regex. Bridge-имена (8) = `BRIDGE_TARGETS = Object.values(BRIDGE_TARGET_BY_CANONICAL)`.
- **Unknown-libc для bridge build/install:** `mode:'throw'` → `getHostTarget` бросает → сборка/prepare/install **падает явно**, а не тихо ставит чужой артефакт. CI/dev-хосты glibc → `getReport()` несёт `glibcVersionRuntime` → поведение там неизменно.
- **Frontend:** единственный touch browser-бандла — изолирован (3 файла + alias + `optimizeDeps.exclude`), проверяется frontend vitest (отдельно от корневого node-сьюта). Рекомендация: включить в этот коммит (механически); отложить **только** frontend-тройку, если alias/optimizeDeps окажется flaky — но `toBridgeTarget` остаётся в `targets.cjs`, так что отложенная правка тривиальна (см. Open Q1).
- **`python-runtime.mjs:32-41`** (glibc-only сборщик Python): **ОСТАВИТЬ** — требует именно glibc (darwin-arm64 | linux-x64-glibc), бросает на musl; это не install-detection из «15+». Документировать.
- **Тип frontend `runtimeArtifacts.ts`:** `artifactTargets` сейчас `as const` и даёт literal-union `(typeof artifactTargets)[number]`. `targets.d.cts` экспортирует `TARGETS: readonly string[]` (→ `string`). Варианты: (a) добавить в `targets.d.cts` type-alias `RuntimeTarget` (type-only, низкий риск) и использовать в frontend; (b) оставить `as const` локально, но **значения** выводить из импорта + compile-time assertion; (c) ослабить тип до `string`. Рекомендация: (a). Реализатор выбирает и фиксирует.

## Verification

**Commands:** (Node 24 обязателен; `check.mjs` резолвит сам, для точечных `node --test` — node 24 из `NODE_BIN`/`.run/toolchains`; системный node не использовать)

**До коммита (baseline):**
- `node scripts/workspace/check.mjs` (или шаг «Общие контракты») — снять счётчики pass/fail/skipped на `a946a7b2`, зафиксировать в PR.

**Точечно:**
- `node --test services/shared/tests/runtime-limits.test.ts services/shared/tests/runtime-archive.test.ts services/shared/tests/runtime-bridge-target.test.ts services/shared/tests/runtime-canonical-uniqueness.test.ts` — expected: зелёно (ленивость, limits-параметр, bridge-маппинг, **уникальность**).
- `node --test services/shared/tests/runtime-targets.test.ts services/shared/tests/runtime-host-target.test.ts` — expected: entry-5 тесты зелёны (фасад identity сохранён).
- `node --test scripts/catalog-plugins/test/prepared-source-snapshot.test.mjs scripts/test/bundled-catalog.test.mjs` — expected: closure + pin зелёные (178 ≤ 180, без stale).
- `node --test scripts/test/bridge-build.test.mjs` — expected: flat-copy с подпапкой, buildId, verifyBridgeBuild зелёные.
- `npm --prefix mcp/neurocenter-asset-sync run build` — expected: `dist/shared/runtime/{targets,host-target,portable-path,limits,archive}.cjs` на месте.
- `npm --prefix mcp/neurocenter-asset-sync run test` — expected: vitest зелёный (`model.ts` делегирует в `getHostTarget`; `runtime-artifacts.test.ts:396-425` target-маппинг без изменений).
- api-gateway + catalog-service: typecheck/build/test — expected: зелёно (`host-target.ts`, `runtime-host-target.ts`, `device-report.ts`, `ticket.ts`, `artifact-cache.ts`).
- frontend: `npm --prefix frontend run build` + `test` (vitest) — expected: зелёно после alias + 3-файлового switch.
- `node scripts/assets/catalog-source-pin.mjs --check` — expected: без stale.
- `npm run lint:root && npm run format:root:check` — expected: 0 ошибок.

**Полно:**
- `node scripts/workspace/check.mjs` — expected: полный план зелёный (lint/format/typecheck/build/test всех пакетов + общие контракты + Compose); корневой сьют **без деградации** против baseline (a946a7b2).

**Чек-лист регрессии (risk=high, прогнать до мержа):**
1. Корневой node-сьют: pass/fail/skipped = baseline(a946a7b2), 0 новых fail.
2. `runtime-canonical-uniqueness.test.ts` зелёный — нет второго getHostTarget/второго TARGETS.
3. `limits.cjs` не читает env при импорте (тест) + `getLimits()` per-call.
4. `LIMITS.X` в `ticket.ts`/`cache.ts`/`runtime-artifact-download.ts` — без правок и без env при импорте.
5. `archive.cjs`: limits-параметр обязателен; oversize → throw; фасадный `inspectRuntimeArchive` byte-идентичен.
6. Bridge build: `dist/shared/runtime/` с `limits`/`archive`, buildId, verifyBridgeBuild; flat-copy фикстуры.
7. glibc-хост: bridge target = как в baseline (`linux-x64`); неизвестная libc → throw (не тихий musl).
8. PREPARED_SOURCE_INPUTS = 178 ≤ 180; pin `--check` без stale.
9. frontend build + vitest зелёные (alias + 3 файла).
10. Полный `check.mjs` зелёный.

## Open Questions

- **Q1 (frontend scope).** Включить 3 frontend-файла + vite alias в этот атомарный коммит ИЛИ отложить? Рекомендация: включить (механически, изолировано, frontend vitest отдельно); отложить только frontend-тройку, если alias/optimizeDeps flaky — но `toBridgeTarget` остаётся в `targets.cjs`, так что отложенная правка тривиальна.
- **Q2 (ленивый `LIMITS`).** Держать frozen accessor-объект в фасаде (потребители без правок) ИЛИ мигрировать 3 потребителя (`ticket.ts`/`cache.ts`/`runtime-artifact-download.ts`) на `getLimits()`? Рекомендация: держать accessor (минимальный риск, ноль consumer-churn); миграция — опциональный фоллоу-ап.
- **Q3 (`python-runtime.mjs`).** Оставить как есть (glibc-only сборщик) ИЛИ прогнать через `getHostTarget`? Рекомендация: оставить (другая семантика, вне «15+ install-детекций»); задокументировать.
- **Q4 (где `toBridgeTarget`).** В `targets.cjs` (расширяет поверхность name-mapping модуля) ИЛИ новый `runtime/bridge-target.cjs`? Рекомендация: в `targets.cjs` (bridge-имена ко-лоцированы с package/windows-маппингами; не 5-й файл; фасадная поверхность не затрагивается).
- **Q5 (baseline).** Числа «без деградации» снимать на `a946a7b2` (план 1.5 вёл от `90b92af`). Рекомендация: прогнать корневой сьют на `a946a7b2` до коммита и зафиксировать счётчики в плане/PR.
- **Q6 (тип frontend).** Literal-union `RuntimeTarget` в `targets.d.cts` (a) vs `as const` + assertion (b) vs `string` (c)? Рекомендация: (a) — type-only, низкий риск, сохраняет строгость frontend-типа.
