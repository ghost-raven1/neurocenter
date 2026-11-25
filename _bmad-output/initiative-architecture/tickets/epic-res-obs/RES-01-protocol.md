# RES-01 — протокол e2e-приёмки P0-RES

- **Статус:** **ВЫПОЛНЕН — GO** (stage 3, повтор 2026-11-25 на repo-фиксах, 8/8 green;
  история: stage 2, 2026-11-24 — NO-GO 7/8, red=д).
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
| б — нагрузка | **Минимальный воспроизводимый профиль** (решение оператора, 2026-11-24; G-10 в скобках): 2 проекта (1 RAG) (10/5) / 4 агента (2 паралл.) (30/10) / 200 msg в крупнейшей комнате, ~2k всего (2000/100k) / ~5–10k embeddings (~10 документов) (250k) / sustained 10 мин (60). GGUF на стенде не загружаются (CPU-only, RAM 33G) — модельный инференс через remote/ollama. Все метрики блока снимаются в полном объёме (RSS-дрейф, p95, WAL, capacity) | б: данные + 10 раундов + конкурирующие тяжёлые операции, WAL, диск | RSS-дрейф <10%; p95 в бюджетах (ready-бюджеты shared); 0 crash; fd/pid стабильны; 503/507 — только истинное capacity-превышение с причиной в диагностике | таблица замеров (60 мин, шаг 5 мин) + p95 + WAL-кривая + вырезки capacity-отказов | **GREEN (11-24, 05:07–05:23Z)**: run 11 мин (A 0–4m base + B 4–11m queue-нагрузка для г2), driver /tmp/opencode/res-01-b.mjs. Профиль: 200 chat-msg 200/200×201 (p95=927ms), **225 879 embeddings** (расширение ~22× для г2-нагрузки), sustained 11 мин. RSS: **утечек нет** — все сервисы флат под нагрузкой (catalog ±0.8%, skills 0%, rag net -1%, api +9%, ba +5%) и ОСВОБОДИЛИ рабочую область post-load (rag 239→115M, api 211→127M, ba 73→38M за 26с); наивный first-vs-last +35/+34/+104% = артефакт окна (холодный t0 + drain-tail + транзиент), развёрнутый замер — в артефакте. 0 crash (CRASHES 0; postgres RestartCount=0, Up 17ч — независимая проверка, драйвер не сэмплировал pg-RSS из-за бага имени). pid 12/12 всё окно; fd: косвенно (0 EMFILE/transport). 5xx: 10/1410 (7×500+3×503) = ТОЛЬКО pg-pool каталога (max 10/scope, 5s) «timeout exceeded when trying to connect» — истинное capacity с причиной в диагностике; драйвер ретраил. WAL 320→896M (+576M). Артефакт: /tmp/opencode/res-01-b-artifact.md |
| в — scrape | prometheus targets job=neurocenter | `res-01-e2e.mjs --blocks scrape` | 6/6 `up=1`; ff:4400 — отдельно (known-defect → flagged) | вывод драйвера + `/api/v1/targets` JSON | **GREEN** (e2e 11-24: 6/6 up=1 — api-gateway:4000, catalog:4100, rag:4300, oauth2-bridge:22222, ff:4400, skills:4200) |
| г1 — disk | free < 1GiB (том capacity-collector) | г1: `dd` filler до free < 1GiB → `rm` | `NeurocenterDiskSpaceLow` (for 1m): строка `firing` в alerts.jsonl/journal → `resolved` | grep-строки firing/resolved с ts | **GREEN** (11-24, 04:23–04:31Z): стэн-заменитель внешней границы (D6): physical том-источник метрики заменён 1G tmpfs на целе `/volumes/projects` capacity-collector (overlay /tmp/opencode/compose.res01-g1.yml, acceptance-only; хост 219G free — физический fill невозможен/небезопасен). Production-цепь без изменений: statfs → snapshot.json → services /metrics (resource="projects", instance="skills-service:4200") → prometheus rule → alertmanager → alerts.jsonl. Fill 950M (root exec, `mode:1777`=decimal→octal 3361 не даёт node-write) → freeBytes=77594624 (74MiB): **обе ветки expr TRUE** (free<1GiB AND free/total=0.072<0.15) → **firing** ts=2026-11-24T04:25:41.676Z (startsAt 04:25:11.657, for:1m, group_wait 30s) → `rm` filler → expr FALSE (endsAt 04:27:11.657) → **resolved** ts=2026-11-24T04:30:41.664Z (group_interval 5m, D9). Gotchas: `up -d --force-recreate` short-circuit на volume-type change (нужно stop+rm -f+up); tmpfs RAM-backed → cgroup charge → OOM-restart collector при mem_limit 128m (overlay поднял до 2g, acceptance-only). Стенд восстановлен на baseline (MemLimit=128m, Tmpfs=map[], projects→named volume 457G). Артефакт: /tmp/opencode/res-01-g1-artifact.md |
| г2 — queue | rag pending > 8 (5m) | г2: штатная нагрузка (блок б) / fixture-сценарий | `NeurocenterRagQueueGrowing`: `firing` → `resolved` | grep-строки (или promtool fixture + строчка в доке) | **GREEN (11-24, 05:11–05:22Z)**: LIVE на реальной нагрузке блока б (фаза B: 22 sync-воркера / 22 проекта — 1 на проект, конфигурация без 409-потолка; base profile 1-writer pending≈0 не триггерит). pending>8 непрерывно 05:12:11.657→05:17:11.657 (for:5m; run-сэмплинг 14–15) → **firing** ts=2026-11-24T05:17:41.670Z (labels queue=rag, instance=rag-sync-service:4300) → load-off 05:18:30 → expr FALSE 05:19:11.657 (endsAt) → **resolved** ts=2026-11-24T05:22:41.669Z (group_interval 5m, D9 — ровно 5m0.001s, как г1). Стэн-заменителей нет: production-метрика rag-sync `neurocenter_work_queue_pending` (ProjectDatabases.withProject, cap 8 / wait 16) → prometheus rule → alertmanager → alerts.jsonl. Promtool-fixture-фолбэк подготовлен, не понадобился: /tmp/opencode/res01-g2-promtool-fixture.yaml (promtool test rules SUCCESS). Артефакт: /tmp/opencode/res-01-g2-artifact.md |
| г3 — service | down 1 сервиса | г3: `compose stop skills-service` → `start` | `NeurocenterServiceUnavailable` (1m): `firing` (labels: service/instance) → `resolved` | grep-строки firing/resolved | **GREEN** (11-24): stop 03:02:56Z → up=0 с 03:03:00 (scrape 15s) → pending 03:03:11.657 (первый eval; `activeAt` в /api/v1/alerts) → firing по for:1m ~03:04:11 (не доставлен — канал был разорван, D9) → stand-фикс D9 → redelivery: **firing-строка 03:13:41.693Z** (instance=skills-service:4200, groupKey, summary) + **resolved-строка 03:18:41.681Z** (endsAt=03:15:11.657 = реальное время resolve после start 03:14:14Z). Down-ветка /ready/dependencies зафиксирована live: 503 `{"ok":false,"checks":{"catalog":"ready","skills":"unavailable","rag":"ready","auth":"ready","featureFlags":"ready"}}` |
| г4 — stale-backup | `external_backup_verified == 0` (1m) | г4: состояние без проверенной внешней копии (стенд без внешнего S3) | `NeurocenterExternalBackupOverdue`: `firing` → `resolved` | gauge-значение + grep-строки | **GREEN (firing; resolve stand-limited по ранбуку)** (11-24): состояние стенда (внешняя копия не верифицирована) → **firing-строка 03:13:41.696Z** (instance=catalog-service:4100, summary «Нет проверенной внешней копии в пределах цели RPO»); resolved невозможен на стенде (нет внешнего S3/верификации) — зафиксировано в ранбуке как stand-limited |
| д — correlation | запрос через nginx с X-Request-ID | `res-01-e2e.mjs --blocks correlation` | id сквозной nginx→gateway→сервис; **нет** ticket-сегмента (REDACTED) и **нет** error.message | вывод драйвера + вырезки логов 3 уровней с одним id | **RED** (D8, тикет 24): драйвер непроходим для 2xx (nginx перезаписывает client-id; gateway/service не логят success). Production-корреляция верна — артефакт по manual-trace id из nginx access-лога (error/warn-путь) + фикс драйвера |
| е — crash | uncaughtException (controlled: `BACKGROUND_AGENT_E2E_CRASH_DISPATCH=1` / штатный unhandled) | е: контролируемый crash background-agent | safe-лог → `error_events` (PG) → exit(1) → restart; видно в admin UI (Error-модуль) и `GET /api/errors` | SQL error_events + скриншот UI + лог crash-handler + факт restart | **GREEN (crash-механизм)** (11-24, 04:08–04:14Z): controlled uncaughtException на dispatch-pass (env `BACKGROUND_AGENT_E2E_CRASH_DISPATCH=1`, overlay /tmp/opencode/compose.res01-e.yml) → safe-лог `{"event":"process-crash","code":"PROCESS_CRASH","type":"uncaughtException"}` → **7 строк error_events** (PG, level=critical, request_id=job 8d4acac4-…: 6× «Background agent process crashed (uncaught exception or unhandled rejection).» + 1× «Background agent job dead-lettered: retry budget exhausted (crash policy).», ts 04:13:05→04:13:54) → job-level crash record (attempts 1→6, backoff 500ms×2 cap 30s, maxAttempts=3) → controlled exit(1) → **docker restart (RestartCount=3 зафиксирован)** → job-level policy: после удаления env retry через реальный движок (D6 stand-in probe exit 1 = normal failed) → **dead_letter** (`dead_letter_reason='Retry budget exhausted (crash policy).'`, delivered=true). Stand-in job (D12-blocked production admission): byte-identical payload к `admitWithLink` (shared background-agent.cjs + backgroundAgentDigest). D6 stand-in движок НЕ исполнялся на crash-фазе (крэш до запуска движка). **RED-хвосты:** (D12/ticket 28) FR-305 start-маршрут `POST …/messages/:id/background-agent` отсутствует в RBAC-матрице gateway (access-policy.ts `allowProjectChat`) → 403 для всех — production I/O-путь недоступен end-to-end; (D13/ticket 29) `GET /api/errors` (admin Error-модуль) тоже отсутствует из access-policy → 403 → **скриншот UI / GET /api/errors BLOCKED** (события в PG написаны, разрыв только на read-пути оператора). Артефакт: /tmp/opencode/res-01-e-artifact.md; драйверы res-01-e.mjs + res-01-e-admit.mjs |
| ж — аудит | admin-мутация (MainAdmin) | ж: мутация (напр., runtime-limit-configuration CAS) | запись в единой истории (`GET /api/audit`): актор/время/ревизия; transactional (нет «мутация без аудита») | ответ /api/audit (выдержка) + скриншот Audit-модуля | **GREEN** (11-24): PKCE-логин blitz-fixture → Главный админ → PATCH runtime-limits (CAS rev 2→3, 200) → /api/audit строка `runtime.limits.update` (actor admin@example.test, at 03:02:11Z, outcome SUCCEEDED, resourceType runtime); transactional — мутация+строка вместе; AD-O7 `login.success` тоже в истории. (артефакт /tmp/opencode/res-01-block-zh.out) |
| з — health | `/ready` (up + down-ветка) | `res-01-e2e.mjs --blocks health` + HITL: stop 1 upstream | up: 200; gateway `{ok:true,checks:{gateway:'ready'}}`; down: 503 + `checks`-разложение; `GET /health` → 404 | ответы /ready (up/down) + 404 /health | **GREEN** (11-24): up — /ready 200, checks={gateway:ready} (e2e + повторный замеры после restore skills); down — live при stop skills: `GET /ready` (gateway, тривиальный) 200 (gateway жив), `GET /ready/dependencies` → **503 + checks-разложение** (skills=unavailable, остальное ready) — ровно по семантике readiness.cjs; `GET /health` → **404 на уровне gateway** («Cannot GET /health» — единственная health-семантика = /ready; через nginx-SPA fallback /health отдаёт index.html 200 — это фронт-роутинг, не health-эндпоинт) |

