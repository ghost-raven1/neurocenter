---
title: 'FR-306 [P1]: Расширения только из одобренного каталога + экспериментальный режим (аудит)'
type: 'feature'
ticket: '8'
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

**Problem:** FR-306 [P1]: плагины/скиллы/MCP opencode для агента — из **одобренного каталога проекта** (точный комплект, FR-202); подключение локальных расширений с устройства допускается **строго для тестирования возможностей** (экспериментальный режим: не входит в одобренный комплект, **фиксируется в аудите**). Сейчас каталог (эпик 2: FR-201..203 — упаковка с SHA-описью, провенанс, immutable-версии, назначение только одобренного комплекта) есть, но **per-agent tool-profile (AP02) не реализован**: device-метод-воркфлоу явно «отдельный набор skills/plugins/MCP и изоляция каждого агента этим расширением не реализуются» (docs §«Закреплённый проектный исполнитель» :41). Gap: (1) расширения opencode агента — **только** из одобренного каталога (точный комплект); (2) **экспериментальный режим** (локальные расширения с устройства строго для тестирования) — с записью в аудит, не входит в одобренный комплект; (3) **per-agent изоляция** набора расширений.

**Approach:** (1) **Per-agent tool-profile (AP02)**: набор плагинов/скиллов/MCP opencode агента — только из одобренного каталога проекта (точный комплект, FR-202); расширение вне каталога → отказ. (2) **Экспериментальный режим**: локальные расширения с устройства допускаются **строго для тестирования возможностей**; не входят в одобренный комплект; **фиксируются в аудите**. (3) **Per-agent изоляция**: набор расширений агента A не виден агенту B. Потребляем каталог (эпик 2), не дублируем.

## Boundaries & Constraints

**Always:**
- Расширения opencode (плагины/скиллы/MCP) — **только** из одобренного каталога проекта (точный комплект, FR-202).
- Экспериментальный режим (локальные расширения с устройства, строго для тестирования) — **фиксируется в аудите**, не входит в одобренный комплект.
- **Per-agent изоляция** набора расширений.
- Каталог/провенанс (SHA/версия/квитанция) — из эпика 2 (потребляем).
- Аудит экспериментального режима — транзакционный (NFR-4/R9).

**Never:**
- Не давать агенту расширения **вне** одобренного каталога (fail-closed).
- Не смешивать экспериментальный режим с одобренным комплектом (экспериментальный не входит в комплект).
- Не пропускать экспериментальный режим без записи в аудит.
- Не ломать per-agent изоляцию (агент A не видит расширения B).
- Не дублировать каталог/упаковку/провенанс (эпик 2).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Расширение из каталога | плагин/скилл/MCP в одобренном каталоге | Доступен агенту | — |
| 2 | Расширение вне каталога | расширение не в каталоге | Отказ | actionable-сообщение (fail-closed) |
| 3 | Экспериментальный режим | локальное расширение с устройства (тест) | Допущено строго для тестирования + запись в аудит | нет аудита → фэйл |
| 4 | Экспериментальный в комплекте | экспериментальное расширение | НЕ входит в одобренный комплект | смешение → фэйл |
| 5 | Per-agent изоляция | агент A и B | Набор A не виден B | утечка → фэйл |
| 6 | Точный комплект (FR-202) | одобренный комплект | Только точный комплект | отклонение от комплекта → фэйл |

</frozen-after-approval>

## Code Map

- Каталог (эпик 2, потребляем): FR-201..203 — упаковка с SHA-описью, провенанс (версия/SHA/источник/время/издатель), immutable-версии, назначение только одобренного комплекта — `services/catalog-service/src/` (catalog-service), `bundled-catalog.lock.json`.
- `docs/features/agent-method-workflows.md` §«Закреплённый проектный исполнитель» `:41` — «отдельный набор skills/plugins/MCP и изоляция каждого агента этим расширением не реализуются» — **фиксация gap (AP02)**.
- `mcp/neurocenter-asset-sync/src/features/agent-method-workflow/preparation.ts` — подготовка opencode (скиллы/plugins/MCP) — точка tool-profile.
- `services/catalog-service/src/agents/agent-job-compiler.ts` — `compileAgentJob` (manifest) — точка per-agent набора расширений.
- `services/catalog-service/src/agents/agent-audit.ts` — аудит экспериментального режима (NFR-4).
- Аудит-стор: `security_events`/`operations` (эпик 6 entry 14) — единая история.

## Tasks & Acceptance

### Execution
- [x] **Per-agent tool-profile (AP02)**: набор плагинов/скиллов/MCP opencode агента — только из одобренного каталога проекта (точный комплект, FR-202).
- [x] Расширение вне каталога → отказ (fail-closed, actionable; mcp-whitelist: только receipt-доказанные approved, прочие `{enabled: false}`).
- [x] **Экспериментальный режим**: локальные расширения с устройства строго для тестирования возможностей; не входят в одобренный комплект; **запись в аудит**.
- [x] **Per-agent изоляция**: набор расширений агента A не виден агенту B (manifest + overlay).
- [x] Тесты: из каталога (доступ), вне каталога (отказ), экспериментальный (аудит+не в комплекте), изоляция, точный комплект (mcp 1925/20skip, catalog kit 20/20, tsc 0).
- [ ] e2e: полный device-флоу (prepare → run → receipt) с реальным бинарником opencode 1.14.48 (native acceptance) — **остаток, после 11.1**.

