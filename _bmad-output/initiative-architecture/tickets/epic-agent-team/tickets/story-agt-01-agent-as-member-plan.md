---
title: 'FR-301: Агент — участник проекта (роль, контекст, инструменты, публичные чаты)'
type: 'feature'
ticket: '1'
created: '2026-11-09'
status: ready-for-dev
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
- [ ] Регресс: ProjectChatRunner/AgentToolsLoop без деградации.
- [ ] Семантический поиск (FR-311) — только доступность инструмента (реализация — epic-project entry 13/14).

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

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- agents project-chat project-chat-inference agent-tools
node --test scripts/test/agent-as-member-e2e.test.mjs 2>/dev/null || true
```
Ожидаемо: e2e (2+ агента server+device в pубличном чате, роль/контекст/инструменты/доступ), контекст=approved, инструмент вне каталога → отказ, device через мост; корневой сьют без деградации.

## Open Questions

1. **Сколько агентов в e2e-фикстуре?** Рекомендация: минимум 2 (1 server + 1 device) для доказательства двух типов; больше — опционально. Обоснование: FR-301 требует именно два типа.
2. **Включать ли в e2e уже реализованный семантический поиск (FR-311)?** Рекомендация: только доступность инструмента (реализация корпусов — epic-project entry 13/14). Обоснование: не дублируем эпик 8.
3. **Где хранить e2e-фикстуру?** Рекомендация: `scripts/test/agent-as-member-e2e.*` (паттерн production-stack.mjs). Обоснование: единый harness-паттерн.
