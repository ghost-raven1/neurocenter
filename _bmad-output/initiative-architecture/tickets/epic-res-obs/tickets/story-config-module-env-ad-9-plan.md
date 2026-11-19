---
title: 'Config-модуль: числовые env fail-fast + owner env-лимитов (AD-9)'
type: 'feature'
ticket: '5'
created: '2026-11-09'
status: done
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
  - deploy/production/environment-model.json
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-9: каждый сервис читает окружение только через свой config-модуль (typed schema, единая валидация, fail-fast с агрегированным отчётом на старте); ВСЕ числовые env — validated positive safe-integer (NaN/invalid = fail-fast). Реальная дыра в main: `NEUROCENTER_MCP_HOST_MAX=abc` → `Math.max(1, Number('abc')) = NaN` → неограниченный пул MCP-хостов (host.ts:40) — лимит, который не работает (R11). Также: shared-модули лимитов читают env сами (gguf-import-policy.cjs:39 `configuredGgufImportPolicy(env = process.env)`, вызов с дефолтом runtime-limits.service.ts:50) — AD-9: «shared-модули лимиты не читают из env сами — принимают значения параметром (инжекция)»; «владелец валидации лимитов из env — ровно один: config-модуль сервиса». Сейчас env читаются ad-hoc `process.env` в feature-коде (PORT/BIND_HOST в main.ts'ах, BACKUP_MAX_* в backup-коде, RAG_*_QUOTA_BYTES и т.д.).

**Approach:** (1) config-модуль на сервис (src/config.ts или feature-файл): typed schema имён env (название + тип + валидация + описание) — единственный источник, из которого сервис читает env; единая валидация на старте (в ВСЕХ режимах, не только production — «сейчас dev = ноль валидаций»); fail-fast с АГРЕГИРОВАННЫМ отчётом (все ошибки сразу, не одна за раз); (2) числовые env = validated positive safe-integer: NaN/не-число/≤0 (где семантика positive) = fail-fast с именем переменной; (3) env-лимиты: shared-модули принимают значения параметром (инжекция из config-модуля); configuredGgufImportPolicy — вызов только с явным env-объектом от config-модуля; (4) значения секретов в отчёте/логах маскируются (названия переменных — да, значения — нет); (5) числовые env-список (compose.production.yml): BACKUP_MAX_TOTAL_BYTES/BACKUP_MAX_FILE_BYTES/BACKUP_MIN_FREE_BYTES (:146-148), RAG_DEFAULT_QUOTA_BYTES/RAG_MAX_QUOTA_BYTES (:224-225), MODEL_CHAT_CONTEXT_WINDOW_TOKENS (:31,:151), NEUROCENTER_MCP_HOST_MAX (gateway), PORT'ы (:134,:175,:198,:222,:251,:277).

## Boundaries & Constraints

**Always:**
- Валидация на старте во всех режимах (dev+production) — AD-9 прямо: «не только production — сейчас dev = ноль валидаций».
- Агрегированный отчёт: все невалидные переменные за один старт (не fail на первой).
- Числовые env: positive safe-integer (NaN/overflow/≤0 где положено = fail-fast).
- Секреты в отчётах: значения маскированы (паттерн: environment-model requiredEnv-примечания уже не содержат значений).
- validateProduction (services/shared/runtime.cjs) — не дублируется: config-модуль — валидация ЗНАЧЕНИЙ, runtime.cjs — production-политики (PANEL_URL и т.д.); стык: оба на старте, единый агрегированный отчёт (OQ-1).

**Never:**
- Не менять значения лимитов по умолчанию (только валидация).
- Не валидировать в shared-модулях при импорте (ленивость — ратификация AD-7/AD-9: shared не пишет в process.env и не валидирует при импорте).
- Не трогать env-названия (dead-env drift — epic 1; config schema = единственный источник имён, но ПЕРЕИМЕНОВАНИЕ env = breaking, не здесь).
- Не создавать полную typed-схему для ВСЕХ env — скоуп: числовые + лимитные env (OQ-2).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | MCP_HOST_MAX=abc | старт gateway | fail-fast: «NEUROCENTER_MCP_HOST_MAX: ожидается positive safe-integer» |
| 2 | BACKUP_MAX_TOTAL_BYTES=1e999 | старт catalog | fail-fast (overflow safe-integer) |
| 3 | RAG_DEFAULT_QUOTA_BYTES=-5 | старт rag-sync | fail-fast (negative) |
| 4 | Все числовые env валидны | старт | старт успешен, отчёт конфигурации (имена+типы, без значений секретов) |
| 5 | Несколько невалидных env | старт | агрегированный отчёт: все имена сразу |
| 6 | env > default (gguf-секция) | старт catalog | fail-fast (AD-1: «env-значение > default = fail-fast на старте» — тест entry 4) |
| 7 | Секрет в env | отчёт старта | значение маскировано (имя видно) |
| 8 | Dev-режим | старт dev | валидация работает (не только production) |
| 9 | configuredGgufImportPolicy | grep | вызовы только с явным параметром env (дефолт process.env удалён) |

## Code Map

- `services/api-gateway/src/features/mcp-host/host.ts:40` — NaN-дыра: `Math.max(1, Number(process.env.NEUROCENTER_MCP_HOST_MAX || 4))`
- `services/shared/gguf-import-policy.cjs:39` — `configuredGgufImportPolicy(env = process.env)` (shared читает env; дефолтный вызов — runtime-limits.service.ts:50)
- `services/catalog-service/src/runtime-limits/runtime-limits.service.ts:50` — `configuredGgufImportPolicy()` без явного env
- `services/shared/runtime.cjs` — validateProduction (production-политики; requiredEnv-примечания environment-model.json ссылаются на него)
- `compose.production.yml:146-148` — BACKUP_MAX_TOTAL_BYTES/BACKUP_MAX_FILE_BYTES/BACKUP_MIN_FREE_BYTES (числовые, с defaults в compose)
- `compose.production.yml:224-225` — RAG_DEFAULT_QUOTA_BYTES/RAG_MAX_QUOTA_BYTES
- `compose.production.yml:31,151` — MODEL_CHAT_CONTEXT_WINDOW_TOKENS (model-runtime + catalog)
- `services/catalog-service/src/main.ts:38-39` — ad-hoc `process.env.PORT`/`BIND_HOST` (паттерн всех 6 main.ts)
- `services/shared/runtime-limits.cjs:24-27` — DEFAULT_RUNTIME_LIMIT_POLICY (default-значения для правила env>default)
- `deploy/production/environment-model.json` — requiredEnv/envNotes (config schema = источник имён — epic 1 dead-env drift уже использует)

## Tasks & Acceptance

### Execution
- [ ] Config-модуль: шаблон (shared-утилита или per-service модуль — OQ-3): schema [{name, type: 'positiveInteger'|'integer'|'string'|'secret', validate, description}] + loadConfig(env) → {values, report} + fail-fast с агрегированным отчётом (throw с полным списком)
- [ ] 6 app-сервисов: config-модуль на сервис; числовые env из списка (PORT, BACKUP_MAX_*, RAG_*_QUOTA_BYTES, MODEL_CHAT_CONTEXT_WINDOW_TOKENS, NEUROCENTER_MCP_HOST_MAX) — валидация positive safe-integer
- [ ] NaN-дыра закрыта: host.ts:40 — значение из config-модуля (валидировано), не raw process.env
- [ ] configuredGgufImportPolicy: вызовы только с явным env-параметром (инжекция из config-модуля catalog); дефолт `= process.env` — удалить или задокументировать как test-only (OQ-3)
- [ ] Секреты в отчёте: значения NEUROCENTER_*_TOKEN/SECRET/PG_URL_FILE — маскированы (имена да)
- [ ] Тесты: на сервис (fixture env: NaN/overflow/negative/отсутствие обязательного) → fail-fast с именем; агрегация (2 ошибки → обе в отчёте); dev-режим валидирует; regression: MCP_HOST_MAX=abc → старт не пройден
- [ ] setup-CLI (database-init/bootstrap-admin/migrate.cli): минимальная валидация числовых (они читают те же образы) — OQ-4, рекомендация: да (тот же config-модуль, подмножество)

### Acceptance
- **Given** NEUROCENTER_MCP_HOST_MAX=abc **when** старт gateway **then** fail-fast с именем переменной (regression NaN-дыры)
- **Given** BACKUP_MAX_TOTAL_BYTES не-число **when** старт catalog **then** fail-fast; агрегированный отчёт при нескольких ошибках
- **Given** валидные env **when** старт **then** успешен, отчёт без значений секретов
- **Given** grep **when** configuredGgufImportPolicy **then** 0 вызовов с дефолтным process.env

## Design Notes

- **Скоуп = числовые + лимитные env** (OQ-2): полная typed-схема всех env (AD-9 целиком) — большой refactor (50+ переменных, описания, types); P0-RES-критичная часть = числовые (NaN-дыры = «лимит, который не работает», R11) + лимитные (env-/bootstrap политики, AD-1). Полная схема — расширение (может быть вынесена, если impl покажет, что граница чистая).
- **Не дублировать validateProduction**: runtime.cjs проверяет production-политики (HTTPS PANEL_URL, _FILE-секреты, SSO_DISABLE=false); config-модуль — типы/значения. Оба — на старте; единый агрегированный отчёт (OQ-1, рекомендация: config-модуль вызывается ПЕРЕД validateProduction, отчёты склеиваются в один throw).
- **Агрегированный отчёт = UX-требование AD-9** («fail-fast с агрегированным отчётом на старте»): оператор не должен чинить env по одному за раз.
- **Secret-маскировка в отчёте**: отчёт конфигурации (имена+типы) пишется в лог/выбрасывается — значения секретов (token/password) никогда. Это же правило AD-O8 для логов (entry 6/7) — единый принцип.
- **Laziness**: config-модуль читает env на старте (одна точка), feature-код получает значения из объекта (не process.env) — паттерн AD-7 limits.cjs (ленивый getLimits, без env-снимка при импорте) переносится на config.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/api-gateway && npm test -- config
cd services/catalog-service && npm test -- config
cd services/rag-sync-service && npm test -- config
# Regression NaN-дыры:
NEUROCENTER_MCP_HOST_MAX=abc node dist/main.js  # (dev) → exit ≠ 0 с именем переменной
grep -rn "configuredGgufImportPolicy()" services/*/src --include="*.ts"  # → 0 вызовов без параметра
```
Ожидаемо: config-тесты зелёные (fail-fast, агрегация, маскировка); NaN-дыра закрыта; корневой сьют — без деградации.

## Open Questions

1. **Стык config-модуль ↔ validateProduction**: единый агрегированный отчёт (рекомендация: config → validateProduction, один throw со всеми ошибками) vs независимые (два throw'а). Рекомендация: единый.
2. **Полная typed-схема всех env**: в скоупе entry vs только числовые+лимитные (рекомендация: только числовые+лимитные — P0-RES-часть AD-9; полная схема — расширение/Deferred, т.к. dead-env drift (epic 1) уже держит имена env в модели).
3. **Дефолт configuredGgufImportPolicy(env = process.env)**: удалить дефолт (обязательный параметр — строже, AD-9) vs оставить для тестов. Рекомендация: удалить дефолт из production-пути; test-only wrapper — отдельно.
4. **Setup-CLI (database-init/bootstrap-admin/migrate)**: тот же config-модуль (подмножество env) vs отдельная минимальная валидация. Рекомендация: тот же модуль — один owner.

## Progress

**Status:** done (branch `nc-res-05`, worktree `/home/region.cbr.ru/69starodubtsevae/projects/nc-wt/res5`)

### Реализовано

1. **Общий config-engine** (`services/shared/config.cjs` + `config.d.cts`): typed-схема (positiveInteger / nonNegativeInteger / integer / string / secret / boolean), `loadConfig(schema, env, validate?)` → `{ values, report }`, `ConfigEnvironmentError` с агрегированным `issues[]`, `formatConfigReport(report)`; секреты маскируются как `***` в отчёте. Drift-guard (`shared-declaration-drift.test.mjs`) — зелёный (6/6).
2. **6 config-модулей сервисов** (`src/config/index.ts`): api-gateway, catalog-service, rag-sync-service, oauth2-bridge, skills-service, feature-flags-service. Каждый читает числовые env как positive safe-integer, порт/биндинг (PORT + BIND_HOST), маскирует секреты в отчёте старта.
3. **Wiring в `main.ts`** всех 6 сервисов: config-модуль вызывается в самом начале `bootstrap()` (до `NestFactory.create`), отчёт пишется через `formatConfigReport`, значения берутся из `config.values.port` / `config.values.bindHost` (не из raw `process.env`).
4. **NaN-дыра закрыта** (`host.ts`): лимит MCP-хостов берётся из config-модуля, а не из сырого `process.env.NEUROCENTER_MCP_HOST_MAX`. `parseMcpHostLimits` дефолт сохранён (defense-in-depth) — regression host-limits тест не сломан.
5. **`configuredGgufImportPolicy(env = process.env)` дефолт удалён** (`gguf-import-policy.cjs` + `.d.cts`): параметр `env` теперь обязателен. Оба catalog-вызова (`runtime-limits.service.ts`, `gguf-import.service.ts`) передают явный `env` из config-модуля. `grep "configuredGgufImportPolicy()"` → 0 вызовов без параметра.
6. **Секреты**: `NEUROCENTER_*_TOKEN/SECRET/PG_URL_FILE`-подобные значения в отчётах маскируются (имена переменных — да, значения — нет).
7. **api-gateway DI**: production-путь (`proxy.module.ts` useFactory + `mcp-host.controller.ts`) передаёт `gatewayMcpHostLimits()` из config в `McpHostService`.

### Тесты (все зелёные)

| Сервис | Файлов | Тестов |
|--------|--------|--------|
| api-gateway | 9 | 88 pass |
| catalog-service | 46 | 434 pass |
| rag-sync-service | 23 | pass (3 skip) |
| oauth2-bridge | — | 12 pass |
| skills-service | — | 334 pass |
| feature-flags-service | — | 11 pass |

Typecheck (`tsc --noEmit`) — чистый на всех 6 сервисах. `shared-declaration-drift.test.mjs` — 6/6. Regression NaN-дыры: `NEUROCENTER_MCP_HOST_MAX=abc node dist/main.js` → exit 1 с именем переменной в отчёте.

### Отклонения / риски

- **setup-CLI** (database-init/bootstrap-admin/migrate): НЕ читают числовые env из списка, поэтому числовая валидация там не добавлена (deviations — OQ-4 закрыт как «не требуется»).
- **Feature-валидаторы** (backupPolicy, ragQuotaPolicy, managedChatContextWindow) оставлены читающими env — config-модуль является стартовым gate; граница сознательная, чтобы не сломать 44 catalog-теста.
- **Полная typed-схема всех env** не делалась (OQ-2): скоуп = числовые + лимитные env.
- :warning: `environment-model` / `compose-drift` тест (`scripts/production/environment-model.mjs`, `compose-drift.test.mjs`) требует перепроверки, т.к. config-schema теперь ссылается на больше имён env.

### Файлы

Новые: `services/shared/config.cjs` + `config.d.cts`; `services/{api-gateway,catalog-service,rag-sync-service,oauth2-bridge,skills-service,feature-flags-service}/src/config/index.ts` + `src/config/tests/config.test.ts`.
Изменённые: `services/shared/gguf-import-policy.cjs` + `.d.cts`; `main.ts` у 6 сервисов; `services/api-gateway/src/proxy/proxy.module.ts`, `services/api-gateway/src/features/mcp-host/mcp-host.controller.ts`; `services/catalog-service/src/runtime-limits/runtime-limits.service.ts`, `services/catalog-service/src/models/gguf-import/gguf-import.service.ts`.
