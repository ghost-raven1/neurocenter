---
title: 'FR-302: Последовательный контекст + подключение агента агентом (передача контекста + аудит)'
type: 'feature'
ticket: '2'
created: '2026-11-09'
status: done
baseline_revision: '56f8c009cf0c9cb9d18091c5176c36831eb981cd'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-agent-team/epic-agent-team.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md
  - _bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/tickets/tickets.toml
  - _bmad-output/initiative-architecture/tickets/epic-project/tickets/tickets.toml
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-302 закрывает цепочку «анализ → требования → архитектура → задачи → код → тесты → ревью → подготовка выпуска» (C5) двумя механизмами, которых сейчас **нет**: (1) **последовательный контекст** — следующий агент видит **опубликованные ответы предыдущих** (ID/автор/порядок/версия опубликованных сообщений) до своего вызова; (2) **подключение агента агентом** — агент подключает к решаемой задаче другого агента проекта: контекст задачи передаётся подключённому, подключение — **с записью в аудит**. Сейчас `ProjectChatInferenceService` строит контекст из `ancestors` (≤8) и `projectChatContext`, но это контекст **одного** диалога, а не последовательная передача «опубликованных ответов предыдущих агентов» между исполнителями цепочки; явного «агент подключает агента» с передачей контекста задачи + аудитом нет.

**Approach:** (1) Расширить построение контекста вызова агента: перед вызовом следующего исполнителя в контекст кладутся **опубликованные ответы предыдущих** (с ID/автором/порядком/версией) — не сырые `ancestors`, а опубликованные артефакты цепочки. (2) Ввести действие «подключить агента к задаче»: агент A → агент B, передаётся **контекст задачи** (состояние/промежуточные результаты/решения), запись в аудит (who подключил, кого, к какой задаче, когда). Подключение = частный случай деления контекста (FR-309/entry 3) с записью в аудит. Стык: не дублируем механику чата (эпик 8) и поиск (epic-project entry 13/14).

## Boundaries & Constraints

**Always:**
- Последовательный контекст = **опубликованные** ответы предыдущих (ID/автор/порядок/версия), доступные следующему **до его вызова**.
- Подключение агента агентом: передача **контекста задачи** + **запись в аудит** (обязательна).
- Аудит — транзакционный (NFR-4/R9): who/what/когда/задача.
- Публикация результата — только если у агента доступ к комнате (FR-301/entry 1).

