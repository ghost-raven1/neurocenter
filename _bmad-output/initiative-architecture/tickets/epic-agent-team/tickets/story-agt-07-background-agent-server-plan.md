---
title: 'FR-305 [P1]: Фоновый агент в opencode-среде на сервере (новый compose-сервис + env-модель + drift)'
type: 'feature'
ticket: '7'
created: '2026-11-09'
status: ready-for-dev
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

**Problem:** FR-305 [P1]: агент запускается в **фоне** (не блокирует чат): задача → работа в полной среде → результат в проектный чат; **работает на сервере**; рабочая среда агента — **opencode** (полная сессия: инструменты, терминал/файлы, скиллы, плагины, MCP); через мост — **настраиваемый доступ к компьютеру** (включая работу с opencode на компьютере); **контекст настраивается**: проект (данные, одобренные знания, каталог), компьютер (через мост), web. Сейчас исполнение agent-method-workflow — **device-сторона**: мост сам запускает OpenCode HTTP-сервер в папке проекта (docs §«Подготовка компьютера»/«Выполнение и результат»: OpenCode 1.14.48, случайный loopback-порт, одноразовый пароль, дерево процессов задания). Сервер (catalog-service) **только** сохраняет методику/версию/задачу/checks в `bridge_jobs` (agent-method-workflows/jobs.ts:35 `agentMethodJobPayload` — версия метода фиксирована сервером `:80` AGENT_METHOD_VERSIONS, deadline 30min `:84`) и авторизует (`assertAgentMethodJob:94`, `assertAgentMethodCompletionAccess:126`). **Серверного фонового агента в opencode-среде НЕТ — большой gap.** Это базис для FR-308 (entry 10) и отказоустойчивости (entry 11).

**Approach:** (1) **Новый compose-сервис** — server background agent в opencode-среде (полная сессия: инструменты/терминал/файлы/скиллы/плагины/MCP) + **environment-model + drift** (паттерн 1.12 D2: новый compose-сервис → environment-model.json + drift-тест + compose-шапка dev/prod). (2) **Фоновый цикл**: задача → фоновая работа в opencode-среде (не блокирует чат) → результат в проектный чат. (3) **Настраиваемый контекст**: проект (данные/одобренные знания/каталог), компьютер (через мост), web. (4) Переиспользуем существующий job-lifecycle (jobs.ts: admission/claim/complete/authorize) и opencode-механику (паттерн device-исполнителя), но исполнение — **на сервере**. Не дублируем device-установщики (эпик 7) и каталог (эпик 2).

## Boundaries & Constraints

**Always:**
- Новый compose-сервис → **environment-model.json** (service, image, networks, mem/cpus/pids, volumes, env) + **drift-тест** (structuralDrift + compose-drift) + **compose-шапка** dev/prod (паттерн 1.12 D2).
- Фоновая работа **не блокирует чат** (асинхронно).
- Результат — в **проектный чат** (с верификацией, entry 6).
- Контекст настраивается: проект / компьютер (через мост) / web.
- Job-lifecycle — паттерн jobs.ts (admission/claim/complete/authorize, immutable payload, версия метода сервером).
- Node 24 (`~/.nvm/versions/node/v24.22.0/bin/node`).

