---
title: 'REL-01: приёмка замороженного кандидата (e2e)'
type: 'feature'
ticket: '13'
created: '2026-11-06'
status: ready-for-dev
baseline_revision: 'a946a7b2'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md'
  - '{project-root}/_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md'
  - '{project-root}/_bmad-output/initiative-architecture/architecture-data/architecture-data.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-release-baseline/epic-release-baseline.md'
  - '{project-root}/docs/production-setup.md'
  - '{project-root}/_bmad-output/initiative-architecture/.memlog.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Эпик 1 (release-baseline) закрыт по частям (1.1–1.12), но ни одна линия не доказала, что **замороженный кандидат релиза** проходит полный промышленный цикл на **чистом хосте** целиком: чистый git-checkout → воспроизводимая сборка → верифицированный манифест `neurocenter-release-v1` → production-деплой **с образов манифеста** → все приёмо-контрольные проверки (drift оба направления, H5 200, `validateProduction`, supply/TLS, schema лок/DDL/ghost-БД). Каждая часть проверена изолированно (unit / static / свой e2e-сегмент), но связка «source↔version↔digest↔descriptor↔SHA» (REL-01) и детерминизм повторной сборки с того же commit (R1) **доказаны только на уровне контекста сборки** (stretch 1.1: `normalizeBuildContext` — content-уровень, 5215 entry идентичны), а **digest-уровень** (полная docker-сборка → одинаковые image ID) — пока нет. REL-01 — предпосылка всех P0-приёмок (PRD C1) и базис для следующих эпиков: без него нет «кандидата, от которого строятся все последующие эпики».

**Approach:** Новая e2e-линия `scripts/test/release-candidate-e2e.mjs` (driver), которая оркестрирует полный цикл на **чистом хосте** (или его симуляции — fresh compose-проект + fresh volumes + чистый docker-статус, как в `production-stack.mjs`, но с чистой сборкой, а не с уже собранными образами). Линия = 6 фаз: (F1) freeze — оператор зафиксировал commit + git-tag, манифест связан с ними; (F2) clean-checkout build — два чистых kлона/воркtree одного commit → `setup.mjs build` → два верифицированных манифеста; (F3) digest-детерминизм — `images`/`postgresImage` двух манифестов идентичны; (F4) deploy-from-manifest — pinned compose overlay из `images`/`postgresImage` манифеста (паттерн `update.mjs:373-386`) → `up --no-build --wait` → `assertLive` (каждый контейнер = image ID из манифеста); (F5) проверки — drift (оба направления, static), H5 200 (live GET bridge-endpoints), `validateProduction` (позитив + негатив dev-обхода), supply (закрытый контур, `--pull never`), TLS (post-1.10: глобального отключения нет, верификация принудительна), schema (лок/DDL/ghost-БД, live); (F6) отчёт — `release-candidate-e2e.json` (кандидат, commit, tag, digests, все проверки). Большая часть фаз — HITL (запуск на хосте, выбор кандидата, сеть); автоматизируем то, что автоматизируется офлайн/повторяемо (F3, F5-static, F6).

## Boundaries & Constraints

