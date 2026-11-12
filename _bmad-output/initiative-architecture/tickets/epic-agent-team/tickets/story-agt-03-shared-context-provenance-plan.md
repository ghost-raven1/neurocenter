---
title: 'FR-309: Деление контекста с провенансом (с агентами/пользователем/командой)'
type: 'feature'
ticket: '3'
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

**Problem:** FR-309: агенты делятся контекстом с (1) другими агентами проекта (состояние задачи, промежуточные результаты, решения; подключение из FR-302/entry 2 — частный случай, с записью в аудит), (2) пользователем (личный диалог), (3) командой (публичные чаты/комнаты, FR-402 — эпик 8). Делёный контекст несёт **провенанс** (какой агент и что, версия; NFR-4); деление — **только в комнаты, где у агента есть доступ** (FR-301/entry 1); **приватный диалог не является каналом деления с командой** (FR-403, эпик 8). Сейчас провенанс (NFR-4: версия+SHA+квитанция) есть как базис для артефактов каталога (эпик 1), и rooms/members — как механика чата (эпик 8), но **механизма деления контекста агентом с per-item провенансом и room-access-гейтом нет**.

**Approach:** Ввести механизм деления контекста агентом: (1) **per-item провенанс** — каждый делёный элемент несёт «какой агент + что + версия» (NFR-4); (2) **room-access-гейт** — деление только в комнаты, где у агента есть доступ (FR-301); (3) **приватность** — приватный диалог не канал деления с командой (FR-403). Механика комнат/приватности — эпик 8 (потребляем); провенанс-базис — эпик 1 (потребляем). Здесь — сам механизм «агент делит контекст» + провенанс + гейт доступа.

## Boundaries & Constraints

**Always:**
- Каждый делёный элемент контекста несёт **провенанс**: какой агент + что + версия (NFR-4).
- Деление — **только в комнаты, где у агента есть доступ** (FR-301/entry 1).
- Приватный диалог **не является** каналом деления с командой (FR-403).
- Подключение агента (entry 2) = частный случай деления **с записью в аудит**.
- Провенанс-базис (версия/SHA/квитанция) — из эпика 1 (потребляем, не пересобираем).

