---
title: 'Quota enforcement: enforcement-точки projects.quota (AD-D4)'
type: 'feature'
ticket: '3'
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
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/tickets/epic-data/tickets/story-quota-model-ad-d4-plan.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-D4: «любое quota-поле в API/DB обязано иметь enforcement-точку (файл) и тест; иначе поле удаляется из API». В main `IQuota` (dto.ts:31-38, 6 полей current/retention/staging × limit/used) декларативна: used всегда 0 (project-quota.ts:1-25), ни один сервис не сравнивает запись с лимитом. Квотная МОДЕЛЬ (persistent per-project used-bytes accounting + schema + API) строит **epic-data entry 1** (план в main: story-quota-model-ad-d4-plan.md: accounting-таблица project_quota_usage, internal API POST /internal/projects/:id/quota-usage, writers подключаются). Эта story строит ВТОРУЮ половину механизма — **enforcement-точки: сравнение с лимитом ДО записи**. Явная граница: «квотная модель — epic-data entry 1, здесь — enforcement».

**Approach:** (1) shared enforcement-помощник (quota-guard): читает limit (projects.quota) + used (accounting API / project_quota_usage) → принимает/отклоняет (used + оценка ≤ limit); отказ = явная ошибка (паттерн CapacityError capacity.cjs:12-23: 507 + понятное сообщение, без внутренних деталей); (2) enforcement-точки: RAG-пакетная запись (rag-sync, до записи: used(retention)+оценка ≤ retentionBytesLimit; оценка — max(16 MiB, 6×байты JSON) — ратифицированная оценка capacity-admission.md:9), сохранение/создание skill (skills-service, до durable-записи: used(current)+оценка ≤ currentBytesLimit); (3) staging-измерение (in-flight uploads/импорты) — список точек = OQ-1; (4) artifact-cache: enforcement = LRU-эвикция (epic-data entry 2 — НЕ здесь), здесь только boundary-тест (эвикция уважает per-project лимит — если epic-data entry 2 не реализована к impl — баг-тикет туда); (5) метрика quota-rejection (counter по измерению) + safe-лог (requestId); (6) инвариант-тест: 6 quota-полей → каждое либо enforcement-точка+тест, либо явно «не enforce'ится» (allowlist с причиной → тогда поле удалить из API).

## Boundaries & Constraints

**Always:**
- used — только из accounting (epic-data entry 1): local-расчёт байтов в enforcement-точке ЗАПРЕЩЁН (один источник правды).
- Сравнение ДО записи (не после): отклонённая запись не оставляет артефактов и не меняет used.
- limit=0 ⇒ unlimited: enforcement не применяется (семантика project-validation.ts:23-79 — ратификация).
- Оценка объёма — консервативная (паттерн capacity-admission.md:9) — недооценка = дефект.
- Отказ: код+сообщение фиксированные (без путей/URL), метрика + safe-лог с requestId (AD-O1, entry 6).