**Never:**
- Не передавать НЕопубликованные/приватные ответы в последовательный контекст (FR-403).
- Не подключать агента без записи в аудит.
- Не ломать существующий `ancestors` (≤8) / `projectChatContext` (регресс).
- Не дублировать механику чата (эпик 8) и поиск (эpic-project entry 13/14).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Следующий агент видит предыдущих | цепочка: агент1 → агент2 | Агент2 до вызова видит опубликованные ответы агента1 (ID/автор/порядок/версия) | — |
| 2 | Порядок/версия отражены | несколько опубликованных ответов | Контекст вызова несёт порядок + версию | — |
| 3 | Подключение агента | агент A → агент B к задаче | Контекст задачи передан B + запись в аудит | нет прав A → отказ |
| 4 | Аудит подключения | подключение совершено | Аудит-событие (who/what/задача/когда) | нет аудита → фэйл (NFR-4) |
| 5 | Приватный ответ | приватный (неопубликованный) ответ | Не попадает в последовательный контекст (FR-403) | — |
| 6 | Цепочка C5 | анализ→…→выпуск | Передаются принятые решения + исходные артефакты, не пересказ | пересказ (без провенанса) → фэйл (R5) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/project-chat-inference/project-chat-inference.service.ts` — `:41` service, `infer:135`, `projectChatContext:184` (собирает контекст), `ancestors:365` (≤8 `:369`) — точка расширения «опубликованные ответы предыдущих».
- `services/catalog-service/src/project-chat/project-chat.schema.ts` — project_chat_messages (immutable attribution, lease, generation) — источник «опубликованных» (ID/автор/порядок/версия).
- `services/catalog-service/src/project-chat/project-chat.runner.ts` — `ProjectChatRunner:54` (FIFO, publication) — публикация ответов.
- `services/catalog-service/src/agents/agent-audit.ts` — существующий аудит агентов (точка для записи подключения).
- `services/catalog-service/src/agents/project-agent.repository.ts` — project_agents (кто подключён к проекту).
- `services/catalog-service/src/learning/learning.repository.ts` — context() (approved) — часть контекста задачи.
- Аудит-стор: `security_events`/`operations` (эпик 6 entry 14, AD-O7) — единая история; запись подключения агента.

## Tasks & Acceptance

### Execution
- [x] Последовательный контекст: при вызове следующего исполнителя в контекст кладутся **опубликованные ответы предыдущих** (ID/автор/порядок/версия) до его вызова.
- [x] Только **опубликованные** (не приватные/неопубликованные) — FR-403.
- [x] Действие «подключить агента к задаче»: агент A → агент B, передача контекста задачи (состояние/результаты/решения).
- [x] Запись в аудит подключения (who/what/задача/когда) — транзакционная (NFR-4).
- [x] C5-цепочка: передача принятых решений + исходных артефактов (не пересказ, провенанс).
- [x] Тесты: последовательный контекст (порядок/версия), подключение (контекст+аудит), приватный вне контекста, C5-передача.

### Acceptance
- **Given** цепочка агент1→агент2 **when** вызов агента2 **then** до вызова агент2 видит опубликованные ответы агента1 (ID/автор/порядок/версия).
- **Given** агент A подключает агента B к задаче **when** подключение **then** контекст задачи передан B + запись в аудит.
- **Given** приватный (неопубликованный) ответ **when** построение последовательного контекста **then** не попадает (FR-403).
- **Given** C5-цепочка **when** передача между этапами **then** принятые решения + исходные артефакты (провенанс), не пересказ (R5).
- Корневой сьют — без деградации.

## Design Notes

- **Почему «опубликованные», а не `ancestors`:** `ancestors` (≤8) — контекст одного диалога; FR-302 требует **последовательную** передачу **опубликованных** ответов предыдущих исполнителей цепочки (C5). Это расширение `projectChatContext`, а не замена `ancestors`.
- **Подключение = частный случай FR-309:** подключение агента — это деление контекста (задачи) с записью в аудит; entry 3 строит общий механизм деления, здесь — конкретное действие «подключить» + аудит. Не дублируем: entry 3 = механизм+провенанс, entry 2 = действие подключения+порядок цепочки.
- **Аудит обязателен (NFR-4/R9):** «подключение — с записью в аудит» — прямое требование FR-302.
- **C5 = артефакты, не пересказ:** следующий исполнитель получает **принятые решения и исходные артефакты** (R5, counter: пересказанные артефакты = 0).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- project-chat-inference project-chat agents
node --test scripts/test/sequential-context-handover.test.mjs 2>/dev/null || true
```
Ожидаемо: последовательный контекст (опубликованные, ID/автор/порядок/версия), подключение агента (контекст+аудит), приватный вне контекста, C5-передача артефактов; корневой сьют без деградации.

## Open Questions

1. **Граничная длина последовательного контекста?** Рекомендация: наследовать лимиты `ancestors`/контекст-окна (не новый безлимит). Обоснование: NFR-6 — лимиты реально работают.
2. **Подключение — синхронно или как задание (job)?** Рекомендация: действие в рамках текущего вызова + аудит (не новый long-running job). Обоснование: FR-302 о «подключении к задаче», не о фоновом запуске (это FR-305/entry 7).
3. **Провенанс передаваемого контекста задачи?** Рекомендация: да — версия/SHA (NFR-4), стык с entry 3. Обоснование: единый провенанс-контракт.

## Progress (2026-11-12, in-progress)

Реализация + тесты завершены (uncommitted). Архитектура: handover выполняется **НЕ** в publish-транзакции ответа, а в финальном блоке `execute()` runner'а (после settling всех ответов) — publish-ре-квиз в середине ломал бы `assertRunning` параллельных агентов (кейс A1-handover + A2-параллель).

