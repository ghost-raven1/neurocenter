---
title: 'Drift code→compose + фикс H5 (AD-OP-1, H5)'
type: 'feature'
ticket: '3'
created: '2026-11-06'
status: ready-for-dev
baseline_revision: 'fa8b92d94ea7d1dbd3d8cbf8576c066745564645'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md
  - _bmad-output/initiative-architecture/tickets/epic-release-baseline/epic-release-baseline.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Drift-тест AD-OP-1 работает только в направлении compose→code (1.2): env в compose без чтения в коде = dead-env. Обратное направление не покрыто: **required** env, которого нет в production compose, ничего не ловит — сервис стартует и тихо работает не так. Классический пример — H5: `BRIDGE_TEMPLATES_DIR` не задан в production compose, `bridge.controller.ts:18` fallback резолвится в `/bridge-dist` (не существует в образе; реально `/app/bridge-dist`), production bridge-endpoints `/api/bridge/*` → 404. Переменная в коде опциональна (есть fallback), поэтому compose→code её отсутствие никогда не поймает; валидация старта (`validateProduction`) её не требует — ловить может только явное декларирование «обязательно в production» + проверка присутствия в compose.

**Approach:** (1) Расширение модели `deploy/production/environment-model.json` полем `requiredEnv` на сервис (map имя → причина, машино-читаемая декларация production-контракта) + drift-тест направление code→compose: required env, отсутствующий в compose = фэйл с именем сервиса и переменной; phantom-защита: каждое имя из `requiredEnv` обязано читаться кодом (переиспользование `envReadInCode` из 1.2). (2) Фикс H5: `BRIDGE_TEMPLATES_DIR=/app/bridge-dist` в модели и production compose (структурный drift 1.2 принудит их равенство); `BRIDGE_DIST` мёртвой остаётся нигде (1.2 удалил из compose; модель её не содержит — проверяется dead-env направлением 1.2 при любом возврате). (3) Регресс-тест резолва шаблонов из собранного образа без docker-сборки: статическое извлечение image-layout из Dockerfile + арифметика fallback из `bridge.controller.ts:18` + кросс-сверка «значение в модели == цель COPY в Dockerfile». Живой стек (bridge-endpoints 200) — приёмка entry 1.13 e2e (явное ограничение, см. Design Notes).

## Boundaries & Constraints

**Always:**
- Тесты — `~/.nvm/versions/node/v24.22.0/bin/node` (системный node v16 падает); новый тест регистрируется в `scripts/workspace/check-tooling-tests.json` и в `expectedFiles` `scripts/test/workspace-check-tooling.test.mjs` (списки идентичны).
- Drift-тесты без Docker: парсинг YAML/JSON/Dockerfile + статический скан исходников (механизм 1.2: `loadProductionCompose`, `collectCodeFiles`, `envReadInCode`).
- Модель остаётся единственным машино-читаемым источником по production-стеку: изменение модели и compose — одним коммитом; значения env не проверяются на равенство конкретным значением (только наличие) — фиксированные значения (SSO_DISABLE=false, NODE_ENV=production, BRIDGE_TEMPLATES_DIR=/app/bridge-dist) уже закреплены структурным drift'ом `model.env` (1.2).
- Скоуп сверки = production-стек: `compose.production.yml` + overlay'и из модели. Dev-стек не трогаем.

