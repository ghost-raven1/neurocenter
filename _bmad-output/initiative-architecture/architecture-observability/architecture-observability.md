---
name: 'Neurocenter: observability — логи, метрики, health, алертинг, audit'
type: architecture-spine
purpose: build-substrate
altitude: initiative
paradigm: 'observability как подсистема стека, а не побочный эффект: каждый сервис пишет structured-логи (JSON lines) со сквозным correlation id, отдаёт канонический набор метрик и отчитывается о health по одной семантике; ошибки фиксируются в PG error-store и видны в admin UI; каждая admin-мутация audit-ируется; алерты реально срабатывают (prometheus+alertmanager внутри стека). Диагностика инцидента = алерт → логи с correlation id → audit, без ручной склейки docker-логов'
scope: 'Observability-контур: unified logging, correlation id, метрики, health/readiness, error visibility (crash-политика + PG error-store + frontend), alerting, audit, log redaction'
status: final
created: '2026-11-05'
updated: '2026-11-05'
binds: []
sources: ['recon-observability.md']
---

# Architecture Spine — Neurocenter: observability — логи, метрики, health, алертинг, audit

## Design Paradigm

**Observability как подсистема стека.** Каждый сервис обязан (а не «по совести»): писать structured-логи с correlation id, отдавать канонические метрики, иметь health по единой семантике. Production-ошибка — **записанное событие** (PG error-store с retention и admin-просмотром), а не строка в ротированном docker-логе. Admin-мутация — **записанное событие** (security_events). Алерты — **часть стека** (prometheus+alertmanager как compose-сервисы), а не конфигурация в надежде.

Решения пользователя (2026-11-05): (1) алертинг — **развернуть** prometheus+alertmanager как compose-сервисы с ≥1 каналом; (2) error tracking — **локальный error-store в PG** + retention + admin UI (внешний Sentry — Deferred).

```mermaid
flowchart LR
  NGX[nginx: JSON access log + X-Request-ID] --> GW[api-gateway]
  GW --> S[сервисы: catalog / ff / skills / rag-sync / bridge]
  S --> LOG[stdout: JSON lines ts/level/service/requestId/msg/err]
  S --> MET[/metrics, Bearer metrics_token]
  S --> ERR[PG error-store: error_events, retention 90d]
  S --> AUD[security_events: ~60+ событий]
  MET --> PROM[prometheus compose-service]
  PROM --> AM[alertmanager + канал]
  ERR --> UI[admin UI: Error-модуль]
  AUD --> UI2[admin UI: Audit-модуль]
```

## Invariants & Rules

### AD-O1 — Unified log schema (shared-модуль логирования)

- **Binds:** новый shared-модуль логирования, `main.ts` каждого сервиса, compose-logging
- **Prevents:** plain-text Nest-логи без даты и таймзоны (HH:MM:SS — после ротации время записи угадывается); логи, нечитаемые машиной; raw `console.*`, обходящие маскирование
- **Rule:** единый shared-модуль логирования: **JSON lines в stdout** со схемой `ts` (RFC3339 UTC), `level`, `service`, `requestId` (AD-O2), `msg`, `err` (структурированная: name/code/cause.code — AD-O8). Запрещены raw `console.log/error` и прямой Nest Logger вне модуля в src сервисов — **drift-тест** (поиск `console.(log|error)` в src сервисов = фэйл; CLI/setup-скрипты — за скобками, профиль не production-рантайм). Retention коротких логов остаётся за compose json-file (policy: поднять `max-file` для gateway/catalog — сейчас 10m×3 ≈ 30 МБ, инцидент старше ~2 дней теряется); **долговременная видимость ошибок — не через retention логов, а через PG error-store** (AD-O5). Маскирование секретов — свойство shared-модуля (стык с AD-9 runtime-trust), а не ответственность каждого сервиса.

### AD-O2 — Correlation id

- **Binds:** nginx-конфиг (frontend), middleware gateway, все внутренние HTTP-вызовы
- **Prevents:** цепочка nginx → gateway → сервис не склеивается — диагностика = ручная переборка 7 docker-логов
- **Rule:** `requestId` **обязателен** в каждом сервис-логе и во всех внутренних вызовах (прокидывается заголовком `X-Request-ID`). Единый источник: nginx `$request_id` (уже шлёт — ратификация); для запросов, не пришедших через nginx (internal-вызовы, maintenance-тики, job-leases) gateway/инициатор **генерирует UUID4**, если заголовок отсутствует. Нестандартные фоновые работы (backup-тик, queue) имеют `jobId` в той же схеме поля `requestId`. Тест: лог-строка сервиса без `requestId` = фэйл.

