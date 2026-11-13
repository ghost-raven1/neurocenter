---
title: 'FR-308 [P1]: BMAD → OpenSpec в основном рантайме (закреплённые версии, без скрытых обновлений) + C5-протокол'
type: 'feature'
ticket: '10'
created: '2026-11-09'
status: in-progress
baseline_revision: '56f8c009cf0c9cb9d18091c5176c36831eb981cd'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-agent-team/epic-agent-team.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md
  - _bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/tickets/tickets.toml
  - _bmad-output/initiative-architecture/tickets/epic-project/tickets/tickets.toml
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-308 [P1]: работа **всех исполняющих агентов** (агент-команда FR-302/entry 2 + фоновый агент FR-305/entry 7) ведётся через методику **BMAD + OpenSpec**: **закреплённые версии, скрытых обновлений и установки при отправке задачи нет**. Обязательный режим для агент-команды — **BMAD → OpenSpec**: BMAD формирует или переиспользует brief/PRD/архитектуру, OpenSpec ведёт **единственную** реализацию с проверками; **принятые документы переиспользуются, второй PRD и второй build-цикл не создаются**. Устройство (личный агент, FR-701) — вне мандата. Фича: `docs/features/agent-method-workflows.md`. Сейчас BMAD→OpenSpec существует на **device** (мост запускает свой OpenCode; AGENT_METHOD_VERSIONS={bmad:6.12.4, openspec:1.15.0, combined} в services/shared/agent-method-workflow.cjs; OpenCode 1.14.48); сервер фиксирует версию метода в payload (jobs.ts:80). **Основной рантайм (сервер) — gap** (device-путь есть). C5 (R5) = «реальный проект проведён агент-командой end-to-end через BMAD→OpenSpec с провенансом». Эта история вводит **main-runtime** путь BMAD→OpenSpec (фоновый агент entry 7 работает через методику с pinned-версиями) + **C5-протокол** (какой проект / какая BMAD-инициатива / pinned-версии / что = «принято»).

**Approach:** (1) **Main-runtime BMAD→OpenSpec**: фоновый агент (entry 7, сервер) работает через BMAD→OpenSpec — **закреплённые версии** (bmad-6.12.4 + openspec-1.15.0), **скрытых обновлений/установки при отправке задачи нет**; обязательный режим BMAD→OpenSpec (BMAD формирует/переиспользует brief/PRD/архитектуру, OpenSpec — единственная реализация с проверками; принятые документы переиспользуются, второй PRD/build-цикл не создаются). (2) **C5-протокол**: зафиксировать — какой проект, какая BMAD-инициатива, pinned-версии (bmad-6.12.4+openspec-1.15.0), что = «принято». Переиспользуем AGENT_METHOD_VERSIONS + device-исполнение (patтерн) + jobs.ts (версия сервером), не дублируем устройство (эпик 7).

## Boundaries & Constraints

**Always:**
- **Закреплённые версии**: bmad-6.12.4 + openspec-1.15.0 (AGENT_METHOD_VERSIONS), OpenCode 1.14.48.
- **Скрытых обновлений/установки при отправке задачи нет** (исполнитель ничего не скачивает и не запускает установщик автоматически).
- Обязательный режим — **BMAD → OpenSpec** (BMAD: brief/PRD/архитектура; OpenSpec: единственная реализация с проверками).
- **Принятые документы переиспользуются; второй PRD и второй build-цикл не создаются.**
- Версия метода фиксируется **сервером** (jobs.ts:80), не runtime-instruction.
- **C5-протокол** задокументирован (какой проект / BMAD-инициатива / pinned-версии / что = «принято»).
- Устройство (личный агент, FR-701) — вне мандата (эпик 7).

**Never:**
- Не скачивать/устанавливать методику при отправке задачи (скрытые обновления запрещены).
- Не запускать второй BMAD build-цикл / второй PRD (переиспользовать принятые).
- Не отходить от pinned-версий (бьёшь иную версию → явная ошибка, не тихая подстановка).
- Не дублировать device-установщики/pairing (эпик 7).
- Не создавать второй root OpenSpec / внешний store (docs §«Подготовка компьютера»).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Main-runtime BMAD→OpenSpec | фоновый агент (entry 7) + задача | Работа через BMAD→OpenSpec (e2e) | — |
| 2 | Pinned-версии | старт | bmad-6.12.4 + openspec-1.15.0; без скрытых обновлений/установки | иная версия → явная ошибка |
| 3 | BMAD формирует/переиспользует | нет brief/PRD/архитектуры | BMAD формирует; есть — переиспользует | — |
| 4 | OpenSpec — единственная реализация | после BMAD | Одна реализация с проверками | второй build-цикл → фэйл |
| 5 | Переиспользование принятых | принятые документы BMAD | Переиспользуются; нет 2-го PRD/build-цикла | дубль → фэйл |
| 6 | C5-протокол | приёмка | Какой проект/BMAD-инициатива/pinned-версии/что=«принято» задокументировано | — |
| 7 | Проверки (OpenSpec) | `openspec validate --all --strict --no-interactive` | Пройдено | не пройдено → failed |