**Never:**
- Правки `docker-compose.yml`, `.env.example`, dev-overlay, кода сервисов (bridge.controller.ts, runtime.cjs) — H5 закрывается окружением, не кодом; removal `BRIDGE_DIST` из dev compose/.env.example — entry 1.4 / sweep 12.
- Config-матрица dev/production, dev-обходы (SSO_DISABLE/RAG_AUTH_DISABLED), validateProduction, latest-теги — entry 4 (AD-OP-5). Dev-only required env не декларируется в production-модели (стык 1.4, Design Notes D3).
- Docker-сборка/запуск образов в CI-тестах (supply-ограничение): регресс H5 — статический/уровень unit (D5).
- Новые зависимости (js-yaml уже в root devDependency с 1.2).
- Расширение модели на dev-профиль, prometheus/alertmanager (AD-O6), artifact-cache (AD-D2) — другие сторис/эпики.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HAPPY_PATH | текущая модель + compose (после фикса H5) | 0 missing required, 0 phantom, 0 dead-env, 0 structural drift | No error expected |
| H5_REGRESSION | в fixture из compose удалён `BRIDGE_TEMPLATES_DIR` (api-gateway) | фэйл: `api-gateway.env` (structural) + missing `api-gateway`/`BRIDGE_TEMPLATES_DIR` (code→compose) с именем | assert с detail |
| MISSING_REQUIRED | в fixture из compose удалён любой required env (напр. `PANEL_URL`) | фэйл с именем сервиса и переменной | assert с detail |
| PHANTOM_REQUIRED | в fixture-модели `requiredEnv` добавлено имя, не читаемое кодом / не во `env` сервиса | фэйл с именем (phantom / не в env) | assert с detail |
| REQUIRED_VALUE_DRIFT | значение required env в compose ≠ модели | фэйл structural drift `service.env` (механизм 1.2, не новый) | assert с detail |
| EXTERNAL_SERVICES | model-runtime (ollama), postgres (pgvector), capacity-collector, database-init | `requiredEnv: {}` — тривиально проходят; внешние образы не могут иметь requiredEnv (нет codeRoots) | validateModelShape |
| BRIDGE_DIST_RETURN | кто-то вернул `BRIDGE_DIST` в compose | фэйл dead-env (направление 1.2: не читается кодом, пометки нет) | assert с detail |
| LIVE_STACK_200 | развёрнутый production-стек: `/api/bridge/install.sh` | 200, не 404 — **не в CI этой сторис**: e2e-линия entry 1.13 (REL-01) | — |

</frozen-after-approval>

## Code Map