**Always:**
- Линия стартует с **чистого git-checkout** кандидата: `assertCleanCheckout` (`release-manifest.mjs:363`) — `git status --porcelain` ≠ пусто → фэйл до docker; commit SHA из `git rev-parse HEAD` в манифесте.
- **Кандидат заморожен**: git-tag на release-commit + `manifest.release` == имя tag + `manifest.commit` == SHA тега. Тег создаётся оператором (HITL, имя = `NEUROCENTER_RELEASE`); driver только **сверяет** связку tag↔manifest, не создаёт тег.
- **Детерминизм**: два чистых клона одного commit → `setup.mjs build` в каждом → секции `images` (7) + `postgresImage` идентичны побайтово (это digest-уровень, которого не было в stretch 1.1).
- **Деплой с образов манифеста**: pinned overlay `image: <sha256-id>` из `manifest.images`/`postgresImage` (паттерн `update.mjs:373-386`/`assertLive:160`) → `up -d --no-build --pull never --wait` → `assertLive`: каждый из 7 app + postgres работает именно с image ID из манифеста.
- Все проверки F5 — на **завёрнутом стеке** из образов манифеста (не из `latest`, не из dev).
- Приватные значения из `deploy/production/local/.env` и секретов в плане и fixtures НЕ раскрываются; production-конфиг — 0700-каталог с file-secrets (ратификация AD-OP-5).
- Повторяемый гейт — на **этой машине** с `NODE_OPTIONS=--dns-result-order=ipv4first` в build-контейнерах (вариант B, см. Design Notes 5); истинный «чистый хост» (вариант A) — отдельный HITL-шаг, когда хост доступен.
- Тесты/сборка — `~/.nvm/versions/node/v24.22.0/bin/node` (системный node v16 падает: `structuredClone`/`t.after`); это рантайм-версия из Dockerfile'ов.

**Never:**
- Не править production-код сервисов, `validateProduction` (`runtime.cjs`), compose-схемы, `configuration.mjs`, `update.mjs` — это территория сторис 1.1–1.12; e2e-линия **конsumирует** их артефакты, не пересобирает.
- Не обходить чистого-checkout гейта и `--pull never` (закрытый контур, AD-OP-2/AD-15); внешние registry (npmjs.org) не источник поставки.
- Не деплоить с `latest`-тега или с непроверенного image ID (только из верифицированного манифеста).
- Не подменять/удалять `schema-initialization.json` (квитанцию) ради обхода проверки (production-setup.md).
- Не вводить в e2e «доверять всем адресам» TLS (post-1.10: глобальное отключение запрещено, AD-OP-7).
- Не выполнять публикацию supply-тарболов в registry (жёсткая директива пользователя 2026-11-06 — только чтение/вендор).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FROZEN_CANDIDATE | release-commit + git-tag, `manifest.release`==tag, `manifest.commit`==SHA тега | F1 зелёный, кандидат зафиксирован | расхождение tag↔manifest → фэйл с указанием поля |
| CLEAN_BUILD | чистый checkout, docker, закрытый контур (registry+vendor) | манифест `<dir>/releases/<rel>/release-manifest.json`, верификация OK | — |
| DIRTY_TREE | незакоммиченные/неотслеживаемые изменения | фэйл до docker (гейт 1.1) | явное сообщение, exit 1 |
| DETERMINISM | два чистых клона одного commit, два build | `images`+`postgresImage` двух манифестов идентичны | любой различающийся digest → фэйл с парой сервис/ид |
| MANIFEST_VERIFY | пересчёт после build (image ID + supply hash + migrations) | `verifyReleaseManifest` пуст | непустой список расхождений → фэйл сборки |
| DEPLOY_MANIFEST | pinned overlay из `manifest.images`, `up --no-build --wait` | `assertLive`: 7 app + postgres = image ID манифеста | расхождение образа контейнера → фэйл |
| DRIFT_COMPOSE_TO_CODE | static `deadEnvironment` (compose→code) | 0 dead-env, 0 noteErrors | имя env+сервис в сообщении |
| DRIFT_CODE_TO_COMPOSE | static `requiredEnvironmentDrift` (code→compose) | 0 missing, 0 phantom | имя env+сервис в сообщении |
| DRIFT_STRUCTURAL | static `structuralDrift` (model↔compose, 12 сервисов) | 0 drift | `service.field` в сообщении |
| H5_200 | live `GET /api/bridge/{config,install.sh,runtime/*}` на развёрнутом стеке | 200, не 404; `install.sh` без `__BASE_URL__`/`__SITE_URL__`/`__RECONNECT__` | 404 = H5-регресс (HITL-эскалация) |
| VALIDATE_PRODUCTION | production-конфиг без dev-обходов, старт стека | все сервисы стартуют (runtime-валидация пройдена) | — |
| VALIDATE_PRODUCTION_REJECT | production `.env` с `SSO_DISABLE=true` | сервис старт **отклонён** (validateProduction на импорте) | явная ошибка сервиса |
| SUPPLY_CLOSED | сборка/деплой на чистом хосте | только локальный registry + `file:vendor`; `--pull never`; 0 обращений к npmjs.org | обращение к внешнему registry → фэйл |
| TLS_ENFORCED | post-1.10: production-образы/compose | `NODE_TLS_REJECT_UNAUTHORIZED=0` нет; исходящий вызов на невалидный сертификат → reject | presence=0 / reject нарушен → фэйл |
| SCHEMA_LOCKS | live: сессия держит ff-лок, миграция catalog (и зеркально) | завершается без ожидания | lock_timeout (negative control) |
| SCHEMA_DDL | live: fresh БД после init+migrate | `security_events` существует (DDL catalog), ff-сервис её не создаёт | отсутствие/дрейф → фэйл |
| SCHEMA_GHOST | live: `pg_database` после init | только `catalog`+`rag`+`nc_rag_*`; `skills` нет | `skills` найден → фэйл |
| HOST_VARIANT_A | чистый хост с корректным IPv4-маршрутом к registry | build OK без IPv4-фикса | — |
| HOST_VARIANT_B | эта машина, `NODE_OPTIONS=--dns-result-order=ipv4first` в build-контейнерах | build OK (обход сломанного IPv6-default-route) | timeout npm-ci → фэйл |

