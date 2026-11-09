---
title: 'FR-311: знания и опыт — поисковые корпуса (индексация с провенансом версии)'
type: 'feature'
ticket: '13'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-project/epic-project.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 2 из 4 корпусов FR-311 уже есть: (1) **код проекта** — RAG develop-index (rag-sync-service/src/rag: file chunks file_path/lines/language/kind/role/quirk_type/tags/content_hash/embedding, delta sync, rag-search.ts) с провенансом file+hash; (2) **публичные чаты** — chat-search/ (явный user job, consent:true, modelId+pin, 1–32 chunks×2048/job, scan cap 10000, exact cosine, live JOIN revisions/tombstones, hits messageId+roomId+revision). **Gap:** (3) **одобренные знания** (FR-502) и (4) **опыт** (записи цикла FR-501) НЕ индексированы/не ищутся: одобренные знания — только в chat-контексте через heads (learning.repository.ts:350-370 `context()`), отдельного поискового корпуса нет. FR-311 [P1]: «У каждого агента проекта — семантический поиск по четырём корпусам: (1) актуальный код проекта, (2) публичные чаты/комнаты, (3) одобренные знания, (4) опыт… «Актуальный» = индекс синхронизирован с изменениями (reindex/sync — FR-606); поиск по протухшему индексу — дефект. Результаты несут провенанс (…версия записи знания/опыта; NFR-4)».

**Approach:** Индексировать (3) **одобренные знания** (approved heads, learning.repository.ts:350-370) + (4) **опыт** (записи FR-501: experiences/checks) как поисковые корпуса: embeddings (per-project, nc_rag_<sha> pattern rag-sync-service), провенанс = **версия записи знания/опыта** (R9/NFR-4). Синхронизация с изменениями (reindex/sync при новых approved/опыте — FR-606 pattern: generation build, plan, approval, model+generation switch one catalog txn). Только APPROVED знания индексируются (FR-502) — не-одобренные не попадают в корпус.

## Boundaries & Constraints

**Always:**
- Индексируются ТОЛЬКО approved знания (FR-502, learning.repository.ts:350-370 approved heads) — не-одобренные НЕ в корпус.
- Опыт (записи FR-501: experiences/checks) — индексируется как корпус.
- Провенанс результата = **версия записи знания/опыта** (R9/NFR-4) — не просто id.
- Embeddings per-project (nc_rag_<sha> pattern, rag-sync-service) — изоляция по проекту.
- Синхронизация (reindex/sync) при новых approved/опыте (FR-606 pattern): индекс актуален, протухший = дефект.
- Embedding-модель = проектная (project-embedding pin, project-embedding.validation.ts) — consistency с кодом/чатами.

**Never:**
- Не индексировать не-одобренные знания (FR-502: только approved в контекст/корпус).
- Не ломать существующие корпуса (1) код (rag-sync-service develop-index) и (2) публичные чаты (chat-search/) — regression.
- Не дублировать embedding-модель (project-embedding pin — единственная, FR-606).
- Не индексировать приватные диалоги/личный диалог с агентом (FR-403 — граница, как в FR-311).
- Не делать «протухший индекс» тихим (FR-311: поиск по протухшему = дефект).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Одобренные знания → корпус | approved heads (learning.repository.ts:350-370) | Индексированы (embeddings, per-project) |
| 2 | Опыт → корпус | записи FR-501 (experiences/checks) | Индексированы |
| 3 | Провенанс результата | hit знания/опыта | Версия записи (R9), не просто id |
| 4 | Не-одобренная запись | не-approved candidate | НЕ в корпусе (FR-502) |
| 5 | Новая approved-запись | reindex/sync | Индекс обновлён (актуален) |
| 6 | Протухший индекс | изменения без sync | Дефект (не тихий stale, FR-311) |
| 7 | Корпус (1) код | существующий | Не деградирует (regression) |
| 8 | Корпус (2) публичные чаты | существующий | Не деградирует (regression) |
| 9 | Приватные диалоги | в корпусе? | НЕ (FR-403 граница) |
| 10 | Embedding-модель | project-embedding pin | Единственная (FR-606), consistency |

</frozen-after-approval>

## Code Map

- `services/rag-sync-service/src/rag/` — develop-index (file chunks file_path/lines/language/kind/role/quirk_type/tags/content_hash/embedding, delta sync, rag-search.ts) — REFERENCE для индексации (корпус кода); nc_rag_<sha> per-project (project-database-name.ts:5).
- `services/rag-sync-service/src/rag/project-databases.ts:187-198` — template-БД nc_rag_<sha> — REFERENCE per-project.
- `services/catalog-service/src/learning/learning.repository.ts:350-370` — `context()` (approved heads, ILearningContext: id/key/version/kind/title/content/targetAgentId/hypothesisId/checkId/approvedAt) — источник одобренных знаний.
- `services/catalog-service/src/learning/learning-schema.ts` — experiences/hypotheses/checks/candidates — источник опыта.
- `services/catalog-service/src/chat-search/` — публичные чаты (корпус 2, существующий) — НЕ трогать (regression).
- `services/catalog-service/src/models/project-embedding.validation.ts` — project-embedding pin (embedding-модель) — consistency.
- `services/catalog-service/src/models/project-reindex.service.ts` — reindex/sync (FR-606 pattern: generation build, plan, approval, model+generation switch one catalog txn) — REFERENCE для sync знаний/опыта.
- New: индексация знаний/опыта (rag-sync-service или learning-index) — embeddings + провенанс версии.

