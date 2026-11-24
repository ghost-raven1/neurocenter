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
| D7 (тикет 23) | catalog-service crash loop (после D5): `crash.unhandledRejection` (message маскируется) → raw: `assertServiceVolumes: /data/models принадлежит uid=0, сервис uid=1000` (volume-ownership.cjs:54) | shared том `model-weights` на КОРНЕ: catalog (uid 1000, `MODEL_STORAGE_PATH=/data/models`) + ollama (root, `/root/.ollama` — каталог отсутствует в образе). Race первого mount на fresh-стеке: в образе catalog `/data/models` = 755 1000:1000, у ollama каталога нет — выигрывает первый mounter; ollama выиграл → корень root:root → fail-closed assert AD-OP-6 (by design) → crash loop. Доки покрывают только «старые тома до миграции», fresh-stack-гонку — нет | stack-up, 11-24 | FIXED (env, санкционирован production-setup.md AD-OP-6 «одноразовый chown uid=1000 по явному решению»): `chown 1000:1000` корня тома через scratch-контейнер (ollama root — не затронут, assert проверяет только корень); `up -d --wait` exit 0. Док-требование в тикете 23 |
| D8 (тикет 24) | e2e-драйвер блок (д) correlation = RED на healthy-стеке (не production-дефект) | (1) nginx `proxy_set_header X-Request-ID $request_id` перезаписывает client-заголовок собственным `$request_id` (ратификация AD-O2); драйвер шлёт свой 32-hex id и гребёт по НЕМУ → ни один слой не матчится (nginx access-лог несёт id NGINX). (2) gateway/сервисы НЕ пишут per-request SUCCESS-логи (только error/warn) → endToEnd-критерий `nginx && gateway` непроходим для 2xx-запроса. Production-корреляция ПРАВИЛЬНА (request-context.cjs уважает X-Request-ID, internal-вызовы несут заголовок) — доказывается live: POST /api/errors/client 201, nginx id в access-логе, 0 downstream-строк для success | block д, 11-24 | OPEN (фикс в ДРАЙВЕРЕ — тест-артефакт): читать id из nginx access-лог-строки после запроса; downstream-слои требовать только при наличии downstream-лога (error/warn-путь или связь с блоками е/ж). Production-код НЕ меняется |
| D9 (тикет 25) | канал доставки алертов AD-O6 не проведён end-to-end: в `prometheus.yml` отсутствует секция `alerting:` → prometheus не пушит алерты в alertmanager (AM пуст: /api/v2/alerts=[]), хотя AM-config (webhook file-sink host.docker.internal:9111/alerts, send_resolved), extra_hosts host-gateway и host-receiver собраны корректно | def в res-obs-артефакте (entry 13, 28940fa6): добавлены alertmanager.yml + правила, но не проводка prometheus→AM. Наблюдения: (a) AM v0.32.1 доставляет resolved НЕ в момент resolve, а на цикле group_interval (resolve 03:15:11.657 → resolved-строка 03:18:41.681 = + ровно 5m = group_interval:5m); (b) Docker-демон стенда инжектит HTTP(S)_PROXY во все контейнеры: node-сервисы защищены NO_PROXY из x-runtime, внешние образы (frontend/prometheus/alertmanager) — короткий daemon no_proxy → proxy-aware-диагностика (wget) внутри них гонит сервис-трафик в корпоративный прокси → ложный «502» (бывший red herring при з-down: wget frontend→api-gateway:4000/ready = 502 через 172.17.0.1:3128; bypass → 200); НЕ production-дефект (nginx/node/webhook-клиент AM env-proxy не используют); (c) capacity-снапшоты на стенде stale (snapshot_available=0 у catalog/rag/skills, CapacityUnavailable firing с 11-23 13:07 у rag) — предсуществующее состояние, влияет на г1 | block г, 11-24 | FIXED (env/stand-fixture): репо-фикс = секция alerting в prometheus.yml (тикет 25); stand: /tmp/opencode/nc-res01-monitoring (копия + alerting) через volumes-override acceptance-overlay + receiver ALERTS_FILE=~/.nc-res01/alerts.jsonl. После: firing+resolved доставлены (г3/г4). Док-заметки (a)/(b) — в тикете 25 |

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
| chown корня `model-weights` → 1000:1000 | D7: fail-closed assertServiceVolumes catalog (uid 1000) на root-owned корне shared-тома | Санкционированная процедура production-setup.md (AD-OP-6); однократно, через scratch-контейнер; ollama (root) не затронут (root bypass DAC), assert проверяет только корень; содержимое ollama (id_ed25519 600 root:root, models/) осталось root-owned — catalog его не трогает (GGUF на стенде не грузится) |
| D9 monitoring-dir (`/tmp/opencode/nc-res01-monitoring`) + host-receiver на 9111 | D9: prometheus.yml без `alerting:` → канал AD-O6 мёртв; stand-fixture проводки | копия `deploy/production/monitoring` с добавленной секцией `alerting: alertmanagers [alertmanager:9093]`, подмешана volumes-override'ом в acceptance overlay (prometheus); receiver: `ALERTS_FILE=~/.nc-res01/alerts.jsonl node scripts/production/alert-receiver.mjs` (хост, 0.0.0.0:9111); репо-фикс — тикет 25 |

