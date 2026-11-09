---
title: 'Sweep + C5 e2e-приёмка (реальный проект агент-командой через BMAD → OpenSpec в основном рантайме)'
type: 'feature'
ticket: '12'
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
  - _bmad-output/initiative-architecture/tickets/epic-release-baseline/tickets/story-rel-01-e2e-acceptance-plan.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Эпик 9 (agent-team) закрыт по частям (entries 1–11), но ни одна линия не доказала **C5 end-to-end**: **реальный проект** проведён **агент-командой** (анализ → требования → архитектура → задачи → код → тесты → ревью → подготовка выпуска) через **BMAD → OpenSpec в основном рантайме** (FR-308/entry 10) **с провенансом** — так что следующий исполнитель получает **принятые решения и исходные артефакты, а не пересказ** (R5, counter: пересказанные артефакты без провенанса = 0). Каждая часть проверена изолированно (entry 1 e2e-агент, entry 2 sequential, entry 3 провенанс, entry 4/5 роли/recovery, entry 6 верификация, entry 7 фоновый агент, entry 8 каталог, entry 9 onboarding, entry 10 BMAD→OpenSpec main-runtime, entry 11 отказоустойчивость), но **сквозная** связка «реальный проект агент-командой через BMAD→OpenSpec с провенансом + отказоустойчивость» — нет. C5 = сигнал GO/NO-GO для пилота (эпик 10 после эпика 9: «реальный проект агент-командой (C5)»).

**Approach:** (1) **Sweep** — вычистить мёртвые флаги/временные артефакты, проверить **drift** (environment-model.json + compose, паттерн 1.12 D2: новый compose-сервис entry 7 → model + drift-тест + compose-шапка), закрыть OQ предыдущих историй, проверить **провенанс** (пересказанные артефакты без провенанса = 0, Done-when 9, NFR-4). (2) **C5 e2e-приёмка (HITL)** — сквозной на **реальном проекте**: агент-команда ведёт проект end-to-end через BMAD→OpenSpec в основном рантайме, используя все entries (фоновый агент FR-305/7, каталог FR-306/8, onboarding FR-307/9, sequential+подключение FR-302/2, провенанс FR-309/3, роли+recovery FR-303/310/4/5, верификация FR-304/6, отказоустойчивость/11). (3) **C5-протокол** — какой проект / какая BMAD-инициатива / pinned-версии (bmad-6.12.4+openspec-1.15.0) / что = «принято». Большая часть — HITL (выбор проекта, запуск, решение «принято/отклонено»); автоматизируем повторяемое (sweep/drift/провенанс-проверки).

## Boundaries & Constraints

**Always:**
- **C5 e2e — на реальном проекте** (не toy): агент-команда (анализ → требования → архитектура → задачи → код → тесты → ревью → подготовка выпуска) через **BMAD → OpenSpec в основном рантайме** (FR-308/entry 10), pinned-версии (bmad-6.12.4+openspec-1.15.0).
- **Провенанс**: следующий исполнитель получает принятые решения + исходные артефакты, **не пересказ**; пересказанные артефакты (без провенанса) = 0 (Done-when 9, NFR-4/R5).
- **Sweep**: drift 0 (environment-model↔compose, паттерн 1.12 D2), мёртвые флаги/артефакты вычищены, OQ закрыты.
- **Отказоустойчивость**: крах во время e2e → политика (retry/backoff/dead-letter/остановка) + нет дубля эффектов (entry 11).
- **C5-протокол** задокументирован: какой проект / BMAD-инициатива / pinned-версии / что = «принято».
- Tесты/сборка — node 24 (`~/.nvm/versions/node/v24.22.0/bin/node`).
- Приватные значения/секреты не раскрываются в плане и fixtures.