**Never:**
- Не реализовывать accounting/таблицу/API (epic-data entry 1) — только потреблять.
- Не менять формат quota JSONB / валидацию лимитов (project-validation.ts).
- Не дублировать RAG per-project budget 1GiB/16GiB (rag-quota-schema.ts:107-108 — DB-enforced, остаётся; quota — дополнительный уровень, OQ-2: взаимодействие).
- Не эвиктировать в этой story (эвикция — epic-data entry 2); отказ = отказ.
- Не считать токены байтами (epic-data entry 1 OQ-2: модельные токены не в used).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | RAG-запись в пределах лимита | used+оценка ≤ retentionBytesLimit | запись проходит, used обновлён (accounting) |
| 2 | RAG-запись сверх лимита | used+оценка > retentionBytesLimit | 507 (или 409) явная причина «превышен лимит базы знаний проекта», данные не повреждены, used не изменился, quota-rejection-метрика +1 |
| 3 | limit=0 (unlimited) | любой used | запись проходит (enforcement off) |
| 4 | Skill-save сверх currentBytesLimit | used(current)+оценка > limit | отказ с явной причиной, журнал skill-записи не создаётся |
| 5 | accounting API недоступен | 5xx от catalog | fail-closed: запись отклонена (503 «лимиты не подтверждены» — паттерн runtime-limits.service.ts:31-34), НЕ «пропустить проверку» |
| 6 | Пустой проект | used=0, limit задан | первая запись в пределах лимита проходит |
| 7 | Одновременные записи (2 writer'а) | race на used | pessimistic: чтение used под lock/accounting-атомарность (epic-data entry 1) — двойное превышение не допускается (тест: сумма записей ≤ limit + одна оценка) |
| 8 | artifact-cache: запись сверх лимита | used+новый файл > currentBytesLimit | эвикция LRU (epic-data entry 2) — boundary-тест только |

## Code Map

- `services/catalog-service/src/catalog/dto.ts:31-38` — IQuota (6 полей)
- `services/catalog-service/src/catalog/project-quota.ts:1-25` — normalizeProjectQuota (все нули — декларативность)
- `services/catalog-service/src/catalog/project-validation.ts:23-79` — валидация quota, limit=0 ⇒ unlimited (ратификация)
- `services/catalog-service/src/catalog/catalog.controller.ts:112-143,171-197` — quota в API-ответах (POST /projects, PATCH quotas)
- `services/rag-sync-service/src/rag/` — пакетная запись (reserveCapacity-вызовы: project-databases.ts, rag-db.ts, rag-generations.ts); оценка — max(16MiB, 6×JSON) (docs/capacity-admission.md:9)
- `services/skills-service/src/storage/fs-skills-storage.ts` — durable-записи skills (точка enforcement: до записи); skill-durability.ts — commit-путь
- `services/shared/capacity.cjs:12-28` — паттерн CapacityError (507/503, safe-сообщение, rejection-счётчик) — образец для quota-ошибок
- `services/api-gateway/src/features/mcp-host/artifact-cache.ts:14-15` — artifact-cache (tmpdir сегодня; LRU+квота — epic-data entry 2; boundary-тест)
- `_bmad-output/initiative-architecture/tickets/epic-data/tickets/story-quota-model-ad-d4-plan.md` — контракт accounting API (POST /internal/projects/:id/quota-usage, GET quota с used)
- `services/shared/runtime-limits.cjs` — паттерн shared-модулей лимитов (ленивые, без env при импорте)

## Tasks & Acceptance

### Execution
- [ ] shared/quota-guard.cjs (+.d.cts): `checkQuota({projectId, dimension, estimateBytes, client})` → {allowed} | QuotaError (507/503 safe-сообщение); used — через accounting (HTTP internal API catalog; fail-closed при недоступности); регистрация в PREPARED_SOURCE_INPUTS (cap — entry 5 эпика 1, задокументировать повышение)
- [ ] rag-sync: enforcement до пакетной записи (retentionBytesLimit; оценка max(16MiB, 6×JSON)); отказ → 507 + метрика + safe-лог; accounting-дельта — после успеха (epic-data entry 1 writers)
- [ ] skills-service: enforcement до durable-записи (currentBytesLimit; оценка = размер каталога версии); отказ → ошибка без артефактов (журнал не committed)
- [ ] staging-точки (OQ-1): список операций → enforcement stagingBytesLimit (рекомендация: вложения чата/импорты моделей — точки определить на impl по epic-data OQ-2 «семантика измерений»)
- [ ] Метрика: neurocenter_quota_rejections_total{dimension} (observability.cjs — рендер, паттерн capacity-rejections :189-194)
- [ ] Инвариант-тест: 6 полей IQuota → таблица «поле → enforcement-точка (файл) + тест» (модуль); поле без точки И без allowlist-причины = фэйл; allowlist-поле = удалить из API (AD-D4)
- [ ] Boundary-тест artifact-cache: эвикция уважает per-project лимит (зависимость: epic-data entry 2 — если нет в main на момент impl — skip с пометкой «ждёт epic-data entry 2»)

### Acceptance
- **Given** проект с retentionBytesLimit и used близким к лимиту **when** RAG-запись с оценкой, выводящей used сверх лимита **then** отказ 507 с явной причиной; прежние данные целы; used не изменился; метрика +1
- **Given** limit=0 **when** запись любого размера **then** проходит (unlimited)
- **Given** skill-save сверх currentBytesLimit **when** сохранение **then** отказ, артефактов нет (каталог версии не создан/не committed)
- **Given** accounting API down **when** запись **then** 503 fail-closed (запись не прошла без проверки)
- **Given** инвариант-тест **when** quota-поле без enforcement-точки **then** фэйл с указанием поля

## Design Notes

- **Порядок операций**: enforcement (проверка) → запись → accounting-дельта. Отказанная запись не учитывается; успешная — всегда учитывается (иначе used дрейфует вниз). Reconciliation (periodic) — epic-data entry 1 OQ-3 (tick) — страховка от дрейфа.
- **Fail-closed при недоступности accounting**: паттерн runtime-limits.service.ts:31-34 («Действующие лимиты не подтверждены») — осознанное снижение доступности в обмен на гарантию лимита (P0-RES: лимит, который не работает = дефект, R11).
- **Оценка vs точный размер**: оценка консервативна (6× JSON под индексы/WAL); точный размер приходит в accounting после записи (дельта) — enforcement работает на оценке, правдивость used — на дельтах.
- **Race**: два конкурентных writer'а могут одновременно увидеть used под лимитом; гарантия «сумма ≤ limit + max(оценка1, оценка2)» требует either pessimistic-lock на project_quota_usage при записи (epic-data entry 1 — атомарный UPDATE) либо admission-займа (паттерн capacity.cjs reservations). OQ-3.
- **staging**: in-flight uploads — записи, которые ещё не закоммичены в current/retention; enforcement staging предотвращает «N параллельных импортов × 10GiB = переполнение до коммита».

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/rag-sync-service && npm test -- quota
cd services/skills-service && npm test -- quota
cd services/catalog-service && npm test -- quota-invariant
# Live (dev-стек): проект с retentionBytesLimit=1MiB, RAG-запись 2MiB → 507
```
Ожидаемо: quota-тесты зелёные (отказ/unlimited/fail-closed/race); инвариант-тест: 6 полей покрыты; live-отказ с явной причиной.

## Open Questions

1. **Список staging-точек**: какие операции = staging (вложения чата? модельные импорты? runtime-artifact-стрим?). Рекомендация: точки = операции с длительным in-flight объёмом (вложения, GGUF-импорт, runtime-artifact); финальный список — на impl по фактическим writers (стык с epic-data entry 1 OQ-2 «семантика измерений»).
2. **Взаимошение с RAG per-project budget** (1GiB/16GiB, rag-quota-schema.ts:107-108, DB-enforced): quota retentionBytesLimit vs RAG budget — два уровня: budget = технический предел БД, quota = админ-лимит проекта. Рекомендация: действует min(quota, budget); quota-ошибка — приоритет (админ-семантика), budget-ошибка — как есть.
3. **Race-гарантия**: (a) pessimistic-lock на project_quota_usage строку при enforcement+записи (проще, блокировка на время записи), (b) admission-займ (capacity-паттерн, без блокировки записи). Рекомендация: (a) — RAG-запись уже держит блокировки БД; (b) — Deferred при росте конкурентности.
4. **Код отказа**: 507 (Insufficient Storage — паттерн CAPACITY_LOW) vs 409 (конфликт с политикой). Рекомендация: 507 для «места/квоты не хватает» (единая семантика с capacity-admission), 409 — если quota изменена между чтением и записью (CAS).