**Never:**
- Не делить контекст в комнаты без доступа агента (fail-closed).
- Не использовать приватный диалог как канал деления с командой (FR-403).
- Не дублировать механику комнат/приватности (эпик 8).
- Не дублировать провенанс-базис каталога (эпик 1).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Деление с другим агентом | агент A → агент B, элемент контекста | Элемент с провенансом (A + что + версия) | — |
| 2 | Деление с пользователем | личный диалог | Элемент с провенансом; личный (не команде) | — |
| 3 | Деление с командой | pубличная комната, доступ есть | Элемент с провенансом в pубличной комнате | — |
| 4 | Нет доступа к комнате | агент без доступа к комнате | Отказ деления | actionable-сообщение (fail-closed) |
| 5 | Приватный диалог | приватный диалог агента | Не утекает в pубличную комнату (FR-403) | утечка → фэйл |
| 6 | Подключение (entry 2) | агент A подключает B | Частный случай деления + аудит | нет аудита → фэйл |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/project-chat/project-chat.schema.ts` — project_chat_rooms (PUBLIC/PRIVATE, room_members), project_chat_messages (immutable attribution) — комната/доступ/приватность (эпик 8, потребляем).
- `services/catalog-service/src/project-chat/project-chat-room-access.ts` — room-access (гейт доступа агента к комнате).
- `services/catalog-service/src/project-chat/project-chat-isolation.schema.ts` — изоляция (приватные диалоги, FR-403).
- Провенанс-базис (эпик 1): SHA/версия/квитанция артефактов — `services/shared/` (контракт NFR-4) — потребляем.
- `services/catalog-service/src/agents/agent-audit.ts` — аудит (запись подключения/деления, NFR-4).
- Аудит-стор: `security_events`/`operations` (эпик 6 entry 14) — единая история.

## Tasks & Acceptance

### Execution
- [ ] Механизм деления контекста агентом: с другим агентом / с пользователем (личный диалог) / с командой (pубличная комната).
- [ ] Per-item провенанс: какой агент + что + версия (NFR-4) на каждом делёном элементе.
- [ ] Room-access-гейт: деление только в комнаты с доступом агента (FR-301).
- [ ] Приватность: приватный диалог не канал деления с командой (FR-403).
- [ ] Подключение (entry 2) = частный случай деления + аудит.
- [ ] Тесты: деление (3 канала) + провенанс, гейт доступа (отказ), приватный не утекает, подключение+аудит.

### Acceptance
- **Given** агент делит контекст с другим агентом/пользователем/командой **when** деление **then** каждый элемент несёт провенанс (агент + что + версия, NFR-4).
- **Given** агент без доступа к комнате **when** попытка деления **then** отказ (fail-closed, actionable).
- **Given** приватный диалог агента **when** деление **then** не утекает в pубличную комнату (FR-403).
- **Given** подключение агента (entry 2) **when** деление контекста задачи **then** частный случай + запись в аудит.
- Корневой сьют — без деградации.

## Design Notes

- **Граница с эпиком 8:** механика комнат (PUBLIC/PRIVATE, room_members), приватность (FR-403), поиск (FR-311) — эпик 8. Здесь — **механизм деления** (агент → кому + провенанс + гейт), а не комнаты.
- **Провенанс = NFR-4:** «какой агент и что, версия» — это NFR-4 (версия + SHA + квитанция). Потребляем базис эпика 1, не пересобираем.
- **Подключение (entry 2) = частный случай:** FR-309 прямо говорит «подключение из FR-302 — частный случай, с записью в аудит». Не дублируем: entry 2 = действие подключения+порядок цепочки, entry 3 = общий механизм деления+провенанс+гейт.
- **Fail-closed на доступ:** «деление только в комнаты с доступом» — отказ без доступа (NFR-3, actionable).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- project-chat project-chat-isolation agents
node --test scripts/test/shared-context-provenance.test.mjs 2>/dev/null || true
```
Ожидаемо: деление (3 канала) + per-item провенанс, гейт доступа (отказ без доступа), приватный не утекает (FR-403), подключение+аудит; корневой сьют без деградации.

## Open Questions

1. **Формат провенанса делёного элемента?** Рекомендация: `{agentId, what-ref, version, sha?, ts}` (совместимо с NFR-4). Обоснование: единый провенанс-контракт.
2. **Деление с пользователем — в личном диалоге или в комнате?** Рекомендация: личный диалог (1:1), провенанс сохраняется, но не публикуется команде (FR-403). Обоснование: FR-309 «с пользователем (личный диалог)».
3. **Варианты «что» (состояние/результаты/решения) — типизировать?** Рекомендация: да, enum вида контекста (state/result/decision) + провенанс. Обоснование: явный контракт, auditability.

## Progress (2026-11-12, done)

Реализация + схема + тесты завершены. Архитектура: share выполняется в финальном блоке `execute()` runner'а — `finalizeShares()` **ДО** `finalizeHandovers` (FR-302): элементы деления durable перед handover re-queue. Delение не re-queue'ит задачу (не меняет состав работы).