**Never:**
- Не принимать C5 на toy/фикстурном проекте (C5 = **реальный** проект).
- Не создавать второй PRD/второй build-цикл (FR-308: принятые документы переиспользуются).
- Не отходить от pinned-версий (бmad-6.12.4+openspec-1.15.0).
- Не принимать «сделано» без верификации (FR-304/entry 6).
- Не допускать пересказанных артефактов без провенанса (NFR-4).
- Не обходить drift (новый compose-сервис entry 7 обязан быть в model).
- Не дублировать устройство/pairing (эпик 7), каталог (эпик 2), чат/комнаты/поиск (эпик 8).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Sweep: drift | environment-model.json + compose (вкл. entry 7) | Drift 0 (structuralDrift + compose-drift + dead/required) | drift → фэйл |
| 2 | Sweep: мёртвые флаги | инвентарь флагов/артефактов | Вычищены (или явный exception) | необъявленный hit → фэйл |
| 3 | Sweep: провенанс | артефакты проекта | Пересказанные (без провенанса) = 0 (Done-when 9) | артефакт без провенанса → фэйл (NFR-4) |
| 4 | C5 e2e: реальный проект | реальный проект + BMAD-инициатива | Агент-команда end-to-end (анализ→…→выпуск) через BMAD→OpenSpec (main-runtime) | — |
| 5 | C5 e2e: провенанс | принятые документы + артефакты | Следующий исполнитель получает решения + исходные артефакты (не пересказ) | пересказ → фэйл (R5) |
| 6 | C5 e2e: верификация | результат этапов | Каждый результат — верификация (exit-code/покрытие), не «сделано» (entry 6) | «сделано» без proof → фэйл |
| 7 | C5 e2e: отказоустойчивость | крах во время e2e | Политика (entry 11) + нет дубля эффектов | дубль/молчаливая смерть → фэйл |
| 8 | C5-протокол | приёмка | Какой проект/BMAD-инициатива/pinned-версии/что=«принято» задокументировано | — |
| 9 | HITL: решение | отчёт e2e | Оператор подтверждает «принято» (C5 GO) / «отклонено» | — |

</frozen-after-approval>

## Code Map

- `deploy/production/environment-model.json` + `deploy/production/compose.production.yml` — drift (паттерн 1.12 D2; новый compose-сервис entry 7 обязан быть в model).
- `scripts/test/compose-drift.test.mjs` + `scripts/production/environment-model.mjs` (`structuralDrift`, `deadEnvironment`, `requiredEnvironmentDrift`) — drift-тесты (sweep).
- `services/shared/agent-method-workflow.cjs` — `AGENT_METHOD_VERSIONS` (bmad:6.12.4, openspec:1.15.0, combined) — pinned-версии C5.
- `services/catalog-service/src/agent-method-workflows/jobs.ts` — `agentMethodJobPayload:35` (версия сервером `:80`), `assertAgentMethodResult:110` — main-runtime BMAD→OpenSpec.
- `docs/features/agent-method-workflows.md` — §«Подготовка компьютера» (BMAD 6.12.4/OpenSpec 1.15.0/BMAD→OpenSpec), §«Выполнение и результат» (PASS-критерии: OpenSpec `all_done`/архив, BMAD `status: done` + Auto Run Result + Review Triage Log), §«Отмена и восстановление» — эталон C5-приёмки.
- `openspec/` + `_bmad-output/` (корень репо) — примеры OpenSpec/BMAD-инициативы (референс C5-протокола).
- `services/catalog-service/src/project-chat/project-chat.runner.ts` — публикация C5-артефактов в проектный чат.
- `tickets/epic-release-baseline/tickets/story-rel-01-e2e-acceptance-plan.md` — **референс** e2e-приёмки (HITL-фазы, driver, протокол, отчёт).
- Entries 1–11 — потреблённые части (e2e-агент/sequential/провенанс/роли/verif/фоновый/каталог/onboarding/BMAD→OpenSpec/отказоустойчивость).

## Tasks & Acceptance

### Execution
- [ ] **Sweep**: drift 0 (environment-model↔compose, паттерн 1.12 D2, вкл. entry 7), мёртвые флаги/артефакты вычищены, OQ предыдущих историй закрыты.
- [ ] **Sweep: провенанс** — пересказанные артефакты (без провенанса) = 0 (Done-when 9, NFR-4).
- [ ] **C5 e2e (HITL)** — реальный проект агент-командой end-to-end (анализ → требования → архитектура → задачи → код → тесты → ревью → подготовка выпуска) через **BMAD → OpenSpec в основном рантайме** (FR-308/entry 10), pinned-версии (bmad-6.12.4+openspec-1.15.0).
- [ ] C5-артефакты: следующий исполнитель получает принятые решения + исходные артефакты (не пересказ); каждый результат — верификация (entry 6).
- [ ] **Отказоустойчивость**: крах во время e2e → политика (entry 11) + нет дубля эффектов.
- [ ] **C5-протокол** задокументирован: какой проект / BMAD-инициатива / pinned-версии / что = «принято».
- [ ] HITL-ранбук + отчёт `c5-e2e.json` (проект, BMAD-инициатива, pinned-версии, артефакты, верификации, результаты) в `NEUROCENTER_TEST_EVIDENCE`.
- [ ] Регистрация в tooling-списке (union+sort при мерже).

