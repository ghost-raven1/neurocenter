---
title: 'Config-матрица production без dev-обходов (AD-OP-5)'
type: 'feature'
ticket: '4'
created: '2026-11-06'
status: ready-for-dev
baseline_revision: 'fa8b92d9'
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

**Problem:** Production-конфиг может содержать dev-дефолты обходов (`SSO_DISABLE=true`, `RAG_AUTH_DISABLED=true`) или `latest`-теги образов без обнаружения на этапе CI/сборки: `validateProduction` ловит это только на старте сервиса (runtime), а drift-тест (1.2) проверяет только структурное равенство model↔compose и dead-env, но не семантические production-ограничения (AD-OP-5, R3).

**Approach:** Расширение модели 1.2 (`deploy/production/environment-model.json`) полем `productionEnvConstraints` (машино-читаемая матрица: env → допустимое production-значение) + новый статический чек в drift-тесте (без Docker): (1) env из `productionEnvConstraints` со значением ≠ constraint в любом сервисе модели → фэйл; (2) `latest`-тег образа в модели → фэйл. `validateProduction` (уже в `services/shared/runtime.cjs:87`, вызов на импорте модуля) — runtime-слой, не меняется. Живая e2e-проверка — entry 13 (REL-01).

## Boundaries & Constraints

**Always:**
- Модель (`environment-model.json`) — единственный машино-читаемый источник production-окружения; ограничения матрицы кодируются в ней, не в отдельном файле.
- Тесты — `~/.nvm/versions/node/v24.22.0/bin/node` (системный node v16 падает); новые тесты регистрируются в `scripts/workspace/check-tooling-tests.json` и `expectedFiles` `scripts/test/workspace-check-tooling.test.mjs` (списки идентичны).
- Drift-тест без Docker: статический анализ модели + compose (уже есть в 1.2).
- Приватные значения из `deploy/production/local/.env` в плане и в тестовых fixtures НЕ раскрываются.

**Never:**
- Правки `validateProduction` в `services/shared/runtime.cjs` (механизм уже есть, runtime-слой не меняется в этой сторис).
- Правки `configuration.mjs` / `setup.mjs` (configure уже не пишет dev-обходы в production `.env` — ратификация текущего механизма, см. Design Notes).
- code→compose-направление (required env из config schema) и фикс H5 — entry 3 (AD-OP-1); не дублировать.
- Dev-стек (`docker-compose.yml`, `.env.example`): чистка мёртвых имён в dev — sweep 12, не сюда.
- Новые зависимости.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | текущая модель: `SSO_DISABLE=false`, `RAG_AUTH_DISABLED=false`, нет `latest` | сьют зелёный | No error expected |
| DEV_OVERRIDE_SSO | `SSO_DISABLE=true` в env любого сервиса модели | фэйл с указанием сервиса и переменной | assert с detail |
| DEV_OVERRIDE_RAG | `RAG_AUTH_DISABLED=true` в env `rag-sync-service` | фэйл с указанием сервиса и переменной | assert с detail |
| LATEST_TAG | `image: "neurocenter/catalog-service:latest"` в модели | фэйл с указанием сервиса | assert с detail |
| CONSTRAINT_ABSENT | переменная из `productionEnvConstraints` отсутствует в сервисе | OK (отсутствие ≠ нарушение; runtime-обязательность — `validateProduction`) | No error expected |
| TEMPLATE_VAR | `image: "…:${NEUROCENTER_RELEASE:?…}"` (тег-переменная compose) | OK (не `latest`, подстановка на деплое) | No error expected |
| DIGEST_PINNED | `image: "…@sha256:…"` (digest-pinned) | OK | No error expected |

</frozen-after-approval>

## Code Map

