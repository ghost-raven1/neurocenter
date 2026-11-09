---
title: 'S3 snapshot GC: reclaim DELETING (AD-D3)'
type: 'feature'
ticket: '9'
created: '2026-11-09'
status: done
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/tickets/epic-data/epic-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** S3 snapshot-blobs в состоянии `DELETING` накапливаются вечно, если verifier не здоров. Существующий 2-фазный GC с refcount (`SnapshotGarbageCollector.collect`, snapshot-gc.ts:9-150) — ратифицирован как основной путь (AD-D3), но вызывается **только** по failure-paths verifier'а (`POST /internal/snapshots/gc` → snapshot-verifier.controller.ts:29, verifier.authenticate). Если verifier down/завис, gc не вызывается → DELETING-снимки и их S3-объекты растут. `delete_after` уже ставится при удалении (snapshot-commands.ts:110: `delete_after=now()+N hours`), age-фильтр `delete_after<=now()` уже в gc (snapshot-gc.ts:23,35).

**Approach:** AD-D3 Rule: «in-process GC-fallback для S3 snapshot-blobs: `DELETING` старше фиксированного возраста **без живого verifier'а** — reclaim (idempotent)». (1) In-process периодический вызов `gc.collect()` внутри catalog-service (не внешний cron, не verifier): новый таймер в `SnapshotService` (уже OnModuleInit/OnModuleDestroy, snapshot.service.ts:29-52) — interval (1x/ч, OQ-1); (2) условие: **нет живого verifier'а** (переиспользовать liveness-запрос snapshot.service.ts:82-87: `last_seen>now()-interval '60 seconds'`) И есть DELETING-кандидаты (`delete_after<=now()`); (3) idempotent: внутри gc уже advisory-лок `neurocenter:snapshot-storage` (snapshot-gc.ts:17) + 2-фазный refcount — двойной gc с verifier'ом невозможен.

## Boundaries & Constraints

**Always:**
- Основной путь (verifier-триггер gc) не меняется — fallback **дополняет**, не заменяет.
- Fallback срабатывает только когда verifier не жив (liveness > 60s) — не конкурировать со здоровым verifier'ом.
- Age-фильтр = `delete_after<=now()` (уже есть в gc, snapshot-gc.ts:23,35) — не вводить новый возраст.
- Idempotency через существующий advisory-лок gc (snapshot-gc.ts:17) — не добавлять свой лок.
- Таймер: OnModuleInit старт / OnModuleDestroy стоп (паттерн snapshot.service.ts:46-52, аналог asset-sources.service.ts:142).

**Never:**
- Не менять 2-фазный gc-алгоритм (refcount, DELETING→DELETED, blob_writes) — ратификация.
- Не reclaim'ить snapshot, который head (gc уже фильтрует `head_snapshot_id IS DISTINCT FROM`, :23) или с profile (NOT EXISTS :24) — не обходить.
- Не вызывать gc если verifier жив (fallback = fallback, не параллельный исполнитель).
- Не трогать S3-credentials/конфиг storage.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | DELETING snapshot + delete_after в прошлом + verifier down | fallback tick | S3-объект + строка удалены (gc.collect) |
| 2 | DELETING snapshot, delete_after в будущем | fallback tick | не тронут (age-фильтр) |
| 3 | Verifier жив | fallback tick | gc не вызывается (liveness ok) — основной путь |
| 4 | Verifier down, нет DELETING-кандидатов | fallback tick | no-op (быстро, без gc) |
| 5 | Fallback + verifier одновременно (race) | оба вызывают gc | advisory-лок: один прошёл, второй no-op (idempotent) |
| 6 | Head snapshot в DELETING | fallback tick | не reclaim (gc-фильтр :23) |
| 7 | Snapshot с profile | fallback tick | не reclaim (gc-фильтр :24) |
| 8 | Crash fallback-процесса | restart | таймер перезапускается (OnModuleInit), нет partial-состояния (gc transactional) |

## Code Map

