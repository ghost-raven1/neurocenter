# RES-01 — протокол e2e-приёмки P0-RES

- **Статус:** НЕ ВЫПОЛНЕН (live-приёмка — HITL, оркестратор/оператор). Скелет зафиксирован тикетом 6.15 (static-часть).
- **База:** production-стек `compose.production.yml` (7 application-образов), образы release-manifest,
  closed-contour (`--pull never`), 7 базовых образов с digest'ами — `docs/res-01-acceptance.md` §1.
- **Ранбук:** `docs/res-01-acceptance.md`. **Критерий GO:** 8/8 блоков green, любой red = баг-тикет
  (не «потолерировать»), повтор RES-01 после фикса. known-defect `feature-flags-service:4400` —
  verdict **flagged** (не red) при down.
- «Доставлено» (блок г) = запись в `/var/log/neurocenter/alerts.jsonl`/journal с меткой времени;
  alertmanager UI — не канал; «файл Prometheus rules» — не доставленный alert (readiness P0-RES :95).

## Sweep (блок S) — статический, выполнен (static-часть тикета 6.15)

Команда: `node scripts/test/res-obs-sweep.mjs` → **0 необъявленных hits, exit 0**
(allowlist зафиксирован в скрипте с обоснованием каждого excepted hit; правила идентичны скоупу
drift-тестов 6.6/6.7).

| # | Правило | Отчёт (progon от 2026-11-23) | Verdict |
|---|---------|-------------------------------|---------|
| r1 | `console.*` в `services/*/src` (excl `*.cli.ts`, тесты) | 926 файлов, 0 hits | GREEN |
| r2 | `error.message` в лог-строках (redaction, excl тесты) | 926 файлов, 0 hits | GREEN |
| r3 | quota-поля (`currentBytesLimit`/`retentionBytesLimit`/`stagingBytesLimit`) без enforcement-точки | 3 поля, все читаются в enforcement (quota-usage.service.ts / snapshot-repository.ts) | GREEN |
| r4 | секции `RUNTIME_LIMIT_CEILINGS` без ENFORCEMENT_POINTS | 2 секции, обе с ENFORCEMENT_POINTS | GREEN |
| r5 | `/health` в src + nginx-конфигах | 0 hits (AD-O4: только /ready) | GREEN |
| r6 | app-сервисы вне scrape targets (compose ↔ prometheus.yml, двусторонне) | 6 scrape-obligated покрыты / 10 non-obligated (осознанные) | GREEN |
| r7 | Dockerfile app-образов без `USER=$SERVICE_USER` | 7/7 `USER=$SERVICE_USER` | GREEN |
| r8 | сервисы без `user`/`pidsLimit` в `environment-model.json` | 16/16 полей | GREEN |

Артефакт S: вывод `node scripts/test/res-obs-sweep.mjs` (отчёт выше — актуальный на момент live-прогона;
перепрогнать перед приёмкой).

## Stage 2 — развёртывание production-стека (2026-11-23/24)

### 2.1. Окружение стенда (документированные отклонения, не дефекты репо)

| # | Отклонение | Причина | Реализация |
|---|-----------|---------|-----------|
| E1 | Сборка образов — внешний build-драйвер, не `setup.mjs build` | docker-bridge egress на корпоративный npm-реестр закрыт (no sudo, организационное управление сетью) | `/tmp/opencode/res-01-build.mjs`: `docker buildx build --network=host` + staged corporate CA (`docker/build-ca/ca-dev-bundle.pem`) + `NPM_REGISTRY_AUTH_B64`; manifest — те же функции release-manifest.mjs |
| E2 | Forward-прокси на 172.17.0.1:3128 (user-space) | daemon инжектит `*_PROXY=http://172.17.0.1:3128` в каждый контейнер; закрытый bridge-egress ломает runtime-запросы | `/tmp/opencode/res-01-proxy.mjs` (жизненный для rebuild и контейнеров с egress) |
| E3 | Schema check/migrate — raw `docker run` вместо `compose run` | Compose v5.6.0 на хосте: `compose run` без `--read-only`/`--network` | Те же hardening-флаги (`--read-only --memory 256m --pids-limit 64 --cap-drop ALL --security-opt no-new-privileges`), тот же network `neurocenter-res01_backend`, env + secret-mounts из `compose config --format json` |
| E4 | Строковые `user` в compose.production.yml | Compose v5.6.0 строго валидирует каждый `-f` файл до merge (числовой user падает на `compose config`) | Фикс 65e9e2a6 (база, не overlay); целевые хосты с compose v2 — совместимо |

### 2.2. Дефекты, обнаруженные при развёртывании (все 6 предшествуют epic-res-obs; баг-тикеты 17–22)