- `deploy/production/environment-model.json` — модель production-стека (12 сервисов, 109 env, entry 2); добавить top-level `productionEnvConstraints`; `env` сервисов уже содержит `SSO_DISABLE:"false"` (bootstrap-admin :128, oauth2-bridge :315) и `RAG_AUTH_DISABLED:"false"` (rag-sync-service :284)
- `scripts/production/environment-model.mjs` — `validateModelShape` :205 (добавить валидацию нового поля), `SERVICE_FIELDS` :19 (не менять); новый exported `productionConstraintViolations(model)` :~230
- `scripts/test/compose-drift.test.mjs` — fixture :24 (переиспользовать), `report()` :50 (добавить constraint-чек); новые тесты :~240
- `scripts/test/production-runtime.test.cjs` :64-70 — runtime-слой уже покрыт: `SSO_DISABLE=true`/`RAG_AUTH_DISABLED=true` → throw (НЕ менять)
- `services/shared/runtime.cjs` :87-188 — `validateProduction` (НЕ менять): :103-107 проверка флагов, :138 `oauth2-bridge` требует `SSO_DISABLE=false`, :185 `rag-sync-service` требует `RAG_AUTH_DISABLED=false`
- `scripts/production/configuration.mjs` :234-252 — `values` для production `.env`: dev-обходы НЕ пишутся (ратификация); :73 `release === 'latest'` → throw (уже есть)
- `scripts/workspace/check-tooling-tests.json` :10 — `scripts/test/compose-drift.test.mjs` уже зарегистрирован (не добавлять новый файл)
- `scripts/test/workspace-check-tooling.test.mjs` — `expectedFiles` :16-69 (не менять, тест уже зарегистрирован)

## Tasks & Acceptance

**Execution:**
- [ ] `deploy/production/environment-model.json` — добавить top-level `"productionEnvConstraints": { "SSO_DISABLE": "false", "RAG_AUTH_DISABLED": "false" }` (рядом с `"schema"`) -- машино-читаемая матрица ограничений production
- [ ] `scripts/production/environment-model.mjs` — (1) `validateModelShape`: опциональное поле `productionEnvConstraints` — если есть, должен быть map `{ [A-Z][A-Z0-9_]*: string }`; (2) новый exported `productionConstraintViolations(model)` : возвращает `[{service, env, value, expected}]` для каждого сервиса, где env из `productionEnvConstraints` имеет значение ≠ expected; (3) новый exported `latestTagViolations(model)` : возвращает `[{service, image}]` для каждого сервиса, чей image-тег = `latest` (литерал, не compose-переменная) -- механизм проверки
- [ ] `scripts/test/compose-drift.test.mjs` — (1) в `report()` fixture добавить `constraintViolations` и `latestViolations` (вызовы новых функций); (2) тесты: HAPPY_PATH (текущая модель — 0 нарушений), `SSO_DISABLE=true` → фэйл, `RAG_AUTH_DISABLED=true` → фэйл, `latest`-тег → фэйл, отсутствие переменной из constraints → OK, `${NEUROCENTER_RELEASE:…}` → OK -- AC
- [ ] `scripts/workspace/check-tooling-tests.json`, `scripts/test/workspace-check-tooling.test.mjs` — НЕ менять (тест `compose-drift.test.mjs` уже зарегистрирован в обоих списках) -- регистрация

**Acceptance Criteria:**
- Given текущая модель (SSO_DISABLE=false, RAG_AUTH_DISABLED=false, нет latest), when `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/compose-drift.test.mjs`, then зелёно: 0 constraint-нарушений, 0 latest-нарушений, все структурные проверки 1.2 проходят
- Given модель с `SSO_DISABLE=true` в любом сервисе, when запуск сьюта, then фэйл с указанием сервиса, имени переменной, полученного и ожидаемого значения
- Given модель с `RAG_AUTH_DISABLED=true`, when запуск сьюта, then фэйл с указанием сервиса и переменной
- Given модель с `image: "neurocenter/catalog-service:latest"`, when запуск сьюта, then фэйл с указанием сервиса
- Given модель с `image: "…:${NEUROCENTER_RELEASE:?…}"` (compose-переменная), when запуск сьюта, then OK (не latest)
- Given переменная из `productionEnvConstraints` отсутствует в сервисе модели, when запуск сьюта, then OK (отсутствие ≠ нарушение; runtime-обязательность — `validateProduction`)
- Given `validateProduction({ SSO_DISABLE: 'true' }, 'oauth2-bridge')`, then throw (runtime-слой, уже покрыт в `production-runtime.test.cjs`, не менять)
- Given `check --tooling`, when генерация плана, then `compose-drift.test.mjs` в списке; `workspace-check-tooling.test.mjs` зелёный

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