- `compose.production.yml` — api-gateway :269-296 (environment :278-289; сюда добавляется `BRIDGE_TEMPLATES_DIR: /app/bridge-dist`); x-runtime-якорь :13-18 (NODE_ENV/BIND_HOST/PANEL_URL/NEUROCENTER_INTERNAL_TOKEN_FILE/NEUROCENTER_METRICS_TOKEN_FILE)
- `deploy/production/environment-model.json` — api-gateway :325-361 (env + envNotes); все 12 сервисов получают новое поле `requiredEnv`
- `services/api-gateway/src/bridge/bridge.controller.ts:18` — `this.dir = process.env.BRIDGE_TEMPLATES_DIR || path.resolve(__dirname, '..', '..', '..', '..', 'bridge-dist')` — источник fallback; НЕ меняется
- `services/api-gateway/Dockerfile` — :22 `WORKDIR /app`, :26 `COPY services/api-gateway/ .` (dist → `/app/dist`), :28 `COPY bridge-dist/ /app/bridge-dist/` (реальный путь шаблонов в образе), :44-45 `ENV NODE_ENV=production` / `ENV NEUROCENTER_SERVICE=api-gateway`, :48 `CMD ["node","dist/main.js"]` ⇒ в образе `__dirname` контроллера = `/app/dist/bridge`, fallback = `/bridge-dist` (H5)
- `services/shared/runtime.cjs` — :5-19 `secretNames` (производные `_FILE`), :87-188 `validateProduction` (единственный production-валидатор env today; источник исходного набора required), :191-193 вызов при импорте во всех 7 node-сервисах
- `scripts/production/environment-model.mjs` (1.2) — :205-227 `validateModelShape` (расширить под `requiredEnv`), :237-257 `structuralDrift`, :276-311 `collectCodeFiles`, :317-335 `envReadInCode` (переиспользовать для phantom-проверки), :370-396 `deadEnvironment` (направление 1.2, не менять), :399-403 `loadProductionCompose`
- `scripts/test/compose-drift.test.mjs` (1.2) — fixture :24-62 (mutateCompose/mutateModel — переиспользовать), :64-74 happy-тест (расширить assertion'ом required)
- `docker-compose.yml:85,95` — dev-стек: `BRIDGE_TEMPLATES_DIR=/app/bridge-dist` + volume `./bridge-dist:/app/bridge-dist:ro` — dev корректен (reference, не менять)
- `scripts/workspace/check-tooling-tests.json` + `scripts/test/workspace-check-tooling.test.mjs` (`expectedFiles`) — регистрация нового теста, списки держать идентичными

## Tasks & Acceptance

**Execution:**
- [ ] `deploy/production/environment-model.json` -- всем 12 сервисам поле `requiredEnv` (map имя → непустая причина; см. D2); api-gateway: `env.BRIDGE_TEMPLATES_DIR = /app/bridge-dist` + entry в `requiredEnv` (причина: потребляется кодом api-gateway, bridge.controller.ts; fallback в production-образе резолвится в `/bridge-dist` ≠ `/app/bridge-dist`; образ несёт шаблоны по `COPY bridge-dist/ /app/bridge-dist/`) -- фикс H5 в модели
- [ ] `compose.production.yml` -- api-gateway environment: `BRIDGE_TEMPLATES_DIR: /app/bridge-dist` -- фикс H5 в compose (структурный drift 1.2 требует равенства с моделью; один коммит с моделью)
- [ ] `scripts/production/environment-model.mjs` -- `validateModelShape`: `requiredEnv` обязан быть у каждого сервиса (map имя → непустая строка; ключи ⊆ `service.env`; у сервисов с пустыми `codeRoots` — только `{}`); новая функция `requiredEnvironmentDrift(model, services, {root, secretNames})` → `{missing: [{service, env}], phantom: [{service, env, reason}], noteErrors}`: missing = имя из requiredEnv отсутствует в env развёрнутого compose; phantom = имя из requiredEnv не находит чтения кодом (`envReadInCode` по `codeRoots` + `services/shared`, включая производные `_FILE` из `secretNames`) -- механизм code→compose
- [ ] `scripts/test/compose-drift.test.mjs` -- `fixture.report` расширяется вызовом `requiredEnvironmentDrift`; happy-тест: 0 missing/phantom; новые негативные сценарии матрицы через fixture (H5_REGRESSION: удалить `BRIDGE_TEMPLATES_DIR` из compose api-gateway; MISSING_REQUIRED: удалить `PANEL_URL`; PHANTOM_REQUIRED: имя в `requiredEnv` не во `env`/не читаемое кодом) -- AC
- [ ] НОВОЕ `scripts/test/bridge-templates-resolution.test.mjs` -- регресс H5 из образа без docker-сборки (D5): (1) из `services/api-gateway/Dockerfile` статически извлечь WORKDIR, цель `COPY bridge-dist/` (=/app/bridge-dist) и путь скомпилированного контроллера (`/app/dist/bridge`); (2) арифметика fallback ровно как в bridge.controller.ts:18 на `__dirname=/app/dist/bridge` ⇒ `/bridge-dist`, assert ≠ `/app/bridge-dist` (fallback в образе сломан — env обязателен); static-guard: строка :18 source всё ещё содержит тот же fallback-выражение (изменили код — тест падает, перепроверить); (3) кросс-сверка: `model.api-gateway.env.BRIDGE_TEMPLATES_DIR` == цель COPY из Dockerfile == значение в развёрнутом production compose (`loadProductionCompose`) ⇒ в развёрнутом стеке ветка `||` fallback никогда не выполняется -- AC
- [ ] `scripts/workspace/check-tooling-tests.json`, `scripts/test/workspace-check-tooling.test.mjs` -- добавить `scripts/test/bridge-templates-resolution.test.mjs` в оба отсортированных списка, идентично -- регистрация в tooling-шаге

**Acceptance Criteria:**
- Given текущая модель + compose (после фикса H5), when `node --test scripts/test/compose-drift.test.mjs`, then зелёно: 0 structural drift, 0 dead-env, 0 missing required, 0 phantom
- Given required env из модели удалён из production compose (fixture), when запуск сьюта, then фэйл с указанием сервиса и имени переменной
- Given в `requiredEnv` модели имя, не читаемое кодом (или отсутствующее в `env` сервиса), when запуск сьюта, then фэйл с указанием имени
- Given `scripts/test/bridge-templates-resolution.test.mjs`, then зелёно: fallback-арифметика = `/bridge-dist` (≠ реального `/app/bridge-dist`); значение модели = `/app/bridge-dist` = цели COPY Dockerfile = compose; BRIDGE_TEMPLATES_DIR присутствует в production compose
- Given `check --tooling`, when генерация плана, then новый тест в списке; `workspace-check-tooling.test.mjs` зелёный

## Design Notes — ключевые решения

**D1. «Required env из config schema» — interim-определение (AD-9 ещё не существует в коде).**
tickets.toml и AD-OP-1 формулируют направление как «required env из **config schema**». Факт: формальный typed config-модуль на сервис — решение AD-9 (architecture-runtime-trust, «Config schema = единственный источник имён env-переменных»), оно **пока не реализовано** и вне скоупа этого эпика (стык — epic-res-obs; план 1.2 зафиксировал: «Формальная config schema — стык AD-9 в epic-res-obs; здесь — только имена и модель»). Сегодня единственный production-валидатор env — `validateProduction` в `services/shared/runtime.cjs` (вызывается при импорте во всех 7 node-сервисах).
Решение (не угадывание, а зафиксированный interim-механизм): required = **явная машино-читаемая декларация** в модели (`requiredEnv`: имя → причина). Тест гарантирует трёхстороннюю согласованность:
1. `requiredEnv ⊆ compose env` (новое направление code→compose; отсутствие = фэйл с именем);
2. каждое имя `requiredEnv` **читается кодом** (переиспользование `envReadInCode` 1.2, включая производные `_FILE` из `secretNames`) — phantom-запись в модели = фэйл;
3. `compose env ⊆ читаемое кодом` (направление 1.2, dead-env).
Композиция 1+2+3 замыкает цикл: каждое required-env гарантированно и в compose, и читаемое кодом. Механизм не зависит от источника списка, поэтому при появлении AD-9 `requiredEnv` становится проекцией typed-схемы config-модуля — **стык задокументирован, работа AD-9 в 1.3 не дублируется**.
Отклонены: (B) парсинг `validateProduction` как источник списка — хрупко и принципиально пропущено BRIDGE_TEMPLATES_DIR (валидация её не требует — там тихий fallback, а не fail-fast); (C) статический скан «`process.env.X` без `||` fallback = required» — ненадёжно (fallback-выражения, конкатенации имён) и по определению слеп к H5-кейсу.

**D2. Начальный набор `requiredEnv` (производное от `validateProduction` + production-контракта; разработчик сверяет каждое имя с кодом).**
Общее для 6 long-running сервисов (кроме bootstrap-admin — `validateProduction` освобождает его): `NODE_ENV` (без `production` валидация старта молча не выполняется), `PANEL_URL`, `NEUROCENTER_INTERNAL_TOKEN_FILE`.
- api-gateway: `BRIDGE_TEMPLATES_DIR` (H5 — опционально в коде, обязательно в production-контракте: образ несёт шаблоны в `/app/bridge-dist`, fallback даёт `/bridge-dist`)
- catalog-service: `CATALOG_PG_URL_FILE`, `RAG_PG_URL_FILE`, `SKILLS_SERVICE_URL`
- rag-sync-service: `RAG_PG_URL_FILE`, `RAG_PROVISION_PG_URL_FILE`, `RAG_AUTH_DISABLED`
- feature-flags-service: `CATALOG_PG_URL_FILE`, `CATALOG_SERVICE_URL`
- oauth2-bridge: `SSO_DISABLE`, `SSO_HOST`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET_FILE`, `REDIRECT_URI`
- bootstrap-admin: `NODE_ENV`, `NEUROCENTER_SERVICE` (override ENV образа `catalog-service` — без него сервис валидируется как catalog-service), `CATALOG_PG_URL_FILE`, `BOOTSTRAP_ADMIN_EMAIL` (`bootstrap-admin.cli.ts` бросает при отсутствии при запуске; compose помечает `:?`)
- model-runtime, postgres (внешние образы) и one-shot'ы capacity-collector, database-init (env пуст): `{}`
Секреты декларируются в compose-видимой форме (`_FILE`), т.к. сверка идёт с env compose. Опциональные в production переменные (NEUROCENTER_METRICS_TOKEN_FILE, CHAT_S3_* — «все или ничего», деградация до null, API_PUBLIC_URL, NEUROCENTER_TLS_PROXY_ADDRESSES, SSO_SCOPE, ASSET_SOURCE_MODE, MODEL_HOSTING_ENABLED, BACKUP_* и пр.) в `requiredEnv` НЕ входят — они покрыты направлением 1.2. Значения не проверяются (только наличие): фиксированные значения уже закреплены структурным drift'ом `model.env`.

**D3. Dev-only required env — стык с entry 1.4, не дублирование.**
Модель описывает только production-стек; code→compose сверяет только production compose. Переменные, обязательные только в dev (обходы SSO_DISABLE=true/RAG_AUTH_DISABLED=true, dev-URL'ы, dev-порты), в production-модели не декларируются; их матрица, запрет в production и validateProduction-отказ — entry 1.4 (AD-OP-5). Функция `requiredEnvironmentDrift(model, services, …)` параметризована (модель + развёрнутые сервисы), так что 1.4 сможет применить тот же механизм к dev-профилю модели (расширение модели dev-профилем — задача 1.4, не этой сторис).

**D4. «consumedBy-семантика» для BRIDGE_TEMPLATES_DIR.**
Существующие пометки `envNotes` (external/builtin/consumedBy:command) не подходят: `consumedBy:command` проверяет `$NAME` в command контейнера, а BRIDGE_TEMPLATES_DIR потребляется **кодом** api-gateway. Реализуется полем `requiredEnv` как map имя → причина: причина обязанa явно называть потребителя (код сервиса, файл/механизм), почему переменная обязательна в production и каков правильный путь в образе. Для BRIDGE_TEMPLATES_DIR: «потребляется bridge.controller.ts (api-gateway); без env fallback резолвится в /bridge-dist (отсутствует в образе); образ несёт шаблоны в /app/bridge-dist (Dockerfile COPY)».
BRIDGE_DIST: в модели не появляется нигде (уже нет в compose после 1.2); повторное добавление в compose ловится dead-env 1.2 (не читается кодом, пометка не может быть легитимной).

**D5. Регресс-тест «из собранного образа» без docker-сборки — реалистичный уровень.**
Supply-ограничение: CI не собирает образы и не деплоит стек (сборка образов с pinned-registry — линия entry 1.1/1.13). Реалистичный уровень гарантии = 3 статических/unit-проверки (см. Tasks): (1) image-layout извлечён из самого Dockerfile (WORKDIR/COPY/CMD) — тест не хардкодит образ, а читает его рецепт; (2) арифметика fallback воспроизведена ровно по выражению `bridge.controller.ts:18` на `__dirname` скомпилированного контроллера в образе + static-guard на строку source (стиль drift-guard entry 1.7: код изменился → тест падает, перепроверить); (3) кросс-сверка значение модели ↔ цель COPY ↔ compose. Логика «fallback больше не срабатывает»: в развёрнутом стеке `process.env.BRIDGE_TEMPLATES_DIR` задан (принудительно — code→compose drift), выражение `process.env.X || fallback` коротко замыкается на env. **Явное ограничение:** проверка «bridge-endpoints отвечают 200, не 404, на развёрнутом production-стеке» (из verify tickets.toml) выполняется e2e-линией **entry 1.13 (REL-01)** на чистом хосте; 1.3 даёт статическую гарантию, 1.13 — приёмку на живом стеке.

**D6. Версия схемы модели.**
Поле `requiredEnv` добавляющее, обязательное для валидационной строгости (модель без поля = невалидна). Единственный потребитель модели — tooling этого репо (подтверждено: только `environment-model.mjs`/тесты). Версия `neurocenter-environment-model-v1` сохраняется; при появлении внешнего потребителя (supply-манифест 1.1, AD-O6/AD-D2) — пересмотреть на v2.

**Зафиксированные противоречия (честно, не угадываем):**
1. tickets.toml/AD-OP-1 говорят «required env **из config schema**», но config schema (AD-9) в коде не существует — она решение другого эпика (epic-res-obs). Разрешено D1 (interim: явная декларация в модели + phantom-защита через чтение кодом + задокументированный стык AD-9).
2. verify tickets.toml «bridge-endpoints на развёрнутом production-стеке отвечают 200» не выполним в CI 1.3 (нет docker-сборки/деплоя) — зафиксировано D5: статический уровень здесь, 200 на живом стеке — 1.13 e2e.
3. Формулировка «required из config schema» буквально не применима к BRIDGE_TEMPLATES_DIR: в коде она опциональна (fallback). Required-ность — свойство **production-развёртывания** (путь в образе), а не валидации кода; D1 расширяет определение required до «сервис стартует и работает корректно в production-контракте».

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/compose-drift.test.mjs` -- expected: зелёный сьют: 0 structural drift, 0 dead-env, 0 missing required, 0 phantom
- `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/bridge-templates-resolution.test.mjs` -- expected: зелёный (fallback=/bridge-dist ≠ /app/bridge-dist; модель=compose=Dockerfile-цель=/app/bridge-dist)
- `~/.nvm/versions/node/v24.22.0/bin/node --test scripts/test/workspace-check-tooling.test.mjs` -- expected: зелёный (регистрация синхронна)
- `~/.nvm/versions/node/v24.22.0/bin/node scripts/workspace/check.mjs --tooling` -- expected: гейт «Инструменты разработки: локальные контракты» зелёный
- (вне CI, приёмка 1.13): развёрнутый production-стек → `GET /api/bridge/install.sh` на api-gateway: 200, не 404
