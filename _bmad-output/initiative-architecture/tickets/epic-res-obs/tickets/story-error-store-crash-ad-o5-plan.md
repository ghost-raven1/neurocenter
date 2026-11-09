---
title: 'Error visibility: crash-политика + PG error-store + API (AD-O5)'
type: 'feature'
ticket: '10'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-observability/architecture-observability.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
  - services/shared/observability.cjs
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-O5: ошибки — видны. В main: (1) crash-политики нет — uncaughtException/unhandledRejection handlers отсутствуют во всех 6 main.ts (процесс умирает без structured-лога и записи; диагностика = только docker-лог-строка «exit 1»); (2) error-store нет — error_events нигде (security_events/operations — аудит, не ошибки); долговременная видимость «почему упал сервис за неделю» — отсутствует (json-file retention 30 МБ — не инструмент); (3) AD-O1/O2 (entry 6) даёт лог-схему + requestId — crash-событие должно в неё вписаться; AD-O8 (entry 7) — только safe-поля.

**Approach:** (1) crash-политика в 6 main.ts: shared `crash-handler.cjs` — uncaughtException/unhandledRejection → structured-лог (level=error, safe-поля AD-O8, requestId из контекста/«crash») → запись в error-store (best-effort, flush-before-exit) → process.exit(1) (контейнер перезапускается docker-политикой restart: unless-stopped; «захватить и жить дальше» запрещено — AD-O5). Порядок: лог → error-store → exit. (2) error_events в catalog DB: (id, service, ts, level, request_id, message-safe, stack-hint-усечённый) — миграция (следующая свободная версия ledger; max сейчас 52 — catalog-migrations.ts:303; epic-data entry 1 занимает v53 — нумерация резолвится на impl) + DDL в schema-contract (invariant-тест, паттерн эпика 1 entry 11: security_events в part-04/part-06) + retention 90d (строка в retention-таблице epic-data entry 7 + prune в maintenance tick, mechanism epic-data entry 8). Write-path: catalog — прямой (pool); rag-sync/oauth2-bridge/skills — outbox/HTTP-канал в catalog (паттерн skills-service: skill-audit-outbox.ts — file outbox + 2s timer; deliver = internal HTTP). (3) API: GET /api/errors (admin, фильтры service/requestId/period) + error-метрики (count/critical — in-process счётчики, рендер через observability — паттерн auth-failures entry 8) для алерта entry 13. (4) Задокументированный residual: PG-down = error-store недоступен (видимость = json-file-логи + статус контейнера); revisit: local spool (не в этой story).

## Boundaries & Constraints

**Always:**
- Crash → exit(1) (контейнер перезапускается); «catch и continue» запрещено.
- Order: structured-лог → error-store (best-effort) → exit. Log всегда; error-store — best-effort (PG-down не блокирует exit).
- Только safe-поля (AD-O8): message = фикс/классификатор, stack-hint = усечённый (без значений переменных); requestId из контекста.
- Retention 90d: строка retention-таблицы + prune в tick (эпик 4/7/8 — механизм, здесь — строка и интеграция).
- Internal-канал — под internal_token (main.ts:38-48 паттерн: x-neurocenter-internal).

**Never:**
- Не сохранять полный стек с значениями (stack-hint = кадры + сообщения, trunc 4KB — OQ-1).
- Не писать в error_events из feature-кода напрямую (только crash-handler + явные report-точки; API-записи — entry 11 frontend).
- Не вводить PG-доступ в rag-sync/bridge/skills ради error-store (outbox-канал — ратификация).
- Не логировать error.message в crash-лог (AD-O8 — entry 7 drift покрывает).
- Не менять security_events/operations (аудит ≠ ошибки; единая история entry 14).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | uncaughtException | throw вне try/catch | structured-лог + строка error_events + exit(1) + docker-restart |
| 2 | unhandledRejection | rejected promise без catch | то же (уровень error) |
| 3 | PG down при crash | error-store недоступен | лог записан, exit(1) — без зависания (best-effort, timeout) |
| 4 | Сервис без PG (skills) | crash | запись через outbox → catalog (после восстановления catalog — доставлено) |
| 5 | Catalog down (outbox-сервис) | crash при down catalog | outbox-файл остаётся, доставляется после up (паттерн skill-audit-outbox) |
| 6 | GET /api/errors?service=rag&period=24h | admin | события rag за 24h (safe-поля) |
| 7 | GET /api/errors?requestId=X | admin | все события с requestId X (cross-service correlation) |
| 8 | Retention | строка > 90d | прунится в tick (epic-data 7/8) |
| 9 | error-метрики | /metrics (catalog) | neurocenter_error_events_total{level} отражает свежие |
| 10 | Всплеск ошибок | 100 crash'ей/мин | error_events не затопляет (нет rate-limit на запись — crash = редкий; OQ-3) |