Дополнительно (г): формат `alerts.jsonl` и resolve-строки — `res-01-e2e.mjs --blocks alerts --expect …`;
grouping: при 6 down — **одна** строка `NeurocenterStackDown` + 6 строк `NeurocenterServiceUnavailable`.

## Stage 3 — повтор RES-01 на repo-фиксах (2026-11-25)

### 3.0. Repo-фиксы (путь к GO: «любой red → баг-тикет → фикс → повтор полный»)

| Тикет | Дефект | Фикс (репо, не стенд) | Коммит |
|-------|--------|----------------------|--------|
| 24 (D8) | e2e-драйвер correlation непроходим для 2xx (nginx перезаписывает client-id; gateway/service не логят success) | Драйвер читает id из nginx access-лога (AD-O2); endToEnd-критерий = nginx; unit-тест D8; self-contained compose logs: `NEURO_E2E_COMPOSE_ENV_FILE` → `--env-file` (env живёт в .env стенда, не в shell) | 2feb49d3 + 8c7de0e9 |
| 25 (D9) | prometheus.yml без `alerting:` → канал AD-O6 мёртв | `alerting: alertmanagers [alertmanager:9093]` в deploy/production/monitoring/prometheus.yml | 2feb49d3 |
| 26 (D10) | capacity-снапшот root:root 0600 нечитаем сервисами uid 1000 | publishCapacity: снапшот 0644 + каталог 0755; повтор 11-25 поймал EPERM-регресс (D14) на персистентном томе: чужой 0755-каталог + cap_drop ALL без CAP_FOWNER → безусловный chmod падал EPERM каждые 15s и ронял весь publish → снапшот застаревал → snapshot_available=0 → CapacityUnavailable + fail-closed гейт → chmod только если `(mode & 0o055) != 0o055` | 2feb49d3 + 1f6e70ca |
| 27 (D11) | quota-delivery requestKey (camelCase) vs request_key (snake_case) → ВСЕ delivery 400, used всегда 0 | Контракт каталога: `request_key` (rag-sync + skills, parseQuotaUsageInput + schema) | 2feb49d3 |
| 28 (D12) | FR-305 start-маршрут background-agent не в RBAC-матрице gateway → 403 для всех | access-policy allowProjectChat: маршрут добавлен | 2feb49d3 |
| 29 (D13) | GET /api/errors не в access-policy → 403, crash-события невидимы оператору | access-policy allowRequest: GET /api/errors (только Главный админ, read) | 2feb49d3 |

