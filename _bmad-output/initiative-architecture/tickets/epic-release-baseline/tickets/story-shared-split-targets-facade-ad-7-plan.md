---
title: 'Shared-сплит: канон TARGETS + host-target + фасад (AD-7, entry 5)'
type: 'refactor'
ticket: '5'
created: '2026-11-06'
status: done
baseline_revision: '90b92af3f5bf47c8a5e320a115f33463d8c0d56a'
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
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `services/shared/runtime-artifacts.cjs` — god-модуль (TARGETS + env-лимиты + portablePath + USTAR-парсер), а `opencode-cli-install.cjs` несёт второй TARGETS-список; пространства имён целей расходятся (win32-* vs windows-*); фасад флэт-копируется в standalone bridge (25 файлов). Правка одного файла расходящаяся на 56 call-site.

**Approach:** канон в подпапке `services/shared/runtime/`: `targets.cjs` (единственный TARGETS, 8 целей, явные маппинги), `host-target.cjs` (единственный `getHostTarget()`, injectable report, throw/unknown — параметр), `portable-path.cjs`. `runtime-artifacts.cjs` на плоском пути остаётся фасадом-identity-реэкспортом (импорты 56 call-site не меняются); TARGETS в `opencode-cli-install.cjs` отменяется (выводится явным маппингом); новые модули регистрируются в `PREPARED_SOURCE_INPUTS` (cap 170 осознанно повышен до 180 — задокументировано), pin-каскад пересчитан.

## Boundaries & Constraints

**Always:**
- Поверхность экспортов фасада инвариантна: `TARGETS, LIMIT_DEFAULTS, LIMITS, portablePath, normalizeRuntimeArtifacts, validateRuntimeArtifactEntrypoints, inspectRuntimeArchive`; фасад реэкспортирует канонические объекты (identity, `===`).
- TARGETS — единственный список (8 целей); маппинги win32-*⇄windows-* и canonical→package-цели — только явные таблицы (regex-срезы запрещены).
- `getHostTarget()`: injectable report; glibc по `glibcVersionRuntime` (regex `^\d+\.\d+(?:\.\d+)?$`), musl по `sharedObjects` (паттерны ld-musl/libc.musl); поведение при неизвестной libc — параметр.
- Новые shared-модули не пишут в `process.env` и не валидируют при импорте.
- Каждый relative-импорт файла из `PREPARED_SOURCE_INPUTS` сам входит в него (closure-тест).

**Never:**
- Не менять call-site'ы (≈56), `runtime-artifacts.d.cts` (поверхность не меняется), семантику лимитов (env-снимок LIMITS — entry 6), USTAR-парсер (archive.cjs — entry 6).
- Не переключать на канон детекции платформы: 3 сильные копии (`mcp-host/host-target.ts`, `catalog-service/.../runtime-host-target.ts`, bridge `model.ts`) и слабые bridge-копии `!glibc⇒musl` — entry 6; frontend-regex `bridgeSource.ts:85` — entry 6.
- Не менять значения `OPENCODE_CLI_INSTALL_TARGETS` (6 целей) и поведение `openCodeInstallRuntimeTarget`.
- Не перемещать фасад с плоского пути `services/shared/runtime-artifacts.cjs`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FACADE_IDENTITY | require фасада + require `runtime/targets.cjs` | `facade.TARGETS === canonical.TARGETS`; `portablePath` — одна функция | No error |
| GLIBC | `getHostTarget({report:{header:{glibcVersionRuntime:'2.36'},sharedObjects:[]}})` | `linux-x64-glibc` | No error |
| MUSL | `sharedObjects:['/lib/ld-musl-x86_64.so.1']` | `linux-x64-musl` | No error |
| UNKNOWN_THROW | неизвестная libc, `mode:'throw'` | throw | actionable сообщение |
| UNKNOWN_SILENT | неизвестная libc, `mode:'unknown'` | `base-unknown` (поведение model.ts) | No error |
| FOREIGN_PLATFORM | `freebsd-x64` / `linux-ppc64`+glibc: `unknown` → как есть; `throw` → throw | `freebsd-x64` / `linux-ppc64-glibc` / throw | throw в `throw`-режиме |
| CLI_INSTALL | `opencode-cli-install`: target `linux-x64` / `linux-x64-musl` / `darwin-arm64` / мусор | `linux-x64-glibc` / тот же / тот же / throw — без изменения | throw как сейчас |
| WINDOWS_MAP | `windows-x64` ⇄ `win32-x64`, `windows-arm64` ⇄ `win32-arm64` | явные маппинги работают; неизвестное имя отклоняется | throw, не regex |
| BRIDGE_BUILD | `npm --prefix mcp/neurocenter-asset-sync run build` | `dist/shared/runtime/{targets,host-target,portable-path}.cjs` на месте; buildId пересчитан; `verifyBridgeBuild` зелёный | No error |
| CLOSURE | `PREPARED_SOURCE_INPUTS` = 174 | ≤ cap 180; pin-каскад свежий | stale = фэйл |
| REGRESSION | корневой сьют | без деградации против baseline (287 файлов, 3693 pass / 0 fail / 38 skipped) | фэйл сьюта |