## Code Map

- `services/catalog-service/src/main.ts:18-53` — bootstrap (врезка crash-handler: до app.listen; паттерн всех 6 main.ts)
- `services/{api-gateway,feature-flags-service,oauth2-bridge,rag-sync-service,skills-service}/src/main.ts` — врезка crash-handler (6 точек)
- `services/shared/crash-handler.cjs` (new, +.d.cts, PREPARED_SOURCE_INPUTS) — installCrashHandler
- `services/catalog-service/src/database/catalog-migrations.ts:303` — max v52 → error_events = следующая свободная (epic-data entry 1 = v53; impl-резолв)
- `services/catalog-service/src/database/schema-contract/part-04.ts:150-164` + `part-06.ts:945-958` — security_events (паттерн DDL-записи для error_events)
- `services/catalog-service/src/access/security-events.ts:12-24` — securityEvent-хелпер (паттерн write-функции)
- `services/skills-service/src/storage/skill-audit-outbox.ts:16-217` — outbox-паттерн (file outbox, 2s timer, deliver, epoch)
- `services/catalog-service/src/catalog/catalog.controller.ts:612` — @Get('audit') (паттерн admin-эндпоинта для /api/errors)
- `scripts/production/maintenance.mjs` — runMaintenance :351-402, prune :137-142 (retention-prune — mechanism epic-data entry 8; здесь строка)
- `services/shared/observability.cjs:49-151` — render-врезка error-счётчиков (паттерн auth-failures entry 8)
- `deploy/production/environment-model.json` — (error_events не env — модель не трогается)

## Tasks & Acceptance

### Execution
- [ ] shared/crash-handler.cjs (+.d.cts): installCrashHandler({service, log, reportError}) — uncaughtException/unhandledRejection → log.error(safe) → reportError (best-effort, timeout 2s) → process.exit(1); PREPARED_SOURCE_INPUTS
- [ ] 6 main.ts: installCrashHandler (до listen); catalog reportError = прямой pool insert; остальные = outbox-репорт (ниже)
- [ ] Миграция: error_events (id UUID PK, service TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now(), level TEXT NOT NULL CHECK(level IN ('error','critical')), request_id TEXT, message TEXT NOT NULL, stack_hint TEXT); версия = следующая свободная (impl-резолв с epic-data v53)
- [ ] DDL error_events в schema-contract (part, паттерн security_events part-04:150-164) + invariant-тест (колонки/индексы; паттерн эпика 1 entry 11)
- [ ] Internal API: POST /internal/error-events {service, level, requestId, message, stackHint} (internal_token; idempotency не нужна — crash-события unique-UUID)
- [ ] Outbox-репорт для rag-sync/bridge/skills: file outbox (паттерн skill-audit-outbox: 2s timer, deliver = POST /internal/error-events, retry, epoch) — crash-handler репортит в outbox (не в PG)
- [ ] Retention: строка error_events 90d в retention-таблице (epic-data entry 7) + prune в maintenance tick (entry 8 mechanism) — интеграция + тест (fixture >90d прунится)
- [ ] API: GET /api/errors (admin; фильтры service/requestId/period; safe-поля; пагинация — паттерн listAuditHistory :44-51)
- [ ] Error-метрики: in-process счётчик (crash-handler + report-точки) → observability render (neurocenter_error_events_total{level}, паттерн auth-failures)
- [ ] Тесты: симуляция uncaughtException (child-process fixture) → лог + error_events + exit(1); PG-down (fixture) → exit без зависания; skills crash → outbox → (catalog up) → доставлено; API-фильтры; retention-prune; compat: старый снапшот/ДБ без error_events — миграция идемпотентна (reliable-migrations)