</frozen-after-approval>

## Code Map

**Сборка и манифест (1.1, AD-OP-2):**
- `scripts/production/release-manifest.mjs` — `validateReleaseManifest:90` (схема: format/commit/release/7×images/postgresImage/supply/migrations), `buildReleaseManifest:125`, `verifyReleaseManifest:169` (пересчёт → список расхождений), `supplyInventory:288` (runtime/opencode `.tgz` + 8 installers + vendorContract, streaming sha256), `normalizeBuildContext:316` (mtime→SOURCE_DATE_EPOCH), `assertCleanCheckout:363` (rev-parse HEAD + status --porcelain), `releaseOfEnv:392`, `writeReleaseManifest:138` (atomic 0600), `buildProductionRelease:436` (полный цикл build).
- `scripts/production/setup.mjs` — build-режим `:113-129` (точка врезки F2), `up/seed:138-185` (F4-опора: database-init → runSchemaCommands → migrate → assertProductionModelKey → bootstrap-admin → up), `configure:98-103`.
- `scripts/production/compose-client.mjs` — `applicationServices:11-19` (7 сервисов), `serviceImageIds:235` (image ID через `docker image inspect`), `composeConfiguration:226`, `maintenanceLock:182`, `docker:22`.

**Деплой с образов манифеста (паттерн из 1.2/1.3/1.4 update-flow):**
- `scripts/production/update.mjs` — `topology:100` (сравнение без image), `assertLive:160` (контейнер State.Health=healthy + Image=ожидание), **pinned overlay `:373-386`** (`services[svc].image = <id>`), **pinned-schemas overlay `:256-265`** (аналогичный overlay `pinned-schemas.json` под `runSchemaCommands check` на pinned-образах — переиспользуем в F5-schema), `preflightUpdate:176`, `updateProduction:289` (журнал + backup + apply). e2e переиспользует **только** pinned-overlay + pinned-schemas overlay + `assertLive` (без backup/rollback — это fresh-deploy, не update).