</frozen-after-approval>

## Code Map

- `services/shared/runtime-artifacts.cjs` (287 строк) — god-модуль: TARGETS (6–15), LIMIT_DEFAULTS/LIMIT_ENV/LIMITS env-снимок (16–38), portablePath (40–59), normalizeRuntimeArtifacts (61–98), validateRuntimeArtifactEntrypoints (100–106), inspectRuntimeArchive USTAR (123–278). Entry 5: TARGETS+portablePath → `require('./runtime/…')`; остальное остаётся до entry 6.
- `services/shared/runtime-artifacts.d.cts` — декларация фасада; не менять (поверхность инвариантна).
- `services/shared/opencode-cli-install.cjs` — локальный TARGETS (5–12: 6 package-целей без win32), `openCodeInstallRuntimeTarget` (60–63), экспорт `OPENCODE_CLI_INSTALL_TARGETS` (228), JSON-schema `enum: TARGETS` (107). Потребители: api-gateway `opencode-cli-supply.controller.ts`, 7 файлов catalog-service, bridge `install-contract.ts` (dual-path), frontend (vite-alias `@neurocenter/opencode-cli-install` в `frontend/vite.config.ts:19`, `tsconfig.json:20`, `vitest.config.ts:14` + относительный импорт `ComputerSetup/model.ts:7`) — пути не меняются.
- `mcp/neurocenter-asset-sync/scripts/runtime-shared-files.mjs` — `BRIDGE_SHARED_RUNTIME_FILES` (25 flat-файлов), источник flat-copy.
- `mcp/neurocenter-asset-sync/scripts/build.mjs:27-30` — копит список flat в `dist/shared/`; нужен `mkdir -p` для подпути; buildId — рекурсивный digest (подпапки учитываются), `verifyBridgeBuild` (`scripts/bridge-build-integrity.mjs`) — рекурсивный, подпапки ок.
- Ещё три места flat-copy: `mcp/neurocenter-asset-sync/integration/test/bridge-cli-profile.fixture.ts:57-63`, `scripts/test/bridge-build.test.mjs:29-33` (fixture) и `:80-84` (byte-equality-ассерт), `scripts/test/bridge-installer-lifecycle.fixture.mjs:146-172` (хардкод 19-файлового подмножества, включает runtime-artifacts + opencode-cli-install).
- `mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts:26-61` — «донор» семантики `getHostTarget()` (injectable report, glibc/musl, fallback `base-unknown`); тесты-эталон: `integration/test/runtime-artifacts.test.ts:396-425`. Entry 6 переключит на канон.
- `services/api-gateway/src/features/mcp-host/host-target.ts` (throw + assertTarget), `services/catalog-service/src/devices/runtime-host-target.ts` (`-unknown`) — 2-я/3-я копии детекции; entry 6.
- `scripts/catalog-plugins/prepared-source-snapshot.mjs:9,11` — `PREPARED_SOURCE_MAX_FILES = 170` (throw при превышении), `PREPARED_SOURCE_INPUTS` = 168 (runtime-подсчёт).
- `scripts/assets/catalog-source-pin.mjs` — pin-каскад `catalog-source/producer.json` → `catalog-source/manifest.json` → `services/shared/bundled-catalog.lock.json`; `--write` / stale-check.
- `scripts/catalog-plugins/test/prepared-source-snapshot.test.mjs:130-154` — closure-тест (автоматически ловит новый `require` фасада); `:155-186` — tsc-сборка catalog-service из snapshot-фикстуры.
- `scripts/test/bundled-catalog.test.mjs:181-205` — pin-тесты; `:206+` — покрытие каждого input'а Dockerfile COPY: `services/catalog-service/Dockerfile:51` `COPY services/shared/ /tools/services/shared/` — подпапку покрывает автоматически (изменение не нужно).
- `services/shared/tests/` — корневой node-сьют (node:test, .ts через createRequire, Node 24 type-stripping) — место новых тестов.
- `scripts/workspace/check-plan.mjs` — состав корневого сьюта; node 24 резолвится через `NODE_BIN`/PATH/`.run/toolchains` (системный node — v16, напрямую не использовать).

## Tasks & Acceptance