### Acceptance
- **Given** симуляция uncaughtException **when** crash-handler **then** structured-лог (safe) + строка error_events + процесс завершён (exit 1)
- **Given** PG down **when** crash **then** лог записан, exit(1) без зависания (best-effort timeout)
- **Given** crash в skills (нет PG) **when** catalog up **then** строка в error_events через outbox (доставлено)
- **Given** GET /api/errors?service=X&period=Y **when** fixture-события **then** фильтры работают (service/requestId/period)
- **Given** error_events: DDL **when** invariant-тест **then** зелёный (колонки/индексы); миграция в ledger

## Design Notes

- **Почему exit(1), а не «захватить и жить»:** AD-O5 прямо: контролируемый exit, контейнер перезапускается docker-политикой. «Жить дальше» после uncaughtException = неизвестное состояние (частичные транзакции, коррумпированные счётчики) — безопаснее перезапуск (идемпотентные init'ы, outbox'ы переживают restart).
- **Best-effort error-store:** PG-down + crash = двойная авария; error-store не может быть обязательным (иначе crash-handler сам падает). Видимость при PG-down = json-file-лог (entry 6) + статус контейнера (docker) — задокументированный residual.
- **Outbox для non-PG-сервисов:** ратификация паттерна skills-service (file outbox переживает restart, 2s timer, deliver-подтверждение). Crash-репорт в outbox = асинхронный (файл-запись синхронная, быстрая) — до exit.
- **stack-hint, а не stack:** полный стек с frame-значениями = AD-O8-риск (переменные в stack). Stack-hint = кадры (файл:строка) + error-имена, trunc 4KB — достаточно для локализации, без значений.
- **Миграционная нумерация:** max = 52 (catalog-migrations.ts:303); epic-data entry 1 = v53 (accounting); error_events = следующая свободная (v54 если нет других) — резолв на impl (ledger-совместимость, reliable-migrations).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/error-events.test.mjs        # crash-симуляция, outbox, API, retention
node --test scripts/test/schema-contract.test.mjs      # DDL error_events (invariant)
# Crash-симуляция (dev-стек):
docker compose exec catalog-service node -e "setTimeout(()=>{throw new Error('test')},100)"
docker compose logs catalog-service | tail   # structured-лог (safe)
docker compose exec postgres psql -U nc_owner -d catalog -c "select service,level from error_events order by ts desc limit 3"
```
Ожидаемо: crash → лог + error_events + exit; PG-down → без зависания; skills → outbox-доставка; API-фильтры; retention-prune; корневой сьют — без деградации.

## Open Questions (с рекомендациями)

1. **stack-hint trunc**: 4KB (рекомендация) vs 8KB vs только top-10 кадров? Рекомендация: 4KB + top-20 кадров (файл:строка) — баланс диагностичности и AD-O8.
2. **level: 'error' vs 'critical'**: crash = всегда critical? Рекомендация: crash (uncaughtException/rejection) = critical; явные report-точки (entry 11 frontend) = error. Алерт entry 13 — на critical.
3. **Rate-limit на запись error_events?** (всплеск crash-loop = 100+/мин). Рекомендация: нет на запись (crash = редкий; crash-loop = сам сигнал), но retention + retention-прун ограничивает объём; alert на crash-loop = entry 13 (rate(critical)).
4. **report-точки кроме crash?** (явные «known-error» в feature-коде). Рекомендация: только crash + frontend (entry 11); feature-report = расширение (не в P0-RES) — иначе error_events превращается в log-таблицу.
5. **Local spool при PG-down** (revisit): crash при PG-down теряет ошибку (только json-file). Рекомендация: не в P0 (residual задокументирован); local spool = расширение (файл + flush при PG-up) — отдельная story при необходимости.