## Tasks & Acceptance

### Execution
- [ ] Индексация одобренных знаний: approved heads (learning.repository.ts:350-370) → embeddings (per-project nc_rag_<sha>), провенанс = версия записи (key+version).
- [ ] Индексация опыта: записи FR-501 (experiences/checks, learning-schema.ts) → embeddings, провенанс = версия записи.
- [ ] Только approved (FR-502): не-одобренные НЕ в корпус (фильтр approved).
- [ ] Провенанс: hit знания/опыта несёт версию записи (R9/NFR-4) — не просто id.
- [ ] Sync (reindex) при новых approved/опыте (FR-606 pattern, project-reindex.service.ts): индекс актуален; протухший = дефект (не тихий).
- [ ] Embedding-модель = project-embedding pin (project-embedding.validation.ts) — consistency с кодом/чатами.
- [ ] Приватные диалоги/личный диалог с агентом — НЕ в корпус (FR-403).
- [ ] Тесты: approved знания → корпус, опыт → корпус, провенанс (версия), не-approved НЕ в корпусе, sync (актуальность), протухший (дефект), код/чаты regression, embedding-pin consistency, приватные НЕ.

### Acceptance
- **Given** approved heads (learning.repository.ts:350-370) **when** индексация **then** в корпусе (embeddings, per-project, провенанс версия).
- **Given** записи FR-501 (опыт) **when** индексация **then** в корпусе (провенанс версия).
- **Given** не-одобренная запись **when** индексация **then** НЕ в корпусе (FR-502).
- **Given** новая approved-запись **when** sync **then** индекс обновлён (актуален).
- **Given** изменения без sync **when** поиск **then** протухший = дефект (не тихий, FR-311).
- **Given** код (1) / публичные чаты (2) **when** run **then** не деградируют (regression).
- **Given** приватные диалоги **when** в корпусе? **then** НЕ (FR-403).
- Корневой сьют — без деградации.

## Design Notes

- **Почему только approved (FR-502):** «Только одобренная (человеком) версия знания попадает в контекст проекта» — корпус поиска = расширение контекста. Не-одобренные (кандидаты) не проходят оценку человека — не в корпусе. Согласовано с FR-502 + entry 9 (политика подтверждений определяет, что approved).
- **Провенанс = версия записи (R9):** FR-311 «версия записи знания/опыта». Не просто id — версия (key+version, learning-schema.ts). Идентично корпусу кода (file+hash) и чатов (messageId+roomId+revision).
- **Per-project nc_rag_<sha>:** переиспользуем rag-sync-service pattern (project-database-name.ts:5, project-databases.ts:187-198). Знания/опыт — в per-project БД (изоляция).
- **Sync = FR-606 pattern:** reindex (project-reindex.service.ts: generation build, plan, approval, model+generation switch one catalog txn). Новые approved/опыт → sync → актуальный индекс. «Поиск по протухшему индексу — дефект» (FR-311).
- **Embedding-модель = project-embedding pin:** одна embedding-модель на проект (FR-606) — consistency: код/чаты/знания/опыт эмбедятся одной моделью (иначе cosine-сравнение невалидно).
- **Граница (FR-403):** приватные диалоги + личный диалог с агентом — НЕ корпус (как в FR-311). Только публичные чаты (корпус 2, существующий).
- **Стык с entry 14 (unified search):** здесь = индексация (корпуса 3+4); entry 14 = единый search-инструмент агента по 4 корпусам. Граница: index (здесь) vs search-API (entry 14).
- **Стык с entry 9 (FR-501):** политика подтверждений (entry 9) определяет, что approved → индексируется (здесь). Не дублируем.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/rag-sync-service && npm test -- project-databases
cd ../catalog-service && npm test -- learning project-embedding
node --test scripts/test/knowledge-experience-index.test.mjs 2>/dev/null || true
```
Ожидаемо: approved знания/опыт → корпус (embeddings, провенанс версия), не-approved НЕ, sync (актуальность), протухший (дефект), код/чаты regression, embedding-pin consistency, приватные НЕ — зелёные; корневой сьют без деградации.

## Open Questions

1. **Индексация — в rag-sync-service или learning?** Рекоменdация: rag-sync-service (уже index-движок, nc_rag_<sha>). Обоснование: переиспользовать develop-index-паттерн.
2. **Опыт: какие записи (experiences, checks, candidates)?** Рекоменdация: experiences + checks (доказательства), approved candidates. Обоснование: FR-311 «опыт (записи цикла FR-501)».
3. **Chunking знаний/опыта?** Рекоменdация: по записи (1 запись = 1 chunk) + title/content. Обоснование: запись = атом (не разрезать).
4. **Sync-триггер: при approve или batch?** Рекоменdация: при approve (event) + периодический batch. Обоснование: актуальность (протухший = дефект).
5. **Провенанс: версия записи или key+version+approvedAt?** Рекоменdация: key+version+approvedAt (полный провенанс, R9). Обоснование: однозначная идентификация.