**Проверки:**
- `scripts/production/environment-model.mjs` — `structuralDrift:258` (model↔compose, 12 сервисов, 14 полей), `deadEnvironment:391` (compose→code), `requiredEnvironmentDrift:425` (code→compose: missing/phantom/noteErrors), `loadProductionCompose:456` (base+2 overlay), `envReadInCode:338`, `parseSecretNames:281` (из `runtime.cjs`).
- `deploy/production/environment-model.json` — модель (12 сервисов, 109 env, 36 requiredEnv, envNotes).
- `scripts/test/compose-drift.test.mjs` — fixture `:25`, `report():50` (drift+dead+required), тесты обоих направлений (1.2/1.3); F5-static **вызывает те же exported функции** на файлах развёрнутого стека.
- `services/shared/runtime.cjs` — `validateProduction:87-188` (на импорте `:193`): `:103-107` флаги SSO/RAG, `:108-110` TLS (post-1.10: без api-gateway-исключения), `:137-148` oauth2-bridge (SSO_DISABLE=false, REDIRECT_URI), `:185-187` RAG_AUTH_DISABLED. **Не менять.**
- `scripts/test/production-stack.mjs` — **существующий e2e-harness** (build→up→~30 live-чеков; local Blitz fixture, unique project, fresh volumes). e2e F4/F5 **переиспользует** его `configureProduction`+override+`request()`+fixtures; НЕ дублирует.
- `scripts/test/production-bridge.fixture.mjs` — `verifyProductionBridge:9` = **H5 200 live**: `:19-43` `GET /api/bridge/runtime/*.tgz.json/.sha256` 200, `/api/bridge/install.sh?reconnect=1` 200 без `__*__`-плейсхолдеров, `/api/bridge/config` 200 `{origin}`.
- `scripts/test/bridge-templates-resolution.test.mjs` — H5 static-guard (без docker); `:19-22` явно: «bridge-endpoints отвечают 200, не 404, на развёрнутом production-стеке принимается **e2e-линией entry 1.13** на чистом хосте».
- `services/api-gateway/src/bridge/bridge.controller.ts` — `@Controller(['bridge','api/bridge']):13`, fallback `:18` (`BRIDGE_TEMPLATES_DIR || /bridge-dist` — H5), endpoints `:22-126` (config/install.*/connect.*/opencode/:file/runtime/:file).
- `scripts/production/schema-migrations.mjs` — `runSchemaCommands:78` (check/migrate, ready+applied+pending), `inspectSchemaManifests:37` (опись из pinned-образа).
- `scripts/production/schema-initialization.mjs` — `noApplicationContainers:123` (ghost/конфликт), `identitySql:37` (system_identifier + OIDs catalog/rag = кластер-identity), `prepareSchemaInitialization:151` (requestKey-лок, DDL-квитанция initializing→schema-ready, binding envSha256/configSha256/images/cluster).
- `scripts/test/schema-locks-ddl-invariant.test.mjs` + `schema-locks-ddl-invariant-db.mjs` (1.11) — статические + QA-инварианты: ff-лок ≠ catalog-лок, DDL `security_events` только catalog, ghost-БД `skills` нет. F5-schema **live-сегмент** расширяет их на развёрнутый стек.

**TLS и supply (1.9/1.10):**
- `compose.production.yml:277` — api-gateway `NODE_TLS_REJECT_UNAUTHORIZED: '0'` (current, pre-1.10), `:287` `BRIDGE_TEMPLATES_DIR: /app/bridge-dist`; 12 сервисов (L19-316).
- `scripts/test/gateway-tls.test.mjs` — текущие TLS-тесты (verification отключена); post-1.10 — обратные ассерты.
- `_bmad-output/initiative-architecture/.memlog.md` — IPv4/IPv6 (L62), 1.10-директива (L47), stretch 1.1 (L65, L71, L78), vendor/registry (L67, L76), load-менеджмент (L54, L59, L73).