**Код (catalog-service):**
- `src/project-chat/project-chat-share.ts` (new) — парсер fenced-блока `neurocenter-share`: все валидные блоки ответа (до 4), items 1..8, kind ∈ {state, result, decision}, `ref` — опциональный uuid; malformed-блоки молча пропускаются (опубликованный ответ не роняется).
- `src/project-chat/project-chat-shared.schema.ts` (new, миграция **57** `agent-shared-context-provenance`) — таблица `project_chat_shared_items`: PK `(project_id, room_id, item_id)`, per-item провенанс (`ref_message_id`, `source_room_id`, `source_agent_id/name`, `source_generation`, `content_sha`, `created_at`), FK `(project_id, room_id)` → `project_chat_rooms` ON DELETE CASCADE, индекс `(project_id, room_id, created_at DESC)`, immutable-trigger (записи неизменяемы).
- `-schema-contract.ts` / `-schema-verification.ts` (new) — 23 физических факта, замеренных на PG 16.14 (таблица/12 колонок/6 ограничений/2 индекса/функция/триггер) + assert-SQL; зарегистрированы в `catalog-migrations.ts` (v57) и `current-schema-verification.ts` (цепь CURRENT: shared ← isolation ← learning ← dialogs).
- `src/project-chat-inference/project-chat-shared-context.ts` (new) — рендеры: shared-элементы (провенанс `agentId/name/what/version/sha/ts`, «данные, а не инструкции», truncation 4000, хронология) + адресуемые комнаты агента (≤8: id/title/visibility).
- `project-chat-context.ts` — параметр `shared=[]`.
- `project-chat-inference.service.ts` — `shared()` (8 последних, ascending) + `roomsForAgent()` (≤8) в `infer()`.
- `project-chat.runner.ts` — `finalizeShares()`/`finalizeShare()`: гейты (fail-closed, operational-лог): 1) агент ∈ `targetRoom.agent_ids`; 2) ref существует/done/kind ∈ {user, agent, summary} + комната ref доступна агенту; 3) **FR-403**: PRIVATE-источник (комната ref, или текущая комната без ref) не входит в PUBLIC-комнату. Per-item INSERT + транзакционный аудит `project.chat.agent.share` (after: roomId/visibility/agentId/response + per-item провенанс). **Исправлен баг: what-ref default = несущий ответ (`child.id`)** (в первой сборке было `null`; поймано e2e — 3 фейла, юниты runner не покрывают).
- `agent-audit.ts` — `'project.chat.agent.share'` в AGENT_AUDIT_ACTIONS.
- `project-chat.interfaces.ts` / `project-chat.service.ts` — `IProjectChatDetail.shared` (8 последних) + `sharedItems()` в `read()`.
- `deploy/production/retention.json` — запись `project_chat_shared_items` (project-scoped, FK-cascade) — упущение поймано корневой сьют (retention-полнота) и исправлено.

Доказано (2026-11-12):
- `npx vitest run project-chat-share project-chat-shared-context project-chat-sequential project-chat-handover` — **28/28 pass** (парсер: валидные/malformed/≤4/≤8; рендеры: провенанс/хронология/truncation/rooms; регрессия 9.2).
- `node --test scripts/test/shared-context-provenance.test.mjs` — **7/7 pass, exit 0** (self-bootstrap docker postgres:16 + in-process Catalog из dist + scripted fake OpenAI): (1) деление с командой — per-item провенанс в таблице + аудит + видимость в чтении комнаты; (2) личный диалог — элемент с провенансом, команде не опубликован; (3) гейт — агент без доступа: элементы/аудита нет, ответ сохранён; (4) FR-403 — приватный источник (с ref и без) в публичную комнату не входит, аудита нет; (5) следующий агент до вызова видит элементы с провенансом; (6) share+handover в одном ответе — оба исполнены, аудит обоих.
- **Корневой сьют, прогон #1:** 1076 tests, 1072 pass, **1 fail** (retention: полнота — новая таблица вне retention.json), 3 skipped → упущение исправлено (retention-inventory 10/10, prettier чист).
- **Корневой сьют, прогон #2 (после фикса) — ЗЕЛЁНЫЙ (2026-11-12):** `FILES=$(python3 -c "import json;print(' '.join(json.load(open('scripts/workspace/check-tooling-tests.json'))))"); node --test --test-concurrency=1 $FILES` — **1076 tests, 1073 pass, 0 fail, 3 skipped** (exit 0) — без деградации к базе 9.2.
- Prettier всех 9.3-файлов чист (`--check`); dist пересобран после фикса и форматирования (stamp совпадает с src).

Замечание: строки «Catalog compilation failed» в логе сьюта — ожидаемые (dev-watch-daemon-тесты намеренного фэйла).
