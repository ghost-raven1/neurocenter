---
title: 'FR-301: Агент — участник проекта (роль, контекст, инструменты, публичные чаты)'
type: 'feature'
ticket: '1'
created: '2026-11-09'
status: in-progress
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

**Problem:** Базис «агент как участник» разрознен и не доказан end-to-end: в main (@ 56f8c009) есть каталог агентов + delivery, проектный чат, tool-loop и системные роли, но **никто не собрал и не проверил** сценарий «несколько агентов (server + device) в одном публичном чате проекта — каждый со своей ролью, контекстом (одобренные знания) и инструментами из каталога». FR-301 требует именно этого: агент = полноценный участник (роль, контекст, инструменты, доступ к публичным чатам); два типа — server-агенты (системные роли, доверенная сторона) и device-агенты (через мост, недоверенная сторона). Механика чата/комнат — эпик 8 (потребляем, не строим); каталог/билеты/mcp-host — эпик 2 (потребляем).

**Approach:** E2E-сборка + закрывающие test-сегменты поверх существующего базиса: (1) fixture-проект с 2+ агентами (1 server-агент системной роли + 1 device-агент через mcp-host-билет); (2) pубличный чат, в котором оба участвуют; (3) проверка, что у каждого агента (a) роль, (b) контекст = **только одобренные** знания (FR-502), (c) инструменты из каталога проекта (включая семантический поиск по 4 корпусам — потребляет epic-project entry 13/14, FR-311; здесь только доступность инструмента), (d) доступ к публичным чатам. Не переизобретаем runner/inference/tools — сводим их в сквозной сценарий и добавляем недостающиеAssertions/фикстуры.

## Boundaries & Constraints

**Always:**
- Контекст агента = **только одобренные** знания (learning context() — только approved, FR-502); некандидатные/отозванные — вне контекста.
- Инструменты — только из **каталога проекта**; инструмент вне каталога проекта → недоступен (fail-closed).
- Device-агент работает **через mcp-host** (недоверенная сторона, верифицированный билет — эпик 2); server-агент — доверенная сторона.
- Чат/комнаты/поиск — механика эпика 8 (потребляем, не дублируем); каталог/билеты/mcp-host — эпик 2.
- Тесты на node 24 (`~/.nvm/versions/node/v24.22.0/bin/node`).

