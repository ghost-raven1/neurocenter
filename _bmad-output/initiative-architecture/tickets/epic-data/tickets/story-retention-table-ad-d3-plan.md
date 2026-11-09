---
title: 'Retention-таблица: единый источник ресурс → retention mode + TTL (AD-D3)'
type: 'feature'
ticket: '7'
created: '2026-11-09'
status: ready-for-dev
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

**Problem:** Retention-режимы разбросаны: ~12+ неограниченных накопителей без retention (AD-D3 Prevents), единичные hardcode-TTL в коде (bridge_pairs 30d — device-store.ts:86, chat activity 30d — chat-activity.sessions.ts:13), «никогда не удаляется» — без зафиксированной причины. AD-D3 Rule: **единая retention-таблица (данные)**: ресурс → режим (TTL / rolling N / ручной / none-с-причиной); **значения TTL фиксируются в таблице одним решением** (не по одной таблице в разном месте).

**Approach:** (1) retention-таблица как данные: `deploy/production/retention.json` (ресурс → {mode, ttl/rollingN, reason, prune-location, owner-service}); (2) инвентарь 100% покрывается (invariant-тест: каждая неограниченная таблица/накопитель из DDL-инвентаря — в таблице); (3) TTL-константы в коде — читаются из таблицы (или генерируются/синхронизируются — OQ-1), существующие hardcode-TTL (bridge_pairs, chat activity) — значения переезжают в таблицу, код читает таблицу; (4) режимы: project-scoped (удаляется каскадом story 11) / TTL / rolling N / ручной / none-с-причиной.

## Boundaries & Constraints

**Always:**
- Каждая растущая сущность — в таблице (AD-D3: «каждая растущая сущность — в единой retention-таблице»).
- «none» (не удаляется) — только с зафиксированной причиной (AD-D3).
- Значения TTL — одно решение в таблице; код не дублирует значения (OQ-1: механизм синхронизации).
- Режимы: `ttl` / `rolling-n` / `manual` / `project-scoped` / `none` (+ reason для none и manual).

**Never:**
- Не менять существующее поведение prune в этой story (prune-реализация — story 8; здесь только таблица + invariant).
- Не вводить TTL там, где режим = project-scoped (chat-таблицы — удаляются каскадом, TTL опционально — OQ-3).
- Не удалять данные «по пути» — таблица описывает, story 8 исполняет.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Инвентарь таблицы vs DDL | invariant-тест | 0 накопителей вне таблицы |
| 2 | Таблица: ресурс с mode=ttl | story 8 (prune) | TTL-значение используется в prune |
| 3 | Ресурс mode=none | таблица | причина зафиксирована (не пустая) |
| 4 | Ресурс mode=project-scoped | таблица | ссылка на каскад (story 11) |
| 5 | Новый накопитель добавлен в код (без таблицы) | invariant-тест (после) | fail: «таблица X не в retention-таблице» |
| 6 | Дублирование TTL-значения в коде | grep/invariant | fail (код должен читать таблицу) — OQ-1 |

## Code Map

**Инвентарь неограниченных накопителей (DDL-факты, main @ 3433b1d1):**

catalog-БД:
- `security_events` — `services/access/access-schema.ts:3`
- `operations` — `services/catalog-service/src/catalog/catalog-schema.ts:50`
- `ai_plugin_versions` — `catalog-schema.ts:40`
- `operation_action_requests` — `services/catalog-service/src/models/model-job-schema.ts`
- `bridge_jobs` — `services/catalog-service/src/devices/device-schema.ts:4`
- `bridge_runtime_artifacts` (+ tar.gz файлы) — `devices/installation-migrations.ts:43`
- `model_usage_calls` — `model-usage/model-usage.schema.ts:3`
- `maintenance_runs` — `maintenance/maintenance-schema.ts:6`
- `retired_rag_previews`, `retired_rag_purges` — `retired-rag/retirement-schema-sql.ts:8,11`
- chat-таблицы (project-scoped): `model_chat_conversations`, `model_chat_turns`, `model_chat_attachments`, `model_chat_objects`, `model_chat_attachment_transfers`, `model_chat_discussions`, `model_chat_discussion_steps`, `model_chat_agent_responses`, `model_chat_research_steps`, `model_chat_compactions` — `model-chat/chat.schema.ts:3,10,23`, `chat-storage.schema.ts:3,13`, `chat-discussion.schema.ts:3,10`, `chat-group.schema.ts:7`, `chat-research.schema.ts:18`, `chat-compaction.schema.ts:4`