**Never:**
- Не блокировать чат фоном (FR-305 «не блокирует чат»).
- Не дублировать device-установщики/pairing (эпик 7).
- Не дублировать каталог/билеты (эпик 2).
- Не нарушать drift (новый сервис без model = фэйл, паттерн 1.12 D2).
- Не запускать opencode без полной сессии (инструменты/терминал/файлы/скиллы/плагины/MCP).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Задача в фоне | задача на фонового агента | Фоновая работа в opencode-среде, чат не блокируется | — |
| 2 | Результат в чат | работа завершена | Результат в проектном чате (с верификацией, entry 6) | — |
| 3 | Полная opencode-сессия | старт агента | Инструменты/терминал/файлы/скиллы/плагины/MCP доступны | нет компонента → явная ошибка |
| 4 | Контекст: проект | данные/одобренные знания/каталог | Контекст проекта подгружен | — |
| 5 | Контекст: компьютер (мост) | доступ к компьютеру через мост | Настраиваемый доступ (вкл. opencode на компьютере) | нет моста → явная ошибка |
| 6 | Контекст: web | web-контекст | Доступ к web | — |
| 7 | Новый compose-сервис | drift-проверка | environment-model + drift + compose-шапка (1.12 D2) | drift → фэйл |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/agent-method-workflows/jobs.ts` — `agentMethodJobPayload:35` (immutable payload, версия метода сервером `:80` AGENT_METHOD_VERSIONS, deadline 30min `:84`), `assertAgentMethodJob:94` (recheck до claim + каждый poll), `assertAgentMethodResult:110`, `assertAgentMethodCompletionAccess:126` — job-lifecycle (паттерн).
- `services/catalog-service/src/agent-method-workflows/selection.ts` — `captureMethodAgent`/`assertMethodAgent` (selected agent).
- `services/shared/agent-method-workflow.cjs` — `AGENT_METHOD_VERSIONS` (bmad/openspec/combined), `normalizeAgentMethodWorkflowPayload/Result`.
- `mcp/neurocenter-asset-sync/src/features/agent-method-workflow/` (executor.ts, opencode-http-runner.ts, preparation.ts) — **device**-исполнитель (OpenCode HTTP-сервер в папке проекта) — **референс** opencode-механики (порт/пароль/дерево процессов/проверки), но исполнение device — здесь переносим на сервер.
- `services/catalog-service/src/agents/agent-job-compiler.ts` — `compileAgentJob` (model mapping).
- `services/catalog-service/src/agents/agent-jobs.ts` — PROJECT_AGENTS_JOB delivery (паттерн job-доставки).
- `deploy/production/environment-model.json` — модель compose-сервисов (12) — добавить server background agent.
- `deploy/production/compose.production.yml` — compose (паттерн x-service, mem/cpus/pids, non-root).
- `scripts/test/compose-drift.test.mjs` + `scripts/production/environment-model.mjs` (`structuralDrift`, `deadEnvironment`, `requiredEnvironmentDrift`) — drift-тесты (паттерн 1.12 D2).
- `docs/features/agent-method-workflows.md` §«Подготовка компьютера»/«Выполнение и результат» — opencode-среда (1.14.48, loopback-порт, пароль, дерево процессов, проверки argv).
- `services/catalog-service/src/project-chat/project-chat.runner.ts` — публикация результата в проектный чат.

## Tasks & Acceptance

### Execution
- [ ] Новый compose-сервис — server background agent (opencode-среда): image, networks, mem/cpus/pids, volumes, env (non-root, паттерн x-service).
- [ ] **environment-model.json** + **drift-тест** (structuralDrift + compose-drift) + **compose-шапка** dev/prod (паттерн 1.12 D2).
- [ ] Фоновый цикл: задача → фоновая работа в opencode-среде (полная сессия: инструменты/терминал/файлы/скиллы/плагины/MCP) → результат в проектный чат.
- [ ] Не блокирует чат (асинхронно).
- [ ] Настраиваемый контекст: проект (данные/одобренные знания/каталог), компьютер (через мост, вкл. opencode на компьютере), web.
- [ ] Job-lifecycle по паттерну jobs.ts (admission/claim/complete/authorize, immutable payload, версия метода сервером).
- [ ] Tесты: фоновая работа+результат в чат, не блокирует чат, полная opencode-сессия, контекст (проект/мост/web), drift 0.

### Acceptance
- **Given** новый compose-сервис (server background agent) **when** drift-проверка **then** environment-model + drift + compose-шапка зелёные (паттерн 1.12 D2).
- **Given** задача на фонового агента **when** запуск **then** фоновая работа в opencode-среде (полная сессия), чат не блокируется.
- **Given** работа завершена **when** результат **then** в проектном чате (с верификацией, entry 6).
- **Given** настраиваемый контекст **when** выбор (проект/компьютер через мост/web) **then** соответствующий контекст подгружен.
- Корневой сьют — без деградации.

## Design Notes

- **Почему high risk:** новый compose-сервис + opencode-среда на сервере + env-модель/drift — наибольший объём и новый рантайм. Базис (job-lifecycle jobs.ts, opencode-механика device-исполнителя, drift-тесты 1.12 D2) есть — переиспользуем.
- **Сервер vs device:** device-исполнитель (mcp/.../agent-method-workflow) запускает OpenCode HTTP-сервер **на компьютере**; здесь — аналогичная opencode-сессия, но **на сервере** (новый compose-сервис). Механику (loopback-порт, пароль, дерево процессов, проверки argv) переносим, не изобретаем.
- **Паттерн 1.12 D2:** новый compose-сервис обязан иметь environment-model + drift-тест + compose-шапку (прецедент эпика 6 entry 12: prometheus/alertmanager 12→14). Не нарушать.
- **Не дублируем:** device-установщики/pairing (эпик 7), каталог/билеты (эпик 2). «Через мост — настраиваемый доступ к компьютеру» — потребляем мост (эпик 2/7), не строим.
- **Базис для entry 10/11:** фоновый агент (здесь) = рантайм, на который entry 10 наводит BMAD→OpenSpec, а entry 11 добавляет отказоустойчивость.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/compose-drift.test.mjs 2>/dev/null || true
cd services/catalog-service && npm test -- agent-method-workflows agents project-chat
node --test scripts/test/background-agent-server.test.mjs 2>/dev/null || true
```
Ожидаемо: drift 0 (новый сервис в model), фоновая работа в opencode-среде → результат в чат, чат не блокируется, полная сессия, контекст (проект/мост/web); корневой сьют без деградации.

## Open Questions

1. **Один compose-сервис или пул воркеров?** Рекомендация: один сервис (масштабирование через replica, не новый сервис). Обоснование: 1.12 D2 — сервис в модели, масштаб — replica.
2. **Opencode на сервере — тот же образ/версия, что device?** Рекомендация: да, OpenCode 1.14.48 (единая версия, AGENT_METHOD_VERSIONS/доки). Обоснование: совместимость, docs §«Подготовка компьютера».
3. **«Через мост — доступ к компьютеру» — скоуп здесь?** Рекомендация: настроить контекст «компьютер» (вызвать мост/опросить opencode на компьютере), но не строить мост/установщики (эпик 2/7). Обоснование: граница эпиков.
4. **Изоляция фоновых агентов (ресурсы)?** Рекомендация: mem/cpus/pids в compose + model (AD-OP-6, эпик 6). Обоснование: NFR-6/R11.