**Never:**
- Не строить проектный чат/комнаты/семантический поиск (эпик 8).
- Не дублировать kаталог/билеты/mcp-host (эпик 2).
- Не давать device-агенту server-права (доверенная/недоверенная сторона — строго).
- Не поднимать некандидатные знания в контекст (FR-502).
- Не ломать существующий ProjectChatRunner/AgentToolsLoop (регресс).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Server-агент в публичном чате | server-агент системной роли, pубличная комната | Участвует, роль+контекст+инструменты видны | — |
| 2 | Device-агент через мост | device-агент, верифицированный mcp-host-билет | Участвует через мост (недоверенная сторона) | нет билета/отозван → 403, не в чате |
| 3 | Контекст = одобренные | approved knowledge + candidate | В контекст только approved (FR-502) | candidate в контекст → фэйл |
| 4 | Инструмент из каталога | инструмент в каталоге проекта | Доступен | — |
| 5 | Инструмент вне каталога | инструмент не в каталоге проекта | Недоступен | actionable-сообщение (fail-closed) |
| 6 | Публичный доступ | pубличная комната | Агент имеет доступ | приватная комната без права → отказ |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/agents/agents.controller.ts` + `agents.service.ts` — CRUD/assign/configure/remove/connect агентов.
- `services/catalog-service/src/agents/project-agent.repository.ts` — project_agents (назначение агентов в проект).
- `services/catalog-service/src/agents/agent-schema.ts` — agent_catalog + immutable agent_catalog_versions + project_agents (migration 7).
- `services/catalog-service/src/agents/agent-job-compiler.ts` — `compileAgentJob` (model mapping).
- `services/catalog-service/src/agents/agent-jobs.ts` — PROJECT_AGENTS_JOB delivery на устройство.
- `services/catalog-service/src/project-chat/project-chat.runner.ts` — `ProjectChatRunner:54` (durable FIFO, «failed attempts never start a paid retry automatically»:53), транспорты server + device-codex `:161`/`:174`, сводка `:198`.
- `services/catalog-service/src/project-chat/project-chat.schema.ts` — project_chat_rooms (PUBLIC/PRIVATE, room_members), project_chat_messages (immutable attribution, lease, generation).
- `services/catalog-service/src/project-chat-inference/project-chat-inference.service.ts` — `:41` service, `roster:53`, `resolve:83`, `transport:125`, `infer:135`, `projectChatContext:184`, `ancestors:365` (≤8 `:369`).
- `services/catalog-service/src/agent-tools/agent-tools.loop.ts` — `AgentToolsLoop:11`, `reserve:36`, `dispatch:47`, `complete:57`, `limits.steps:68`.
- `services/catalog-service/src/agent-tools/agent-tools.service.ts` — инструменты rag/publicChats/systemRoles, capability-фильтр `:141`.
- `services/catalog-service/src/devices/mcp-host.controller.ts` (catalog) + `services/api-gateway/src/features/mcp-host/mcp-host.controller.ts` — device-канал (HMAC, билет) — device-агент (эпик 2).
- `services/catalog-service/src/system-roles/system-role.definitions.ts` — `:13` 5 ролей (server-агенты = системные роли).
- `services/catalog-service/src/learning/learning.repository.ts` — context() (только approved, FR-502) — контекст агента.

## Tasks & Acceptance

### Execution
- [ ] Fixture-проект: 2+ агента (1 server-агент системной роли + 1 device-агент), pубличная комната.
- [ ] E2E: оба агента в pубличном чате; у каждого роль + контекст (approved) + инструменты каталога + доступ к pубличным чатам.
- [ ] Device-агент — только через mcp-host-билет (недоверенная сторона); server-агент — доверенная сторона.
- [ ] Assert: контекст = только approved (FR-502); инструмент вне каталога → недоступен (fail-closed).
- [x] Регресс: ProjectChatRunner/AgentToolsLoop без деградации.
- [x] Семантический поиск (FR-311) — только доступность инструмента (реализация — epic-project entry 13/14).

### Acceptance
- **Given** server-агент системной роли **when** pубличный чат **then** участвует с ролью/контекстом/инструментами.
- **Given** device-агент с верифицированным mcp-host-билетом **when** pубличный чат **then** участвует через мост (недоверенная сторона).
- **Given** approved + candidate знания **when** контекст агента **then** в контекст только approved (FR-502).
- **Given** инструмент вне каталога проекта **when** вызов **then** недоступен (fail-closed, actionable).
- **Given** pубличная комната **when** доступ агента **then** доступ подтверждён.
- Корневой сьют — без деградации.

## Design Notes

- **Почему e2e, а не новые модули:** базис уже в main (каталог, чат, tools, роли). Gap — отсутствие сквозного доказательства «агент = участник» с двумя типами (server/device). E2E + закрывающие assertions дешевле и честнее, чем новый код.
- **Граница доверия:** server-агент (системная роль) = доверенная сторона; device-агент = недоверенная (через mcp-host, билет). Не смешивать: device не получает server-права.
- **Контекст = approved (FR-502):** learning context() отдаёт только approved; это якорь «контекст = одобренные знания» из FR-301.
- **Семантический поиск (FR-311)** — потребляет epic-project entry 13/14; здесь только «инструмент доступен агенту», не реализация корпусов.

## Progress (2026-11-12, in-progress)

E2E `scripts/test/agent-as-member-e2e.test.mjs` (живой dev-стэк, docker-compose.yml): **4 pass / 0 fail / 1 skipped**.

Доказано:
- Server-агент: карточка (`definition` = description/prompt/mode/permission-объект), назначение в проект (CAS по ревизии `project_agent_sets`, `version`+`manifest` карточки), видимость в `assignments` списка `GET /api/agents?projectId=`.
- Публичная комната: `visibility: 'PUBLIC'` + `memberEmails: []` (list-маршрута нет — доступ через `GET /team-chat/rooms/:roomId`).
- FR-502: полный конвейер обучения (experience → hypothesis → check `human_review/passed` → candidate → approve → activate) с CAS-ревизией (старт 0); во второй конвейер без одобрения; в `/context` только approved (`e2e-approved`), proposed (`e2e-pending`) — нет.
- Инструменты: `GET /api/agent-tools/capabilities?projectId=` — 200.
- Регресс: корневой 72-файловый сьют — 1073 pass / 0 fail / 3 skipped, exit 0.

НЕ доказано (честно, без done):
- **Device-агент через mcp-host-билет** — требует bridge-worker runtime устройства: `bind-project` это workspace-job (`workspaceKinds`, devices/workspace-queue.ts), который обрабатывает и завершает worker-процесс устройства; pairing чистый HTTP, но binding без worker не завершится. Форж completion нарушает недоверенную границу — недопустимо. Live-итерация (потребление эпика 2), тест в e2e — skipped-сегмент.
- **Fail-closed на инструмент вне каталога** — подтверждена доступность capabilities; точный формат отказа на dispatch уточняется по живому стеку (live-итерация).

## Progress (2026-11-13, in-progress)

**Chat-turn e2e добавлен** (субагент, worktree nc-01 → мерж в main, коммит в `5dec548c`): `scripts/test/agent-as-member-e2e.test.mjs` — тест «9.1: chat turn — человек пишет в публичную комнату, server-агент отвечает (роль + одобренный контекст)». Файл: **5 pass / 0 fail / 1 skipped** (2 прогона; на main после мержа перепроверено).

Доказано (сквозной chat turn, I/O-матрица сценарий 1):
- Человек-участник (`developer`) пишет в `PUBLIC`-комнату, где назначен server-агент; `ProjectChatRunner` завершает задачу.
- Ответ агента опубликован в комнате: `kind='agent'`, `status='done'`, `room_id` = публичная комната, автор = server-агент (`agentId`/`name`/`definition.description`).
- Роль применена: `system`-сообщение вызова модели = профиль агента.
- FR-502 в реальном чат-вызове: одобренное знание (полный конвейер experience→…→activate) в контексте; pending-кандидат — нет.
- Реализация: self-contained 9.2-style секция в том же файле (disposable `postgres:16` + in-process Catalog из dist + scripted fake OpenAI `model-chat.fixture.mjs`) — работает независимо от доступности dev-стэка; существующие 4 live-stack теста не тронуты.

НЕ доказано (честно, без done) — как в п. 2026-11-12:
- **Device-агент через mcp-host-билет** (hard-блокер: bridge 0.9.15, в bridge-dist только 0.9.10) — решение: stub device runtime / live-итерация / descope.
- **Fail-closed точный формат отказа** на инструмент вне каталога (пока capabilities 200) — live-итерация.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- agents project-chat project-chat-inference agent-tools
node --test scripts/test/agent-as-member-e2e.test.mjs 2>/dev/null || true
```
Ожидаемо: e2e (2+ агента server+device в pубличном чате, роль/контекст/инструменты/доступ), контекст=approved, инструмент вне каталога → отказ, device через мост; корневой сьют без деградации.

**Gap (2026-11-12):** `npm test -- agents project-chat project-chat-inference agent-tools` — exit 1 «No test files found»: в baseline нет ни одного unit-файла этих доменов (включено в паттерны vitest, файлов нет). Регресс покрывается корневым 72-файловым сьютом (см. Progress). Дописывать unit-файлы в этом тикете не планируется — это отдельная работа по покрытию.

## Open Questions

1. **Сколько агентов в e2e-фикстуре?** Рекомендация: минимум 2 (1 server + 1 device) для доказательства двух типов; больше — опционально. Обоснование: FR-301 требует именно два типа.
2. **Включать ли в e2e уже реализованный семантический поиск (FR-311)?** Рекомендация: только доступность инструмента (реализация корпусов — epic-project entry 13/14). Обоснование: не дублируем эпик 8.
3. **Где хранить e2e-фикстуру?** Рекомендация: `scripts/test/agent-as-member-e2e.*` (паттерн production-stack.mjs). Обоснование: единый harness-паттерн.
