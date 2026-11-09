---
title: 'Удаление проекта: полный каскад + receipt (AD-D3)'
type: 'feature'
ticket: '11'
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

**Problem:** Удаление проекта = только FK-cascade в catalog-БД (`deleteProjectWithAudit`, project-deletion.ts:6-63: `DELETE FROM projects` :32 + revoke grants :37-42 + `project_retirements` :43-47 + operations-строка :48-54). **НЕ удаляются** (AD-D3 Prevents): per-project RAG-БД `nc_rag_<sha>` (project-database-name.ts:5), skills-каталоги проекта (SKILLS_STORAGE_PATH), S3-объекты (chat-оригиналы `projects/<chatObjectDigest(projectId)>/`, snapshot-blobs), локальные dumps. Результат: «удалённый» проект продолжает занимать данные (утечка). AD-D3 Rule: «project deletion = полный каскад с receipt: локальная папка + S3-объекты (snapshots, chat-оригиналы) + per-location dump + per-project RAG-DB — через референс-паттерн `retired-rag.service.ts` (preview→purge→receipt, freeze+DROP): **ручной purge остаётся ручным** (`automaticPurge:false` — ратификация); **автоматическое retirement — только как триггер подтверждённого удаления проекта** (отдельный путь, не флаг); freeze-протокол при активных сессиях: freeze останавливает записи, активные сессии истекают по TTL (задокументировать)».

**Approach:** Расширить удаление проекта на 4 внешних data-домена (помимо FK-cascade): (1) **RAG-БД** — автоматическое retirement (отдельный путь, не флаг) по подтверждённому удалению → DROP (референс: retired-rag.service.ts freeze+DROP, request_key idempotency); (2) **S3-объекты** — chat-оригиналы (`projects/<chatObjectDigest(projectId)>/`, через существующий deletion-outbox) + snapshot-blobs проекта; (3) **skills-каталоги** проекта (SKILLS_STORAGE_PATH); (4) **локальные dumps/backup-копии** проекта (OQ-2: whole-stack — leave+document). **Receipt** = расширение `project_retirements` (JSONB `deleted_resources` — что реально удалено + статус). Idempotency: request_key (AD-D5 pattern 4). Freeze-протокол: задокументировать.

## Boundaries & Constraints

**Always:**
- FK-cascade (существующий, project-deletion.ts:32) остаётся базой — внешние домены **дополняют**, не заменяют.
- Idempotency: каждый внешний шаг — request_key (повторное удаление/повторный вызов = no-op, AD-D5 pattern 4).
- Receipt: `project_retirements.deleted_resources` (JSONB) — что удалено, что оставлено (с причиной), статус per домен.
- Ручной purge retired-rag **остаётся ручным** (`automaticPurge:false` — ратификация) — не менять; автоматическое retirement = **отдельный путь** (триггер подтверждённого удаления), не флаг.
- Order: RAG-БД (freeze+DROP) → S3 → skills → dumps; каждый шаг idempotent и не блокирует FK-cascade.

**Never:**
- Не удалять whole-stack backup'ы проекта автоматически (OQ-2: recommend leave+document в receipt) — backup = операторская зона.
- Не менять `automaticPurge:false` (ручной purge) — ратификация.
- Не удалять model_usage_calls автоматически (OQ-3: recommend leave для аналитики; retention story 7/8 решит TTL).
- Не делать внешний шаг «fire-and-forget»: каждый шаг подтверждён (S3 read-back / DROP подтверждение / rm подтверждение) до записи в receipt.
- Не обходить freeze-протокол: активные RAG-сессии — freeze (остановка записей) + TTL-истечение, не hard-kill.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Полное удаление проекта | DELETE /projects/:id | FK-cascade + RAG-БД DROP + S3-объекты + skills + receipt (все домены) |
| 2 | Проект без RAG-БД (не создавалась) | delete | RAG-шаг = no-op, receipt «rag: absent» |
| 3 | Проект без S3-объектов | delete | S3-шаг = no-op |
| 4 | Активные RAG-сессии при удалении | delete | freeze (остановка записей), сессии истекают по TTL, DROP после freeze |
| 5 | Повторный delete (idempotency) | delete ещё раз | no-op (проект уже удалён / request_key), без ошибок |
| 6 | S3 недоступен во время delete | delete | S3-шаг = failed (deletion-outbox retry), receipt «s3: pending», FK-cascade прошёл (проект удалён логически) |
| 7 | RAG-БД уже purged вручную (retired-rag) | delete | RAG-шаг = no-op (absent), receipt отражает |
| 8 | Частичный сбой (S3 ок, skills fail) | delete | receipt: per-домен статус (s3: deleted, skills: failed), retry-абилен |
| 9 | Whole-stack backup с проектом | delete | backup НЕ удаляется (OQ-2), receipt «backups: retained (operator)» |
| 10 | model_usage_calls проекта | delete | НЕ удаляется (OQ-3), retention решит |

## Code Map

