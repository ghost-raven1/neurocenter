---
title: 'FR-311: единый семантический поиск агента по 4 корпусам (с провенансом + freshness-guard)'
type: 'feature'
ticket: '14'
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
  - _bmad-output/initiative-architecture/tickets/epic-project/epic-project.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Сейчас agent-tools (agent-tools.service.ts:178-413) имеет **раздельные** инструменты: `rag_search`/`rag_read` (корпус кода через ModelChatProjectContext, :303-331) + `public_chat_search` (публичные чаты через ChatSearchService, :333-358). 2 корпуса (знания/опыт) добавлены в entry 13. **Gap FR-311:** «У каждого агента проекта — семантический поиск по четырём корпусам… «Актуальный» = индекс синхронизирован с изменениями (reindex/sync — FR-606); **поиск по протухшему индексу — дефект**. Результаты поиска несут провенанс: источник (файл + commit, сообщение + комната, версия записи знания/опыта; NFR-4). Граница: приватные диалоги и личный диалог с агентом не являются корпусом поиска (FR-403)». Сейчас нет: ЕДИНОГО поиска по 4 корпусам, per-hit провенанса для всех 4, freshness-guard (протухший = дефект).

**Approach:** **Единый search-инструмент агента**, охватывающий 4 корпуса (код, публичные чаты, одобренные знания, опыт): (1) единый `search`-action (agent-tools), принимающий query → семантический поиск по 4 корпусам (агрегация). (2) **Per-hit провенанс:** файл+commit (код), сообщение+комната (чаты), версия записи (знания/опыт) — R9/NFR-4. (3) **Freshness-guard:** проверка актуальности индекса перед поиском — протухший = отказ/флаг (не тихий stale-результат, FR-311). (4) Граница (FR-403): приватные диалоги + личный диалог с агентом — НЕ корпус. Существующие rag_search/rag_read/public_chat_search — не ломаем (regression), единый search — надстройка.

## Boundaries & Constraints

**Always:**
- Единый search-инструмент охватывает 4 корпуса (код/публичные чаты/знания/опыт) — агрегация.
- Per-hit провенанс: файл+commit (код), сообщение+комната (чаты), версия записи (знания/опыта) — R9/NFR-4.
- Freshness-guard: актуальность индекса проверяется перед поиском; протухший = отказ/флаг (не тихий stale, FR-311).
- Граница (FR-403): приватные диалоги + личный диалог с агентом — НЕ корпус.
- Access: агентский поиск — с правами агента (assertProjectChatRoomAccess / resolveProject level), как существующие agent-tools.
- Корпуса (1) код (rag-search) + (2) публичные чаты (chat-search) — существующие, не ломаем (regression).
- Корпуса (3) знания + (4) опыт — entry 13 (индексация) — precondition.

