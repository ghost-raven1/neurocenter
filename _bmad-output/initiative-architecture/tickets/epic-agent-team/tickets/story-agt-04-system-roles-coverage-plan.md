---
title: 'FR-303: Системные роли — покрытие вопросов системы + владелец следующего действия + сводка после N'
type: 'feature'
ticket: '4'
created: '2026-11-09'
status: done
baseline_revision: '56f8c009cf0c9cb9d18091c5176c36831eb981cd'
route: 'full'
route_source: 'auto'
risk: 'low'
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

**Problem:** FR-303: системные роли покрывают вопросы **самой системы**: настройка (включая **конфигурации на компьютере**), диагностика, модели, мосты, навыки/плагины/MCP, агенты/ассеты, доступы, данные (включая RAG/quirk), очереди, обновление, восстановление; **координатор показывает владельца следующего действия** (агент может вызвать системного агента и напрямую — FR-310/entry 5); **сводка — только после ответов нескольких уникальных агентов**. Сейчас 5 ролей есть (`system-role.definitions.ts:13` — coordinator/packager/indexer/ai-admin/autoconfigurator), budget/вызовы (`roleCallBudget:147`, coordinatorCalls=5 `:136`), сводка в `ProjectChatRunner` (`:198`) — но «после ≥2 агентов», а не «после нескольких **уникальных**». Gap: (1) **покрытие** полного списка вопросов системы ролями (нет «никто не отвечает»), (2) **координатор = владелец следующего действия**, (3) семантика сводки **уникальных** агентов. Не перестраиваем роли (базис есть) — закрываем покрытие + координатор-владелец + семантику сводки.

**Approach:** (1) **Coverage-матрица**: каждый класс вопросов системы → ответственная системная роль (тест-матрица, без «никто не отвечает»); при провале — расширить/дополнить роль или явно задокументировать владельца. (2) **Координатор-владелец**: координатор (agent-coordinator) для каждого следующего действия показывает **владелец** (какой агент/роль/человек) — стык с FR-310/entry 5 (агент может вызвать системного напрямую). (3) **Сводка после N уникальных**: уточнить `ProjectChatRunner:198` — сводка только после ответов **нескольких уникальных** агентов (не повтор одного и того же).

## Boundaries & Constraints

**Always:**
- Каждый класс вопросов системы имеет **ответственную** системную роль (покрытие, без «никто не отвечает»).
- Координатор показывает **владельца следующего действия**.
- Сводка — только после ответов **нескольких уникальных** агентов.
- Бюджет вызовов (`roleCallBudget:147`, coordinatorCalls=5) — fail-closed (NFR-6).

**Never:**
- Не перестраивать 5 ролей с нуля (базис `system-role.definitions.ts:13` есть).
- Не дублировать явный вызов системной роли агентом (FR-310/entry 5) — здесь только «показать владельца».
- Не превышать бюджет вызовов (fail-closed).
- Не делать сводку после 1 агента / повтора того же.

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Покрытие: вопрос системы | вопрос (настройка/диагностика/модели/мосты/навыки/агенты/доступы/данные RAG/очереди/обновление/восстановление) | Назначена ответственная роль | «никто не отвечает» → фэйл |
| 2 | Настройка на компьютере | вопрос конфигурации на компьютере | Ответственная роль (autoconfigurator/ai-admin) | — |
| 3 | Координатор-владелец | следующее действие | Координатор показывает владельца (агент/роль/человек) | — |
| 4 | Сводка: 1 агент | 1 ответ | Нет сводки | — |
| 5 | Сводка: несколько уникальных | ответы N уникальных агентов | Сводка | — |
| 6 | Сводка: повтор того же | 2 ответа одного агента | Нет сводки (не уникальные) | — |
| 7 | Бюджет координатора | > coordinatorCalls (5) | Отказ (fail-closed) | NFR-6 |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/system-roles/system-role.definitions.ts` — `SYSTEM_ROLE_DEFINITIONS:13` (5 ролей: `agent-coordinator:15`, `agent-packager:36`, `agent-indexer:48`, `agent-ai-admin:59`, `agent-autoconfigurator:70`), `roleHash:96`, `ROLE_RAG_POLICY:101`, `ROLE_GUIDANCE_POLICY:108`, `roleDefinitionPin:115`, `ROLE_BUDGET:134` (coordinatorCalls=5 `:136`), `roleCallBudget:147`.
- `services/catalog-service/src/system-roles/system-role.coordinator.ts` + `system-role.coordinator.schema.ts` — координатор (точка «владелец следующего действия»).
- `services/catalog-service/src/system-roles/system-role.runner.ts` + `system-role.service.ts` — исполнение ролей.
- `services/catalog-service/src/system-roles/system-role.rag-context.ts` + `system-role.diagnostics.ts` + `system-role.operations.ts` — контекст/диагностика/операции ролей (покрытие).
- `services/catalog-service/src/project-chat/project-chat.runner.ts` — `:198` сводка (`projectChatSummary`) — уточнить «уникальные».
- `services/catalog-service/src/system-role-mcp/system-role-mcp.controller.ts` — execute/close (вызов, proof, state) — потребляем (явный вызов агентом — entry 5).

## Tasks & Acceptance

### Execution
- [ ] Coverage-матрица: каждый класс вопросов системы (настройка/конфиг на компьютере, диагностика, модели, мосты, навыки/плагины/MCP, агенты/ассеты, доступы, данные RAG/quirk, очереди, обновление, восстановление) → ответственная роль (тест-матрица, без «никто не отвечает»).
- [ ] При провале покрытия — расширить/дополнить роль или явно задокументировать владельца.
- [ ] Координатор показывает **владельца следующего действия** (agent/роль/человек).
- [ ] Сводка — только после ответов **нескольких уникальных** агентов (уточнить `project-chat.runner.ts:198`).
- [ ] Бюджет вызовов (roleCallBudget, coordinatorCalls=5) — fail-closed.
- [ ] Тесты: coverage-матрица, координатор-владелец, сводка (1/уникальные/повтор), бюджет.

### Acceptance
- **Given** любой класс вопросов системы **when** запрос **then** назначена ответственная роль (тест-матрица, без «никто не отвечает»).
- **Given** координатор **when** следующее действие **then** показывает владельца (агент/роль/человек).
- **Given** 1 агент / повтор того же **when** сводка **then** нет сводки.
- **Given** несколько **уникальных** агентов **when** сводка **then** сводка есть.
- **Given** > coordinatorCalls (5) **when** вызов **then** отказ (fail-closed, NFR-6).
- Корневой сьют — без деградации.

## Design Notes

- **Почему low risk:** базис ролей есть (5 ролей, budget, runner, mcp). Задача — coverage-матрица + координатор-владелец + уточнение семантики сводки, а не перестройка.
- **Граница с entry 5:** здесь координатор **показывает владельца** следующего действия; **явный вызов** системной роли агентом (problem/уточнение + recovery) — entry 5 (FR-310). Не дублируем.
- **Сводка «уникальных»:** сейчас `≥2 агентов` (`project-chat.runner.ts:198`); FR-303 — «несколько **уникальных**». Уточнение: уникальность по agent-id (повтор одного не считает).
- **Конфигурации на компьютере:** FR-303 явно называет «настройка (включая конфигурации на компьютере)» — это autoconfigurator/ai-admin + мост (эпик 7, не дублируем устройство).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- system-roles project-chat
node --test scripts/test/system-roles-coverage.test.mjs 2>/dev/null || true
```
Ожидаемо: coverage-матрица (вопрос→роль, без «никто не отвечает»), координатор-владелец, сводка (1/уникальные/повтор), бюджет fail-closed; корневой сьют без деградации.

