# Recon: observability (logging, metrics, health, alerting, audit) — 2026-11-05

Источник: recon-агент (brownfield), полный ввод в architecture-observability spine.

## 1. Факты

### Таблица сервис → логгер → формат → куда → metrics → health

| Сервис | Логгер | Формат | Куда (prod) | Metrics | Health |
|---|---|---|---|---|---|
| api-gateway | NestJS default Logger + `console.log/error` | plain text `[Nest] HH:MM:SS LOG` | stdout → docker json-file (10m×3) | /metrics (shared) | /ready (always ok) + /ready/dependencies (5 upstream'ов) |
| catalog-service | Nest Logger + console | plain text | stdout → json-file | /metrics + backup-метрики | /ready (postgres) |
| oauth2-bridge | console.log/error — **только `error.name`** | plain text | stdout → json-file | /metrics (shared) | /ready (catalog via httpReady) |
| rag-sync-service | Nest Logger (только `error.code`) + console | plain text | stdout → json-file | /metrics + work-queue | /ready (postgres) |
| skills-service | Nest Logger + console | plain text | stdout → json-file | /metrics | /ready (storage write + durability + audit outbox) |
| feature-flags-service | Nest Logger + console | plain text | stdout → json-file | /metrics | /ready (postgres) |
| frontend (nginx) | nginx access_log | **JSON**: time, requestId($request_id), method, path, status, duration | /dev/stdout → json-file | отсутствует | healthcheck: wget https://127.0.0.1:8443/ready |
| capacity-collector | console (JSON snapshot) | JSON | stdout → json-file | сам публикует /capacity/snapshot.json | /--check |

### Logging
- pino/winston/consola — **отсутствуют** (0 в package.json).
- Централизованный logger-модуль в shared — **отсутствует**. Каждый сервис — Nest Logger (plain text, HH:MM:SS без даты) или сырой console.*.
- Production: docker json-file, `max-size: 10m, max-file: 3` — 30 МБ на контейнер, дальше потеряно. Централизованной агрегации — **отсутствует**.
- Correlation/request-id: nginx шлёт `X-Request-ID: $request_id`, **ни один сервис его не читает**. Сквозной correlation id — отсутствует.

### Redaction (что реально маскируется сейчас)
- PG-пул пишет только `error.code` (URL/пароль не попадают).
- oauth2-bridge code exchange — только `error.name`.
- nginx access log: `$uri` без query, cookies/Authorization не в log_format.
- **Не маскируется**: `m/:ticket` — `/api/mcp-host/m/<ticket>` уходит в `$uri` (стык с AD-5).
- **Не маскируется**: `error.message` (axios) в api-gateway (proxy.service.ts:414, auth-guard.service.ts:112) — внутренний host:port (стык с AD-9/AD-19).
- CLI-скрипты пишут `error.message` (hostname БД; риск низкий, профиль setup).

### Metrics
- prom-client — **отсутствует**. Ручной Prometheus text renderer: `services/shared/observability.cjs` — `neurocenter_http_requests_total{service,method,group,status}`, `neurocenter_http_request_duration_seconds` (histogram 10ms..30s), `neurocenter_http_in_flight`, process uptime/RSS/heap/CPU.
- Метрики на всех 6 сервисах, middleware `app.use(createObservability(...))`.
- Доступ: Bearer `NEUROCENTER_METRICS_TOKEN`, timingSafeEqual, fail-closed; наружу /metrics не выходит (nginx 404); Prometheus-сборщик внутри backend-сети.
- Метки фиксированные группы (api/auth/other/ready/health) — произвольные URL/почты/коды не попадают.
- Capacity-метрики (shared/capacity.cjs): `neurocenter_capacity_snapshot_available/age_seconds/free_bytes/total_bytes/wal_bytes{resource}`, `neurocenter_capacity_rejections_total{resource,reason}`, `neurocenter_work_queue_pending/active{queue}` — только при `CAPACITY_REQUIRED=true` (compose: catalog, skills, rag-sync).
- Backup-метрики (только catalog): `neurocenter_backup_status_available/external_backup_verified/external_backup_age_seconds/backup_rpo_exceeded/backup_next_run_timestamp_seconds/backup_last_run_failed`.
- capacity-collector: statfs 6 томов каждые 15 с → `/capacity/snapshot.json` (стык с AD-18).

### Health/readiness
- Все 6 сервисов: `/health` (liveness, всегда 200) + `/ready` (readiness, 503 + `{ok,checks}`).
- `/ready`: catalog/feature-flags/rag-sync — postgres; skills — реальная запись temp-файла + durability + пустой audit outbox; oauth2-bridge — catalog через httpReady; gateway — всегда ok (liveness-семантика).
- Бюджеты: `checkReadiness` — 2500 мс на чек, `httpReady` — 2000 мс + лимит тела 16 КБ.
- `gateway /ready/dependencies` — 5 upstream'ов, 503 с состоянием.
- Compose healthchecks — все на `/ready`; `/health` **не используется никем**.

### Alerting
- **Определено, но не развёрнуто.** `deploy/production/monitoring/`: prometheus.yml (scrape job neurocenter, 15 с) + neurocenter-alerts.yml (9 алертов: ServiceUnavailable, ApiErrors >1% 5xx, ApiLatency p95 >500мс, CapacityUnavailable, DiskSpaceLow, RagQueueGrowing, ExternalBackupOverdue, BackupRunFailed, BackupStatusUnavailable).
- Prometheus-сервиса в **любом** compose — нет; alertmanager.yml — **отсутствует**; каналов уведомлений — нет. Алерты никогда не сработают.
- В scrape targets **нет feature-flags-service:4400** — 1 из 6 сервисов не собирается.

### Error tracking
- Sentry/что-либо подобное — **отсутствует**.
- Production-ошибки видны только через docker logs: NestJS default BaseExceptionFilter (кастомных ExceptionFilter — 0); unhandled = 500 «Internal server error» + stack в stdout.
- unhandledRejection/uncaughtException-обработчиков — **нет**; падение bootstrap'а = crash-обновление контейнера.

### Tracing
- Distributed tracing — **отсутствует**.
- dev-trace.cjs — dev-only: два флоу (tool-build, saved-chat), только при `NEUROCENTER_DEV_TRACES=1` + launch-id UUID4, фиксированные события, без payload.

### Frontend
- `window.onerror` / `unhandledrejection` / ErrorBoundary — **отсутствуют**.
- Axios: 401 → unauthorizedHandler; ошибки показываются текстом сервера или fallback.
- Админу при падении видно: Maintenance-модуль (capacity/backup-статус), Audit-модуль, McpBridge (устройства). Инцидент-дашборда, лога ошибок, metrics-UI — **нет**.

### Audit
- `security_events` (catalog PG; feature-flags-service подключается к той же БД и пишет в ту же таблицу): actor/action/resource_id/before_state/after_state.
- ~60 действий: runtime.limits.update, admin.bootstrap, model.*, snapshot.*, agent.*, plugin.*, maintenance.policy.update, feature_flag.update, asset.legacy.retire, rag.purge.* и др.
- skills-service: файловый outbox → доставка в каталог; в журнал — только безопасные сводки generation/version/sha256.
- `operations`-таблица: device-jobs (install/uninstall/apply) со state/error/log.
- Чтение: единая history operations+security_events с пагинацией (audit-history.ts), UI — frontend/src/modules/Audit.
- **Отсутствует**: device unbind — `revoke()` без securityEvent; login/session-события (oauth2-bridge не пишет ни одного security event); api-gateway без аудита.

### Что видно при инциденте (gateway 503)
1. `docker logs` 7 контейнеров (json-file, 30 МБ каждый, без агрегации);
2. nginx access log — requestId/status/duration;
3. `/ready/dependencies` — единственный dependency-диагностика (**вызовов на неё нет нигде в репо**);
4. `/metrics` с токеном (если бы Prometheus работал);
5. `docker ps` — unhealthy статусы;
6. Admin UI: Maintenance + Audit.
Request-цепочка nginx → gateway → сервис не склеивается (no correlation id).

## 2. Дыры

1. `[SEV: high]` **Тикет mcp-host в access log** — `/api/mcp-host/m/<ticket>` в nginx `$uri` при каждом запросе. Стык с AD-5.
2. `[SEV: high]` **Алертинг не развёрнут** — prometheus.yml + 9 алертов существуют, но нет Prometheus-сервиса, alertmanager, каналов. Сервис может гореть часами.
3. `[SEV: high]` **Ошибка production видна только через docker logs** — нет error tracking, нет агрегации, json-file 30 МБ/контейнер. Инцидент 2 дня назад: логи ротированы.
4. `[SEV: med]` **feature-flags-service не в scrape targets** (prometheus.yml:14-20).
5. `[SEV: med]` **Нет correlation id** — nginx шлёт X-Request-ID, сервисы не читают.
6. `[SEV: med]` **Device unbind без аудита** (device-store.ts:267).
7. `[SEV: med]` **Login/session без аудита** (oauth2-bridge не пишет security events).
8. `[SEV: med]` **error.message passthrough в лог** (proxy.service.ts:414, auth-guard.service.ts:112). Стык с AD-9/AD-19.
9. `[SEV: med]` **Frontend: падение UI невидимо серверу** (нет ErrorBoundary/window.onerror/unhandledrejection).
10. `[SEV: med]` **Нет distributed tracing** — цепочка не реконструируема.
11. `[SEV: low]` **/health мёртвый** (никто не коллится).
12. `[SEV: low]` **/ready/dependencies без потребителей**.
13. `[SEV: low]` **Нет crash-политики** (unhandledRejection/uncaughtException обработчиков нет).
14. `[SEV: low]` **Формат логов не для машин** (plain text Nest, без даты/таймзоны; JSON только у nginx).
15. `[SEV: low]` **Capacity-алерты не покрывают gateway/bridge/flags** (CAPACITY_REQUIRED=true только у 3 сервисов; осознанно, но не задокументировано).

## 3. Кандидаты AD для architecture-observability spine

- **AD-O1 — Unified log schema**: shared-модуль логирования (JSON lines: ts/level/service/requestId/msg/err), запрет raw console.*/сырого Nest Logger; retention-решение. Стык с AD-9 (маски) и AD-19.
- **AD-O2 — Correlation id**: request-id обязателен в логах и прокидывается nginx → gateway → сервисы (включая internal-вызовы); единый источник (nginx `$request_id` или генерация gateway'ем).
- **AD-O3 — Минимальный набор метрик**: канонический список на сервис (http/process/capacity/queue + auth-failure) + completeness-тест; **все 6 сервисов в scrape targets**; новый сервис без метрик = фэйл. Стык с AD-18.
- **AD-O4 — Health-модель**: семантика — compose healthcheck = /ready, liveness = /health (или убрать /health); бюджеты 2500/2000 мс — константы; /ready/dependencies — потребитель или удалить; задокументировать, для каких сервисов capacity-метрики не рендерятся.
- **AD-O5 — Error visibility**: crash-политика (unhandledRejection/uncaughtException + лог причины), решение по error tracking (PG-error-store или Sentry-совместимый экспорт), frontend-репортинг (ErrorBoundary + unhandledrejection).
- **AD-O6 — Alerting deployment**: Prometheus как сервис compose (backend-сеть, metrics_token — уже схема) + alertmanager с ≥1 каналом; 9 алертов — базис; completeness: каждый сервис в targets.
- **AD-O7 — Audit-модель**: обязательный список событий (device revoke, login/session + существующие ~60), единый store security_events, правило «админ-мутация без securityEvent = фэйл-тест».
- **AD-O8 — Log redaction policy**: запрет `error.message` passthrough в логи (allowlist полей: code/name/cause-code). Стык с AD-9 и AD-19.

Уже покрыто runtime-trust (ссылки): AD-5 (маскирование m/:ticket), AD-9 (секреты в логах — маски), AD-19 (error-body; «детали — в server-логи»), AD-18 (machine metrics в capacity snapshot).