**Execution:**
- [ ] `services/shared/runtime/targets.cjs` + `targets.d.cts` — канон: `TARGETS` (Object.freeze, 8 целей, значения как в runtime-artifacts.cjs:6-15), явные таблицы win32-⇄windows- и canonical→package (win32-* package-аналога не имеют) + обратные маппинги/хелперы
- [ ] `services/shared/runtime/host-target.cjs` + `host-target.d.cts` — `getHostTarget()`: семантика model.ts:26-61 + параметр режима (см. Design Notes); `process.report` — только при отсутствии report, try/catch без подмены
- [ ] `services/shared/runtime/portable-path.cjs` + `portable-path.d.cts` — `portablePath` дословно из runtime-artifacts.cjs:40-59
- [ ] `services/shared/runtime-artifacts.cjs` — фасад: identity-реэкспорт TARGETS/portablePath из `./runtime/`; LIMITS/normalize/validate/inspect остаются (используют канон через require); экспортная поверхность без изменений
- [ ] `services/shared/opencode-cli-install.cjs` — удалить локальный TARGETS (5-12): значения из канонического маппинга; `openCodeInstallRuntimeTarget` через обратный маппинг; экспортные значения и ошибки без изменений
- [ ] `mcp/neurocenter-asset-sync/scripts/runtime-shared-files.mjs` — добавить `runtime/targets.cjs`, `runtime/host-target.cjs`, `runtime/portable-path.cjs`; `scripts/build.mjs:27-30` — mkdir родителя перед copyFile
- [ ] Фикстуры flat-copy: `bridge-cli-profile.fixture.ts`, `bridge-build.test.mjs` (fixture :29-33; ассерт :80-84 работает для подпутей без правок), `bridge-installer-lifecycle.fixture.mjs` — копировать подпапку `runtime/`
- [ ] `scripts/catalog-plugins/prepared-source-snapshot.mjs` — +6 записей (`services/shared/runtime/{targets,host-target,portable-path}.{cjs,d.cts}`), `PREPARED_SOURCE_MAX_FILES` 170→180 с комментарием (осознанное повышение, AD-7 entry 5/6)
- [ ] `node scripts/assets/catalog-source-pin.mjs --write` — пересчитать pin-каскад
- [ ] `services/shared/tests/runtime-targets.test.ts`, `services/shared/tests/runtime-host-target.test.ts` — сценарии I/O-матрицы: identity фасада, маппинги, getHostTarget (glibc/musl/unknown/foreign, оба режима, injectable report), opencode-cli-install без изменения поведения

**Acceptance Criteria:**
- Given фасад на плоском пути, when импорт из любого call-site, then поверхность и значения идентичны baseline (корневой сьют зелёный).
- Given чистая bridge-сборка, when инспекция `dist/shared`, then подпапка `runtime/` с 3 модулями на месте и standalone-архив исполним (bridge-build-тест + vitest-интеграция).
- Given 174 записи `PREPARED_SOURCE_INPUTS`, when pin-каскад, then `--check` зелёный (без stale).
- Given `opencode-cli-install.cjs`, when валидация прежних target'ов, then результат и ошибки идентичны (включая `-glibc`-маппинг).

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- `getHostTarget({platform=process.platform, arch=process.arch, report=undefined, mode='unknown'}): string`. Не-linux: `base` (`throw` — дополнительно assert ∈ TARGETS). Linux: glibc → `base-glibc`; musl → `base-musl`; иначе `unknown` → `base-unknown`, `throw` → throw. `mode:'throw'` = поведение `mcp-host/host-target.ts`, `mode:'unknown'` = поведение `model.ts`/`runtime-host-target.ts`.
- Cap 180: entry 5 даёт 168+6=174, entry 6 ещё +4 (limits/archive + .d.cts) = 178; 180 — задокументированный запас, ограничение сохраняется.
- `.d.cts` у новых модулей: конвенция shared-слоя (у каждого .cjs есть декларация) + guard entry 7 («.cjs без декларации = флаг»); `getHostTarget` потребители entry 6 импортируют напрямую из `shared/runtime/host-target.cjs` — фасадная поверхность не расширяется.

## Verification

**Commands:** (Node 24 обязателен; `check.mjs` резолвит сам, для точечных `node --test` использовать node 24 из `NODE_BIN`/`.run/toolchains`)
- `node --test services/shared/tests/runtime-targets.test.ts services/shared/tests/runtime-host-target.test.ts` -- expected: зелёно
- `node --test scripts/catalog-plugins/test/prepared-source-snapshot.test.mjs scripts/test/bundled-catalog.test.mjs` -- expected: closure + pin зелёные
- `node --test scripts/test/bridge-build.test.mjs` -- expected: flat-copy с подпапкой, buildId, verifyBridgeBuild зелёные
- `npm --prefix mcp/neurocenter-asset-sync run build` -- expected: `dist/shared/runtime/` на месте
- `npm --prefix mcp/neurocenter-asset-sync run test` -- expected: vitest зелёный (runtime-artifacts.test.ts + integration-фикстура)
- `node scripts/assets/catalog-source-pin.mjs --check` -- expected: без stale
- `npm run lint:root && npm run format:root:check` -- expected: 0 ошибок
- `node scripts/workspace/check.mjs` -- expected: полный план зелёный; корневой сьют без деградации против baseline (287 файлов, 3693 pass / 0 fail / 38 skipped)