### AD-O3 — Канонический набор метрик + completeness

- **Binds:** `services/shared/observability.cjs` (механизм ратифицируется), `deploy/production/monitoring/prometheus.yml`
- **Prevents:** новый сервис без метрик; сервис в стеке, который не собирается (factual gap: `feature-flags-service:4400` отсутствует в scrape targets — один из 6 сервисов невидим); тихое отсутствие метрик
- **Rule:** механизм ручного Prometheus text-renderer (`observability.cjs`, Bearer `metrics_token`, timingSafeEqual, fail-closed) — **ратификация** (prom-client не вводится). Канонический набор на каждый сервис: http (requests_total с фиксированными groups + duration-histogram + in-flight — ратификация текущей), process (uptime/RSS/heap/CPU — ратификация), capacity (только при `CAPACITY_REQUIRED=true`: catalog, skills, rag-sync — ратификация), work-queue (где есть очередь), **auth-failure counter — новый** (leading-индикатор для self-hosted: рост отказов auth до 5xx). **Completeness-тест:** каждый **app-сервис с /metrics** (явный список: api-gateway, catalog, feature-flags, skills, rag-sync, oauth2-bridge) присутствует в scrape targets prometheus.yml и отдаёт канонический набор (fix: добавить ff:4400); новый сервис без строк в targets и без метрик = фэйл. Знаменатель НЕ включает: capacity-collector (отдаёт snapshot.json, не /metrics), frontend/nginx, postgres, prometheus/alertmanager (добавляются AD-O6). Метки — только фиксированные groups; URL/почты/коды проектов в метки не попадают (ратификация). Stык с AD-18 runtime-trust (machine metrics в capacity snapshot).

### AD-O4 — Health-модель

