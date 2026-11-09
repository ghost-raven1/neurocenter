---
title: 'Quota-модель: per-project used-bytes accounting + schema + API (AD-D4)'
type: 'feature'
ticket: '1'
created: '2026-11-09'
status: ready-for-dev
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

**Problem:** `projects.quota` (6 полей: current/retention/staging × limit/used, dto.ts:31-38) — декларативное поле: `used` всегда 0 (project-quota.ts:4-21), ни один сервис не учитывает фактические байты проекта. AD-D4: «любое quota-поле в API/DB обязано иметь enforcement-точку (файл) и тест; иначе поле удаляется из API». Решение пользователя (2026-11-05): quota = **enforce**. Механизм по AD-D4 — **персистентный per-project used-bytes accounting** + сравнение с лимитом до записи. Эта story строит первую половину механизма — accounting (модель правдива: used = фактические байты); **enforcement-точки (сравнение с лимитом до записи) — epic-res-obs (эпик 6)**, они строятся на этой модели.

**Approach:** (1) schema: quota JSONB на projects замораживается (6 полей, limit=0 ⇒ unlimited — project-validation.ts:23-79); (2) персистентный accounting: новая таблица `project_quota_usage` (project_id, dimension, used_bytes, updated_at) — атомарные дельта-обновления; (3) единая точка записи accounting: internal API catalog `POST /internal/projects/:id/quota-usage` {dimension, deltaBytes, request_key} (idempotency — AD-D5 pattern 4: unique + ON CONFLICT DO NOTHING); (4) API quota (POST /projects, GET /projects/:id, PATCH /projects/:id/quotas — catalog.controller.ts:112-143, 171-197) возвращает quota с фактическим used (merge limit из projects.quota + used из таблицы); (5) подключение writers: RAG-записи (rag-sync), skills-записи (skills-service), artifact-cache (story 2).

## Boundaries & Constraints

**Always:**
- Семантика quota (6 полей, limit=0 ⇒ unlimited) — из project-validation.ts:23-79, не меняется.
- used-обновления — только через internal accounting API (единая точка; обход = фэйл-тест).
- Idempotency: (project_id, dimension, request_key) — unique, повторный вызов не дублирует дельту (AD-D5 pattern 4).
- used_bytes никогда не уходит в отрицательное (CHECK-constraint; дельта-минус больше текущего = 0 + лог).
- Aтрибуция: writer знает свой projectId; без projectId запись не учитывается (не глобальный счётчик).

