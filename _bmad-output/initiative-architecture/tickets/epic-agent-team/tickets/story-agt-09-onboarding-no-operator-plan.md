---
title: 'FR-307 [P1]: Onboarding агента без оператора — первая полезная операция за минуты (C2)'
type: 'feature'
ticket: '9'
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

**Problem:** FR-307 [P1]: добавление агента в проект **без оператора**: роль, контекст (одобренные знания), инструменты из каталога, доступ к публичным чатам; **первая полезная операция — за минуты** (C2). R2 = «новый участник (человек или агент) самонастраивается и начинает работать за минуты без оператора»; counter — «onboarding с вмешательством оператора». Сейчас: agents-модуль CRUD + assign/configure/connect (agents.controller.ts/service.ts), agent-readiness (diagnostic trials — **server_chat только, не OpenCode**: agent-readiness.runner.ts), agent-method-workflow preparation (`needs_setup` → `setup-method`/`setup-runtime`, docs §«Подготовка компьютера»). Gap: (1) **self-onboarding** агента без оператора (автоматическая настройка роли/контекста/инструментов/доступа), (2) измерение «первая полезная операция за минуты» (C2), (3) readiness-проба расширена на **opencode** (сейчас только server_chat).

**Approach:** (1) **Self-onboarding без оператора**: добавление агента в проект автоматически настраивает роль/контекст (одобренные знания)/инструменты из каталога/доступ к публичным чатам (потребляем entry 1/8). (2) **Первая полезная операция за минуты (C2)**: измерить и обеспечить, что от добавления агента до первой полезной операции — минуты (baseline Q7). (3) **Readiness**: расширить agent-readiness на opencode (содержательная проба, не только server_chat). Не дублируем устройство/pairing (эпик 7) и каталог (эпик 2).

## Boundaries & Constraints

**Always:**
- Onboarding агента — **без оператора** (самонастройка; добавление человеком админом — не вмешательство оператора, R2).
- Настройка: роль / контекст (одобренные знания) / инструменты из каталога / доступ к публичным чатам.
- **Первая полезная операция — за минуты** (C2, baseline Q7).
- Readiness = содержательная проба (расширено на **opencode**, не только server_chat).
- Потребляем entry 1 (роль/контекст/инструменты/чаты) и entry 8 (расширения из каталога).

**Never:**
- Не требовать ручных шагов оператора для базового onboarding (R2 counter).
- Не считать «добавил админ» вмешательством оператора (R2: добавление человека админом — не вмешательство).
- Не дублировать device/pairing/установщики (эпик 7).
- Не дублировать каталог (эпик 2).
- Не принимать readiness без содержательной пробы (карточка ≠ работающая обработка).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Onboarding без оператора | добавление агента в проект | Самонастройка: роль/контекст/инструменты/доступ к публичным чатам | — |
| 2 | Первая полезная операция | после onboarding | За минуты (C2) | > целевого → фэйл (C2) |
| 3 | Readiness opencode | проба opencode-агента | Содержательная проба (не только server_chat) | проба не прошла → needs_setup |
| 4 | Readiness server_chat | проба server_chat | Содержательная проба (существующее) | — |
| 5 | Контекст = одобренные | approved knowledge | В onboarding контекст = approved (FR-502) | — |
| 6 | Без вмешательства оператора | onboarding | 0 ручных шагов оператора (R2 counter) | вмешательство → фэйл (R2) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/agents/agents.controller.ts` + `agents.service.ts` — CRUD/assign/configure/connect (точка self-onboarding).
- `services/catalog-service/src/agents/project-agent.repository.ts` — project_agents (назначение в проект).
- `services/catalog-service/src/agents/agent-job-compiler.ts` — `compileAgentJob` (manifest: роль/контекст/инструменты/модель).
- `services/catalog-service/src/agent-readiness/agent-readiness.runner.ts` + `agent-readiness.service.ts` — diagnostic trials (сейчас **server_chat только**) — расширить на opencode.
- `services/catalog-service/src/agent-readiness/agent-readiness.policy.ts` — политика readiness.
- `services/catalog-service/src/agent-method-workflows/jobs.ts` — preparation (`needs_setup` → `setup-method`/`setup-runtime`) — паттерн «не готов → следующий шаг».
- `docs/features/agent-method-workflows.md` §«Подготовка компьютера» — needs_setup/setup-method/setup-runtime.
- `services/catalog-service/src/learning/learning.repository.ts` — context() (approved, FR-502) — контекст onboarding.
- Baseline Q7 — целевое время onboarding (PRD Success Metrics «Скорость»).

## Tasks & Acceptance

### Execution
- [ ] **Self-onboarding без оператора**: добавление агента → автоматическая настройка роли/контекста (approved)/инструментов из каталога/доступа к публичным чатам (потребляем entry 1/8).
- [ ] **Первая полезная операция за минуты (C2)**: измерение + обеспечение (baseline Q7).
- [ ] **Readiness**: расширить agent-readiness на **opencode** (содержательная проба, не только server_chat); `needs_setup` → actionable следующий шаг.
- [ ] Tесты: onboarding без оператора (0 ручных шагов), первая полезная операция ≤ целевого, readiness opencode, контекст=approved.

### Acceptance
- **Given** добавление агента в проект **when** onboarding **then** самонастройка (роль/контекст approved/инструменты/доступ к публичным чатам), 0 ручных шагов оператора (R2 counter).
- **Given** onboarding завершён **when** первая полезная операция **then** за минуты (C2, baseline Q7).
- **Given** opencode-агент **when** readiness **then** содержательная проба (не только server_chat); не готов → `needs_setup` + actionable следующий шаг.
- **Given** контекст onboarding **when** знания **then** только approved (FR-502).
- Корневой сьют — без деградации.

## Design Notes

- **Почему «добавление админом ≠ вмешательство оператора»:** R2 прямо говорит «добавление человека админом — не вмешательство оператора». Onboarding агента = самонастройка; роль админа — инициация, не ручная настройка.
- **Readiness opencode:** сейчас agent-readiness — только server_chat (diagnostic trials). FR-307 «первая полезная операция» требует, чтобы агент был **реально готов** (opencode-проба), а не только «карточка». Расширяем runner на opencode.
- **C2 baseline Q7:** целевое время onboarding фиксируется при старте пилота (Q7). Здесь — обеспечить «за минуты» + измерение.
- **Потребляем, не строим:** роль/контекст/инструменты/чаты (entry 1), расширения из каталога (entry 8), каталог (эпик 2), устройство (эпик 7).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- agents agent-readiness
node --test scripts/test/onboarding-no-operator.test.mjs 2>/dev/null || true
```
Ожидаемо: onboarding без оператора (0 ручных шагов), первая полезная операция ≤ целевого (C2), readiness opencode (содержательная проба), контекст=approved; корневой сьют без деградации.

## Open Questions

1. **Целевое время «за минуты» — сколько секунд?** Рекомендация: фиксировать в baseline Q7 (целевое время onboarding); interim — ≤ 5 минут. Обоснование: Q7 — источник целевых значений.
2. **Readiness opencode — полная сессия или проба инструмента?** Рекомендация: содержательная проба (запустить инструмент/команду в opencode-среде), не просто «карточка». Обоснование: «карточка ≠ работающая обработка».
3. **Onboarding device-агента — здесь или эпик 7?** Рекомендация: здесь — self-onboarding (роль/контекст/инструменты/чаты); pairing/установщик — эпик 7. Обоснование: границы эпиков.