**Контекст/доки:**
- `docs/production-setup.md` — операторский порядок (configure/check/build/seed/up), `production-stack.mjs` как «закрытый автоматический изолированный тест» (`:78`).
- `_bmad-output/.../architecture-operational/architecture-operational.md:45` — DR-бандл включает `docker save` всех pinned-образов; `--pull never` ратифицирован.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/test/release-candidate-e2e.mjs` (new, driver) — F1–F6 как матрица: (F1) аргумент `--candidate <commit> --tag <rel>` + `manifest` path → сверка tag↔`manifest.release`↔`manifest.commit`; (F2) два `git clone`/worktree @ commit → `setup.mjs build --directory <dir>` (node 24) → два верифицированных манифеста; (F3) deep-equal `images`+`postgresImage` двух манифестов (парой сервис/ид при расхождении); (F4) pinned overlay из `manifest.images`/`postgresImage` (паттерн `update.mjs:373-386`) + `up -d --no-build --pull never --wait` + `assertLive` (7 app + postgres = ID манифеста); (F5) вызовы `structuralDrift`/`deadEnvironment`/`requiredEnvironmentDrift` (static, из `environment-model.mjs`) + live-чеки `verifyProductionBridge` (H5 200) + `validateProduction`-негатив (dev-обход → отказ старта) + supply (closed-contour guard) + TLS (post-1.10 ассерты) + schema live (лок/DDL/ghost-БД); (F6) запись `release-candidate-e2e.json` (кандидат, commit, tag, digests, результаты всех проверок) в `NEUROCENTER_TEST_EVIDENCE`. Переиспользовать `configureProduction`, override-ports, `request()`, fixtures из `production-stack.mjs` (не дублировать).
- [ ] F2/F3 — **детерминизм-сегмент**: два чистых клона, **sequential** build (load-менеджмент, не параллельно — прецедент исчерпания ресурсов 2026-11-06); сравнение секций `images`/`postgresImage`.
- [ ] F4 — **deploy-from-manifest-сегмент**: pinned overlay + `--no-build --pull never` + `assertLive`; `maintenanceLock` (как в `setup.mjs up`) для безопасности.
- [ ] F5 — **матрица проверок** (см. I/O Matrix): drift (3 static-вызова), H5 200 (`verifyProductionBridge`), `validateProduction` (live-старт + негатив `SSO_DISABLE=true`), supply (0 внешних registry, `--pull never`, registry-availability-снапшот 1.9), TLS (post-1.10: absence `NODE_TLS_REJECT_UNAUTHORIZED=0` в production-образах/compose + reject невалидного сертификата), schema live (лок-независимость racing-сессией, DDL `security_events` = catalog, ghost-БД `skills` нет в `pg_database`).
- [ ] HITL-ранбук `docs/release-candidate-e2e.md` (new) — пошаговый: выбор кандидата+тега (F1), сеть хоста (вариант A/B), запуск driver, интерпретация отчёта; **HITL-точки явно** (см. Design Notes 7).
- [ ] Регистрация: `scripts/workspace/check-tooling-tests.json` + `expectedFiles` `scripts/test/workspace-check-tooling.test.mjs` (driver в tooling-список; **union+sort** при мерже — конфликтная зона, memlog L49/L63/L72/L76).

**Acceptance Criteria:**
- Given замороженный кандидат (commit + git-tag, `manifest.release`==tag, `manifest.commit`==SHA), when F1, then связка подтверждена, кандидат зафиксирован; расхождение → фэйл с полем.
- Given два чистых клона одного commit, when два `setup.mjs build` (F2→F3), then `images` (7) + `postgresImage` двух манифестов идентичны побайтово (digest-детерминизм).
- Given незакоммиченные изменения, when build, then фэйл до docker (гейт 1.1, без изменений).
- Given верифицированный манифест, when F4 (pinned overlay + `up --no-build --pull never --wait`), then `assertLive`: 7 app + postgres работают именно с image ID из манифеста.
- Given развёрнутый стек из образов манифеста, when F5, then: drift 0/0/0 (structural/dead/required), H5 bridge-endpoints 200 (не 404), `validateProduction` старт OK + dev-обход отклонён, supply 0 внешних registry + `--pull never`, TLS (post-1.10) глобального отключения нет + reject, schema лок/DDL/ghost-БД зелёные.
- Given отчёт, when F6, then `release-candidate-e2e.json` содержит кандидата, commit, tag, все digests и результаты всех проверок (аудирует REL-01).
- `check --tooling` зелёный; корневой сьют — без деградации против baseline (driver добавлен, не ломает существующее).

## Implementation Notes

- **Граница с `production-stack.mjs`:** этот harness уже делает build→up→live-чеки, но (а) без чистого-checkout-гейта (гонится в main), (б) без верификации манифеста, (в) без digest-детерминизма, (г) без deploy-from-manifest, (д) без freeze. e2e-1.13 **добавляет** F1/F2/F3/F4 поверх и **переиспользует** live-фикстуры F5 (не переписывает).
- **Почему deploy = pinned overlay по image ID, а не по `:tag`:** `manifest.images` хранит **image ID** (`sha256:<64>`), не имя:тег. «Deploy с образов манифеста» строго = контейнер работает с именно тем image ID, что в манифесте. `update.mjs:373-386` уже делает `image: <id>` (bare digest = image ID, Docker резолвит по ID) + `assertLive` сверяет `container.Image`. Это самый строгий и уже проверенный паттерн; не изобретать `name@digest`.
- **Почему sequential build (не параллельный):** прецедент 2026-11-06 (memlog L54): 4 параллельных implementer'а → load 25, RAM free 1G, тайминг-падения. Два полных docker-build с npm-ci — тяжёлые; последовательно + cooldown (load < 8) — обязательное условие.

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Две линии acceptance (build + deploy) + freeze — в одном driver.** Тикет-verify требует и «с чистого хоста с манифестом: стек стартует, все проверки зелёные» (deploy-линия, F4/F5), и «повторная сборка с того же commit — те же digest'ы» (build-линия, F2/F3), и «кандидат заморожен — tag + commit SHA в манифесте» (F1). Driver оркестрирует все три; каждая фаза идемпотентна и логгируется в отчёт F6.

2. **Digest-детерминизм — это то, чего не было в stretch 1.1.** Stretch 1.1 (memlog L65/L78) доказал **content-уровень** контекста (5215 entry идентичны, единственная разница — артефакт BuildKit `.dockerfile.<rand>` при `-f` вне контекста, в production-пути его нет) и **офлайн** (no-op build, `FROM scratch`+`COPY . /`). **Digest-уровень** (полная сборка → одинаковые image ID) не доказан напрямую (нужна полная сборка — «post-1.9 или 1.13», memlog L65/L78). 1.9 закрыл supply-разрыв (vendor + локальный registry), поэтому полная сборка теперь возможна — **F2/F3 это и есть**. Stretch-скрипты (`stretch-ctx-326a01f2.sh`) переиспользовать как основу F2.

3. **Freeze = операторский tag + driver-сверка (без нового инструмента).** Механизм «заморозки» в коде отсутствует; манифест уже хранит `commit` (40-hex) и `release` (метка из `.env`). Заморозка = оператор ставит annotated git-tag на release-commit (имя тега = `NEUROCENTER_RELEASE`), и driver **сверяет**: `manifest.release` == имя тега, `manifest.commit` == `git rev-list -n1 <tag>`. Новый инструмент не нужен — только assertion в F1. Имя тега решает оператор (HITL).

4. **H5 200 — live-сегмент уже существует, 1.13 его **запускает** на чистом стеке.** `bridge-templates-resolution.test.mjs:19-22` явно деферит live-проверку на 1.13; `production-bridge.fixture.mjs:19-43` уже делает live `GET /api/bridge/*` → 200. 1.13 не пишет новый H5-тест — он **включает** `verifyProductionBridge` в F5 на стеке, собранном с чистого checkout (а не на dev-стеке). Фикс `BRIDGE_TEMPLATES_DIR=/app/bridge-dist` (1.3) уже в compose+модели.

5. **Чистый хост (A) vs эта машина с IPv4-фиксом (B).** Корень проблемы (memlog L62): хосту IPv6-адреса есть, но **IPv6-default-route нет** (только IPv4 default via 192.168.146.1); DNS отдаёт IPv6 Cloudflare (2606:4700::/32); клиенты, пробующие IPv6 первым (Node/npm-ci в контейнере), висят до таймаута; curl спасает Happy-Eyeballs. После 1.9 (vendor + локальный registry `ppod-npm-trusted`, анонимные чтения работают — прецедент 1.2) сборка **не требует npmjs.org**, только локальный registry. Два варианта: **(A) чистый хост** с корректным IPv4-маршрутом к registry — сборка работает без фикса, это «идеальный» закрытый контур; **(B) эта машина** + `NODE_OPTIONS=--dns-result-order=ipv4first` в build-контейнерах (или pin registry-IP в `/etc/hosts` контейнера) — обход сломанного IPv6-роутинга. IPv4-фикс — **воркараунд конкретной машины**, не общее требование. **Рекомендация:** повторяемый e2e-гейт (F2/F4/F5) — на **этой машине (B)** с ipv4first (детерминированно, без зависимости от наличия хоста); **истинный «чистый хост» (A)** — отдельный HITL-шаг (F6-разметка), когда хост доступен, для финальной «промышленной» приёмки. Driver получает `--host-variant A|B` и injects `NODE_OPTIONS` только при B.

6. **Зависимость от 1.10 (TLS) — TLS-чек пишется против post-1.10 контракта.** 1.10 **ещё не в main** (`neurocenter.config.json` отсутствует в main; работа в worktree `entry-1-10-nc` @ 90b92af3). Post-1.10 (memlog L47): один флаг `tls.disableTlsVerification` в `neurocenter.config.json` (дефолт true = dev/закрытый контур), производные `NEUROCENTER_TLS_DISABLE`/`NEUROCENTER_NPM_STRICT_SSL`, production fail-closed 3 слоя (setup.mjs форсирует 0 + ARG-дефолты strict, `validateProduction` **без** api-gateway-исключения, production-модель без ключа). F5-TLS ассерты: (a) `NODE_TLS_REJECT_UNAUTHORIZED=0` **отсутствует** в production-образах/compose (сейчас есть в `compose.production.yml:277` — исчезнет с 1.10), (b) production-конфиг форсирует `NEUROCENTER_TLS_DISABLE=0`, (c) исходящий вызов gateway на сервер с невалидным сертификатом → **reject**. **Гейт:** F5-TLS запускается только после мержа 1.10 (`after=[1..12]` уже включает 10). До мержа 1.10 F5-TLS — skipped с явной пометкой «ждёт 1.10». Точная механика (имена env/флагов) — за 1.10; plan сверяется с финальным state 1.10 при запуске.

7. **HITL-точки (что требует подтверждения оператора):** (H1) **выбор кандидата** — commit + имя tag (F1); (H2) **доступ к чистому хосту / сети** — вариант A или B, наличие локального registry (F2/F4); (H3) **запуск driver** на хосте (F2/F4 — docker build + up, ресурсоёмкие, sequential + cooldown); (H4) **интерпретация отчёта F6** + решение «кандидат принят/отклонён» (REL-01 = сигнал GO/NO-GO для P0, PRD C1); (H5) **реальный Blitz IdP** — повторный гейт использует local Blitz fixture (как `production-stack.mjs`); реальный Blitz = отдельная HITL-приёмка (территория epic-identity, вне 1.13). Автоматизируем (без HITL): F3 (детерминизм), F5-static (drift), F6 (отчёт).

8. **Закрытие «чистого хоста» без реального хоста — симуляция.** «Чистый хост» = хост без предшествующего neurocenter-статуса (нет образов, нет volumes, нет config). Симуляция (как `production-stack.mjs`): unique compose-проект (`nc-rel01-<uuid>`), fresh named volumes, `configureProduction` в fresh 0700-каталог, тестовый TLS (openssl), `--build` с нуля (не с уже собранными образами). Это даёт «чистоту» статуса на этой машине; истинный физический чистый хост — H2/H3. DR-бандл (`docker save` всех pinned-образов, operational:45) — альтернативный путь «чистый хост + бандл» (docker load → deploy), покрывается тем же F4 (pinned overlay работает и с loaded-образами).

## Verification

**Commands:** (Node 24 обязателен: `~/.nvm/versions/node/v24.22.0/bin/node`; docker build — sequential + cooldown load < 8)
- `node scripts/test/release-candidate-e2e.mjs --candidate <commit> --tag <rel> --manifest <path> --host-variant B` -- expected: F1–F6 зелёные, `release-candidate-e2e.json` записан; кандидат принят
- `node --test scripts/test/release-candidate-e2e.mjs` (если driver структурирован как node:test) -- expected: F3 (детерминизм) + F5-static (drift) проходят без docker
- `node --test scripts/test/compose-drift.test.mjs` -- expected: без регрессии (оба направления, 14 тестов 1.2/1.3)
- `node --test scripts/test/production-stack.mjs --build` (существующий harness) -- expected: без регрессии (e2e 1.13 не ломает его)
- `node --test scripts/test/bridge-templates-resolution.test.mjs scripts/test/release-manifest.test.mjs` -- expected: H5 static-guard + manifest-схема зелёные
- `node --test scripts/test/schema-locks-ddl-invariant.test.mjs` -- expected: без регрессии (1.11)
- `node scripts/workspace/check.mjs --tooling` -- expected: driver в tooling-списке, гейт зелёный
- **HITL (F2/F3, главная):** два `git clone` @ frozen-commit → `setup.mjs build` в каждом (node 24, sequential) → сравнить `images`+`postgresImage` обоих манифестов -- expected: идентичны (digest-детерминизм); `touch` незакоммиченное → build → фэйл
- **HITL (F4/F5):** чистый хост / симуляция → pinned overlay из манифеста → `up --no-build --pull never --wait` → `assertLive` (7 app + postgres = ID манифеста) → drift 0/0/0, H5 200, validateProduction OK + dev-обход отклонён, supply closed-contour, TLS (post-1.10) enforced, schema лок/DDL/ghost-БД зелёные
- **HITL (F6):** отчёт `release-candidate-e2e.json` содержит кандидата, commit, tag, digests, результаты всех проверок; оператор подтверждает «кандидат принят» (REL-01 GO)

## Open Questions (с рекомендациями)

- **OQ1 — Инструмент заморозки: автоматизировать или HITL?** Рекомендация: **HITL** (оператор создаёт annotated tag; имя = `NEUROCENTER_RELEASE`), driver только **сверяет** tag↔manifest (F1). Новый инструмент не нужен — assertion достаточен. Обоснование: заморозка кандидата — продуктовое решение (какой commit/tag становится релизом), а не технический шаг.
- **OQ2 — Deploy по image ID (bare digest) или по `name@digest`?** Рекомендация: **bare image ID** (паттерн `update.mjs:373-386` + `assertLive`). Манифест хранит именно ID; bare digest резолвится Docker по ID; уже проверено в update-flow. `name@digest` не обязателен (локально-собранные образы могут не иметь RepoDigests).
- **OQ3 — Повторяемый гейт на этой машине (B) или ждать реальный чистый хост (A)?** Рекомендация: **повторяемый гейт = B** (эта машина + ipv4first, детерминированно, без зависимости от хоста); **истинный чистый хост (A) = отдельный HITL-шаг** (F6) для финальной промышленной приёмки. Обоснование: чистый хост может быть недоступен; B даёт повторяемую защиту, A — финальный стейтмент.
- **OQ4 — Реальный Blitz IdP нужен для приёмки 1.13?** Рекомендация: **нет для гейта** (local Blitz fixture, как `production-stack.mjs`); реальный Blitz = отдельная HITL-приёмка (epic-identity). Обоснование: 1.13 принимает **кандидата сборки/деплоя**, не IdP-интеграцию; SSO-flow уже покрывается fixture.
- **OQ5 — TLS-чек до мержа 1.10?** Рекомендация: **F5-TLS = skipped с пометкой «ждёт 1.10»** до мержа; после мержа — полный ассерт (absence `NODE_TLS_REJECT_UNAUTHORIZED=0` + reject невалидного сертификата). Обоснование: 1.10 не в main; точные имена env/флагов за 1.10; `after=[1..12]` гарантирует порядок сборки.