| # | Дефект | Root cause | Обнаружен | Статус |
|---|--------|-----------|-----------|--------|
| D1 (тикет 17) | frontend-сборка падает: nginx pid-sed | alpine `nginx:1.30.6` содержит `pid /run/nginx.pid;` (паттерн искал `/var/run/...`) | build 7/7, 11-23 | FIXED 6ce92dde |
| D2 (тикет 18) | `compose config` падает на числовых user | Compose v5.6.0 per-file strict validation до merge | stack-up, 11-23 | FIXED 65e9e2a6 |
| D3 (тикет 19) | schema-migrations: stale `/app/dist/...` | repo-лейаут d658006f (код в `/repo/services/<svc>/dist/`) | stack-up, 11-23 | FIXED 3eb6d1ea |
| D4 (тикет 20) | capacity-collector unhealthy → `up --wait` блокирует стек | AD-OP-6 (94f1a647) user 1000 + `cap_add DAC_OVERRIDE`: для non-root капабилити НЕ попадают в effective (у node нет file-капабилити, no-new-privileges) → CapEff=0 → EACCES `pg_wal` (700, uid 999) → snapshot `wal:available=false` | stack-up, 11-23 | FIXED 110775a8 (ратификация user "0", прецедент model-runtime; харнес capacity-collector-stack.mjs гоняет collector как root — протестированный дизайн) |
| D5 (тикет 21) | catalog-service crash loop: `UnknownDependenciesException (ModelsService, ?) — argument Function at index [1]` | 17162a26 (agt-07 B4, 11-16): `import type { PgBackgroundAgentStore }` — type-only импорт стирается tsc, `design:paramtypes` = `[ModelsService, Function]`; catalog.module.ts store КОРРЕКТНО провайдит | stack-up, 11-24 | FIXED 56a6a552 (value import + комментарий; локальный nest build: метадата несёт класс; image rebuild) |
| D6 (тикет 22) | background-agent crash loop: `startup-failed ENGINE — runtime.json не найден` | 17162a26: НАМЕРЕННЫЙ fail-fast (пакет operator-provisioned), НО операторский шаг провижининга отсутствует во всех доках → чистый production-стек не становится healthy | stack-up, 11-24 | FIXED (доки): production-setup.md §«Автономный пакет фонового агента» + res-01-acceptance.md §1.2; стендовый stand-in пакета (2.4) |

**E2E-археология (почему D5/D6 не обнаружены раньше):** production-stack e2e (26/26) не гонялся на
agt-коде. Единственное evidence — `/home/.../projects/neurocenter/.run/production-stage-1/`
(checkedAt 2026-11-16T11:39:29Z, main checkout 2d25c293) — образы тегом `verify-20261017`
(старые, от эпика TRUST-01); agt-07 B4 (17162a26) смёржен 11-16 15:48 — на fresh-стеке не проверялся.

### 2.3. Транзитный инцидент model-runtime (не дефект)

ollama 30 мин crash-loop'ил с `open /root/.ollama/id_ed25519: permission denied` — гонка первичной
инициализации named volume `model-weights` (владение _data восстановилось; ключ id_ed25519 создан
и персистентен в томе, subsequent restarts healthy). Статус: healthy, `ollama list` 200.

### 2.4. Стендовые фиксиры (environment, не production-код)

| Фиксюр | Назначение | Детали |
|--------|-----------|--------|
| Fixture TLS (`/tmp/opencode/nc-res01-fixture/tls.{crt,key}`) | приёмок через 18443 (443 MITM host-AV KESL) | key 0444 (nginx uid 1000 читает); `NODE_EXTRA_CA_CERTS` для драйверов |
| Acceptance overlay (`/tmp/opencode/compose.res01-acceptance.yml`) | порты 18xxx, bridge-CA, blitz-fixture alias | не часть репо |
| (г1) overlay (`/tmp/opencode/compose.res01-g1.yml`) | 1GiB tmpfs вместо `projects`-тома capacity-collector | хост 219G free — физическое заполнение <1GiB невозможно; tmpfs.size=1073741824 → обе ветви expr `NeurocenterDiskSpaceLow` |
| Stand-in автономного пакета (том `background-agent-runtime`) | background-agent healthy без реального движка | `bin/opencode-probe` (stub, при запуске — явный отказ exit 1) + `runtime.json` с ЕГО реальным sha256 и пином 1.14.48; ассерт реального кода образа: `ENGINE OK 1.14.48 ab1b8b9da994…`; e2e-хук крэша (блок е) срабатывает до запуска движка — реальный бинарь в приёмке не исполняется |

### 2.5. Итог stage 2

Стек: 16/16 (после rebuild каталог-образа и seed пакета — см. §2.2 D5/D6). Schema: catalog 64 /
feature-flags 1 / rag 5 applied, `schema-initialization.json` state=schema-ready.
Bootstrap-admin seeded. Model-key asserted. Дальше — блоки live-приёмки.

## Блоки live-приёмки

