---
title: 'Freshness-guard сборок dist/ (AD-10)'
type: 'feature'
ticket: '8'
created: '2026-11-06'
status: done
baseline_revision: '90b92af3f5bf47c8a5e320a115f33463d8c0d56a'
route: 'full'
route_source: 'auto'
risk: 'low'
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

**Problem:** Корневой сьют (30+ node-тестов `scripts/test/`, `scripts/catalog-plugins/test/`) импортирует `services/*/dist` и `mcp/neurocenter-asset-sync/dist` напрямую, но актуальность `dist/` против `src/` не проверяется: `check --step test` без build читает устаревший `dist/` — «проходит у меня, падает в CI» (AD-10).

**Approach:** Stamp build-входов (sha256 `src/` + build-конфигов) пишет `postbuild`-хук пакета в `.run/dist-stamps/<dir>.json`; `check-plan` помечает test-шаги полем `distGuard`, `runCheck` на старте шага в-процессе утверждает freshness; устаревание = явная ошибка «run nest build», а не фэйл теста.

## Boundaries & Constraints

**Always:**
- Guard только на test-шагах до запуска раннера; check никогда сам не запускает build.
- Stamp пишет только `postbuild` успешной сборки: `{schemaVersion:1, srcSha256}` — без mtime и git-HEAD.
- Stamp — в `.run/` (вне source-идентичности), не в `dist/` (не ломает buildId bridge), не в tracked-пути (не ломает SOURCE_CHANGED).
- Форма плана/отчёта неизменна: новых имён шагов нет (regex `stepIdentity`), фэйл guard'а = исходный test-шаг с `failure.code: 'DIST_STALE'` + явное сообщение в stderr.
- Список dist-пакетов и entry-файлов dist/ — из `buildPackages` (`isolated-build-source.mjs`), новая константа не создаётся.

**Never:**
- Drift-guard `.d.cts`↔`.cjs` (entry 7) и shared-сплит (entries 5/6) — не сюда.
- Не мигрировать тесты на src (AD-10 Deferred); не расширять guard на non-test-шаги; не трогать `bridge build.mjs`/`build.json`/`verifyBridgeBuild`; не хэшировать `node_modules`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FRESH | build выполнен, src не менялся | guard прозрачен, тесты стартуют | — |
| STALE | src изменён после build | test-шаг останавливается до тестов | «…run nest build…», exit 1, код DIST_STALE |
| NO_STAMP | чистый checkout / `.run` очищен | то же явное «run nest build» | код DIST_STALE |
| DIST_GONE | stamp и src цела, dist/ (entry) удалён | то же явное «run nest build» | код DIST_STALE |
| FULL_PLAN | полный план, build зелёные | guard'ы зелёные, общие node-тесты отработали | — |
| TOOLING | `--tooling` | план без guard'ов, без изменений | — |

</frozen-after-approval>

## Code Map