Сборка: образы `res-obs-20261125` (build4/5); 6+3 сервисов redeploy'нуты с production-топологией
из репо; stand-фикситуры D9 (prometheus-копия) и D10 (collector user overlay) УДАЛЕНЫ из
acceptance overlay — повторяется именно репо-код. D14 (EPERM publishCapacity) обнаружен
повтором 11-25, диагностирован и зафиксирован 1f6e70ca, live-верифицирован: снапшот
915B 0644 root:root, `snapshot_available=1` у всех 3 потребителей, CapacityUnavailable
firing 03:55:41.698Z (окно EPERM) → resolved 04:40:41.675Z (после redeploy с фиксом).

### 3.1. Повтор блоков (на фиксированных образах, 2026-11-25)

- **а1 — quota: GREEN** (рерун 04:37–04:43Z): sync#1 201 (30804→30805, rev 88→89) +
  seal 201 `complete=true` (rev 90); PATCH `retentionBytesLimit=1MiB` 200 (ответ уже несёт
  `retentionBytesUsed: 704` — T27 delivery ЖИВАЯ; 11-24 было used=0); sync#2 → 503
  `upstream-error` (AD-19 маска; 11-24 тот же envelope принимался GREEN) + server-side
  `[quota-guard] quota rejection dimension=retention reason=exceeded used=704
  limit=1048576 estimate=16777216` (16MiB-floor оценки) + метрика
  `neurocenter_quota_rejections_total{retention,exceeded}=75`; данные целы 30805.
  **T27 доказан SQL:** `project_quota_usage.retention.used_bytes=704` = Σ
  `project_quota_usage_requests.delta_bytes` (repro-snake +1234 / repro-undo −1234 /
  intent:b3441526 +352 / intent:c35b0407 +352).