### 2.5. Итог stage 2

Стек: **15/15** (14 healthcheck-сервисов healthy + blitz-fixture up без healthcheck по дизайну;
«16/16» в черновике — ошибка счёта: bootstrap-admin/database-init — one-shot-задачи, не сервисы).
Артефакт: `up -d --wait` exit 0 (2026-11-24, после D5-rebuild + D6-pkg + D7-chown). Schema:
catalog 64 / feature-flags 1 / rag 5 applied, `schema-initialization.json` state=schema-ready.
Bootstrap-admin seeded. Model-key asserted. Дальше — блоки live-приёмки.

## Блоки live-приёмки

| Блок | Условие | Действие (ранбук) | Ожидаемый | Артефакт | Verdict |
|------|---------|-------------------|-----------|----------|---------|
| а1 — quota | запись сверх `retentionBytesLimit` (проекта) | а1: малый лимит + запись сверх | 507 `QUOTA_EXCEEDED`/503; прежние данные целы; `retentionBytesUsed` не изменился | HTTP-ответ + SQL quota до/после + лог enforcement | **GREEN** (11-24, 03:35–03:56Z): проект res01-a1-quota, stand-in embedding-модель (host 172.22.0.1:9173, OpenAI-совместимый, 16-dim — D6-паттерн, только модельный endpoint; весь production-путь gateway→catalog coordinator→intent→rag-sync→quota-guard без изменений). Sync #1 (unlimited) → 201 upserted:1; `retentionBytesLimit=1MiB` (PATCH quotas); sync #2 → **503** (rag-sync 507→503 маппинг project-rag-client; body gateway-маска error-body-policy). Enforcement: safe-лог `[quota-guard] quota rejection dimension=retention reason=exceeded used=0 limit=1048576 estimate=16777216` (16MiB-floor оценки исполнил 1MiB-лимит) + метрика `neurocenter_quota_rejections_total{dimension="retention",reason="exceeded"} 30`; данные целы (rowCount=1, dataRevision не изменился), retained_bytes не изменился. **Побочные дефекты (ticket'ы, не red блока):** D10/ticket 26 — capacity-снапшот root:root 0600 нечитаем сервисами uid 1000 + init:true лишает node cap DAC_OVERRIDE (wal.available=false) → snapshot_available=0 → CAPACITY_UNAVAILABLE блокировал reindex; stand-фикс: overlay user 1000:1000 + одноразовый chmod 755 PG data-dir/pg_wal → snapshot_available 0→1. D11/ticket 27 — quota-accounting delivery разбита camelCase `requestKey` (rag-sync/skills) vs snake_case `request_key` (catalog parse) → ВСЕ delivery 400 → used всегда 0 (отказ исполнился через estimate — fail-closed не сломан). Артефакт: /tmp/opencode/res-01-block-a1.out; драйверы res-01-a1-step{1,2,3,4}.mjs + res-01-embed-standin.mjs |
| а2 — two-tier | смена policy в DB (MainAdmin, CAS) | а2: policy до/после + та же операция | enforcement-точка применила новое значение **без рестарта**; ceiling не превышен | policy (revisions) + решения до/после + строка аудита | **GREEN** (11-24, 04:01–04:02Z): проект res01-a2-two-tier (prj-f71f3e63-…). Двухуровневая модель: уровень 1 = статический `TEXT_KNOWLEDGE_CEILINGS` (каталог-кромка, не превысимо), уровень 2 = живая политика `runtime_limit_settings` (catalog DB, CAS-ревизии), применяемая rag-sync `text/upload` через `readTextAdmission()` (GET /internal/runtime-limits) на каждую операцию — **без рестарта**. Доказательства: policy revisions 5(docs=16)→6(docs=2)→7(restore 16); **та же операция** (3 docs) → 201 ACCEPTED под docs=16, затем **400 REJECTED** «от 1 до 2 текстовых файлов» под docs=2 (раг-синк/каталог не рестартовались); граница 2 docs → 201 ACCEPTED; **ceiling** docs=300 (>256) → **400 REJECTED** «выходят за поддерживаемые границы» (не превышен); строки аудита `runtime_limit_requests` (actor=admin@example.test, key, hash, new_rev, after_docs, accepted_at) + квитанция `GET /api/runtime-limits/admin/requests/:key`. Stand-in: НЕТ (чистый production-путь). Артефакт: /tmp/opencode/res-01-a2-artifact.md; драйвер res-01-a2.mjs |
| а3 — hardening | `docker exec id` в 7 app; `docker inspect` PidsLimit | а3: id + PidsLimit по модели | uid=1000 (≠0) во всех 7; PidsLimit = модели (capacity-admission §AD-OP-6) | 7 строк `id` + PidsLimit + сверка с моделью | **GREEN** (11-24): 7/7 `uid=1000(node)`; PidsLimit = модели: catalog/skills/rag/bridge 256 (якорь), ff/api-gw 128 (ратиф.), frontend 64 |
| а4 — fork-стресс | контролируемый fork-bomb (timeout 10s, 1 контейнер) | а4: `sh -c 'while :; do : & done'` | контейнер умирает (pids EAGAIN), **хост не затронут**; restart вернул сервис | docker ps (restart) + dmesg tail + PID хоста до/после | **GREEN** (11-24, 03:22–03:30Z): skills (pids.max=256 cgroup v2 подтверждён). Запуск 2 (при живом запуске 1) → `sh: 0: Cannot fork` (EAGAIN) — лимит enforced; 2 бомбы одновременно → pids.current **256/256** (потолок); одиночная минимальная бомба не детерминированно насыщает (max 239). **Семантика (протокольная заметка):** pids.max блокирует НОВЫЕ forks (EAGAIN), но НЕ убивает контейнер — main-сервис (node, PID 7) пережил всё, контейнер `Up (healthy)` на всём протяжении, `/ready` 200 после прогона; ранбук-формулировка «контейнер умирает (pids)» завышена — blast-radius = «новые fork'и в контейнере падают EAGAIN, существующие процессы живут» (containment). Хост не затронут (red-критерий не сработал): PIDs 490→497(пик)→491, load пик 13.87(1m)→6.21 через 2m, нет OOM/kill; dmesg без root нечитаем (зафиксировано). Инструментально: `docker top` сломан на хосте («Couldn't find PID field in ps output») — сэмплирование через /sys/fs/cgroup/docker/<cid>/pids.current; exec-процессы переживают смерть exec-клиента (timeout 124 убил только клиент, bomb-shell PID 612 пережил — убивался in-container kill; host-kill невозможен, uid 1000). Артефакт: /tmp/opencode/res-01-block-a4.out + traces a4-pids-v{3,4,5}.txt |
| б — нагрузка | **Минимальный воспроизводимый профиль** (решение оператора, 2026-11-24; G-10 в скобках): 2 проекта (1 RAG) (10/5) / 4 агента (2 паралл.) (30/10) / 200 msg в крупнейшей комнате, ~2k всего (2000/100k) / ~5–10k embeddings (~10 документов) (250k) / sustained 10 мин (60). GGUF на стенде не загружаются (CPU-only, RAM 33G) — модельный инференс через remote/ollama. Все метрики блока снимаются в полном объёме (RSS-дрейф, p95, WAL, capacity) | б: данные + 10 раундов + конкурирующие тяжёлые операции, WAL, диск | RSS-дрейф <10%; p95 в бюджетах (ready-бюджеты shared); 0 crash; fd/pid стабильны; 503/507 — только истинное capacity-превышение с причиной в диагностике | таблица замеров (60 мин, шаг 5 мин) + p95 + WAL-кривая + вырезки capacity-отказов | PENDING |
| в — scrape | prometheus targets job=neurocenter | `res-01-e2e.mjs --blocks scrape` | 6/6 `up=1`; ff:4400 — отдельно (known-defect → flagged) | вывод драйвера + `/api/v1/targets` JSON | **GREEN** (e2e 11-24: 6/6 up=1 — api-gateway:4000, catalog:4100, rag:4300, oauth2-bridge:22222, ff:4400, skills:4200) |
| г1 — disk | free < 1GiB (том capacity-collector) | г1: `dd` filler до free < 1GiB → `rm` | `NeurocenterDiskSpaceLow` (for 1m): строка `firing` в alerts.jsonl/journal → `resolved` | grep-строки firing/resolved с ts | PENDING |
| г2 — queue | rag pending > 8 (5m) | г2: штатная нагрузка (блок б) / fixture-сценарий | `NeurocenterRagQueueGrowing`: `firing` → `resolved` | grep-строки (или promtool fixture + строчка в доке) | PENDING |
| г3 — service | down 1 сервиса | г3: `compose stop skills-service` → `start` | `NeurocenterServiceUnavailable` (1m): `firing` (labels: service/instance) → `resolved` | grep-строки firing/resolved | **GREEN** (11-24): stop 03:02:56Z → up=0 с 03:03:00 (scrape 15s) → pending 03:03:11.657 (первый eval; `activeAt` в /api/v1/alerts) → firing по for:1m ~03:04:11 (не доставлен — канал был разорван, D9) → stand-фикс D9 → redelivery: **firing-строка 03:13:41.693Z** (instance=skills-service:4200, groupKey, summary) + **resolved-строка 03:18:41.681Z** (endsAt=03:15:11.657 = реальное время resolve после start 03:14:14Z). Down-ветка /ready/dependencies зафиксирована live: 503 `{"ok":false,"checks":{"catalog":"ready","skills":"unavailable","rag":"ready","auth":"ready","featureFlags":"ready"}}` |
| г4 — stale-backup | `external_backup_verified == 0` (1m) | г4: состояние без проверенной внешней копии (стенд без внешнего S3) | `NeurocenterExternalBackupOverdue`: `firing` → `resolved` | gauge-значение + grep-строки | **GREEN (firing; resolve stand-limited по ранбуку)** (11-24): состояние стенда (внешняя копия не верифицирована) → **firing-строка 03:13:41.696Z** (instance=catalog-service:4100, summary «Нет проверенной внешней копии в пределах цели RPO»); resolved невозможен на стенде (нет внешнего S3/верификации) — зафиксировано в ранбуке как stand-limited |
| д — correlation | запрос через nginx с X-Request-ID | `res-01-e2e.mjs --blocks correlation` | id сквозной nginx→gateway→сервис; **нет** ticket-сегмента (REDACTED) и **нет** error.message | вывод драйвера + вырезки логов 3 уровней с одним id | **RED** (D8, тикет 24): драйвер непроходим для 2xx (nginx перезаписывает client-id; gateway/service не логят success). Production-корреляция верна — артефакт по manual-trace id из nginx access-лога (error/warn-путь) + фикс драйвера |
| е — crash | uncaughtException (controlled: `BACKGROUND_AGENT_E2E_CRASH_DISPATCH=1` / штатный unhandled) | е: контролируемый crash background-agent | safe-лог → `error_events` (PG) → exit(1) → restart; видно в admin UI (Error-модуль) и `GET /api/errors` | SQL error_events + скриншот UI + лог crash-handler + факт restart | PENDING |
| ж — аудит | admin-мутация (MainAdmin) | ж: мутация (напр., runtime-limit-configuration CAS) | запись в единой истории (`GET /api/audit`): актор/время/ревизия; transactional (нет «мутация без аудита») | ответ /api/audit (выдержка) + скриншот Audit-модуля | **GREEN** (11-24): PKCE-логин blitz-fixture → Главный админ → PATCH runtime-limits (CAS rev 2→3, 200) → /api/audit строка `runtime.limits.update` (actor admin@example.test, at 03:02:11Z, outcome SUCCEEDED, resourceType runtime); transactional — мутация+строка вместе; AD-O7 `login.success` тоже в истории. (артефакт /tmp/opencode/res-01-block-zh.out) |
| з — health | `/ready` (up + down-ветка) | `res-01-e2e.mjs --blocks health` + HITL: stop 1 upstream | up: 200; gateway `{ok:true,checks:{gateway:'ready'}}`; down: 503 + `checks`-разложение; `GET /health` → 404 | ответы /ready (up/down) + 404 /health | **GREEN** (11-24): up — /ready 200, checks={gateway:ready} (e2e + повторный замеры после restore skills); down — live при stop skills: `GET /ready` (gateway, тривиальный) 200 (gateway жив), `GET /ready/dependencies` → **503 + checks-разложение** (skills=unavailable, остальное ready) — ровно по семантике readiness.cjs; `GET /health` → **404 на уровне gateway** («Cannot GET /health» — единственная health-семантика = /ready; через nginx-SPA fallback /health отдаёт index.html 200 — это фронт-роутинг, не health-эндпоинт) |

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