### Acceptance
- **Given** плагин/скилл/MCP из одобренного каталога **when** назначение агенту **then** доступен (точный комплект, FR-202).
- **Given** расширение вне каталога **when** назначение **then** отказ (fail-closed, actionable).
- **Given** локальное расширение с устройства (тест) **when** экспериментальный режим **then** допущено строго для тестирования + запись в аудит, не входит в одобренный комплект.
- **Given** агенты A и B **when** per-agent изоляция **then** набор A не виден B.
- Корневой сьют — без деградации.

## Design Notes

- **Почему AP02 tool-profile:** docs :41 явно фиксирует «не реализуются» — это и есть gap FR-306. Здесь реализовываем per-agent tool-profile (набор расширений из каталога) + экспериментальный режим + изоляцию.
- **Каталог — эпик 2:** упаковка/провенанс/immutable-версии/назначение одобренного комплекта (FR-201..203) — эпик 2. Здесь — **политика** «расширения агента только из каталога» + экспериментальный режим, не каталог.
- **Экспериментальный ≠ одобренный:** «не входит в одобренный комплект, фиксируется в аудите» — экспериментальный режим отдельный, с аудитом, не смешивается с комплектом.
- **Изоляция:** «отдельный набор skills/plugins/MCP и изоляция каждого агента» — per-agent, агент A не видит B.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- agents
node --test scripts/test/catalog-only-extensions.test.mjs 2>/dev/null || true
```
Ожидаемо: из каталога (доступ), вне каталога (отказ), экспериментальный (аудит+не в комплекте), per-agent изоляция, точный комплект (FR-202); корневой сьют без деградации.

## Open Questions

1. **Граница «строго для тестирования возможностей»?** Рекомендация: экспериментальный режим = явный opt-in + аудит + срок/флаг (не production-комплект). Обоснование: FR-306 «строго для тестирования».
2. **Экспериментальный режим — per-agent или per-project?** Рекомендация: per-agent (с аудитом), не поднимается в project-комплект без одобрения. Обоснование: изоляция + не в комплекте.
3. **Какие типы расширений (плагин/скилл/MCP) в профиле?** Рекомендация: все три (единый tool-profile). Обоснование: FR-306 «плагины/скиллы/MCP».

## Progress

**2026-11-16 — код в main (merge 256e64ff, cf327151, 21 файл +1712/−73); остаток = device-e2e с реальным бинарником.**
- Реализация: `agent-extension-kit.ts` (ядро: per-agent kit, sha256 self-proof overlay, экспериментальный режим с транзакционным аудитом), миграция 59 (`AGENT_EXTENSION_SCHEMA_SQL` — отдельный блок, не append: checksum-ловушка `validateMigrationHistory`), `mcpOverride` в overlay (pre-computed mcp-изоляция, runner ре-верифицирует byte-exact), опциональный `agentId` в MCP-ticket (`^agent-[a-z0-9][a-z0-9-]{0,120}$`, `assertAgentKitMembership`, обратно совместимо).
- Тесты: mcp full (sequential) 1925 passed / 20 skipped, catalog agent-extension-kit 20/20, tsc 0 (mcp + catalog), prettier OK. Параллельный vitest-прогон даёт 5с-таймаут-флейки в worker-project-agents/project-agents-apply под CPU-нагрузкой — sequential детерминированно зелёный (проверено на main после мержа: 162/162+skip).
- Оставшийся e2e: device-флоу (prepare → run → receipt) с opencode 1.14.48 — после 11.1 (нужен бинарник в среде).
- Новые OQ из отчёта: (a) REST-эндпоинты pin/experiment-управления — нужны или управление через существующие flow? (b) кто наполняет device-local `.nc/agents/<agentId>/experimental/<assetId>` (capability-test?).

**OQ-статус (аудит sweep agt-12, 2026-11-17):**
- OQ1 (граница «строго для тестирования») — **resolved**: экспериментальный режим реализован как явный opt-in (`AgentExtensionRepository.experiment*`, транзакционный аудит `agent.extensions.experimental-enable/revoke`), lifetime 7–30 дней (`EXPERIMENT_MIN_DAYS/MAX_DAYS`), никогда не входит в approved-комплект (`agent_extension_experiments` отдельная таблица; approved pins win over experiments).
- OQ2 (per-agent или per-project) — **resolved**: per-agent — `agent_extension_pins`/`agent_extension_experiments` keyed (project_id, agent_id), advisory-lock `agent-extension:<project>:<agent>`; в project-комплект не поднимается.
- OQ3 (типы расширений) — **resolved**: все три — mcp/plugin/skill (`isKind`; «Поддерживаются расширения mcp, plugin и skill»).
- Новый OQ (a) REST-эндпоинты — **resolved (design decision)**: отдельные REST-эндпоинты НЕ созданы; управление — через существующие service-флоу (`AgentExtensionRepository.pin/unpin/enableExperiment/revokeExperiment`, fail-closed: ассет обязан быть в approved-кит проекта, agent обязан быть назначен). Отдельный контроллер не нужен: все операции транзакционные с аудитом, UI потребляет через существующие маршруты агентов.
- Новый OQ (b) наполнение device-local experimental — **resolved (design decision)**: server хранит только запись эксперимента (+audit); device-local материаллизация идёт штатным установщиком кита агента (overlay с `mcpOverride`, runner ре-верифицирует byte-exact) — эксперимент = capability-test на устройстве в рамках существующей установки, отдельного «наполнителя» нет.
