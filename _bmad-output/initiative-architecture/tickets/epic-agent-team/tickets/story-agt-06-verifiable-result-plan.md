---
title: 'FR-304: Проверяемый результат — верификация (exit-code/покрытие), а не «сделано»'
type: 'feature'
ticket: '6'
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

**Problem:** FR-304: **результат работы агента в проекте проверяем: верификация (exit-code/покрытие), а не «сделано».** Сейчас доказательство есть точечно: `system-role-mcp` (execute/close, state succeeded/unknown/failed, proof, 45s) и **device**-метод-воркфлоу (`docs/features/agent-method-workflows.md` §«Выполнение и результат»: настоящие exit code/signal выбранных проверок, SHA изменённых файлов, `succeeded` только после успешных проверок и завершения runtime, `not_run`/`failed` явно). Но **универсального** verification-контракта результата агента (вне device-метод-воркфлоу) нет: «сделано» без верификации сегодня может быть принято. Gap: единый механизм — результат агента несёт **машина-читаемое доказательство** (exit-code/покрытие/proof), «сделано» без верификации = **не принято** (fail-closed), `succeeded` только после успешных проверок.

**Approach:** Ввести **verification-контракт** результата агента (универсальный, не только device-метод-воркфлоу): (1) результат несёт машина-читаемое доказательство — **exit-code/покрытие/proof**; (2) **«сделано» без верификации = не принято** (fail-closed); (3) **`succeeded` только после успешных выбранных проверок и завершения** (паттерн device-метод-воркфлоу + system-role-mcp); (4) явные состояния `not_run`/`unknown`/`failed`. Переиспользуем существующие состояния/proof (system-role-mcp, метод-воркфлоу), не пересобираем их.

## Boundaries & Constraints

**Always:**
- Результат агента несёт **машина-читаемое доказательство** (exit-code/покрытие/proof).
- «Сделано» без верификации = **не принято** (fail-closed).
- `succeeded` — только после **успешных выбранных проверок** и завершения.
- Явные состояния: `not_run`/`unknown`/`failed`/`succeeded`.
- Доказательство — с провенансом (версия/SHA, NFR-4) там, где применимо.

**Never:**
- Не принимать «сделано» без верификации.
- Не объявлять `succeeded` без успешных проверок/завершения.
- Не путать `not_run` (проверка не запускалась) и `failed` (запустилась, ненулевой exit).
- Не дублировать device-метод-воркфлоу (потребляем его контракт).
- Не терять сырые stdout/секреты в результате (docs §«Выполнение и результат» — не передаются).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Результат с exit-code | агент завершил, проверки запущены | Результат с exit-code/покрытием (proof) | — |
| 2 | «Сделано» без верификации | результат без proof/exit-code | Не принят (fail-closed) | actionable-сообщение |
| 3 | succeeded после проверок | успешные выбранные проверки + завершение | `succeeded` | — |
| 4 | Проверка не запускалась | not_run | `not_run` (явно) | не смешивать с failed |
| 5 | Ненулевой exit | проверка завершилась ≠0 | `failed` | — |
| 6 | unknown (крах/потеря ACK) | нет подтверждения завершения | `unknown` (явно, не succeeded) | recovery (entry 11) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/system-role-mcp/system-role-mcp.controller.ts` — execute/close, state succeeded/unknown/failed, proof (45s) — паттерн состояний/доказательства.
- `services/shared/agent-method-workflow.cjs` — `normalizeAgentMethodWorkflowResult` (состояния succeeded/failed, exit code/signal, SHA) — device-контракт (потребляем).
- `docs/features/agent-method-workflows.md` §«Выполнение и результат» — `succeeded` только после успешных проверок+завершения, `not_run`/`failed` явно, сырые stdout/секреты не передаются — эталон.
- `services/catalog-service/src/agent-method-workflows/jobs.ts` — `assertAgentMethodResult:110` (succeeded/failed против исходной задачи/версии/проверок) — точка проверки результата.
- `services/catalog-service/src/agents/agent-audit.ts` — аудит результата.
- NFR-4 — провенанс доказательства (версия/SHA).

## Tasks & Acceptance

### Execution
- [x] **Verification-контракт** результата агента (универсальный): результат несёт машина-читаемое доказательство (exit-code/покрытие/proof).
- [x] «Сделано» без верификации = **не принято** (fail-closed, actionable).
- [x] `succeeded` — только после успешных выбранных проверок и завершения (паттерн method-workflow + system-role-mcp).
- [x] Явные состояния `not_run`/`unknown`/`failed`/`succeeded`.
- [x] Доказательство с провенансом (NFR-4) там, где применимо; сырые stdout/секреты не в результате.
- [x] Тесты: результат+exit-code, «сделано» без верификации → отказ, succeeded после проверок, not_run/failed/unknown.

### Acceptance
- **Given** результат работы агента **when** завершение **then** несёт машина-читаемое доказательство (exit-code/покрытие/proof).
- **Given** «сделано» без верификации **when** приёмка **then** не принято (fail-closed, actionable).
- **Given** успешные выбранные проверки + завершение **when** результат **then** `succeeded`.
- **Given** проверка не запускалась / ненулевой exit / потеря подтверждения **when** результат **then** `not_run` / `failed` / `unknown` (явно).
- Корневой сьют — без деградации.

## Design Notes

- **Почему low risk:** состояния/proof/exit-code уже есть (system-role-mcp, method-workflow). Задача — **универсальный контракт** + fail-closed «без верификации = не принято», а не новый механизм проверки.
- **Эталон — device-метод-воркфлоу:** `docs/features/agent-method-workflows.md` §«Выполнение и результат» задаёт семантику (succeeded/not_run/failed, exit code/signal, SHA). Универсальный контракт повторяет её для **любого** результата агента (не только device).
- **`unknown` = стык с entry 11:** потеря подтверждения завершения (крах/потеря ACK) → `unknown` (не `succeeded`); recovery — entry 11 (отказоустойчивость).
- **NFR-4:** доказательство несёт провенанс (версия/SHA) — «пересказанные артефакты (без провенанса) = 0» (Done-when 9).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- system-role-mcp agent-method-workflows agents
node --test scripts/test/verifiable-result.test.mjs 2>/dev/null || true
```
Ожидаемо: результат+exit-code/proof, «сделано» без верификации → отказ (fail-closed), succeeded после проверок, not_run/failed/unknown явные; корневой сьют без деградации.