- `scripts/workspace/check-plan.mjs` — `checkPlan` L129-210: per-package push L179-185 (сюда `distGuard`), «Общие контракты» L189-195 (`distGuard`: все 7), `checkHelp` L23-30.
- `scripts/workspace/check.mjs` — `runCheck` L20-175: guard в-процессе перед `runCheckProcess` L119; фэйл-паттерн L145-150.
- `scripts/workspace/isolated-build-source.mjs` — `buildPackages` L7-16 (каталоги + entry dist — переиспользовать), `exclusion` L61-84 (`.run`/`dist` вне source-идентичности).
- `scripts/dev-mcp/run-reports.mjs` — `checkFailures` L163-176 (+`'DIST_STALE'`), `stepIdentity` L96-101 (почему отдельный plan-шаг невозможен).
- `scripts/workspace/dist-freshness.mjs` — НОВЫЙ: `stampDigest`/`writeStamp`/`assertDistFresh` + CLI `--write`/`--check`.
- `mcp/neurocenter-asset-sync/scripts/runtime-shared-files.mjs` — `BRIDGE_SHARED_RUNTIME_FILES` (только динамический import: tooling-fixture копирует лишь `scripts/workspace/*.mjs`).
- `scripts/bridge-build-integrity.mjs` L6-25 — `verifyBridgeBuild` (почему stamp не в dist/).
- `services/{api-gateway L8, catalog-service L8, feature-flags-service L8, oauth2-bridge L7, rag-sync-service L7, skills-service L8}/package.json` + `mcp/neurocenter-asset-sync/package.json` L15 — `"postbuild"`.
- `scripts/workspace/check-tooling-tests.json` + `scripts/test/workspace-check-tooling.test.mjs` L16-69 — регистрация нового теста.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/workspace/dist-freshness.mjs` -- closure входов (сервис: `src/**` + tsconfig.json + tsconfig.build.json + nest-cli.json + package.json; bridge: `src/**` + tsconfig.json + package.json + package-lock.json + vendor/ollama-runtime/{package.json,index.js} + shared-файлы BRIDGE_SHARED_RUNTIME_FILES) → sha256; `writeStamp` → `.run/dist-stamps/<dir>.json`; `assertDistFresh` (нет stamp / digest не совпадает / нет dist или entry → `Error.code='DIST_STALE'`, сообщение с «run nest build»); CLI `--write`/`--check` -- единый механизм (AD-10)
- [ ] `scripts/workspace/check-plan.mjs` -- `distGuard: [dir]` у test-шагов dist-пакетов; `distGuard`: все 7 у «Общих контрактов»; строка в checkHelp
- [ ] `scripts/workspace/check.mjs` -- для шага с `distGuard`: `assertDistFresh` до spawn; фэйл → entry `{ok:false, exitCode:1, signal:null, durationMs, leaderReaped:false, cleanup:{noLiveDescendants:true, signals:[], zombieCount:0}, failure:{code:'DIST_STALE'}}` + сообщение в errorOutput + стоп (без spawn, без нового имени шага)
- [ ] `scripts/dev-mcp/run-reports.mjs` -- `'DIST_STALE'` в checkFailures
- [ ] 7 × `package.json` -- `"postbuild": "node <rel>/scripts/workspace/dist-freshness.mjs --write <dir>"`
- [ ] `scripts/test/workspace-dist-freshness.test.mjs` -- сценарии матрицы на tmp-fixture (fresh/stale/no-stamp/dist-gone/rebuild→зелёно) + `distGuard` в checkPlan (frontend и tooling — без)
- [ ] `scripts/workspace/check-tooling-tests.json` + `scripts/test/workspace-check-tooling.test.mjs` -- новый тест в обоих списках

**Acceptance Criteria:**
- Given собран dist/, when src/ изменён без build и стартует прогон тестов (`check --step test` или полный план), then прогон останавливается на первом test-шаге с явной ошибкой «run nest build» (exit 1, тесты не выполнялись, failure DIST_STALE).
- Given то же устаревание, when `npm run build` (nest build) в пакете, then тот же check зелёный.
- Given чистый checkout, when `check --step test`, then явная «run nest build», а не module-not-found из теста.
- Given полный план с успешными build, then guard'ы зелёные и общие node-тесты читают свежий dist/; `--tooling` без изменений.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Stamp в `.run/dist-stamps/`, а не в `dist/`/корне пакета: файл в dist/ bridge меняет buildId (`verifyBridgeBuild` пересчитывает хэш всего dist) → ломается упаковка; untracked-файл в корне меняет source-идентичность → SOURCE_CHANGED в конце check. `.run` исключён из обоих (`exclusion()`). Отдельный plan-шаг невозможен: `stepIdentity` не примет новое имя, special-шаги запрещены в scoped-планах — guard в-процессе внутри test-шага.

## Verification

**Commands:** (node-тесты — только `$NODE`, системный v16 не подходит)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `$NODE scripts/test/workspace-dist-freshness.test.mjs` -- expected: 0 fail
- `$NODE scripts/test/workspace-check-tooling.test.mjs` -- expected: 0 fail (новый файл в fixed-списке)
- `$NODE scripts/test/workspace-check.test.mjs && $NODE scripts/test/workspace-check-options.test.mjs && $NODE scripts/test/workspace-check-source.test.mjs` -- expected: без деградации
- `npm run check -- --tooling` -- expected: зелёный
- `npm run lint:root` -- expected: 0 warnings
- E2E (зависимости установлены): `cd services/catalog-service && npm run build` → правка `src/*.ts` → `$NODE scripts/workspace/check.mjs --step test --package catalog-service` → явная «run nest build», exit 1; `npm run build` → та же команда зелёная.