</frozen-after-approval>

## Code Map

- `services/shared/agent-method-workflow.cjs` — `AGENT_METHOD_VERSIONS` (bmad:6.12.4, openspec:1.15.0, combined) — **pinned-версии** (единый источник).
- `services/catalog-service/src/agent-method-workflows/jobs.ts` — `agentMethodJobPayload:35` (метод/версия/checks, версия сервером `:80`), `assertAgentMethodJob:94`, `assertAgentMethodResult:110` — server-фиксация версии метода.
- `mcp/neurocenter-asset-sync/src/features/agent-method-workflow/executor.ts` + `opencode-http-runner.ts` + `preparation.ts` — **device**-исполнитель (OpenCode HTTP-сервер, BMAD/OpenSpec-проверки, `openspec validate --all --strict --no-interactive`) — **референс** механики (переиспользуем на main-runtime).
- `docs/features/agent-method-workflows.md` — §«Подготовка компьютера» (BMAD 6.12.4 / OpenSpec 1.15.0 / BMAD→OpenSpec combined, skills, needs_setup), §«Выполнение и результат» (проверки, exit code, succeeded), §«Отмена и восстановление» — эталон методики.
- `openspec/` (корень репо) — само репо разрабатывается через OpenSpec (пример).
- `_bmad-output/` (корень репо) — BMAD-инициатива (пример BMAD-инициативы).
- `services/catalog-service/src/agent-method-workflows/selection.ts` — `captureMethodAgent`/`assertMethodAgent` (selected agent в main-runtime).
- `services/catalog-service/src/project-chat/project-chat.runner.ts` — публикация результата в проектный чат (C5-артефакты).

## Tasks & Acceptance

### Execution
- [ ] **Main-runtime BMAD→OpenSpec**: фоновый агент (entry 7, сервер) работает через BMAD→OpenSpec (e2e).
- [ ] **Pinned-версии**: bmad-6.12.4 + openspec-1.15.0 (AGENT_METHOD_VERSIONS), OpenCode 1.14.48; **скрытых обновлений/установки при отправке задачи нет** (проверка версий на старте, auto-update/установка запрещены).
- [ ] Обязательный режим **BMAD → OpenSpec**: BMAD формирует/переиспользует brief/PRD/архитектуру, OpenSpec — единственная реализация с проверками.
- [ ] **Принятые документы переиспользуются; второй PRD и второй build-цикл не создаются.**
- [ ] **C5-протокол**: задокументировать — какой проект / какая BMAD-инициатива / pinned-версии (bmad-6.12.4+openspec-1.15.0) / что = «принято».
- [ ] Tесты: main-runtime BMAD→OpenSpec (e2e), pinned-версии (без скрытых обновлений), BMAD→OpenSpec (переиспользование, без 2-го PRD/build), C5-протокол.

### Acceptance
- **Given** фоновый агент (main-runtime) **when** задача **then** работает через BMAD→OpenSpec (e2e).
- **Given** старт **when** версии **then** bmad-6.12.4 + openspec-1.15.0, без скрытых обновлений/установки при отправке задачи (иная версия → явная ошибка).
- **Given** BMAD→OpenSpec **when** brief/PRD/архитектура **then** BMAD формирует/переиспользует, OpenSpec — единственная реализация с проверками.
- **Given** принятые документы **when** цикл **then** переиспользуются; нет 2-го PRD и 2-го build-цикла.
- **Given** C5-протокол **when** приёмка **then** задокументировано: какой проект / BMAD-инициатива / pinned-версии / что = «принято».
- Корневой сьют — без деградации.

## Design Notes

- **Почему high risk:** main-runtime (сервер) BMAD→OpenSpec — новый рантайм пути (device есть, server — gap); pinned-версии + «без скрытых обновлений» — строгий контракт.
- **Main-runtime vs device:** device-исполнитель (mcp/.../agent-method-workflow) запускает OpenCode **на компьютере** и проверяет BMAD/OpenSpec. Здесь — та же методика/версии/проверки, но исполнение **на сервере** (фоновый агент entry 7). Механику (BMAD 6.12.4 / OpenSpec 1.15.0 / `openspec validate --all --strict --no-interactive` / skills / needs_setup) переиспользуем.
- **Pinned-версии = AGENT_METHOD_VERSIONS:** единый источник (services/shared/agent-method-workflow.cjs). «Скрытых обновлений/установки нет» — исполнитель ничего не скачивает (docs §«Подготовка компьютера»: «Исполнитель ничего не скачивает и автоматически не запускает установщик»).
- **BMAD→OpenSpec combined:** «закреплённая комбинация bmad-6.12.4+openspec-1.15.0; требуются обе методики и их проектные корни. BMAD используется для недостающих brief/PRD/архитектуры, затем одна реализация через OpenSpec. Принятые документы BMAD переиспользуются; второй BMAD build-цикл не запускается» (docs).
- **C5-протокол:** фиксируем конкретный проект + BMAD-инициативу + pinned-версии + критерий «принято» — это вход для e2e-приёмки (entry 12, HITL).