**Never:**
- Не ломать существующие rag_search/rag_read/public_chat_search (regression) — единый search = надстройка.
- Не возвращать тихий stale-результат (протухший индекс = дефект, FR-311 — отказ/флаг).
- Не включать приватные диалоги/личный диалог с агентом в поиск (FR-403).
- Не терять per-hit провенанс (R9/NFR-4) — каждый hit несёт источник+версию.
- Не обходить access-проверки (права агента, room-access).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Поиск по 4 корпусам | agent search {query} | Агрегированные hits из 4 корпусов |
| 2 | Провенанс hit кода | hit (корпус 1) | файл+commit |
| 3 | Провенанс hit чата | hit (корпус 2) | сообщение+комната |
| 4 | Провенанс hit знания/опыта | hit (корпус 3/4) | версия записи |
| 5 | Freshness: актуальный индекс | sync OK | Поиск возвращает результаты |
| 6 | Freshness: протухший индекс | изменения без sync | Отказ/флаг (не тихий stale, FR-311) |
| 7 | Приватные диалоги | в корпусе? | НЕ (FR-403) |
| 8 | Личный диалог с агентом | в корпусе? | НЕ (FR-403) |
| 9 | Access: агент без прав | search | Отказ (access-проверка) |
| 10 | Существующие инструменты | rag_search/public_chat_search | Не деградируют (regression) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/agent-tools/agent-tools.service.ts:178-413` — `run()` (tools: rag_search :303-331, rag_read :326-332, public_chat_search :333-358, system-role) — точка расширения (единый search); `:247-273` observe (contextIdentity check), `:274-301` present (public_chat_search hydrate).
- `services/catalog-service/src/agent-tools/agent-tools.constants.ts` — AGENT_TOOL_LIMITS (steps:3, outputBytes, contextBytes, deadlineMs:120000) — лимиты search.
- `services/catalog-service/src/model-chat/chat-project-context.ts` — RAG project context (корпус кода) — REFERENCE (корпус 1).
- `services/catalog-service/src/chat-search/` — ChatSearchService (корпус публичных чатов, job-based) — REFERENCE (корпус 2).
- `services/rag-sync-service/src/rag/rag-search.ts` — corpus code search (REF, корпус 1).
- `services/catalog-service/src/learning/` (entry 13) — знания/опыт-корпус (корпуса 3/4) — precondition.
- `services/catalog-service/src/models/project-embedding.validation.ts` — embedding-pin (consistency, freshness).
- `services/catalog-service/src/models/project-reindex.service.ts` — reindex/sync (FR-606, freshness-источник).
- New: единый search-инструмент (agent-tools) — агрегация 4 корпусов + провенанс + freshness-guard.

## Tasks & Acceptance

### Execution
- [ ] Единый `search`-action (agent-tools.service.ts run()) — query → агрегированный семантический поиск по 4 корпусам (код/pубличные чаты/знания/опыт).
- [ ] Per-hit провенанс: файл+commit (код), сообщение+комната (чаты), версия записи (знания/опыт) — R9/NFR-4.
- [ ] Freshness-guard: проверка актуальности индекса (reindex/sync статус, FR-606) перед поиском; протухший = отказ/флаг (не тихий stale, FR-311).
- [ ] Граница (FR-403): приватные диалоги + личный диалог с агентом — НЕ корпус.
- [ ] Access: search — с правами агента (resolveProject level, room-access), как существующие agent-tools.
- [ ] Лимиты: AGENT_TOOL_LIMITS (steps/outputBytes/contextBytes/deadlineMs) — search в пределах.
- [ ] Тесты: поиск по 4 корпусам (агрегация), per-hit провенанс (4 типа), freshness (актуальный OK / протухший отказ), приватные/личный НЕ, access, лимиты, regression (rag_search/public_chat_search).

### Acceptance
- **Given** agent search {query} **when** run **then** агрегированные hits из 4 корпусов (код/чаты/знания/опыт).
- **Given** hit кода **when** провенанс **then** файл+commit.
- **Given** hit чата **when** провенанс **then** сообщение+комната.
- **Given** hit знания/опыта **when** провенанс **then** версия записи.
- **Given** актуальный индекс **when** search **then** результаты.
- **Given** протухший индекс **when** search **then** отказ/флаг (не тихий stale, FR-311).
- **Given** приватные диалоги/личный диалог **when** в корпусе? **then** НЕ (FR-403).
- **Given** rag_search/public_chat_search **when** run **then** не деградируют (regression).
- Корневой сьют — без деградации.

## Design Notes

- **Единый search = надстройка, не замена:** существующие rag_search/rag_read/public_chat_search — не ломаем (regression). Единый search — агрегация 4 корпусов (одна точка входа для агента). Агенты могут использовать и старый, и новый (backward-compat).
- **Freshness-guard = ключевое (FR-311):** «поиск по протухшему индексу — дефект». Реализация: перед поиском — проверка sync-статуса (reindex/sync, FR-606, project-reindex.service.ts). Протухший (изменения без sync) = отказ/флаг (actionable: «индекс устарел, требуется reindex»), не тихий stale-результат. Это NFR-6 (лимит/актуальность enforced) + NFR-4 (провенанс).
- **Per-hit провенанс (R9/NFR-4):** каждый hit несёт источник+версию: код=файл+commit, чаты=сообщение+комната, знания/опыт=версия записи. Единый формат (как у существующих: code sources = contextIdentity+generation+snapshot, chat = messageId+roomId+revision).
- **Граница (FR-403):** приватные диалоги + личный диалог с агентом — НЕ корпус. Только публичные чаты (корпус 2). Как в FR-311 + FR-403.
- **Access = права агента:** search — с правами агента (resolveProject level, assertProjectChatRoomAccess), как существующие agent-tools. Не привилегированный поиск.
- **Лимиты (AGENT_TOOL_LIMITS):** steps:3, outputBytes:32768, contextBytes:98304, deadlineMs:120000 — search в пределах (не раздувать контекст).
- **Стык с entry 13 (корпуса 3/4):** здесь = search-API по 4 корпусам; entry 13 = индексация (корпуса 3/4). Gраница: search (здесь) vs index (entry 13).
- **Стык с entry 12 (autonomous rounds):** автономные раунды (entry 12) могут использовать единый search (агент ищет в раунде). Не конфликт.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- agent-tools chat-search
node --test scripts/test/unified-agent-search.test.mjs 2>/dev/null || true
```
Ожидаемо: поиск по 4 корпусам (агрегация), per-hit провенанс (4 типа), freshness (актуальный OK / протухший отказ), приватные/личный НЕ, access, лимиты, regression (rag_search/public_chat_search) — зелёные; корневой сьют без деградации.

## Open Questions

1. **Единый search заменяет или дополняет rag_search/public_chat_search?** Рекоменdация: дополняет (надстройка, backward-compat). Обоснование: не ломать существующее; агенты выбирают.
2. **Агрегация: merge результатов или per-corpus?** Рекоменdация: merge (единый ranked список) + per-hit corpus-метка. Обоснование: агенту проще один результат.
3. **Freshness-guard: отказ или деградация (stale+флаг)?** Рекоменdация: отказ/флаг (actionable: «индекс устарел»). Обоснование: FR-311 «поиск по протухшему = дефект» — не тихий stale.
4. **Лимит hits per corpus?** Рекоменdация: per-corpus top-K + общий лимит (AGENT_TOOL_LIMITS.contextBytes). Обоснование: не раздувать контекст.
5. **Search по 4 корпусам — один LLM-шаг или несколько?** Рекоменdация: один search-шаг (агрегация серверная), LLM-вызов на интерпретацию. Обоснование: steps:3 лимит.