- **а2 — two-tier: GREEN** (рерун 04:47Z): revisions 7→8→9; 3 docs ACCEPTED под docs=16 →
  **400 REJECTED** под docs=2 (без рестарта) → граница 2 docs 201 → ceiling 300 400;
  audit-строки 89a7d693→rev8, 045c8b51→rev9 (04:47:58Z).
- **а3 — hardening: GREEN** (рерун): catalog/skills/rag-sync node/256, background-agent
  node/256, capacity-collector root/32, api-gateway node/128, prometheus nobody/512
  (+cap_drop по сервисам) — сверено с environment-model.
- **а4 — fork-стресс: GREEN** (рерун 04:55–05:10Z): pids.max=256 (cgroup v2 подтверждён);
  2-бомба пики 232/256 и 253/256, 3-бомба 245/256; **EAGAIN зафиксирован**
  (`sh: 0: Cannot fork`, dash exit 2) — динамика: dash reap'ит bg-детей лениво →
  zombie-осцилляция 12→138→191→201→256 → транзитно 256 → EAGAIN; одиночная runbook-бомба
  детерминированно НЕ насыщает (97/256 — совпадает с заметкой 11-24); контейнер пережил
  всё (Up healthy, /ready 200); хост не затронут (PIDs 522–538, load 4.4–10.6 естественный,
  нет OOM/kill). RLIMIT_NPROC unlimited, memory 38/512MiB, PidMode private, pid_max
  4194304 — исключены. `docker top` сегодня работает (11-24 был сломан).
