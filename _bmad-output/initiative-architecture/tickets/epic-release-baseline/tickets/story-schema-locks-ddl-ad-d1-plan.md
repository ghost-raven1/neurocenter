---
title: 'Schema: лок feature-flags + DDL security_events + ghost-БД (AD-D1)'
type: 'feature'
ticket: '11'
created: '2026-11-06'
status: done
baseline_revision: '90b92af3f5bf47c8a5e320a115f33463d8c0d56a'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** feature-flags и catalog делят advisory-лок `neurocenter:catalog:migrations` — миграция любого из сервисов блокирует другой (скрытая связка); DDL `security_events` дублируется двумя сервисами (целостность только через ручную идентичность SQL); dev-init создаёт ghost-БД `skills`, которой не пользуется никто.

**Approach:** (1) ff получает собственный лок `neurocenter:feature-flags:migrations` (3 точки); (2) DDL `security_events` — только catalog: SQL v1 ff-миграции замораживается побайтово (checksum в ledger'ах существующих БД неизменяем по AD-D1), `feature-flags-schema.ts` теряет DDL, целостность общей таблицы — invariant-тест; (3) ghost-БД `skills` удалена из dev-init.

## Boundaries & Constraints

**Always:**
- SQL v1 ff-миграции — побайтово заморожен (checksum `7324275e1a3ca4dd3299f9288b48b8dd8a7a1cdca2ec82d4647a2f062751014d`): ledger-протокол (monotonic, no-rollback, история неизменяема) не позволяет переписать checksum применённой миграции в существующих БД.
- Запись строк в `security_events` из ff (`feature_flag.update` в `FlagsRepository.patch`) — сохраняется без изменений; путь `patch()` не трогать.
- DDL `security_events` единого источника (catalog, baseline-миграция 0) — не менять; ff-сервис не создаёт чужие таблицы в новых миграциях.
- Путь `migrate.cli.ts` (manifest/check/migrate) работает без изменения сигнатур экспортов.

**Never:**
- Нет изменения catalog-кода (`access-schema.ts`, `migrations.ts`, `catalog-schema.ts`, `catalog-migrations.ts`) и RAG-локов.
- Нет новых версий ff-миграций (в БД менять нечего), нет DROP/ALTER `security_events`, нет удаления ghost-БД из существующих dev-томов (только из init).
- Нет изменения compose-схем, update-flow, shared-слоя — чужие сторис эпика.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FRESH_DB | fresh PG, старт обоих сервисов (любой порядок) | `security_events` существует (DDL catalog; замороженный v1 idempotent `IF NOT EXISTS`), `feature_flags` + ledger, оба ready | — |
| EXISTING_DB | БД с ledger v1 (старый checksum) | migrate — no-op, история валидна, ready | — |
| LOCKS_INDEPENDENT | сессия A держит лок ff (или catalog) | миграция другого сервиса завершается без ожидания | фэйл теста (lock_timeout) |
| SHARED_TABLE_DRIFT | колонки/PK/индекс `security_events` ≠ DDL catalog | invariant-тест красный | имя колонки/индекса в сообщении |
| GHOST_DB | fresh dev PG после init | БД: только `catalog` + `rag` (+prod-набор), `skills` нет | — |
| PREFLIGHT_READY | `migrate.cli.js check --ready` на мигрированной БД | `{ok:true, ready:true, pending:[]}` | — |

</frozen-after-approval>

## Code Map

- `services/feature-flags-service/src/database/migrations.ts` — Л8 `const lock = …'neurocenter:catalog:migrations'…` (используется L122 `checkFeatureFlagsMigrations` READ-ONLY и L145 `migrateFeatureFlags`); Л5-7 `FEATURE_FLAGS_MIGRATIONS` (v1 `sql: FEATURE_FLAGS_SCHEMA_SQL`); Л10-11 `featureFlagsMigrationManifest` (export → `migrate.cli.ts` manifest, release-manifest); Л49-104 `assertFeatureFlagsSchema` — цикл по `FEATURE_FLAGS_COLUMNS` (вкл. `security_events`), L68 ветка PK `event_id`, L88-103 чек индекса `security_events_created`; Л24 комментарий про общий лок.
- `services/feature-flags-service/src/database/feature-flags-schema.ts` — Л2-13 `FEATURE_FLAGS_SCHEMA_SQL` = DDL `security_events`+индекс+`feature_flags` (это и есть замороженный SQL v1); Л15-38 `FEATURE_FLAGS_COLUMNS` (вкл. `security_events` Л16-24); Л40-49 `FEATURE_FLAGS_DEFAULTS` (вкл. `security_events` Л41).
- `services/feature-flags-service/src/flags/flags.repository.ts` — Л52-74 `setup()`: `migrateFeatureFlags` + сид-INSERT дефолтных флагов под общим локом (Л58), комментарий Л48; Л93-137 `patch()` — запись `security_events` (Л122-125), **не менять**.
- `services/feature-flags-service/src/database/migrate.cli.ts` — manifest/check/migrate через экспорты; изменений не требует (лок — через константу).
- `services/catalog-service/src/access/access-schema.ts` — единственный владелец DDL `security_events`; входит в `CATALOG_BASELINE_SQL` (`baseline-schema.ts` Л17) → миграция 0 `catalog-complete-baseline` (`catalog-migrations.ts` Л97). Не менять.
- `services/catalog-service/src/database/migrations.ts` Л78, `catalog-schema.ts` Л17 — catalog-лок. Не менять.
- `services/rag-sync-service/init/00-create-databases.sql` (13 строк) — Л5 `CREATE DATABASE skills;` + Л10-11 `\c skills`-блок (pgvector). Dev-only: монтируется в `/docker-entrypoint-initdb.d` только из `docker-compose.yml` Л221; production создаёт БД в `production-init.cli.ts` (только catalog/rag/nc_rag_template — проверено).
- `scripts/test/owned-postgres-acceptance.test.mjs` — Л10-35 реестр `entries` DB-тестов (имя, env-var owned PG); сюда регистрируется новый QA-тест.
- `scripts/test/reliable-migrations.mjs` — паттерн QA-теста: `ownedTestPostgresAdmin(process.env.TEST_ADMIN_PG_URL)`, ts-node register, scratch-БД create/drop.
- `scripts/test/schema-migration-coverage.test.mjs` — статический гард: SQL-граф от входов (вкл. ff `migrations.ts`); замороженный v1 SQL остаётся в графе → `security_events` зарегистрирован; должен остаться зелёным.
- `scripts/test/flags-rollback-integrity.mjs` — phase-gated QA, покрывает запись `security_events` в `patch()` (boundary `patch`); не менять, продолжает валидировать «запись строк сохраняется».
- Авто-обнаружение тестов: `nodeTestFiles` в `scripts/workspace/check-plan.mjs` Л55-82 (все `scripts/test/*.test.mjs` с `node:test` — без ручной регистрации); `check-tooling-tests.json` — фиксированный tooling-набор (не требуется для этой истории).

## Tasks & Acceptance

**Execution:**
- [ ] `services/feature-flags-service/src/database/migrations.ts` -- (1) константа лока → `hashtextextended('neurocenter:feature-flags:migrations',0)`; (2) вверху файла — замороженный SQL v1 побайтово как есть из `FEATURE_FLAGS_SCHEMA_SQL` (константа с комментарием «замороженная история — не изменять, checksum в ledger'ах БД») и `FEATURE_FLAGS_MIGRATIONS` ссылается на неё (import `FEATURE_FLAGS_SCHEMA_SQL` убрать); (3) `assertFeatureFlagsSchema` — убрать проверки `security_events` (итерация колонок таблицы, ветка `key==='event_id'`, чек индекса `security_events_created`), оставить `feature_flags` + ledger; (4) обновить комментарий Л24 (лок больше не общий) -- отделить лок-границы ff/catalog по AD-D1.
- [ ] `services/feature-flags-service/src/database/feature-flags-schema.ts` -- удалить константу `FEATURE_FLAGS_SCHEMA_SQL` (SQL v1 переехал в migrations.ts), из `FEATURE_FLAGS_COLUMNS` и `FEATURE_FLAGS_DEFAULTS` убрать записи `security_events` -- единый источник DDL = catalog.
- [ ] `services/feature-flags-service/src/flags/flags.repository.ts` -- Л58: лок в `setup()` → `neurocenter:feature-flags:migrations`; обновить комментарий Л48 (общий журнал больше не под общим локом) -- сидинг флагов не конкурирует с catalog.
- [ ] `services/rag-sync-service/init/00-create-databases.sql` -- удалить `CREATE DATABASE skills;` и `\c skills`-блок (pgvector), поправить заголовок (создаётся только `catalog`) -- ghost-БД не создаётся на fresh dev-томе.
- [ ] `scripts/test/schema-locks-ddl-invariant.test.mjs` (new, node:test) -- статические инварианты: (a) `featureFlagsMigrationManifest()[0].checksum === '7324275e…014d'` (regression-гейт замороженного v1); (b) текст `feature-flags-schema.ts` не содержит DDL `security_events`; (c) текст `00-create-databases.sql` не содержит `CREATE DATABASE skills`; (d) ключ лока ff ≠ `neurocenter:catalog:migrations` (по тексту `migrations.ts`) -- ловит дрейф контракта без PG.
- [ ] `scripts/test/schema-locks-ddl-invariant-db.mjs` (new, QA; паттерн `reliable-migrations.mjs`, `TEST_ADMIN_PG_URL`) -- (1) fresh scratch-БД: `ensureCatalogSchema` + `migrateFeatureFlags` → `security_events` ровно 6 колонок ожидаемых типов/nullability, PK `event_id`, индекс `security_events_created` btree `(created_at DESC)` non-unique valid (invariant целостности общей таблицы; контракт жёстко задан в тесте по DDL catalog); (2) независимость локов: сессия A держит `pg_advisory_xact_lock` ff-ключа в открытом tx, сессия B (lock_timeout 2s) успешно гоняет `migrateCatalog` на второй scratch-БД, и зеркально — A держит catalog-ключ, B — `migrateFeatureFlags`; плюс assert, что `hashtextextended`-значения ключей различаются; (3) существующая история: в ledger v1 с замороженным checksum → `migrateFeatureFlags` no-op, ready.
- [ ] `scripts/test/owned-postgres-acceptance.test.mjs` -- добавить `['schema-locks-ddl-invariant-db', 'TEST_ADMIN_PG_URL']` в `entries` -- admission-реестр покрывает новый тест.

**Acceptance Criteria:**
- Given существующая БД с ff-ledger v1, when запуск новой сборки (migrate + check --ready), then история валидна (checksum заморожен), `ready: true`, сервис стартует.
- Given fresh БД, when старт catalog + ff в любом порядке, then `security_events` существует (DDL catalog), `feature_flags` + ledger созданы, оба сервиса ready.
- Given удержанный ff-лок (и зеркально catalog-лок), when миграция другого сервиса, then завершается без ожидания; при возврате общего лока тест красный (lock_timeout).
- Given fresh dev-PG после init, then БД `skills` не создаётся; dev-стек поднимается, сервисы здоровы.
- Given `security_events` с изменённой колонкой/индексом (fixture-ALTER в QA-тесте), then invariant-тест падает с именем расхождения.
- `FlagsRepository.patch` продолжает писать `feature_flag.update` в `security_events` (покрыто неизменённым `flags-rollback-integrity.mjs`).

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Почему v1 замораживается, а не переписывается:** ledger-протокол AD-D1 — история неизменяема, checksum = sha256 SQL-текста; существующие БД содержат строку v1 со старым checksum, и `history()` (migrations.ts Л33-44) жёстко её сверяет. Прецедент каталога — baseline adoption (`validateMigrationHistory`: `adopted = first===0 && rows[0]?.version===1`): новые версии добавляются, старые не переписываются. Замороженный v1 idempotent (`IF NOT EXISTS`) и на fresh БД не конфликтует с catalog-миграцией 0 (одинаковый DDL). Двойное создание на fresh БД — допустимое следствие frozen-истории; с этого момента новые ff-миграции чужих таблиц не содержат.
2. **Почему ff при старте больше не валидирует `security_events`:** runtime-владелец — catalog; при отсутствии/дрейфе таблицы запись в `patch()` явно падает с откатом транзакции (ServiceUnavailable) — приемлемо; целостность общей таблицы — зона invariant-теста, а не старта сервиса.

## Verification

**Commands:**
- `node --test scripts/test/schema-locks-ddl-invariant.test.mjs` -- expected: all green (frozen checksum, отсутствие DDL/ghost-БД в источниках, разные ключи локов)
- `node --test scripts/test/owned-postgres-acceptance.test.mjs` -- expected: green, admission нового DB-теста (rejection + owned URL)
- `node --test scripts/test/schema-migration-coverage.test.mjs` -- expected: green без регрессии (замороженный v1 в SQL-графе)
- `TEST_ADMIN_PG_URL=<owned> node scripts/test/schema-locks-ddl-invariant-db.mjs` -- expected: green (owned PG: `node scripts/qa/cli.mjs postgres create` → URL из ответа, потом close)
- `npm run check -- --package feature-flags --step typecheck` / `--step build` / `--step test` -- expected: green (vitest `flag-validation.test.ts` не затронут)
- `npm run lint:root` / `npm run format:root:check` -- expected: green
- HITL (fresh dev): новый том `pgvector-data` → `docker compose up -d` → expected: postgres/catalog/ff здоровы, в PG `\l` нет БД `skills`; ff `/ready` 200.
