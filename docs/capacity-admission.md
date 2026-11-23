# Физические ресурсы и остановка тяжёлых записей

Production Compose запускает `capacity-collector` из того же закреплённого catalog-образа. У него нет сети, Docker socket и секретов; PG, skills, projects, backups и runtime-artifacts смонтированы read-only. Сборщик каждые 15 секунд измеряет **физическую файловую систему** через `statfs`, отдельно сверяет `pg_wal` и считает его сегменты. Размер базы из `pg_database_size` не подменяет свободное место. Снимок атомарно публикуется в производный том `capacity`, который приложения получают read-only **директорией**, поэтому `rename` не оставляет старый bind-inode. Этот том не включён в DR-комплект и создаётся заново.

Перед стартом рабочих сервисов Compose ждёт здоровый сборщик. `setup.mjs up` сначала поднимает PostgreSQL и initializer, затем Compose поднимает сборщик и приложения в порядке зависимостей. Запуск старых образов без новых `/shared/capacity*.cjs` с этой конфигурацией завершится ошибкой; поставляйте согласованный выпуск. Сборщик продолжает работать при offline backup: он не пишет в исходные тома, не подключается к PG и не мешает согласованию данных.

При `CAPACITY_REQUIRED=true` отсутствующий/повреждённый/просроченный более 90 секунд снимок, недоступный том или несоответствие файлового устройства дают 503 **до** защищённой тяжёлой записи. Недостаток места с учётом оценки операции и фиксированного резерва 1 ГиБ даёт 507 с понятным сообщением. Локальные записи скиллов, артефактов и дампов дополнительно проверяют `statfs` собственного управляемого корня; папки временных файлов находятся на этих же томах, отдельного вымышленного staging-каталога нет.

Защищены создание проектной БД, пакетная запись RAG, сохранение/создание скиллов и их журналов, импорт runtime-архива и поток HTTP-копии. Для RAG используется запас `max(16 МиБ, 6 × байты JSON)` под строки/индексы/WAL; создание БД резервирует `max(64 МиБ, 3 × размер шаблона)`. Это консервативные оценки, требующие проверки на рабочей нагрузке. Исходные логические квоты RAG и бюджет копий остаются отдельными ограничениями.

В одном процессе одновременные записи на одном физическом устройстве делят резерв. Завершённая оценка остаётся списанной до нового замера; незавершённый резерв переживает смену снимка. Между разными процессами нет распределённого allocator, а посторонний writer и рост WAL могут занять место после проверки. Поэтому эта защита **не является OS-квотой и не обещает предотвращение любого переполнения PG**. До промышленного допуска нужны filesystem/storage enforcement, проверка объёмов/WAL на целевой нагрузке, резерв под миграции и обслуживание. Небольшие обычные записи каталога, SQL вне приложения и полный DR CLI этим admission пока не покрыты.

Перенос `pg_wal` симлинком за пределы смонтированного PG-тома считается недоступным ресурсом и блокирует тяжёлые операции. Для отдельного WAL-диска требуется явное расширение read-only topology сборщика с проверкой реального тома; произвольный env-путь не считается достаточным доказательством.

Операторская проверка заново читает физические тома сборщика и печатает JSON без путей и секретов:

```sh
node scripts/production/resources.mjs --directory /etc/neurocenter --project-name neurocenter-production
```

`/metrics` защищённых сервисов отдаёт доступность/возраст снимка, свободные/полные байты по ресурсу, WAL, причины отказов и очередь RAG. При ошибке измерения неизвестные размеры не превращаются в ноль. Правила Prometheus добавляют предупреждения о недоступном замере, свободном месте менее 1 ГиБ или 15%, очереди RAG более восьми и непроверенной/просроченной внешней копии. Prometheus/Alertmanager нужно подключить и проверить отдельно: файл правила сам по себе не является доставленным оповещением.

Проверки: `node --test scripts/test/capacity.test.cjs scripts/test/observability.test.cjs scripts/test/metrics-completeness.test.mjs`; typecheck catalog, skills и rag-sync. Эти локальные проверки не подменяют Docker/native/server приёмку и тест реального заполнения отдельного стенда.

## Ресурсные ограничения сервисов (AD-OP-6)

Ресурсная таблица — это модель `deploy/production/environment-model.json`: единственный машино-читаемый
источник. Drift-тест (`scripts/test/compose-drift.test.mjs`, `structuralDrift`) сверяет модель с compose
по каждому полю, включая `pidsLimit` и `user`, — в обе стороны. Таблица ниже — проекция модели для
review: её не редактируют руками, значения берутся из модели (автоматическая сверка проекции —
Deferred, OQ-4). Инвариансы (long-running — pids_limit, app-сервисы — non-root, все — mem_limit,
ратифицированные значения) проверяет `scripts/test/resource-limits-invariant.test.mjs`.