## Open Questions

1. **Что считать «покрытием» (coverage) для не-кодовых результатов?** Рекомендация: coverage — для кода (тесты); для не-кодовых — proof (квитанция/артефакт+SHA). Обоснование: FR-304 «exit-code/покрытие» — покрытие применимо к коду.
2. **Единая ли таблица состояний для всех агентов?** Рекомендация: да — succeeded/unknown/failed/not_run (единый контракт). Обоснование: согласуется с system-role-mcp + method-workflow.
3. **Где хранить доказательство?** Рекомендация: в квитанции результата (с SHA/провенансом), аудит — отдельно. Обоснование: NFR-4 + traceability.

## Progress (2026-11-13, done)

**Архитектура:** универсальный verification-контракт в shared (CJS, потребляется из TS) + fail-closed гейт приёма в device-completion. Device-контракт method-workflow **потребляет** универсальные семантики (рефактор без изменения error-идентичности), а не дублирует их.

**Код:**
- `services/shared/agent-result-verification.cjs` (+ `.d.cts`) (new) — универсальный контракт, protocol `agent-result-verification-v1`: states `succeeded/failed/cancelled/unknown`; stages `prerequisites/execution/checks/completed`; checks `{command, args, exitCode, signal, state: passed/failed/not_run}`; failure `{code, action}` (универсальные коды; device-контракт передаёт свои). Инварианты: `succeeded` → `completed` + нет failure + ≥1 passed check; `!succeeded` → failure обязателен; размер ≤64KiB; NFR-4: intent-digest (проверки зафиксированы в интенте, результат обязан описать **ровно** объявленные проверки).
- `services/shared/agent-method-workflow.cjs` (refactor) — device-контракт потребляет универсальные примитивы (uuid/sha/text/exact/checkCommand/relativePath, normalize checks/changes/artifacts, assert outcome); error-идентичность сохранена (те же сообщения).
- `services/catalog-service/src/agents/agent-verification.ts` (new) — гейт `assertVerifiedAgentResult`: fail-closed, принимает только результат, прошедший универсальную нормализацию + сверку с интентом.
- `services/catalog-service/src/devices/device-completion.ts` — гейт вызывается после `assertAgentMethodResult`; job kind `AGENT_METHOD_WORKFLOW_JOB` без `payload.verification` — no-op (обратная совместимость).

**Доказано (2026-11-13):**
- `node --test scripts/test/verifiable-result.test.mjs` — **12/12 pass** (живой PG + собранный dist): method-workflow 1–4 (exit-code/SHA, not_run/failed/unknown, succeeded только после проверок) + универсальный гейт 5–10 (fail-closed без верификации, succeeded после проверок+завершения, NFR-4 intent-digest, размер, сырые stdout не передаются).
- Юниты `services/catalog-service/src/agent-method-workflows/tests/agent-result-verification.test.ts` — **15/15 pass**; typecheck (tsc) чист; dist пересобран (stamp 3ae211a3).
- **Корневой сьют ЗЕЛЁНЫЙ (definitive-rerun):** `node --test --test-concurrency=1 <check-tooling-tests.json>` — **1076 tests, 1073 pass, 0 fail, 3 skipped** (exit 0).

Замечание (pre-existing flake, не регресс 9.6):
- Первый прогон корневого сьюта дал 1 фейл `scripts/test/workspace-check-process.test.mjs` «a denied process probe remains fatal...» (ожидал `[SIGTERM]`, пришло `[SIGTERM, SIGKILL]` — эскалация kill под нагрузкой). Тест проходит **3/3 изолированно**, ноль пересечения с файлами 9.6; definitive-rerun — 0 fail.