**Код (catalog-service):**
- `src/project-chat-inference/project-chat-sequential.ts` (new) — рендер последовательного контекста: `messageId`/`author`/`position`/`generation`, truncation ответа до 4000 с указателем на копию в комнате.
- `src/project-chat/project-chat-handover.ts` (new) — парсер fenced-блока `neurocenter-handover` (строгий JSON, невалидные блоки не роняют ответ; первая валидная директива выигрывает). **Исправлен баг формата id:** канонический regex UUID отклонял реальные id платформы (`agent-<uuid>`); заменён на chat-agent контракт `agent-[a-z0-9][a-z0-9-]{0,120}` (case-insensitive, normalizация в нижний).
- `src/project-chat-inference/project-chat-inference.service.ts` — метод `sequential()` (SQL: опубликованные `kind='agent' AND status='done'` из неп-приватной комнаты, `position < source OR (source_message_id=source AND generation≠response)`, LIMIT 8) + интеграция в `infer()`.
- `src/project-chat/project-chat-context.ts` — параметр `sequential=[]`.
- `src/project-chat/project-chat.runner.ts` — `finalizeHandovers()` в финальном блоке `execute()`: парсинг done-ответов, валидация from/to ∈ `room.agent_ids`, не-себе, не-дубликат, resolve с catch-skip (+ постоянный `console.error` при пропуске), INSERT child B `queued` + `securityEvent` + re-квиз source под новым generation; `ConflictException` если requeued=0.
- `src/access/security-events.ts` — параметр расширен до `Pick<PoolClient,'query'>` (TProjectChatDb совместим).
- `src/agents/agent-audit.ts` — `'project.chat.agent.handover'` в AGENT_AUDIT_ACTIONS (журнал агентов).

**E2E-инфраструктура:** `scripts/test/model-chat.fixture.mjs` — миграция на новый API подключений (с 12.8 общий ключ в `PUT /connection` не настраивается): `authMode: required`/`none` + личный ключ «Мой доступ» (`PUT /api/models/:id/my-access`) для акторов main/developer; порядок: main до hosting-check, developer после назначения модели проекту.

Доказано (2026-11-12):
- `npx vitest run project-chat-sequential project-chat-handover` — **15/15 pass** (провенанс/порядок/версия, truncation, ordering; парсер: валидные/невалидные/first-valid/формат id).
- `node --test scripts/test/sequential-context-handover.test.mjs` — **4/4 pass** (self-bootstrap docker postgres:16 + in-process Catalog из dist + scripted fake OpenAI): (1) C5-цепочка — агент2 до вызова видит опубликованный ответ агента1 (ID/автор/порядок/версия); (2) handover — контекст задачи + транзакционный аудит `project.chat.agent.handover` (who/кого/откуда-ответ/задача/когда, after_state jsonb); (3) FR-403 — приватный ответ вне последовательного контекста; (4) отказы — агент вне состава комнаты и malformed-директива: без аудита, опубликованный ответ сохранён.
- tsc: файлы 9.2 чисты (7 pre-existing ошибок в чужих тестах backups/project-deletion/snapshots).

- **Корневой сьют без деградации — ЗЕЛЁНЫЙ (2026-11-12):** `FILES=$(python3 -c "import json;print(' '.join(json.load(open('scripts/workspace/check-tooling-tests.json'))))"); node --test --test-concurrency=1 $FILES` — **1076 tests, 1073 pass, 0 fail, 3 skipped** (exit 0). Строки «Catalog compilation failed» в логе — ожидаемые: dev-watch-daemon-тесты намеренно проверяют сценарий битой компиляции (тесты зелёные).
- Prettier-формат всех 9.2-файлов после верификации (стиль проекта, `prettier --check` чист); dist пересобран (stamp актуален), e2e 4/4 и юниты 15/15 перепроверены после форматирования.

Замечание (pre-existing, не регресс 9.2):
- **`check.mjs --tooling`** — не гоняется: хардкод CHECK_TIMEOUT 600 c < длительность сьюта ~1021 c (commit 0d9b9430); контент шага верифицирован отдельным прогоном корневого сьюта (см. выше).