- `services/catalog-service/src/snapshots/snapshot-gc.ts:7-150` — `SnapshotGarbageCollector.collect` (advisory-лок :17, age-фильтр :23/35, 2-фазный refcount, DELETING→DELETED :136)
- `services/catalog-service/src/snapshots/snapshot-verifier.controller.ts:29-31` — `POST /gc` (текущий триггер, verifier.authenticate)
- `services/catalog-service/src/snapshots/snapshot.service.ts:29-52` — SnapshotService (OnModuleInit/Destroy, pool), :82-87 — verifier liveness-запрос (переиспользовать)
- `services/catalog-service/src/snapshots/snapshot-commands.ts:110` — `delete_after=now()+N hours` (age-источник)
- `services/catalog-service/src/snapshots/snapshot-storage.ts:418` — recoverWrite (вызывается gc :10)
- `services/catalog-service/src/snapshots/snapshot-schema.ts:13` — project_snapshots (status, delete_after)
- `scripts/test/snapshot-recovery.test.mjs`, `snapshot-recovery-live.test.mjs` — тестовая инфраструктура (S3 fixture)

## Tasks & Acceptance

### Execution
- [ ] `SnapshotService`: поле `gcFallbackTimer?`; onModuleInit — `setInterval(gcFallbackTick, 1h)` (OQ-1); onModuleDestroy — `clearInterval`
- [ ] `gcFallbackTick()`: (a) liveness-запрос (переиспользовать :82-87) — если verifier жив → return; (b) есть ли DELETING с `delete_after<=now()` (быстрый count) — если нет → return; (c) `new SnapshotGarbageCollector(this).collect()`
- [ ] Single-flight: флаг `gcRunning` (не запускать второй tick пока первый идёт)
- [ ] Лог/наблюдаемость: security event или maintenance-лог «fallback gc reclaim N»
- [ ] Тесты: fixture DELETING snapshot + verifier down → fallback reclaim; verifier жив → нет fallback; race (advisory-лок idempotency); head/profile не reclaim

### Acceptance
- **Given** DELETING snapshot + delete_after в прошлом + verifier down **when** fallback tick **then** S3-объект и строка удалены
- **Given** verifier жив **when** fallback tick **then** gc не вызывается (основной путь)
- **Given** fallback + verifier одновременно **when** оба gc **then** один прошёл, второй no-op (idempotent, advisory-лок)
- **Given** head snapshot / snapshot с profile **when** fallback tick **then** не reclaim

## Design Notes

- Почему in-process (не cron/verifier): AD-D3 явно «in-process GC-fallback». In-process = тот же процесс catalog, тот же pool, тот же advisory-лок — минимальная поверхность, нет внешнего cron, нет новых credentials.
- Liveness-условие: fallback — страховка на случай «verifier down». Если verifier жив, он сам триггерит gc (основной путь). Не дублировать работу живого verifier'а.
- `delete_after` = «фиксированный возраст» из AD-D3 (ставится при удалении, snapshot-commands.ts:110). Не вводить отдельный fallback-возраст — единый age-источник.
- Interval 1x/ч — OQ-1 (частота fallback; не критична, т.к. age-фильтр delete_after уже даёт нижнюю границу).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- snapshot
# S3-fixture:
node --test scripts/test/snapshot-recovery.test.mjs 2>/dev/null || true
```
Ожидаемо: snapshot-тесты зелёные; fallback reclaim на fixture (DELETING + verifier down); liveness-тест (verifier жив → нет fallback).

## Open Questions

1. **Interval fallback**: 1x/ч (рекомендация) — подтвердить. Не критично (delete_after даёт нижнюю границу возраста).
2. **Liveness-порог**: переиспользовать 60s (snapshot.service.ts:87) — да (единый порог).
3. **Наблюдаемость**: security event vs maintenance-лог vs metrics — какой канал (рекомендация: лог + maintenance_runs, если есть hook).
4. **Совместимость с AD-OP**: fallback gc — data-контура; если operational spine (AD-OP) вводит отдельный gc-cron — не дублировать (стык проверить).