## Open Questions

1. **Как фиксировать coverage-матрицу?** Рекомендация: data-driven тест-матрица (вопрос→роль) как единый источник (паттерн RUNTIME_LIMIT_CEILINGS, эпик 6 entry 4). Обоснование: новые классы вопросов подхватываются автоматически.
2. **«Несколько уникальных» — порог N?** Рекомендация: N≥2 уникальных (совместимо с текущим ≥2, но по уникальности). Обоснование: FR-303 «несколько уникальных», не «один».
3. **Координатор-владелец — новое поле или guidance?** Рекомендация: расширение guidance координатора (roleDefinitionPin/guidance). Обоснование: не новая сущность, а вывод координатора.

## Progress (2026-11-12, done)

Реализация завершена; идёт корневой сьют. Решил Open Questions: (1) coverage-матрица — data-driven файл `system-role.coverage.ts` как единый источник + структурные тесты; (2) порог сводки — N≥2 **уникальных** (по agent-id); (3) координатор-владелец — расширение guidance координатора (prompt → pin меняется по дизайну, old-консенты инвалидированы намеренно).

**Код (catalog-service):**
- `src/system-roles/system-role.coverage.ts` (new) — coverage-матрица FR-303: 11 классов вопросов системы (настройка/конфиг на компьютере, диагностика, модели, мосты, навыки/плагины/MCP, агенты/ассеты, доступы, данные RAG/quirk, очереди, обновление, восстановление) → ответственные роли с **структурным обоснованием** (target/diagnostic, реально существующие в определениях). Доступы/очереди — задокументированные владельцы (agent-ai-admin, measurement `project` + adapter), без изменения ролей.
- `src/system-roles/system-role.definitions.ts` — промпт координатора: «Для каждого пункта nextSteps укажи владельца следующего действия: системная роль (точный ID), агент проекта или человек» (guidance; общий `contract` 5 ролей не тронут; pin координатора сместился — expected, old-консенты по дизайну инвалидированы).
- Сводка (`projectChatSummary`, runner:41) — **код менять не потребовалось**: дедупликация по agent-id (Map) уже реализована, «≥2» считается по уникальным; зафиксировано тестами.
- Бюджет (roleCallBudget/coordinatorCalls=5) — fail-closed уже в repository.ts:176, runner.ts:415 и DB CHECK (schema.ts:34); зафиксировано тестами констант.

**Тесты (new):**
- `src/system-roles/tests/system-role-coverage.test.ts` — полнота матрицы (все 11 классов, ≥1 владельца, все владельцы существуют), структурное обоснование каждого владельца (target ∈ role.targets / diagnostic ∈ role.diagnostics), координатор-владелец (prompt-лока, только у координатора, pin ≠ previous), бюджет (coordinatorCalls=5/calls=2/fanout=3/depth=1, roleCallBudget 5+MCP/2).
- `src/project-chat/tests/project-chat-summary.test.ts` — сводка: 0/1 агент → ''; повтор одного агента (2 done) → ''; 2 уникальных → сводка с обеими вкладами и ссылками; failed/running игнорируются; truncation 4000.

Доказано (2026-11-12):
- Новые тесты: **13/13 pass**; полный vitest каталога: **199/199 pass (26 файлов)** — смена пина координатора без регрессий.
- Prettier всех 9.4-файлов чист; dist пересобран (stamp fd771234… совпадает с src).
- **Корневой сьют — ЗЕЛЁНЫЙ (2026-11-12):** `FILES=$(python3 -c "import json;print(' '.join(json.load(open('scripts/workspace/check-tooling-tests.json'))))"); node --test --test-concurrency=1 $FILES` — **1076 tests, 1073 pass, 0 fail, 3 skipped** (exit 0) — без деградации к базе 9.3.
