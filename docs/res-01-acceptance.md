# RES-01 — e2e-приёмка P0-RES (HITL-ранбук)

Приёмка epic-res-obs (epic 6, P0-RES) на живом production-стеке. Закрывает readiness-критерий
`docs/implementation-readiness.md` P0-RES: «Применённые ограничения хранилища, проверка конкурирующих
writers/WAL/заполнения и нагрузки; настоящий scrape и доставленные уведомления» (+ «файл Prometheus
rules не является доставленным alert»). Сценарий S26 — `docs/publication-scenarios.md:73`.

**Принципы (из тикета 6.15):**

- RES-01 — consumer артефактов entry 1–14: production-код сервисов **не меняется** и не пересобирается.
- Каждый блок — с **артефактом** (лог/скриншот/метрика/значение) в протоколе
  `_bmad-output/initiative-architecture/tickets/epic-res-obs/RES-01-protocol.md`.
- Любой **red = баг-тикет** (не «потолерировать», не «чинить на ходу»): red → баг-тикет → фикс → повтор RES-01.
- **GO только при 8/8 green.**
- «Доставлено» (блок г) = **запись в `alerts.jsonl`/journal с меткой времени**; alertmanager UI — диагностика, не канал.

## 0. Состав приёмки

| # | Блок | Тема | Способ |
|---|------|------|--------|
| S | Sweep | grep-инвентарь по 8 правилам эпика | автоматический (статический, до live) |
| а1–а4 | Лимиты | quota-отказ, two-tier, UID≠0/pids, fork-стресс | HITL |
| б | Нагрузка | конкурирующие тяжёлые операции, WAL, диск | HITL |
| в | Scrape | Prometheus targets 6/6 up=1 | автоматический (драйвер) |
| г1–г4 | Алерты | disk/queue/service/stale → доставлено+снято | HITL + драйвер (формат) |
| д | Логи | correlation nginx→gateway→сервис, без ticket/error.message | автоматический (драйвер) |
| е | Ошибки | crash → error_events + admin UI | HITL |
| ж | Аудит | admin-мутация → единая история | HITL |
| з | Health | /ready-семантика, /health удалён | автоматический (драйвер) + HITL (down-ветка) |

Автоматизируемое (без HITL): sweep, в, з (up-ветка), д, формат alerts.jsonl (г).
HITL: а1–а4, б, вызов условий г1–г4, е, ж, з (down-ветка).

## 1. Предпосылки и развёртывание production-стека

### 1.1. Стенд

- Хост с Docker, достаточный по RAM/CPU для 7 app-контейнеров + мониторинг (модель ресурсов —
  `deploy/production/environment-model.json`, таблица в `docs/capacity-admission.md` §AD-OP-6).
- Node.js 24 на сборочной машине: `export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH`.
- **Замкнутый контур (AD-OP-2/AD-15):** стек стартует с `--pull never`-семантикой — только локальные
  образы. Базовые образы (7) закреплены digest'ами — сверить на хосте:

  | Образ | Digest |
  |---|---|
  | `node:24.22.0-bookworm-slim` | `sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5` |
  | `nginx:1.30.6-alpine` | `sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5` |
  | `ollama/ollama:0.35.1` | `sha256:292ee7945dfc3d5840a181f3ab86fedb1e66703e02c8af98b50f4da56b7e278c` |
  | `pgvector/pgvector:pg16` | `sha256:ad2e18408bf447f62092a8a5259e7df10505c5a0360bd1a1853ac8b8b0763da2` |
  | `prom/node-exporter:v1.9.1` | `sha256:863b62ff9f392b6f472e22b4b670ad1cabb66b3042502ebd4b2cd192733e1bce` |
  | `prom/prometheus:v3.0.0` | `sha256:3b9b2a15d376334da8c286d995777d3b9315aa666d2311170ada6059a517b74f` |
  | `prom/alertmanager:v0.32.1` | `sha256:51a825c2a40acc3e338fdd00d622e01ec090f72be2b3ea46be0839cd47a4d286` |

  ```sh
  docker image ls --digests | grep -E 'node:24.22.0-bookworm-slim|nginx:1.30.6-alpine|ollama:0.35.1|pgvector:pg16|node-exporter:v1.9.1|prometheus:v3.0.0|alertmanager:v0.32.1'
  ```

### 1.2. Сборка и запуск (7 application-образов: 6 app + frontend)

По `docs/production-setup.md` §«Проверка, сборка и первый seed»:

```sh
npm ci --ignore-scripts
node scripts/production/setup.mjs check --directory /srv/neurocenter/config
node scripts/production/setup.mjs build --directory /srv/neurocenter/config   # fail-closed, чистое дерево, manifest
node scripts/production/setup.mjs up --directory /srv/neurocenter/config
```