| сервис | mem_limit | cpus | pids_limit | user | примечания |
|---|---|---|---|---|---|
| model-runtime | 5g | 4 | 512 (ратиф.) | `0` (root — выбор образа) | cap_drop ALL |
| postgres | 1g (ратиф.) | 2 | 256 (якорь) | `postgres` (uid 999) | entrypoint образа работает от postgres |
| capacity-collector | 128m | 0.25 | 32 (ратиф.) | `0` (root — читает 700-том postgres; DAC_OVERRIDE неэффективен для non-root) | read_only, cap_drop ALL + DAC_OVERRIDE, network_mode none |
| database-init | 512m | — | 128 | `1000` | one-shot, profile setup |
| bootstrap-admin | 512m | — | 128 | `1000` | one-shot, profile setup |
| background-agent | 1g | 2 | 256 (ратиф.) | `1000` | cap_drop ALL |
| catalog-service | 512m | 1 | 256 (якорь) | `1000` | cap_drop ALL, seccomp catalog-packager (bwrap) |
| feature-flags-service | 256m | 0.5 | 128 (ратиф.) | `1000` | |
| skills-service | 512m | 1 | 256 (якорь) | `1000` | |
| rag-sync-service | 2g | 2 | 256 (якорь) | `1000` | |
| oauth2-bridge | 256m | 1 | 256 (якорь) | `1000` | |
| api-gateway | 512m | 1 | 128 (ратиф., AD-4) | `1000` | cap_drop ALL (child-MCP) |
| frontend | 128m | 1 | 64 | `1000` | nginx, non-root master (6.1) |
| node_exporter | 128m | 1 | 64 (ратиф.) | `65534` | USER nobody — дефолт образа |
| prometheus | 1g | 2 | 512 (ратиф.) | `65534` | USER nobody — дефолт образа |
| alertmanager | 256m | 0.5 | 128 (ратиф.) | `65534` | USER nobody — дефолт образа |

- **Baseline pids = 256** — `pids_limit` в x-service-якоре `compose.production.yml` (OQ-1): Node-сервис
  держит 1-3 PID, 256 — запас против форк-бомбы с рабочим запасом по процессам. Per-service override —
  только осознанное отклонение; ратифицированные (не меняются): 512/32/128/128/256/64/512/128. Новые
  (OQ-2/OQ-3): postgres, catalog, skills, rag, bridge — 256 через якорь; frontend — 64 (nginx master +
  worker'ы, фактические единицы PID); setup-контейнеры — 128 + mem 512m.
- **user**: 11 сервисов на образах neurocenter/* работают от `node` с единым uid **1000** (6.1 — общие
  named volumes). Внешние образы вне non-root-скоупа (6.1): `ollama/ollama` — root (выбор образа),
  `pgvector/pgvector` — процесс от `postgres` (uid 999; проверено: initdb и рестарт под `user: postgres`),
  prom/* — `nobody` (65534, Config.User образов). Compose объявляет `user` явно у всех сервисов —
  ратификация фактических uid (external-note в модели).
- Живая проверка (fork-стресс: контейнер получает EAGAIN, хост стабилен, restart policy возвращает сервис;
  `docker inspect` → PidsLimit) — final gate.

## Design note: CAPACITY_REQUIRED=false и machine-метрики (AD-18 / AD-O3)

`CAPACITY_REQUIRED=false` у api-gateway, oauth2-bridge и feature-flags-service — **осознанно** (AD-O4): эти сервисы не выполняют защищённые тяжёлые записи (создание БД, RAG-батч, импорт runtime-архива, поток HTTP-копии), поэтому capacity-блок и machine-метрики у них не рендерятся. Это не дефект и не отсутствие покрытия — решение зафиксировано в полисе AD-O4 и проверяется completeness-тестом (AD-O3). Catalog, skills и rag-sync (`CAPACITY_REQUIRED=true`) отдают capacity-семейства и machine-метрики.

Machine-метрики (host RAM/CPU) считываются сборщиком из `/proc/meminfo` + `/proc/stat` (AD-18): `network_mode: none` + `DAC_OVERRIDE` в compose не маскируют `/proc`. Поле `machine` добавляется в snapshot.json; cpuUtilization — дельта по кумулятивным jiffies `/proc/stat` между тиками (модульное состояние), на первом тике поле отсутствует («нет данных», а не 0). `validateSnapshot` не требует `machine` — старые снапшоты (включая schemaVersion 1 и rolling-deploy с новым/старым коллектором) остаются валидными; новый сборщик всегда публикует `machine`. Метки — только фиксированные groups: в metric-пространство не попадают email, ID проектов и произвольные URL.

## Единственная health-семантика: /ready (AD-O4)

В стеке одна семантика готовности — `GET /ready` (503 + `checks`-разложение драйверами). `/health` как liveness-эндпоинт удалён (liveness = «контейнер жив» = docker restart policy, а не HTTP). Docker-проверки (dev- и production-compose) опрашивают `/ready`; внешний мониторинг использует тот же `/ready`.

### `/ready/dependencies` — решение

`GET /ready/dependencies` (api-gateway, 5 upstream'ов: catalog / skills / rag / auth / featureFlags) сохранён — это диагностика готовности зависимостей, а не маршрутизация трафика (AD-4, entry 9):

- **consumers**: `stack-watchdog` (эпик 4, AD-OP-8), admin UI (OQ-1);
- **решение**: оставить; **удалить, если к концу эпика 4 не подключён** — ревизия = задача эпика 4.

Проверка зависит от upstream'ов: `/ready` локального сервиса остаётся 200 + `{ok:true, checks:{<svc>:'ready'}}`, а `/ready/dependencies` при недоступном upstream'е возвращает 503 + `checks` разложение.

### CAPACITY_REQUIRED=false — capacity-метрики не рендерятся у gateway / bridge / feature-flags

`renderCapacityMetrics` (`services/shared/capacity.cjs`) эмитит снимки `neurocenter_capacity_*` только при `CAPACITY_REQUIRED === 'true'`. У api-gateway, oauth2-bridge и feature-flags-service переменная не задана, поэтому `/metrics` у них **не отдаёт** capacity-снимок — только счётчики отказов и очередь. Это осознанно: capacity-admission критичен для тяжёлых записей каталога, а не для транзитных/лёгких сервисов. Для этих трёх сервисов `CAPACITY_REQUIRED=false` означает, что `/ready` не проверяет capacity — health-смысл `/ready` у них изолирован от капасити-защиты. Prometheus-оповещения по capacity (`/metrics` catalog, `capacity-collector` при `CAPACITY_REQUIRED=true`) остаются.

