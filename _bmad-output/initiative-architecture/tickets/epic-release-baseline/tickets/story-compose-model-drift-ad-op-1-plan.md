---
title: 'Модель окружения + drift-тест compose→code (AD-OP-1)'
type: 'feature'
ticket: '2'
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
  - '{project-root}/_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-release-baseline/epic-release-baseline.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Production compose живёт независимо от кода: env-переменные задаются без чтения в коде (BRIDGE_DIST, AUTH_GUARD_ENABLED, ASSET_SYNC_NODE_BIN/MCP_BIN) и единственной машино-читаемой модели окружения нет (AD-OP-1, R2).

**Approach:** Модель production-стека как данные (`deploy/production/environment-model.json`: сервис → образ+digest/тег, сети, mem/cpus/pids, read_only/cap/seccomp, секреты, порты, volumes, env) + tooling drift-тест направление compose→code: структурная сверка model↔compose и dead-env (env из compose, не читаемый кодом = фэйл с именем переменной).

## Boundaries & Constraints

**Always:**
- Модель — единственный машино-читаемый источник по production-стеку; compose сверяется с ней.
- Нечитаемый в коде env удаляется из compose ИЛИ помечается в модели явно (external / builtin / consumedBy:command); безмолвный allowlist запрещён.
- Тесты — `~/.nvm/versions/node/v24.22.0/bin/node` (системный node v16 падает); новый тест регистрируется в `scripts/workspace/check-tooling-tests.json` и в `expectedFiles` `scripts/test/workspace-check-tooling.test.mjs` (списки идентичны).
- Drift-тест без Docker: парсит YAML и сканирует исходники.