### Acceptance
- **Given** sweep **when** drift **then** 0 (structural/dead/required, вкл. entry 7); мёртвые флаги/артефакты вычищены; OQ закрыты.
- **Given** артефакты проекта **when** провенанс **then** пересказанные (без провенанса) = 0 (Done-when 9, NFR-4).
- **Given** реальный проект + BMAD-инициатива **when** C5 e2e **then** агент-команда end-to-end (анализ→…→выпуск) через BMAD→OpenSpec в main-runtime, pinned-версии (bmad-6.12.4+openspec-1.15.0).
- **Given** C5-артефакты **when** передача **then** следующий исполнитель получает принятые решения + исходные артефакты (не пересказ, R5); каждый результат — верификация (entry 6).
- **Given** крах во время e2e **when** отказоустойчивость **then** политика (entry 11) + нет дубля эффектов.
- **Given** отчёт **when** C5-протокол **then** задокументировано: какой проект / BMAD-инициатива / pinned-версии / что = «принято»; HITL-оператор подтверждает «принято» (C5 GO).
- `check --tooling` зелёный; корневой сьют — без деградации.

## Design Notes

1. **Почему HITL + реальный проект:** C5 (R5) = «**реальный** проект проведён агент-командой end-to-end … с провенансом». Toy/фикстура не доказывает C5. Запуск на реальном проекте + решение «принято/отклонено» — продуктовое (HITL), как REL-01 (entry 13 эпика 1). Автоматизируем повторяемое (sweep/drift/провенанс-проверки), HITL — выбор проекта/запуск/решение.
2. **C5-протокол = вход + критерий:** фиксируем (а) **какой проект** (реальный пилотный), (б) **какая BMAD-инициатива**, (в) **pinned-версии** (bmad-6.12.4+openspec-1.15.0, OpenCode 1.14.48), (г) **что = «принято»** (принятые документы BMAD + OpenSpec change `all_done`/архив + успешные проверки `openspec validate --all --strict --no-interactive` + провенанс — docs §«Выполнение и результат»).
3. **Связка частей:** e2e **консумирует** entries 1–11, не пересобирает. Если какая-то часть красная — это баг-тикет той части, не «потолерировать» (паттерн RES-01, эпик 6 entry 15).
4. **Отказоустойчивость в e2e:** крах во время реального проекта — ожидаемый сценарий (не «нужно избегать»); e2e проверяет, что политика (entry 11) сработала + нет дубля эффектов + артефакты с провенансом не потеряны.
5. **Регресс-базис:** корневой сьют без деградации против baseline (56f8c009); e2e-driver не ломает существующие harness'ы.

## Verification

**Commands:** (Node 24 обязателен: `~/.nvm/versions/node/v24.22.0/bin/node`)
- `node --test scripts/test/compose-drift.test.mjs` -- expected: drift 0 (structural/dead/required, вкл. entry 7)
- `node scripts/workspace/check.mjs --tooling` -- expected: e2e-driver в tooling-списке, гейт зелёный
- `cd services/catalog-service && npm test` -- expected: без деградации против baseline
- **HITL (главная):** реальный проект → агент-команда end-to-end (анализ→…→выпуск) через BMAD→OpenSpec в main-runtime (pinned bmad-6.12.4+openspec-1.15.0) → C5-артефакты с провенансом → верификация каждого результата → крах-сценарий (entry 11) → отчёт `c5-e2e.json` -- expected: следующий исполнитель получает решения+артефакты (не пересказ); оператор подтверждает «принято» (C5 GO)
- **HITL (C5-протокол):** зафиксировано какой проект / BMAD-инициатива / pinned-версии / что = «принято»; артефакты в `NEUROCENTER_TEST_EVIDENCE`.

## Open Questions (с рекомендациями)

- **OQ1 — Какой реальный проект для C5?** Рекомендация: реальный пилотный проект (не toy), согласованный с пользователем при e2e (HITL). Обоснование: C5 = «реальный проект» (R5).
- **OQ2 — Какая BMAD-инициатива?** Рекомендация: реальная BMAD-инициатива пилотного проекта (аналог `_bmad-output/` в репо), с принятыми brief/PRD/архитектурой. Обоснование: FR-308 «принятые документы переиспользуются».
- **OQ3 — Что именно = «принято» (критерий GO)?** Рекомендация: принятые документы BMAD (brief/PRD/архитектура) + OpenSpec change с `all_done`/архив + успешные проверки (`openspec validate --all --strict --no-interactive`) + провенанс всех артефактов (NFR-4) + верификация (entry 6). Обоснование: docs §«Выполнение и результат» (PASS-критерии).
- **OQ4 — Обязателен ли крах-сценарий в e2e?** Рекомендация: да — инъецировать крах (kill) на одном из этапов и проверить политику (entry 11) + отсутствие дубля. Обоснование: C5 должен доказать отказоустойчивость в реальном прогоне, а не только unit.
- **OQ5 — Пилот (эпик 10) ожидает C5?** Рекомендация: да — эпик 10 `after` эпик 9 «реальный проект агент-командой (C5)». C5 GO = вход в пилот. Обоснование: tickets.toml (эпик 10 after эпик 9).