| Блок | Условие | Действие (ранбук) | Ожидаемый | Артефакт | Verdict |
|------|---------|-------------------|-----------|----------|---------|
| а1 — quota | запись сверх `retentionBytesLimit` (проекта) | а1: малый лимит + запись сверх | 507 `QUOTA_EXCEEDED`/503; прежние данные целы; `retentionBytesUsed` не изменился | HTTP-ответ + SQL quota до/после + лог enforcement | PENDING |
| а2 — two-tier | смена policy в DB (MainAdmin, CAS) | а2: policy до/после + та же операция | enforcement-точка применила новое значение **без рестарта**; ceiling не превышен | policy (revisions) + решения до/после + строка аудита | PENDING |
| а3 — hardening | `docker exec id` в 7 app; `docker inspect` PidsLimit | а3: id + PidsLimit по модели | uid=1000 (≠0) во всех 7; PidsLimit = модели (capacity-admission §AD-OP-6) | 7 строк `id` + PidsLimit + сверка с моделью | PENDING |
| а4 — fork-стресс | контролируемый fork-bomb (timeout 10s, 1 контейнер) | а4: `sh -c 'while :; do : & done'` | контейнер умирает (pids EAGAIN), **хост не затронут**; restart вернул сервис | docker ps (restart) + dmesg tail + PID хоста до/после | PENDING |
| б — нагрузка | G-10: 10 проектов (5 RAG) / 30 агентов (10 паралл.) / 2000 msg крупнейшая комната (100k всего, 50MiB/10) / 250k embeddings / 5 GGUF (2 active) / 60 min sustained | б: данные + 10 раундов + конкурирующие тяжёлые операции, WAL, диск | RSS-дрейф <10%; p95 в бюджетах (ready-бюджеты shared); 0 crash; fd/pid стабильны; 503/507 — только истинное capacity-превышение с причиной в диагностике | таблица замеров (60 мин, шаг 5 мин) + p95 + WAL-кривая + вырезки capacity-отказов | PENDING |
| в — scrape | prometheus targets job=neurocenter | `res-01-e2e.mjs --blocks scrape` | 6/6 `up=1`; ff:4400 — отдельно (known-defect → flagged) | вывод драйвера + `/api/v1/targets` JSON | PENDING |
| г1 — disk | free < 1GiB (том capacity-collector) | г1: `dd` filler до free < 1GiB → `rm` | `NeurocenterDiskSpaceLow` (for 1m): строка `firing` в alerts.jsonl/journal → `resolved` | grep-строки firing/resolved с ts | PENDING |
| г2 — queue | rag pending > 8 (5m) | г2: штатная нагрузка (блок б) / fixture-сценарий | `NeurocenterRagQueueGrowing`: `firing` → `resolved` | grep-строки (или promtool fixture + строчка в доке) | PENDING |
| г3 — service | down 1 сервиса | г3: `compose stop skills-service` → `start` | `NeurocenterServiceUnavailable` (1m): `firing` (labels: service/instance) → `resolved` | grep-строки firing/resolved | PENDING |
| г4 — stale-backup | `external_backup_verified == 0` (1m) | г4: состояние без проверенной внешней копии (стенд без внешнего S3) | `NeurocenterExternalBackupOverdue`: `firing` → `resolved` | gauge-значение + grep-строки | PENDING |
| д — correlation | запрос через nginx с X-Request-ID | `res-01-e2e.mjs --blocks correlation` | id сквозной nginx→gateway→сервис; **нет** ticket-сегмента (REDACTED) и **нет** error.message | вывод драйвера + вырезки логов 3 уровней с одним id | PENDING |
| е — crash | uncaughtException (controlled: `BACKGROUND_AGENT_E2E_CRASH_DISPATCH=1` / штатный unhandled) | е: контролируемый crash background-agent | safe-лог → `error_events` (PG) → exit(1) → restart; видно в admin UI (Error-модуль) и `GET /api/errors` | SQL error_events + скриншот UI + лог crash-handler + факт restart | PENDING |
| ж — аудит | admin-мутация (MainAdmin) | ж: мутация (напр., runtime-limit-configuration CAS) | запись в единой истории (`GET /api/audit`): актор/время/ревизия; transactional (нет «мутация без аудита») | ответ /api/audit (выдержка) + скриншот Audit-модуля | PENDING |
| з — health | `/ready` (up + down-ветка) | `res-01-e2e.mjs --blocks health` + HITL: stop 1 upstream | up: 200; gateway `{ok:true,checks:{gateway:'ready'}}`; down: 503 + `checks`-разложение; `GET /health` → 404 | ответы /ready (up/down) + 404 /health | PENDING |

Дополнительно (г): формат `alerts.jsonl` и resolve-строки — `res-01-e2e.mjs --blocks alerts --expect …`;
grouping: при 6 down — **одна** строка `NeurocenterStackDown` + 6 строк `NeurocenterServiceUnavailable`.

## GO / NO-GO

- **Verdict: PENDING** (live-приёмка не выполнена).
- GO — 8/8 green (S + а/б/в/г/д/е/ж/з), known-defect ff:4400 — flagged.
- NO-GO — любой red → баг-тикет → фикс → повтор RES-01 (полный).

## Ссылки

- Тикет: `tickets/story-res-01-e2e-acceptance-plan.md` (I/O-матрица S..з, Design Notes).
- Readiness: `docs/implementation-readiness.md` P0-RES («Чего недостаёт» закрывается этим протоколом при GO).
- Ограничения/таблица ресурсов: `docs/capacity-admission.md`.
- Канал алертов + механика вызова условий: `docs/production-setup.md` §«Канал алертов», §«HITL-приёмка 6.15».
- Сценарий S26: `docs/publication-scenarios.md:73`.