**Never:**
- Не реализовывать enforcement (отказ/очередь при превышении) — эпик 6.
- Не менять формат quota JSONB и валидацию лимитов.
- Не менять RAG per-project budget (1GiB/16GiB, DB-enforced, rag-quota-schema.ts:107-108) — он отдельный и остаётся.
- Не считать токены модели «байтами» (model_usage_calls — токены; в used не попадают — OQ-2).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Пустой проект | GET quota | все used = 0 (таблица пуста), лимиты как заданы |
| 2 | RAG-запись 50МБ | rag-sync → accounting delta +50МБ (dimension OQ-2) | used отражает 50МБ в следующем GET |
| 3 | Эвикция/удаление (дельта −) | delta −20МБ | used уменьшается; не ниже 0 |
| 4 | limit=0 (unlimited) | любой used | unlimited-поведение (нет ошибок), used считается |
| 5 | used > limit | GET quota | ответ с фактическим used (факт); enforcement не здесь |
| 6 | Повторный accounting-вызов (тот же request_key) | replay | дельта не дублируется (idempotent) |
| 7 | Конкурентные дельты (2 writer'а) | параллельные POST | сумма = алгебра дельт (атомарный UPDATE ... SET used = used + $) |
| 8 | Удаление проекта | FK-cascade (story 11) | строки project_quota_usage каскадом (FK ON DELETE CASCADE) |
| 9 | Неизвестный projectId | accounting POST | 404 (проект не существует) |

## Code Map

- `services/catalog-service/src/catalog/catalog-schema.ts` — DDL projects (quota JSONB), операции-таблицы :50+
- `services/catalog-service/src/catalog/dto.ts:31-38` — `IQuota` (current/retention/staging × limit/used), :148-152 — createProjectDto {name, quota?}
- `services/catalog-service/src/catalog/project-quota.ts:4-21` — пустая quota (все нули)
- `services/catalog-service/src/catalog/project-validation.ts:3-10,23-79` — валидация quota, limit=0 ⇒ unlimited (замораживается)
- `services/catalog-service/src/catalog/catalog.controller.ts:112-143` — POST /projects, :171-197 — PATCH /projects/:id/quotas (quota в ответах)
- `services/catalog-service/src/catalog/catalog-migrations.ts:302-306` — текущий max v52 → новая миграция **v53** (project_quota_usage)
- `services/catalog-service/src/catalog/project-deletion.ts:6-63` — FK-cascade (accounting-строки должны каскадировать)
- `services/catalog-service/src/devices/device-job-requests.ts:23-61` — референс idempotency (UNIQUE + ON CONFLICT DO NOTHING) для accounting API
- `services/rag-sync-service/src/rag/storage-budgets.ts:41-76` — расчёт size RAG-БД (источник дельты для RAG-writer'а)
- `services/skills-service/src/skills/skills.module.ts:15-17` — корень skills (SKILLS_STORAGE_PATH); `src/storage/skill-durability.ts` — durable-записи skills (точка дельты)
- `services/api-gateway/src/features/mcp-host/ticket.ts:24-30` — `IHostedMcpSession.projectId` (атрибуция artifact-cache — story 2)

## Tasks & Acceptance

### Execution
- [ ] Миграция v53: `project_quota_usage (project_id TEXT NOT NULL REFERENCES projects ON DELETE CASCADE, dimension TEXT NOT NULL CHECK (dimension IN ('current','retention','staging')), used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project_id, dimension))` + таблица accounting-идемпотентности `project_quota_usage_requests (project_id, dimension, request_key, delta_bytes, created_at, UNIQUE (project_id, dimension, request_key))`
- [ ] Internal API: `POST /internal/projects/:id/quota-usage` {dimension, deltaBytes (int, ≠ 0), request_key} — transaction: ON CONFLICT (unique) DO NOTHING (idempotency) → UPDATE used = used + delta (GREATEST(0, ...)); ответ {used}
- [ ] Quota API merge: POST/GET/PATCH quota-ответ = limits (projects.quota) + used (project_quota_usage, отсутствующая строка = 0)
- [ ] RAG-writer: rag-sync при изменении size per-project БД → accounting-вызов (дельта = Δ size; источник: storage-budgets.ts:41-76 паттерн)
- [ ] Skills-writer: skills-service при записи/удалении версии → accounting-вызов (дельта = Δ каталог версии)
- [ ] Тесты: fixture-проект + дельты → used в GET; idempotency replay; конкурентные дельты; negative floor; FK-cascade при удалении проекта
- [ ] Fail-тест «обход»: запись RAG/skills данных без accounting-вызова обнаруживается (test: size изменился, used нет → fail)

### Acceptance
- **Given** проект с RAG-записью 50МБ **when** GET /projects/:id **then** quota.used по измерению = 50МБ (± погрешность Δ)
- **Given** повторный accounting-вызов с тем же request_key **when** GET quota **then** used без дубля
- **Given** пустой проект **when** GET quota **then** used = 0, лимиты сохранены
- **Given** удаление проекта **when** select * from project_quota_usage **then** 0 строк (FK-cascade)

## Design Notes

- **Персистентный** accounting (а не расчёт на чтение) — по AD-D4: механизм enforcement = «персистентный per-project used-bytes accounting + сравнение с лимитом до записи». Расчёт на чтение не даёт атомарности «до записи» (эпик 6) и правдивости при частичных сбоях.
- Единая точка записи (internal API) = требование AD-D4 «единый путь project-записей — через accounting (обход = фэйл-тест)». Writers (rag-sync, skills, artifact-cache) вызывают API, а не пишут в таблицу напрямую.
- Дельты (а не абсолютные значения): writer знает изменение, а не полный объём (дешевле, нет races на «полный пересчёт»).
- Измерения (current/retention/staging): какая запись в какое измерение — OQ-2 (рекомендация: файлы проекта (artifact-cache, skills) = current; RAG-данные = retention; in-flight uploads = staging; уточняется в эпике 6 при enforcement).
- Миграция v53: первая миграция эпика (каталог-номенклатура max = 52, catalog-migrations.ts:302-306).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- quota
cd services/rag-sync-service && npm test -- storage-budgets
cd services/skills-service && npm test
```
Ожидаемо: quota-тесты (accounting, idempotency, cascade) зелёные; миграция v53 в ledger (reliable-migrations паттерн: scripts/test/reliable-migrations.mjs); used ≠ 0 на fixture после записей.

## Open Questions

1. **Таблица vs JSONB**: used в отдельной таблице `project_quota_usage` (рекомендация — атомарные дельты, меньше contention на projects-строку) vs обновление used-полей quota JSONB (проще API, но JSONB-race на конкурентных дельтах)?
2. **Семантика измерений**: что = current/retention/staging (рекомендация выше); входят ли модельные токены (рекомендация: нет — не байты).
3. **Гранулярность Δ RAG**: пересчёт size() при каждой записи (дорого) vs периодический reconciliation (tick, как в story 8) + дельты при явных операциях? Рекомендация: дельты при операциях + reconciliation в tick.
4. **skills layout**: как байты версии атрибутируются к проекту (SKILLS_STORAGE_PATH структура) — dev-уточнение.
5. **Дельта при эвикции artifact-cache**: эвикция (story 2) — дельта минус через тот же API? Рекомендация: да (единая точка).