- **б — нагрузка: GREEN** (рерун 05:16:42–05:28:30Z, 11 мин, driver res-01-b.mjs):
  200 chat-msg (198×201 + 2×503), **232 148 embeddings**, sustained 11 мин.
  RSS: утечек НЕТ — все сервисы флат под нагрузкой (catalog 113–115M ±0.5%, rag 218–241M,
  api 306–321M ±1%, skills 38–39M, ba 40–41M; пик drain rag 292M) и **освободили рабочую
  область post-load** (rag 292→114M, api 308→218M, catalog 114→98M, ba 77→41M;
  api-gateway V8 high-water масштабируется с пропускной способностью: +2.5GB payload
  г2-прогона → 339M при нулевой нагрузке — flat при постоянном темпе, не утечка).
  CRASHES 0; postgres RestartCount=0, Up 41ч (тот же контейнер, StartedAt 2026-11-23T12:44),
  pg-RSS 913M — независимая проверка (баг драйвера имени `postgres-1-1` — тот же, что 11-24).
  WAL 896→1008M (сегменты рикалцировались mid-run: 896→784→1008). pid 12/12 всё окно.
  5xx 36/1492 + 2 chat-503 = ТОЛЬКО истинное capacity с причиной в диагностике:
  catalog pg-pool (max 10/scope, 5s; 34× «timeout exceeded when trying to connect») →
  18×500 rag/sync; ProjectRagUnavailable «Сервис индексов недоступен. Результат записи
  будет проверен перед повтором» (project-rag-client.ts, timeout/abort на rag-sync) →
  11×503 rag/sync; 2×503 rag/manifest «Каталог не подтвердил активный индекс проекта»;
  2×503 chat = access-decision-вызов gateway→catalog упал (proxy.service.ts:254–266 →
  503 «Не удалось проверить доступ к ресурсу.»; без error-лога — AD-19). p95: chat 1056ms,
  rag 4497ms (ожидание в 8-слотовой очереди под перегрузкой — ожидание, не деградация).
  Наблюдение (не дефект): quota-delivery best-effort без ретрая (project-quota-usage.ts:63–67) —
  6 delivery упали на те же pg-pool 500 под нагрузкой; механизм (а1) при штатной работе
  доказан, 16MiB-floor estimate доминирует enforcement.
- **в — scrape: GREEN** (рерун e2e после env-file-фикса): 6/6 up=1.
- **д — correlation: GREEN** (рерун e2e 8c7de0e9): nginx `$request_id` из access-лога,
  endToEnd-критерий = nginx (успешный запрос не логируется gateway/service — зафиксировано).
- **е (красный хвост): GREEN** (рерун): T29 `GET /api/errors` 200 total=794 (7 crash-строк
  e-crash 11-24 видны: 6× «process crashed» + 1× «dead-lettered»); T28
  `POST …/background-agent` → **201** {requestKey, state:pending} (было 403 для всех).