RAG-БД:
- `rag_quota_events` — `services/rag-sync-service/src/rag/quota/rag-quota-schema.ts:32-36`

FS:
- skill-versions — `services/skills-service/src/storage/skill-versions.ts` (`.neurocenter-skill-versions`, rolling N=2 — AD-D3(5), server-side prune отсутствует)

**Существующие TTL (переезжают в таблицу):**
- `bridge_pairs` 30d — `services/catalog-service/src/devices/device-store.ts:86`
- chat activity sessions 30d — `services/catalog-service/src/model-chat/chat-activity.sessions.ts:13`

**Механизм prune (story 8 исполняет):**
- `scripts/production/maintenance.mjs:61-148` — tick, :137-142 — существующий prune (локальные backup-копии), :351-402 — runMaintenance (advisory-лок 53709168)
- `services/skills-service/src/storage/skill-versions.ts:100-138` — prune-функция (есть, не подключена)

## Tasks & Acceptance

### Execution
- [ ] `deploy/production/retention.json`: все ресурсы инвентаря с {mode, ttl|rollingN, reason?, prune-location, owner-service}; режимы по AD-D3
- [ ] TTL-значения — единым решением (OQ: значения — рекомендация в OQ-секции)
- [ ] TTL-константы в коде читают таблицу (или синхронизация — OQ-1): bridge_pairs 30d, chat activity 30d → из таблицы
- [ ] invariant-тест `retention-inventory.test.mjs` (scripts/test/): DDL-инвентарь (парсинг CREATE TABLE из schema-файлов) vs retention.json → 0 накопителей вне таблицы; mode=none → reason обязателен
- [ ] check-tooling-tests.json: добавить тест
- [ ] Документ: архитектура (architecture-data.md) — ссылка на retention.json как single source (не дублировать значения в документе)

### Acceptance
- **Given** retention.json + DDL **when** invariant-тест **then** 0 накопителей вне таблицы
- **Given** ресурс с mode=none **when** invariant-тест **then** reason непустой
- **Given** bridge_pairs/chat activity **when** код читает TTL **then** значение из retention.json (не hardcode)
- **Given** новый CREATE TABLE (fixture) без записи в retention.json **when** invariant-тест **then** fail

## Design Notes

- Таблица как данные (JSON) = AD-D3 «единая retention-таблица (данные)». JSON (не TS-константа) — чтобы drift-тест и prune-тук читали один файл без импортов.
- Режимы: `project-scoped` (chat-таблицы, skills-каталоги, RAG-БД — удаляются каскадом story 11), `ttl` (audit/usage-таблицы), `rolling-n` (skill-versions N=2), `manual` (retired-rag purge — automaticPurge:false ратификация), `none` (с причиной: operations/audit — OQ-2).
- Почему separate от story 8: таблица = данные (решение), prune = исполнение. Разделение позволяет зафиксировать решение (TTL-значения) до реализации prune.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/retention-inventory.test.mjs
node scripts/test/check-tooling.test.mjs 2>/dev/null || true
```
Ожидаемо: retention-invariant зелёный (100% инвентаря); negative (fixture CREATE TABLE без записи) fail'ит.

## Open Questions

1. **Механизм «код читает таблицу»**: retention.json импортится в код (TS import JSON) vs генерация TS-константы vs просто «таблица = документ, код дублирует значения + invariant-тест проверяет идентичность»? Рекомендация: invariant-тест (identical-значения) — проще, чем импорт JSON в NestJS, и не ломает build.
2. **operations/audit — TTL или none?** AD-D3: «никогда не удаляется — только с зафиксированной причиной». operations = audit-лог (рекомендация: none с причиной «audit-trail» или TTL 1год — OQ). security_events — аналогично (рекомендация: TTL 1год, security-аудит).
3. **Chat-таблицы: TTL + project-scoped или только project-scoped?** Рекомендация: project-scoped (каскад) + без TTL (история чата = данные проекта, TTL не нужен); model_chat_objects/S3 = project-scoped (story 11).
4. **Значения TTL** (единое решение): security_events 90d? operations none/1y? operation_action_requests 30d? bridge_jobs 30d (совпадает с bridge_pairs)? bridge_runtime_artifacts 30d? model_usage_calls 90d? maintenance_runs 30d? retired_rag_previews/purges 30d? rag_quota_events 90d? — **подтвердить пользователем** (рекомендации: audit/usage 90d, operational 30d, audit-trail none/1y).
5. **model_usage_calls**: TTL или project-scoped? (рекомендация: TTL 90d — аналитика, не project-data).