- production `.env` — обычный файл с ровно одной `NEUROCENTER_RELEASE` (меткой релиза),
  `NEUROCENTER_CONFIG_DIR` — каталог закрытых конфигов (0700), `NEUROCENTER_HOST` — наружный адрес edge.
- `up` — БД-миграции (catalog/flags/RAG-base), проверка места, запуск с ожиданием readiness.
  Первый запуск — `seed` (bootstrap-администратор).
- Артефакт 1.2: SHA HEAD + timestamp commit из `release-manifest.json`, `docker compose ps` — все сервисы Up.

### 1.3. Канал алертов и watchdog на хосте

По `docs/production-setup.md` §«Канал алертов (AD-O6, ep6 entry 13)»:

```sh
# host-receiver (systemd): юнит deploy/production/alert-receiver.service → /etc/systemd/system/,
# CERT_PATH = TLS_CERT_FILE из production .env
systemctl daemon-reload && systemctl enable --now neurocenter-alert-receiver
curl -s localhost:9111/ready    # → ready
```

`stack-watchdog` — systemd-timer каждые 5 минут (`scripts/production/stack-watchdog.mjs check`,
consumer `/ready/dependencies`, 5 upstream'ов) — включить по той же секции.

### 1.4. Sweep (блок S) — статический, до live

```sh
node scripts/test/res-obs-sweep.mjs
```

Критерий: **0 необъявленных hits** (allowlist зафиксирован в самом скрипте с комментариями —
каждый excepted hit обоснован). 8 правил: console.* в src (excl CLI/тесты); error.message в логах
(redaction); quota-поля без enforcement-точки; секции RUNTIME_LIMIT_CEILINGS без enforcement-точки;
/health в src+nginx; app-сервисы вне scrape targets; Dockerfile'ы app-образов без USER=$SERVICE_USER;
сервисы без user/pidsLimit в environment-model.

Артефакт S: вывод скрипта (отчёт по 8 правилам, «0 undeclared»).

## 2. Блок а — лимиты и hardening (HITL)

### а1. Quota-отказ (projects.quota)

1. Выбрать тестовый проект; задать малый `retentionBytesLimit` (MainAdmin — квотное поле проекта /
   JSON-поле `projects.quota`: `retentionBytesLimit`).
2. Выполнить запись сверх лимита (сообщение/вложение, размер > остатка).
3. **Ожидание:** явный отказ `507 QUOTA_EXCEEDED` (quota-guard `decideQuota`, fail-closed) либо `503`;
   прежние данные проекта целы; `retentionBytesUsed` не изменился из-за отклонённой записи.
4. **Артефакт:** ответ HTTP (код + body), SQL-снимок quota-полей проекта до/после, лог enforcement-точки.
5. **Red:** запись прошла (лимит не исполняется) / данные повреждены / без явной причины.

### а2. Two-tier: policy в DB применяется

1. Зафиксировать текущую effective policy (MainAdmin: чтение policy + revision).
2. Изменить значение policy через MainAdmin (runtime-limit-configuration: revision CAS, атомарный аудит).
3. Вызвать ту же операцию (тяжёлая запись/адмиссия), которая ранее прошла/отказалась.
4. **Ожидание:** решение enforcement-точки изменилось согласно новому значению policy **без рестарта**
   сервисов; ceiling-константы кода не превышены (ceiling — верхняя граница policy).
5. **Артефакт:** policy до/после (revision), решения до/после, строка аудита изменения.
6. **Red:** policy не применена без рестарта / enforcement читает старое значение / превышен ceiling.

### а3. Hardening: UID≠0 и pids_limit

```sh
# 7 app-контейнеров (AD-OP-6): uid 1000 (node) во всех
for c in neurocenter-production-catalog-service-1 neurocenter-production-api-gateway-1 \
         neurocenter-production-skills-service-1 neurocenter-production-rag-sync-service-1 \
         neurocenter-production-feature-flags-service-1 neurocenter-production-oauth2-bridge-1 \
         neurocenter-production-frontend-1; do docker exec "$c" id; done

# PidsLimit по модели (environment-model.json)
docker inspect --format '{{.HostConfig.PidsLimit}}' <container>
```

**Ожидание:** во всех 7 — `uid=1000` (≠0); `PidsLimit` = значению модели (якорь 256 / ратифицированные
отклонения — таблица capacity-admission.md §AD-OP-6). Внешние образы вне non-root-скоупа (ollama — root,
pgvector — postgres, prom/* — nobody) — сверить с моделью, это не red.

**Артефакт:** вывод `id` (7 строк) + `PidsLimit` (по каждому сервису) + сверка с моделью.
**Red:** любой app-контейнер от root / PidsLimit не совпадает с моделью.

### а4. Fork-стресс (контролируемый)

Один контейнер (например, skills-service), `pids_limit` из модели:

```sh
timeout 10 docker exec neurocenter-production-skills-service-1 sh -c 'while :; do : & done' &
```

**Ожидание:** контейнер получает EAGAIN по PID-лиміту и умирает (pids), **хост не затронут**
(`uptime`/процессы хоста стабильны); restart policy возвращает сервис. Ограничение: timeout 10s,
один контейнер — не настоящий fork-bomb.

**Артефакт:** `docker ps` (restart после смерти), `dmesg | tail` (host intact), PID хоста до/после.
**Red:** хост затронут (процессы хоста убиты/pid-pressure) — red-критический, баг-тикет немедленно.

## 3. Блок б — нагрузка (HITL, G-10: зафиксированный объём)

**Цели (масштаб пилота, решение пользователя 2026-11-09):** 10 проектов (5 активных с RAG);
30 агентов (3/проект; 10 параллельных автономных раундов); 2000 сообщений в крупнейшей комнате
(100k всего; вложения 50MiB/10 — FR-404); 250k embeddings RAG суммарно (100k — топ-проект);
5 GGUF-моделей hosted (20B–70B, 2 активны в inference). **60-минутный sustained-прогон.**

1. Подготовить данные по целям выше (через API/UI; embeddings — штатный RAG-индекс).
2. Запустить 10 параллельных автономных раундов агентов; конкурирующие тяжёлые операции
   (создание БД проекта, RAG-батч, импорт runtime-архива, потоковые загрузки) + рост WAL
   (активные записи) + сценарий нехватки диска (см. г1, на резерве — без вреда для данных).
3. Измерять в прогоне (раз в 5 минут): `docker stats --no-stream` (RSS по сервисам),
   p95 API (gateway-метрики/логи), `ls /proc/1/fd | wc -l` и PID-счётчики в контейнерах,
   `pg_wal` (размер WAL: `pg_ls_walfiles()`).
4. **Критерии green:** RSS-дрейф <10% за прогон; p95 в бюджетах (ready-бюджеты shared);
   **0 crash** (error_events без критических); fd/pid стабильны; 503/507 — только истинное
   capacity-превышение **с причиной в UI/диагностике** (не «молча упало»).
5. **Артефакт:** таблица замеров (60 мин, шаг 5 мин), p95-значения, WAL-кривая, выдержки логов
   capacity-отказов с причиной.
6. **Red:** drift ≥10% / p95 вне бюджетов / crash без причины / молчаливое 500.

## 4. Блок в — scrape (автоматический, драйвер)

```sh
node scripts/test/res-01-e2e.mjs --blocks scrape
```

- **Ожидание:** все таргеты job=`neurocenter` — `up=1` (6/6). `feature-flags-service:4400`
  — known-defect instance: если таргет существует и down — verdict **flagged** (зафиксированный
  дефект, не регрессия данного прогона); остальные down — red.
- **Артефакт:** вывод драйвера (статус по каждому таргету) + `curl -s localhost:9090/api/v1/targets` (JSON).
- **Red:** любой таргет (кроме known-defect) down.

## 5. Блок г — алерты: «вызвать → доставлено → снято» (HITL)

Критерий: условие вызвано → в `/var/log/neurocenter/alerts.jsonl` (и/или journal
`neurocenter-alert-receiver`) строка `firing` с временем → условие снято → строка `resolved`.
Формат строк и resolve-строки дополнительно проверяет драйвер:
`node scripts/test/res-01-e2e.mjs --blocks alerts --expect NeurocenterDiskSpaceLow,NeurocenterServiceUnavailable,NeurocenterStackDown`.

Пошагово (механика вызова — `docs/production-setup.md` §«HITL-приёмка 6.15»):

| # | Условие | Алерт (for) | Вызов | Снятие |
|---|---------|-------------|-------|--------|
| г1 | free < 1GiB | `NeurocenterDiskSpaceLow` (1m) | `dd if=/dev/zero of=<том>/filler-nc bs=1M count=<N>` до free < 1GiB (том capacity-collector) | `rm filler-nc` |
| г2 | rag pending > 8 | `NeurocenterRagQueueGrowing` (5m) | штатная нагрузка: очередь RAG-запросов > 8 на 5m (блок б покрывает); безопасного изолированного вызова нет — допустимо fixture-сценарий `alert-rules.fixture.yaml` (promtool) + строчка в доке | снижение очереди / fixture |
| г3 | down 1 сервиса | `NeurocenterServiceUnavailable` (1m) | `docker compose -f compose.production.yml -p neurocenter-production stop skills-service` | `… start skills-service` |
| г4 | external_backup_verified == 0 | `NeurocenterExternalBackupOverdue` (1m) | состояние «нет проверенной внешней копии в пределах RPO» (на стенде без настроенного внешнего S3 возникает естественно); сверить gauge `neurocenter_external_backup_verified` | успешная внешняя копия с проверкой (P0-S3) |

- **Артефакт по каждому:** grep-строки `firing` + `resolved` (с `ts`), `groupKey`, имя сервиса из labels.
- Ожидаемо (grouping): при остановке всех 6 app — **одна** строка `NeurocenterStackDown` + 6 строк
  `NeurocenterServiceUnavailable` (не 6×StackDown).
- **Red:** условие вызвано, но строки `firing` нет в канале (файл+journal) / `resolved` нет после снятия.
  «Алерт виден в alertmanager UI» без строки в канале — **не** доставка (readiness :95).

## 6. Блок д — логи: correlation + redaction (автоматический, драйвер)

```sh
node scripts/test/res-01-e2e.mjs --blocks correlation
```

- Запрос через nginx с `X-Request-ID` → id сквозной: **nginx → api-gateway → сервис**
  (один id в строках всех трёх уровней, JSON-лог-схема AD-O1/O2).
- Ассерт-ы: **нет** ticket-сегмента в access/error-строках (маскируется: `m/:ticket` → REDACTED),
  **нет** `error.message` (только safe-поля).
- **Артефакт:** вывод драйвера + вырезки логов (nginx access, gateway, сервис) с одним correlation id.
- **Red:** id рвётся на любом переходе / ticket-сегмент или error.message в строках.

## 7. Блок е — ошибки: crash → error_events + admin UI (HITL)

1. Контролируемый crash (реальный production-путь): background-agent — env
   `BACKGROUND_AGENT_E2E_CRASH_DISPATCH=1` (пересоздать контейнер с переменной; production
   environment-model её не содержит — drift-тест её пометит, поэтому после проверки вернуть).
   Либо на любом сервисе: unhandled error (uncaughtException) штатным вызовом.
2. **Ожидание:** crash-handler → safe-лог → запись в `error_events` (PG, best-effort ~2s) →
   `process.exit(1)` → restart; событие видимо в **admin UI** (Error-модуль) и `GET /api/errors`
   (main-admin).
3. **Артефакт:** SQL `SELECT service, level, message FROM error_events ORDER BY ts DESC LIMIT 5`,
   скриншот Error-модуля, лог-строка crash-handler, факт restart (`docker ps` / watchdog).
4. **Red:** crash без записи в error_events / событие не видно в UI / сервис не вернулся.

## 8. Блок ж — аудит: admin-мутация → единая история (HITL)

1. Выполнить admin-мутацию (например, MainAdmin: сохранение runtime-limit-configuration — CAS +
   атомарный аудит; или сохранение политики обслуживания).
2. **Ожидание:** мутация в **единой истории аудита** (`GET /api/audit`, main-admin): запись с актором,
   временем, ревизией; transactional — мутация и запись аудита атомарны (нет «мутация есть, аудита нет»).
3. **Артефакт:** ответ `GET /api/audit` (выдержка по мутации), скриншот Audit-модуля.
4. **Red:** мутация без записи аудита / запись несовместима с фактом (ревизия/актор).

## 9. Блок з — health: /ready-семантика (автоматический + HITL)

1. Автоматически: `node scripts/test/res-01-e2e.mjs --blocks health` — `GET /ready` на таргетах:
   200 при up; gateway `/ready` → `{ok:true, checks:{gateway:'ready'}}`;
   `/ready/dependencies` — 5 upstream'ов (catalog/skills/rag/auth/featureFlags).
2. HITL (down-ветка): остановить один upstream (например, skills-service) →
   `GET /ready/dependencies` у api-gateway → **503** + body с `checks` (разложение,
   ServiceUnavailableException); вернуть сервис → снова ok.
3. **/health удалён:** `GET /health` → 404 (liveness = docker restart policy, не HTTP; AD-O4).
4. **Артефакт:** ответы /ready (up и down), 404 на /health, выдержка readiness-бюджетов shared.
5. **Red:** /ready 200 при down-зависимости (без 503+checks) / /health жив.

## 10. GO / NO-GO

- **GO** — 8/8 блоков green (S, а, б, в, г, д, е, ж, з; known-defect ff:4400 — flagged, не red)
  + протокол заполнен артефактами.
- **NO-GO** — любой red: баг-тикет → фикс → **повтор RES-01** (полный). GO только при 8/8 без red.

## 11. Хранение артефактов

Протокол — `_bmad-output/initiative-architecture/tickets/epic-res-obs/RES-01-protocol.md`
(таблица блоков + вложения). Логи/скриншоты/метрики — там же или по ссылке на хранение
(не коммитить секреты; объём — по решению оператора, OQ-5 тикета).