- `services/catalog-service/src/catalog/project-deletion.ts:6-63` — `deleteProjectWithAudit` (FK-cascade :32, grants :37-42, project_retirements :43-47, operations :48-54) — точка расширения
- `services/catalog-service/src/retired-rag/retired-rag.service.ts` (489 строк) — референс-паттерн: freeze+DROP, request_key idempotency, preview→purge→receipt, `automaticPurge:false` :113, recover 3s
- `services/catalog-service/src/retired-rag/retired-rag.controller.ts:14-57` — routes (list/preview/purge/retry/authorize), `/internal/retired-rag/*`
- `services/rag-sync-service/src/rag/project-database-name.ts:5` — `nc_rag_<sha256(projectId)[:32]>`; `project-databases.ts:187-198` — template-БД
- `services/catalog-service/src/model-chat/chat-attachment-storage.ts:33` — «deletion outbox survives attachment/project cascades», :121-123 — `projects/<chatObjectDigest(projectId)>/` prefix, :137-139 — model_chat_objects, :231 — S3 delete-retry
- `compose.chat-storage.yml` — `CHAT_S3_PROJECT_BUCKET`/`CHAT_S3_PERSONAL_BUCKET` (project-объекты в project-bucket)
- `services/skills-service/src/skills/skills.module.ts:15-17` — SKILLS_STORAGE_PATH (skills-каталоги проекта)
- `services/catalog-service/src/snapshots/snapshot-storage.ts:418` — recoverWrite; `snapshot-gc.ts` — 2-фазный GC (S3 blob-удаление)
- `services/catalog-service/src/backups/backup-storage.ts:38-67` — backup-лок; `scripts/production/recovery.mjs` — whole-stack backup/dump
- `scripts/test/project-profile-delete-db.mjs` — существующий delete-тест (расширить)

## Tasks & Acceptance

### Execution
- [ ] `project-deletion.ts`: после FK-cascade (:32) — последовательность внешних шагов (каждый idempotent, request_key): RAG-БД → S3 → skills → dumps; каждый результат → receipt
- [ ] RAG-БД: автоматическое retirement (отдельный путь, не флаг) по подтверждённому удалению → freeze + DROP (референс retired-rag.service.ts); нет БД → no-op
- [ ] S3: chat-оригиналы `projects/<chatObjectDigest(projectId)>/` через deletion-outbox (chat-attachment-storage.ts:33) + snapshot-blobs проекта (2-фазный, snapshot-gc); S3 down → outbox retry, receipt «pending»
- [ ] skills: rm каталогов проекта (SKILLS_STORAGE_PATH, структура — OQ-4)
- [ ] dumps/backup-копии: OQ-2 (recommend: whole-stack leave+document; per-project dumps — удалить, если есть механизм)
- [ ] Receipt: `project_retirements.deleted_resources` JSONB (per-домен: deleted/absent/pending/failed + reason); migration v53+ (колонка)
- [ ] Freeze-протокол: задокументировать (freeze останавливает записи, активные сессии — TTL-истечение)
- [ ] Тесты: полный каскад (fixture: RAG-БД + S3-объекты + skills + проект) → все домены; idempotency (повторный delete); частичный сбой (per-домен статус); S3 down (outbox retry)

### Acceptance
- **Given** проект с RAG-БД + S3-объектами + skills **when** DELETE /projects/:id **then** FK-cascade + RAG-БД DROP + S3-объекты + skills удалены + receipt со всеми доменами
- **Given** повторный delete **when** run **then** no-op (idempotency, request_key)
- **Given** активные RAG-сессии **when** delete **then** freeze + TTL-истечение + DROP (не hard-kill)
- **Given** S3 down **when** delete **then** FK-cascade прошёл, S3 = pending (outbox), receipt отражает
- **Given** whole-stack backup с проектом **when** delete **then** backup не удалён, receipt «backups: retained»

## Design Notes

- **Почему отдельный путь, не флаг**: AD-D3 «автоматическое retirement — только как триггер подтверждённого удаления проекта (отдельный путь, не флаг)». Т.е. не `automaticPurge:true` (это сломало бы ручной purge), а dedicated-путь «проект удалён → retire+purge RAG-БД».
- **Референс retired-rag**: freeze+DROP + request_key + preview→purge→receipt уже реализованы (489 строк) — переиспользовать, не изобретать. Автоматический путь = вызов того же DROP, но триггер = подтверждённое удаление (не ручной preview/purge).
- **S3 deletion-outbox** уже «survives project cascades» (chat-attachment-storage.ts:33) — chat-оригиналы уже каскадируют; убедиться, что snapshot-blobs тоже (2-фазный GC).
- **Order и атомарность**: FK-cascade атомен (транзакция). Внешние домены — не атомарны (S3/FS/RAG) — каждый idempotent + receipt-статус. Проект «логически удалён» после FK-cascade; внешние доемы — best-effort с retry (outbox) + receipt.
- **Receipt** = расширение project_retirements (уже есть project_id/name/actor) — добавить `deleted_resources` JSONB.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- project-deletion retired-rag
node --test scripts/test/project-profile-delete-db.mjs 2>/dev/null || true
```
Ожидаемо: delete-тесты зелёные (полный каскад, idempotency, частичный сбой, S3 down); receipt заполнен per-домен.

## Open Questions

1. **RAG-БД: retire+purge vs только retire?** AD-D3: «автоматическое retirement — только как триггер подтверждённого удаления». Retirement = помечена+retain (ручной purge позже) vs сразу DROP? Рекомендация: **retire + purge (DROP)** для подтверждённого удаления (проект мёртв, данные не нужны) — но сохранить ручной purge для non-удалённых (retired-rag). Подтвердить.
2. **Whole-stack backup'ы проекта**: удалять или leave+document? Рекомендация: **leave + document в receipt** (backup = операторская зона, whole-stack dump содержит другие проекты). Per-project dumps (если есть) — удалить.
3. **model_usage_calls**: удалить или leave (аналитика)? Рекомендация: **leave** (аналитика/биллинг), retention (story 7/8) решит TTL. Подтвердить.
4. **skills layout**: какой подкаталог SKILLS_STORAGE_PATH = проект (для rm) — dev-уточнение (fs-skills-storage.ts baseDir layout).
5. **S3 snapshot-blobs**: удалить через 2-фазный GC (snapshot-gc) или отдельный project-scope delete? Рекомендация: 2-фазный (refcount, безопасный).
6. **Freeze-протокол**: документировать где (architecture-data.md vs code-comment) — OQ.
