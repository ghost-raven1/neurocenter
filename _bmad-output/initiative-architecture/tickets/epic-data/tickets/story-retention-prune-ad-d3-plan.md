---
title: 'Retention prune: периодический проход в maintenance tick (AD-D3)'
type: 'feature'
ticket: '8'
created: '2026-11-09'
status: done
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'high'
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

**Problem:** Prune по retention-таблице (story 7) нигде не исполняется: существующий prune в maintenance tick (maintenance.mjs:137-142) чистит только локальные backup-копии; skill-versions prune-функция есть (skill-versions.ts:100-138) но не подключена; остальные unbounded-таблицы растут линейно с трафиком. AD-D3 Rule: «Prune — в maintenance-tick (существующий механизм, ратификация)».

**Approach:** В `runMaintenance` (maintenance.mjs:351-402, уже под advisory-локом 53709168) добавить prune-шаги по retention-таблице (story 7): (1) TTL-таблицы catalog-БД: `DELETE WHERE created_at < now() - interval '<ttl>'` (batched, лимит на проход); (2) bridge_runtime_artifacts — строки + tar.gz-файлы (FS cleanup); (3) rag_quota_events (RAG-БД); (4) skill-versions rolling N=2 (подключение существующей prune-функции, story 7 режим `rolling-n`). Idempotent: уже под advisory-локом runMaintenance; повторный тик = 0 удалений.

## Boundaries & Constraints

**Always:**
- Prune только по retention-таблице (story 7): ресурс, режим, TTL — из таблицы, не hardcode.
- Batched DELETE (LIMIT на проход, например 1000) — не блокировать БД на долгих транзакциях.
- Запись в maintenance_runs (существующая) — сколько удалено (наблюдаемость).
- Порядок: DB-строки сначала, затем связанные FS-файлы (bridge_runtime_artifacts tar.gz) — осиротевший файл без строки = GC-кандидат (OQ-2).

**Never:**
- Не прунить project-scoped данные здесь (chat-таблицы, RAG-БД, skills-каталоги — каскад story 11).
- Не прунить `none`-ресурсы (story 7: reason-фиксация).
- Не менять существующий prune (локальные backup-копии :137-142) и runnerLedger.prune (:206-289) — additive.
- Не прунить без проверки retention-таблицы (если ресурс не в таблице — не прунить, лог).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Застарелые строки (старше TTL) | тик | удалены (batched), maintenance_runs записан |
| 2 | Свежие строки (моложе TTL) | тик | нетронуты |
| 3 | Повторный тик (idempotency) | тик после удаляющего | 0 удалений |
| 4 | Конкурентный тик | 2 процесса | advisory-лок: один прунит, второй skip |
| 5 | bridge_runtime_artifacts: строка + tar.gz | тик | строка удалена + tar.gz удалён |
| 6 | Осиротевший tar.gz (строки нет) | тик | OQ-2: GC или оставить |
| 7 | skill-versions: 5 версий | тик | остались 2 последние (rolling N=2) |
| 8 | Ресурс не в retention-таблице | тик | не прунится + лог (invariant story 7 должен поймать) |
| 9 | РAG-БД недоступна | тик | прун catalog-таблиц прошёл; RAG — ошибка в maintenance_runs (не crash всего тика) |

## Code Map

- `scripts/production/maintenance.mjs:61-148` — tick, :137-142 — существующий prune (backup-копии), :206-289 — runnerLedger.prune (паттерн batched prune), :292-348 — store (advisory-лок 53709168), :351-402 — runMaintenance
- `scripts/production/maintenance-database.mjs` — DB-доступ (подключения к catalog/RAG-БД)
- `deploy/production/retention.json` — retention-таблица (story 7, источник режимов/TTL)
- `services/skills-service/src/storage/skill-versions.ts:100-138` — prune-функция (rolling N, подключить)
- `services/catalog-service/src/devices/installation-migrations.ts:43` — bridge_runtime_artifacts DDL (+ tar.gz FS-путь)
- `services/rag-sync-service/src/rag/quota/rag-quota-schema.ts:32-36` — rag_quota_events DDL
- `scripts/test/maintenance-database.mjs`, `scripts/test/production-maintenance.fixture.mjs`, `scripts/test/maintenance-runner.test.mjs` — тестовая инфраструктура

## Tasks & Acceptance

### Execution
- [ ] `retention-prune.mjs` (scripts/production/): по retention.json — prune-функции per ресурс (TTL-DELETE batched, rolling-n, FS cleanup); подключение в runMaintenance (после существующего prune :137-142)
- [ ] bridge_runtime_artifacts: DELETE строки + rm tar.gz (FS-путь из DDL/кода)
- [ ] rag_quota_events: prune в RAG-БД (maintenance-database.mjs подключение)
- [ ] skill-versions: подключение skill-versions.ts:100-138 (rolling N=2 из retention.json)
- [ ] maintenance_runs: счётчики удалений per ресурс
- [ ] Ошибки per ресурс изолированы (один ресурс не падает весь тик)
- [ ] Тесты: fixture застарелые/свежие строки → тик → удалены/нет; idempotent повтор; skill-versions N=2; concurrency (advisory-лок)

### Acceptance
- **Given** строки старше TTL **when** maintenance тик **then** удалены (batched), maintenance_runs записан, свежие нетронуты
- **Given** skill-versions 5 версий **when** тик **then** 2 последние
- **Given** повторный тик **when** run **then** 0 удалений (idempotent)
- **Given** конкурентный тик **when** 2 процесса **then** один прунит, второй skip (advisory-лок)
- **Given** RAG-БД down **when** тик **then** catalog-прун прошёл, RAG — ошибка в maintenance_runs, тик не crashed

## Design Notes

- Maintenance tick = ратифицированный механизм (AD-D3): не изобретать отдельный cron/сервис — добавлять в существующий runMaintenance.
- Batched DELETE (LIMIT 1000 + повтор в следующем тике) — паттерн runnerLedger.prune (:206-289): не длинные транзакции.
- Skill-versions rolling N=2: AD-D3(5) «rolling N (N=2) — новое retention-правило (server-side prune сейчас отсутствует вообще; значение выбрано по аналогии с cleanup-политикой bridge-клиента — не ратификация)». Функция prune есть (skill-versions.ts:100-138) — подключаем, N=2 из retention.json.
- FS-cleanup (tar.gz): только по строкам (не glob-подход) — безопаснее; осиротевшие файлы — OQ-2.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/maintenance-runner.test.mjs
# fixture:
node scripts/test/production-maintenance.fixture.mjs 2>/dev/null || true
```
Ожидаемо: maintenance-тесты зелёные (prune per ресурс, idempotency, concurrency); fixture-строки старше TTL удалены.

## Open Questions

1. **TTL-значения**: из retention.json (story 7 OQ-4) — должны быть подтверждены до этой story (иначе prune не знает, что прунить).
2. **Осиротевшие tar.gz** (bridge_runtime_artifacts: файл без строки): GC по glob (`/data/.../*.tar.gz` без строки в БД старше X) или оставить (ручной)? Рекомендация: GC в этом же prune (с dry-run логом), возраст > TTL.
3. **skill-versions N=2**: ратифицировать N=2 (AD-D3 выбрало по аналогии, «не ратификация») — подтвердить пользователем (story 7 OQ).
4. **Ресурсы без created_at**: не все таблицы имеют created_at (проверить per ресурс) — prune-ключ (created_at vs updated_at vs специфичный) — dev-уточнение per ресурс.