**Never:**
- code→compose-направление (required env из config schema) и фикс H5 (BRIDGE_TEMPLATES_DIR) — entry 3; config-матрица dev/production, dev-обходы, validateProduction, latest-теги — entry 4.
- Правки `docker-compose.yml`, `.env.example`, dev-overlay и кода сервисов (удаление мёртвого env — поведенчески нейтрально, нигде не читается).
- Новые зависимости, кроме js-yaml@5.2.2 в root (версия уже в lockfile'ах frontend/catalog-service — локальный registry).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | чистый checkout, модель == compose | сьют зелёный, 0 dead-env | No error expected |
| DEAD_ENV | новая переменная в env compose-сервиса, не читается кодом | фэйл с именем переменной и сервисом | assert с detail |
| MODEL_DRIFT | compose отличается от модели (pids_limit/secrets/ports) | фэйл с указанием service.field | assert с detail |
| ALLOWLIST_BYPASS | external/builtin-переменная без пометки в модели | фэйл (посмотреть пометку) | assert с detail |
| OVERLAY | dead-env в production overlay (chat-storage/web-restore) | фэйл с именем переменной | assert с detail |
| ANCHORS | compose с `<<: *service` / `<<: *runtime` | имена собраны после merge-ключей | — |

</frozen-after-approval>

## Code Map

- `compose.production.yml` — production-стек: x-service :2, x-runtime :12-17, services :19-320, secrets :322-333, networks/volumes :334-345; мёртвые env: :232-233 (ASSET_SYNC_NODE_BIN/MCP_BIN), :285-286 (AUTH_GUARD_ENABLED, BRIDGE_DIST)
- `compose.chat-storage.yml`, `compose.web-restore.yml` — production overlay (CHAT_S3_*, RESTORE_RUNNER_TOKEN_FILE) — в scope сверки
- `scripts/production/compose-client.mjs` — `applicationServices` :11-19 (канон 7 сервисов, переиспользовать); `composeClient` :126 в тесте НЕ использовать (нужен Docker)
- `services/shared/runtime.cjs` — config-ядро: `secretNames` :5-19 → производные `NAME+'_FILE'` читаются динамически :33; `validateProduction` :87; импорто-время :184-186 — источник производных имён для сканера
- `scripts/workspace/check-tooling-tests.json` + `scripts/test/workspace-check-tooling.test.mjs` (`expectedFiles` :16-69, deepEqual args :167) — регистрация tooling-тестов, списки держать идентичными
- `package.json` (root) — devDependencies: добавить js-yaml@5.2.2
- НОВОЕ: `deploy/production/environment-model.json` (модель), `scripts/production/environment-model.mjs` (загрузчик + сканер), `scripts/test/compose-drift.test.mjs` (тест)

## Tasks & Acceptance

**Execution:**
- [ ] `package.json`, `package-lock.json` -- js-yaml@5.2.2 в root devDependency через локальный registry -- YAML-парсинг в тесте
- [ ] `deploy/production/environment-model.json` -- модель production-стека: 12 сервисов compose.production.yml + 2 overlay (образ+digest/тег, сети, mem/cpus/pids, read_only/cap/seccomp, секреты, порты, volumes, env, codeRoots, пометки external/builtin/consumedBy) -- единственный машино-читаемый источник
- [ ] `scripts/production/environment-model.mjs` -- загрузчик модели + разбор compose (js-yaml, merge-ключи, onlay-merge) + сканер «читается кодом»: `process.env.X`, строковые литералы имён в `codeRoots` сервиса + `services/shared`, производные `NAME_FILE` из `secretNames` runtime.cjs -- механизм, переиспользуемый entry 3
- [ ] `scripts/test/compose-drift.test.mjs` -- drift compose→code: структурная сверка model↔compose + dead-env с именем в фэйле; негативные сценарии матрицы через временную копию compose -- AC
- [ ] `compose.production.yml` -- удалить 4 мёртвых env: :232-233, :285-286 -- «0 dead-env в production compose»
- [ ] `scripts/workspace/check-tooling-tests.json`, `scripts/test/workspace-check-tooling.test.mjs` -- добавить `scripts/test/compose-drift.test.mjs` в оба отсортированных списка, идентично -- регистрация в tooling-шаге

**Acceptance Criteria:**
- Given чистый checkout, when `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/compose-drift.test.mjs`, then зелёно: 0 dead-env в production compose (включая overlay), все поля модели совпадают с compose
- Given добавленная в production compose переменная, не читаемая кодом, when запуск сьюта, then фэйл с указанием имени переменной и сервиса
- Given модель разошлась с compose (mem/cpus/pids, secrets, ports, volumes), when запуск сьюта, then фэйл с указанием service.field
- Given `check --tooling`, when генерация плана, then новый тест в списке; `workspace-check-tooling.test.mjs` зелёный

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

- «Читается кодом» = статический скан (process.env.X + строковые литералы имён в src сервиса) + производные `NAME_FILE` из `secretNames` (runtime.cjs:33 читает `env[name + '_FILE']`). Формальная config schema — стык AD-9 в epic-res-obs; здесь только имена и модель.
- Scope drift-теста = production: compose.production.yml + production overlay. Dev-стек (docker-compose.yml, *.dev.yml) — матрица entry 4 (AD-OP-5); те же мёртвые имена в dev compose и .env.example чистятся там или в sweep 12.
- NODE_TLS_REJECT_UNAUTHORIZED — builtin Node (уходит entry 10), NEUROCENTER_HOST — потребляется envsubst в command фронта, model-runtime/postgres — чужие образы: все только с явными пометками в модели.
- BRIDGE_DIST удаляется здесь (compose→code: compose не может держать мёртвый env); добавление BRIDGE_TEMPLATES_DIR и H5-регресс — entry 3.

## Verification

**Commands:**
- `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/compose-drift.test.mjs` -- expected: зелёный сьют
- `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/workspace-check-tooling.test.mjs` -- expected: зелёный (регистрация синхронна)
- `~/.nvm/versions/node/v24.22.0/bin/node scripts/workspace/check.mjs --tooling` -- expected: гейт «Инструменты разработки: локальные контракты» зелёный