- **Binds:** `services/shared/readiness.cjs`, health-роуты сервисов, compose healthchecks
- **Prevents:** `/health` мёртвый (никто не коллится — семантика не определена); бюджеты как magic-числа в коде; `/ready/dependencies` без потребителей
- **Rule:** одна семантика: **healthcheck compose и внешний мониторинг = `/ready`** (503 + checks — ратификация); **`/health` удалить** (liveness = «контейнер жив» — docker restart policy, отдельный endpoint не несёт информации); бюджеты `checkReadiness` 2500 мс / `httpReady` 2000 мс + limit тела 16 КБ — **фиксированные константы в shared** (один источник, invariant-тест — не расходятся по сервисам). `/ready/dependencies` (gateway, 5 upstream'ов) — **потребители: stack-watchdog (AD-OP-8) и admin UI**; если не подключены — удалить (сейчас вызовов на неё нигде нет). Задокументировать: capacity-метрики не рендерятся у gateway/bridge/ff (`CAPACITY_REQUIRED=false` — осознанно).

### AD-O5 — Error visibility (crash-политика + PG error-store + frontend)

- **Binds:** `main.ts` каждого сервиса (process handlers), новая таблица в catalog DB, frontend (ErrorBoundary), admin UI
- **Prevents:** production-ошибка видна только в docker logs (30 МБ/контейнер, ротация ~2 дня — инцидент невидим); падение bootstrap = молчаливое перезапуск-цикл; ошибка UI невидима серверу
- **Rule:** (1) **crash-политика**: `uncaughtException`/`unhandledRejection` → structured-лог (AD-O1, level=error, safe-поля) + запись в error-store + **контролируемый exit** (контейнер перезапускается по политике docker; «захватить и жить дальше» запрещено — состояние после uncaughtException не доверяется). (2) **error-store**: таблица `error_events` в catalog DB (service, ts, level, requestId, message-safe, stack-hint усечённый) + **retention 90 дней** (prune в maintenance-tick — AD-D3 data spine) + **admin UI** (модуль рядом с Audit; фильтр service/requestId/period). **Write-path**: catalog — прямой; сервисы без прямого write-доступа (rag-sync, oauth2-bridge, skills) — через существующий outbox/HTTP-канал в catalog (паттерн skills-service — ратификация). Порядок при крахе: structured-лог → error-store (best-effort, flush-before-exit) → exit. **Задокументированный residual: PG-down (самая частая причина краха) = error-store недоступен** — видимость в этом случае ограничена json-file-логами + статусом контейнера; revisit: local spool. Схема совместима с будущим внешним экспортом (Sentry-совместимый экспорт — Deferred). (3) **frontend**: ErrorBoundary + `window.onerror`/`unhandledrejection` → POST в gateway (rate-limited, только safe-поля: компонент/сообщение-фикс/stack-hint; URL-параметры, cookies, payload — не отправляются) → error-store. `message-safe` — фиксированное сообщение, без passthrough (AD-O8; стык с AD-19 runtime-trust — тот же принцип для client-facing body).

### AD-O6 — Alerting deployment (prometheus + alertmanager в стеке)

- **Binds:** compose.production.yml (новые сервисы), `deploy/production/monitoring/`, systemd (AD-OP-8)
- **Prevents:** алерты определены, но не могут сработать (нет сервиса, alertmanager, каналов — сервис может гореть часами); ff-service невидим в метриках
- **Rule:** prometheus + alertmanager — **compose-сервисы в backend-сети** (scrape через `metrics_token` — механизм уже в prometheus.yml); alertmanager — **≥1 канал** (email/webhook — выбор оператора, в config-каталоге). 9 алертов `neurocenter-alerts.yml` — **ратификация как базис** + новые: cert-expiry (AD-OP-7), stack-down (AD-OP-8), error-store-рост/присутствие critical (AD-O5). **Completeness:** все 6 сервисов в scrape targets (fix: ff:4400) + completeness-тест (AD-O3). Образы prometheus/alertmanager — **digest-pinned, часть release manifest** (AD-OP-2 operational spine). **Топология: prometheus+alertmanager = compose-сервисы (этот AD — owner механизма)**; на хосте (systemd) только node_exporter + stack-watchdog (AD-OP-8) — без дублирования ownership.

### AD-O7 — Audit-модель (обязательные события)

- **Binds:** `security_events` (catalog DB), audit-history.ts, frontend Audit-модуль, oauth2-bridge, device-store, api-gateway
- **Prevents:** device unbind без аудита (device-store.ts:267 — `revoke()` не пишет securityEvent); login/session не аудит-ятся (oauth2-bridge не пишет ни одного security event); админ-мутация без следа
- **Rule:** store = `security_events` (единая таблица; DDL-owner = catalog — AD-D1 data spine; писатели — сервисы с доступом, сервисы без прямого доступа доставляют через существующий outbox-канал, паттерн skills-service → catalog ратифицируется). Обязательный набор: существующие ~60 событий (ратификация) + **новые обязательные**: device.pair / device.bind / **device.revoke**, **login/session (успех + отказ)**, **auth-решения gateway** (ticket verify успех/отказ). **Фэйл-тест: любая admin-мутация без записи securityEvent = фэйл** (тест обходит mутационные роуты и проверяет запись в store). Чтение — единая история operations + security_events с пагинацией (ратификация), UI — Audit-модуль (ратификация).

### AD-O8 — Log redaction policy

- **Binds:** shared-модуль логирования (AD-O1), proxy.service.ts, auth-guard.service.ts, nginx log_format
- **Prevents:** `error.message` passthrough в логи (proxy.service.ts:414, auth-guard.service.ts:112 — axios-ошибки несут внутренний host:port/URL); билеты в access-лог
- **Rule:** в логи попадают только **allowlist-поля** ошибки: `name`, `code`, `cause.code` (структурированно); **passthrough `error.message` в логи запрещён** (может нести URL/секреты; диагностика — через `requestId` → error-store/полный стек в safe-представлении). Клиенту — только фиксированные сообщения (AD-19 runtime-trust — не дублируется, тот же принцип для server-логов). **Нginx: маскирование `m/:ticket` в access-лог**: инвариант (декларация) — AD-5 runtime-trust; **owner механизма (nginx `map`/rewrite для log_format) = этот AD** — одна точка правки nginx-конфига, без дублирования ownership (AD-5 ссылается, не дублирует); сегодня `m/:ticket` пишется в каждый запрос — fix.

## Known Defects (вне AD — фиксируются для реализации)

- **ff:4400 отсутствует в scrape targets** (prometheus.yml) — fix, покрывается completeness-тестом AD-O3/AD-O6.
- **`m/:ticket` в nginx `$uri`** — fix (механизм AD-O8, инвариант AD-5 runtime-trust).
- **`/ready/dependencies` не вызывается нигде** — подключить к watchdog (AD-O4 → AD-OP-8) или удалить.
- **error.message в gateway-логах** — fix (AD-O8).

## Consistency Conventions

| Concern | Convention |
| --- | --- |
| Логи | JSON lines в stdout через shared-модуль; raw console.* в src = фэйл |
| Correlation | requestId в каждом логе и внутреннем вызове; источник — nginx, fallback — генерация |
| Метрики | канонический набор + completeness: сервис в стеке = сервис в targets |
| Health | /ready = единственный health-эндпоинт; бюджеты — константы shared |
| Ошибки | ошибка = записанное событие (error-store 90d + UI); crash = controlled exit |
| Audit | admin-мутация без securityEvent = фэйл-тест |
| Redaction | allowlist name/code/cause.code; error.message в логи = фэйл |

## Stack

| Name | Version |
| --- | --- |
| Node.js | 24 (node:24.22.0, digest-pinned) |
| shared/observability.cjs (metrics renderer) | текущий ручной renderer — ратификация |
| shared/readiness.cjs | текущий (бюджеты 2500/2000 мс — константы) |
| PostgreSQL (error_events, security_events) | pgvector/pgvector:pg16 (digest-pinned — production) |
| Prometheus / Alertmanager | digest-pinned (выбор образа — в release manifest, AD-OP-2) |
| nginx (access log JSON) | 1.30.6-alpine (digest-pinned) |

## Structural Seed

```text
services/shared/
  logging.cjs          # НОВЫЙ: JSON lines, safe-error-поля (AD-O1, AD-O8)
  observability.cjs    # метрики (ратификация) + auth-failure counter (AD-O3)
  readiness.cjs        # бюджеты-константы (AD-O4)
  error-store.cjs      # НОВЫЙ: запись/чтение error_events (AD-O5)
catalog DB
  error_events         # НОВАЯ таблица (AD-O5), retention 90d (AD-D3)
  security_events      # существующая (AD-O7), DDL-owner = catalog (AD-D1)
deploy/production/monitoring/
  prometheus.yml          # существующий, + ff:4400 (AD-O3)
  neurocenter-alerts.yml  # существующие 9 + новые (AD-O6)
  alertmanager.yml        # НОВЫЙ (AD-O6)
compose.production.yml
  # новые сервисы: prometheus, alertmanager (backend-сеть, AD-O6)
frontend/
  ErrorBoundary + window.onerror/unhandledrejection → gateway (AD-O5)
```

## Capability → Architecture Map

| Capability / Area | Lives in | Governed by |
| --- | --- | --- |
| O1 structured-логи | shared/logging.cjs + сервисы | AD-O1 |
| O2 correlation id | nginx + gateway + сервисы | AD-O2 |
| O3 метрики | shared/observability + prometheus.yml | AD-O3 |
| O4 health | readiness.cjs + роуты + compose | AD-O4 |
| O5 error visibility | error-store + crash-политика + frontend | AD-O5 |
| O6 алертинг | prometheus+alertmanager в стеке | AD-O6 |
| O7 audit | security_events + admin UI | AD-O7 |
| O8 redaction | logging-модуль + nginx | AD-O8 |

## Deferred

- **Distributed tracing** (open-telemetry-совместимый) — revisit: когда correlation id (AD-O2) перестанет покрывать диагностику цепочек (nginx→gateway→сервис сегодня покрывается).
- **Внешний Sentry-совместимый экспорт из error-store** — revisit: при выходе за self-hosted контур (схема error_events совместима — AD-O5).
- **Централизованная log-агрегация** (Loki/ELK) — revisit: когда json-file + error-store перестанут быть достаточны (single-host — достаточно).
- **Metrics-дашборд (Grafana)** — revisit: после стабилизации базового алертинга (AD-O6).