- **ж — аудит: GREEN** (рерун 04:52Z): PKCE blitz-fixture → CAS rev 9→10 → audit-строка
  `runtime.limits.update` (security:1d580c85…, 2026-11-25T04:52:40.596Z).
- **з — health: GREEN** (рерун e2e): up 200 /ready; /health 404 на gateway.
- **г3 — service: GREEN** (live 11-25, production-топология): ServiceUnavailable pair
  firing 03:59:41.672Z → resolved 04:04:41.665Z (skills stop/start, alertmanager-канал
  репо-фикса t25).
- **г4 — stale-backup: GREEN (firing; resolve stand-limited по ранбуку)**:
  `NeurocenterExternalBackupOverdue` firing 2026-11-25T03:28:41.913Z (catalog-service:4100) —
  состояние стенда без внешней S3; resolve невозможен на стенде (то же, что 11-24).
- **г2 — queue: GREEN** (2 итерации):
  - итерация 1 (в составе блока б, 05:20:42–05:27:46Z): 22w/22p batch 100–200 →
    pending 3–14, просадки ≤8 (05:23:30=8, 05:24:00=3, 05:26:30=5 — for:5m сбросился 3×)
    — алерт не сработал; механизм задокументирован: capacity-5xx (pg-pool) → 1s-sleep
    воркеров → просадки. 11-24 та же конфигурация держала pending 10–14 (везение фазы).
  - итерация 2 (детерминированное давление, res-01-g2.mjs, 05:33:43–05:48:19Z,
    14 мин, batch 400+jitter, чистое queue-давление без chat): pending >8 непрерывно
    **770s** (10s-сэмплинг, 0 просадок ≤8 после 30s ramp; 10–15) → **firing**
    ts=2026-11-25T05:40:41.676Z (startsAt 05:40:11.657, for:5m; instance
    rag-sync-service:4300, queue=rag) → load off 05:48:19 → endsAt 05:48:11.657 →
    **resolved** ts=2026-11-25T05:50:41.702Z. 1060/1060 syncs 201 (441 129 chunks,
    p50=10.1s p95=13.3s — 400-chunk-батчи; 5xx = 0: длинный sync держит воркеров в
    очереди, pg-pool не насыщается так, как при коротких батчах).
- **г1 — disk: GREEN** (рерун, 1G tmpfs-станд-том, overlay как 11-24; 3 итерации):
  - итерация 1 (05:51–06:01Z) — не зачтён (стенд, не репо): `.env` стенда несло
    устаревшее `NEUROCENTER_RELEASE='res-obs-20261123'` (утренний redeploy шёл с
    явным override, .env не обновляли) → драйвер пере-создал collector на старом
    образе (pre-t26 publishCapacity: снапшот 0600 root:root) → потребители uid 1000
    EACCES → `snapshot_available=0` с 05:52:00, `free_bytes` не рендерился → expr
    не оценивался. Инцидент ЧЕСТНО зафиксирован репо-alert-каналом (t25):
    CapacityUnavailable firing 05:53:41.721Z ×3 → resolved 06:13:41.711Z ×3 (после
    восстановления 06:05Z: force-recreate с NEUROCENTER_RELEASE=res-obs-20261125,
    снапшот 0644, 3/3 snapshot_available=1). Урок зафиксирован (quirk 6b3e683c):
    на этом стенде — явный release-override в env compose-вызова + сверка image
    контейнера до/после recreate.
  - итерация 2 (06:14–06:22Z) — GREEN по правилу, 2/3 инстанса: fill 950M
    (root, gotcha `mode:1777`=decimal) → freeBytes=77594624 → **firing**
    06:16:42.001Z (catalog) / 06:16:42.008Z (skills) → rm 06:16:42 → **resolved**
    06:21:41.780/781Z (×2). rag-sync: expr TRUE 06:15:30–06:17:00 (метрика
    77594624), но его for:1m-фаза запаздывала (scrape-offset) и rm драйвера пришёлся
    в её хвост — racing драйвера, не продукт.
  - итерация 3 (06:25–06:33Z) — чистый 3×3: fill 950M → freeBytes=77594624 →
    **firing** 06:28:11.740Z (catalog) / 06:28:11.743Z (rag-sync) /
    06:28:11.743Z (skills) (startsAt 06:28:11.657, for:1m; resource=projects,
    severity=critical) → rm только после firing всех 3 (06:28:32) → **resolved**
    06:33:11.678Z (catalog) / 06:33:11.681Z (rag-sync) / 06:33:11.681Z (skills)
    (endsAt 06:29:11.657, group_interval 5m). Стенд восстановлен: collector на
    res-obs-20261125, MemLimit=128m, Tmpfs=null, снапшот 0644,
    projects ≈490G total / ≈210G free.