**1. `validateProduction` — существующий механизм, не создавать заново.**
`services/shared/runtime.cjs:87` — вызывается на импорте модуля (:193). Уже проверяет: `SSO_DISABLE`/`RAG_AUTH_DISABLED` ≠ `false` → throw (:103-107); `oauth2-bridge` требует `SSO_DISABLE=false` (:138); `rag-sync-service` требует `RAG_AUTH_DISABLED=false` (:185). Runtime-тесты уже в `scripts/test/production-runtime.test.cjs:64-70`. Эта сторис НЕ меняет `runtime.cjs`.

**2. Ратификация 0700-каталога с file-secrets.**
Механизм уже реализован в `scripts/production/configuration.mjs`: `mkdir(dest, {mode:0o700})` (:186), `chmod(dest, 0o700)` (:192), `mkdir(secrets, {mode:0o700})` (:194), `privateWrite` с `mode:0o600` (:140). Production `.env` — 0600 файл в 0700-каталоге, секреты — 0600 файлы в `secrets/` (0700). `configure` НЕ пишет `SSO_DISABLE`/`RAG_AUTH_DISABLED` в production `.env` (:234-252 — список значений не включает эти флаги). Это — ратификация текущего механизма: документирование, что 0700-каталог с file-secrets = целевой production-конфиг, без изменений в коде.

**3. Матрица кодируется расширением модели 1.2, не отдельным артефактом.**
Поле `productionEnvConstraints` (top-level в `environment-model.json`) — машино-читаемая часть матрицы: env → допустимое production-значение. Остальная часть матрицы (разрешено отличаться: env_file vs 0700-каталог, порты 127.0.0.1 vs 80/443, build vs метка-релиза) — свойства модели/compose, которые drift-тест 1.2 уже сверяет структурно. Отдельный файл-матрица не нужен: модель = production-окружение, constraints = ограничения.

**4. Граница с entry 3 (AD-OP-1, H5).**
Entry 3: code→compose (required env из config schema не в compose = фэйл) + явный `BRIDGE_TEMPLATES_DIR=/app/bridge-dist` в модели + H5-регресс. Entry 4 (эта сторис): семантические production-ограничения (значения env, latest-теги) + матрица. Не пересекаются: entry 3 проверяет НАЛИЧИЕ required env, entry 4 проверяет ЗНАЧЕНИЯ env и тегов образов.

**5. Верификация без живого стека.**
Уровень верификации: (a) unit-тест `validateProduction` (runtime-слой, уже есть — `production-runtime.test.cjs:64-70`); (b) drift-тест (статический анализ модели, без Docker — новый); (c) живая e2e-проверка «production-старт с dev-обходом → отказ» = entry 13 (REL-01, e2e). В этой сторис уровень (a)+(b) достаточен; (c) фиксируется как ответственность entry 13.

**6. `latest`-тег: литерал vs compose-переменная.**
В модели тег = `${NEUROCENTER_RELEASE:?Заполните метку релиза}` (compose-переменная, подстановка на деплое) — НЕ `latest`, проверка не срабатывает. Литерал `:latest` в image = фэйл. `configure` уже запрещает `release === 'latest'` (`configuration.mjs:73`) — двойная защита: configure на входе + drift-тест на модели.

**7. Отсутствие переменной из constraints ≠ нарушение.**
Если `SSO_DISABLE` отсутствует в сервисе модели — это OK. Runtime-обязательность (`oauth2-bridge` должен иметь `SSO_DISABLE=false`) обеспечивается `validateProduction` (:138). Drift-тест проверяет только: если переменная ЕСТЬ, значение должно быть = constraint.

## Verification

**Commands:**
- `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/compose-drift.test.mjs` -- expected: зелёный сьют (все тесты 1.2 + новые constraint/latest-тесты)
- `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/production-runtime.test.cjs` -- expected: зелёный (runtime-слой, не менять)
- `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/workspace-check-tooling.test.mjs` -- expected: зелёный (регистрация синхронна, новый файл не добавляется)
- `~/.nvm/versions/node/v24.22.0/bin/node scripts/workspace/check.mjs --tooling` -- expected: гейт «Инструменты разработки: локальные контракты» зелёный