## Progress (2026-11-13, in-progress)

**Ядро main-runtime (фаза без e2e) — готово, unit 37/37 green (28 Phase A agt-07 + 9 agt-10), tsc 0 новых ошибок:**
- `services/catalog-service/src/background-agent/method-preparation.ts` — server-порт device-`prepareMethod` (механика `mcp/neurocenter-asset-sync/.../agent-method-workflow/preparation.ts`): pinned-версии из единого источника `AGENT_METHOD_VERSIONS` (BMAD 6.12.4 / OpenSpec 1.15.0 / OpenCode 1.14.48), mismatch → явная именованная ошибка `MainMethodPreparationError` (RUNTIME_MISSING / METHOD_MISSING / METHOD_VERSION / PROJECT_NOT_INITIALIZED / METHOD_WORKFLOW_MISSING / CHECKS_REQUIRED / OBSERVATION_LIMIT). BMAD: manifest `installation.version` + `render_skill.py` + `uv`; OpenSpec: `openspec/config.yaml` + `context --json` / `list --json`.
- «Без скрытых обновлений»: `mainMethodEnvironment()` — OPENSPEC_TELEMETRY=0, OPENSPEC_NO_UPDATE_CHECK=1, OPENCODE_CONFIG_CONTENT {autoupdate:false, share:'disabled', permission.external_directory:'deny'}. При отправке задачи исполнитель ничего не скачивает.
- `buildMainMethodPrompt` — combined-промпт BMAD→OpenSpec: BMAD только для недостающих planning-стадий, переиспользование accepted brief/PRD/architecture, без build-auto/2-го цикла, один OpenSpec-цикл (propose/apply/verify/archive), `openspec validate --all --strict --no-interactive` после изменений. Skills подгружаются из `.opencode/skills`/`.agents/skills` (device parity: `requiredSkills`).
- Шов `TMainMethodRunner` (инжект исполнителя команд): production — реальные pinned CLIs, тесты — stub'ы вывода.
- **C5-протокол задокументирован** в `docs/features/agent-method-workflows.md` §«C5-протокол (main-runtime)»: какой проект (реальный пилотный, не toy — фиксация в e2e-приёмке HITL), какая BMAD-инициатива (реальная, в корне проекта), pinned-версии (единый источник `AGENT_METHOD_VERSIONS`, версия сервером), что = «принято» (принятые planning-документы + OpenSpec change `all_done`/архив + `openspec validate --all --strict --no-interactive` + нулевые exit объявленных проверок + провенанс).

**Остаток (деферируется до Фазы B agt-07 = compose-сервис + environment-model, табло 11.1):**
- Wiring: `prepareMainMethod` в `OpenCodeAgentRuntime` (method='combined' → prepared prompt/env/validate вместо generic), e2e `scripts/test/bmad-openspec-main-runtime.test.mjs` (owned-PG + fixture-проект с pinned BMAD/OpenSpec).
- Open Questions 1–4: решение зафиксировано в §C5-протокол (проект/инициатива — в e2e-приёмке; «принято» = PASS-критерии docs; OpenCode 1.14.48 единая версия, запуск на сервере).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- agent-method-workflows
node --test scripts/test/bmad-openspec-main-runtime.test.mjs 2>/dev/null || true
# Pinned-версии (static):
grep -n "bmad.*6.12.4\|openspec.*1.15.0" services/shared/agent-method-workflow.cjs
```
Ожидаемо: main-runtime BMAD→OpenSpec (e2e), pinned-версии bmad-6.12.4+openspec-1.15.0 (без скрытых обновлений), BMAD→OpenSpec (переиспользование, без 2-го PRD/build), C5-протокол задокументирован; корневой сьют без деградации.

## Open Questions

1. **Какой проект для C5-протокола?** Рекомендация: реальный пилотный проект (не toy) — фиксировать в C5-протоколе при e2e (entry 12). Обоснование: C5 = «реальный проект».
2. **Какая BMAD-инициатива?** Рекомендация: реальная BMAD-инициатива пилотного проекта (как `_bmad-output/` в репо). Обоснование: переиспользование принятых документов.
3. **«Что = принято» — критерий?** Рекомендация: принятые документы BMAD (brief/PRD/архитектура) + OpenSpec change с `all_done` + успешные проверки (`openspec validate --all --strict --no-interactive`) + провенанс. Обоснование: docs §«Выполнение и результат» (PASS-критерии).
4. **Main-runtime — тот же OpenCode-сервер, что device?** Рекомендация: да, OpenCode 1.14.48 (единая версия), но запуск на сервере (entry 7). Обоснование: совместимость + docs.