### 3.2. Вердикт Stage 3

**GO**: 8/8 блоков green на фиксированных образах (production-топология из репо,
stand-фикситуры D9/D10 удалены). Красный 11-24 (д) закрыт repo-фиксами 2feb49d3+8c7de0e9
и рераном GREEN. Дефекты D8–D13 закрыты в репо (тикеты 24–29 → FIXED); D14 (EPERM
publishCapacity, пойман повтором) закрыт 1f6e70ca. Known-defect ff:4400 (flagged,
вне скоупа) — без изменений.

## GO / NO-GO

- **Verdict: GO** (2026-11-25, stage 3 — повтор на repo-фиксах: 8/8 green; §Stage 3).
- **Verdict: NO-GO** (2026-11-24, stage-2 live-приёмка выполнена полностью; история).
- **11-24 (stage 2) — история:** S-статика 64/1/5 + live 8/8 блоков выполнены —
  **7/8 GREEN** (а a1–a4, б, в, г г1–г4, ж, з; е — crash-механизм GREEN), **1/8 RED** (д).
- **RED 11-24: д (correlation)** — D8, тикет 24: e2e-драйвер непроходим для 2xx (требует
  gateway-строку, которую успешный запрос не даёт, и гребёт client-id, который nginx
  перезаписывает). Дефект драйвера, не продукта — но по правилу протокола любой red → NO-GO.
- **Открытые дефекты, зафиксированные на GREEN-блоках (тикет открыт, сам блок green):**
  D12 (тикет 28: стартовый маршрут FR-305 background-agent не в RBAC-матрице gateway →
  403 для всех) и D13 (тикет 29: GET /api/errors не в access-policy → 403, crash-события
  невидимы оператору) — оба обнаружены в блоке е (crash-механизм сам GREEN);
  D11 (тикет 27: quota-delivery requestKey/request_key mismatch — accounting мёртв,
  fail-closed intact).
- NO-GO по правилу: «любой red → баг-тикет → фикс → повтор RES-01 (полный)».
- **Путь к GO (выполнен 2026-11-25, §Stage 3):** repo-фиксы (не стенд) тикетов
  24 (e2e-драйвер), 25 (alerting-секция prometheus), 26 (snapshot 0644 + non-root-
  покрытие харнеса), 27 (request_key), 28 (RBAC-маршрут FR-305), 29 (access-policy
  /api/errors) → повтор RES-01 полный → GO.
- Known-defect (вне скоупа, flagged): ff:4400 (frontend `/health` 404 — error-body-policy 3/7).
- Дефекты стенда D1–D14 = тикеты 17–29 + D14: 17–23 fixed в репо (6ce92dde…110775a8,
  7/7; D7 — env-фикс), 24 (D8) FIXED 2feb49d3+8c7de0e9, 25 (D9) FIXED 2feb49d3,
  26 (D10) FIXED 2feb49d3, 27 (D11) FIXED 2feb49d3, 28 (D12) FIXED 2feb49d3,
  29 (D13) FIXED 2feb49d3, D14 (EPERM publishCapacity, пойман повтором 11-25)
  FIXED 1f6e70ca.

## Ссылки

- Тикет: `tickets/story-res-01-e2e-acceptance-plan.md` (I/O-матрица S..з, Design Notes).
- Readiness: `docs/implementation-readiness.md` P0-RES («Чего недостаёт» закрывается этим протоколом при GO).
- Ограничения/таблица ресурсов: `docs/capacity-admission.md`.
- Канал алертов + механика вызова условий: `docs/production-setup.md` §«Канал алертов», §«HITL-приёмка 6.15».
- Сценарий S26: `docs/publication-scenarios.md:73`.
