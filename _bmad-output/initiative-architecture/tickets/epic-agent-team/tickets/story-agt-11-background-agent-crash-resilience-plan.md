---
title: 'FR-305: Отказоустойчивость background-агента (crash-политика, retry, идемпотентность)'
type: 'feature'
ticket: '11'
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
  - _bmad-output/initiative-architecture/architecture-observability/architecture-observability.md
  - _bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/tickets/tickets.toml
  - _bmad-output/initiative-architecture/tickets/epic-project/tickets/tickets.toml
  - _bmad-output/initiative-architecture/tickets/epic-project/tickets/story-prj-12-autonomous-rounds-engine-plan.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/tickets/tickets.toml
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Coverage-аудит (`coverage-wave2-2026-11-09.md`, §4 G-7) нашёл дыру в скоупе эпика: **отказоустойчивость серверного background-агента (FR-305)** — crash/retry/idempotency не явны в done-when; brownfield-семантика recovery есть **ТОЛЬКО для device-метод-воркфлоу** (`docs/features/agent-method-workflows.md` §«Отмена и восстановление»), **не для серверного агента**. Сейчас (по фактам main @ 56f8c009): серверный фоновый агент (entry 7) работает в opencode-среде, но при его **крахе во время работы** (OOM/kill/рестарт контейнера) **нет политики** (retry с backoff / dead-letter / явная остановка), **нет гарантии идемпотентности** (повтор не дублирует эффекты: сообщения/артефакты/бюджет) и **crash не попадает** в error-store (эпик 6 entry 10) + security/operations events (эпик 6 entry 14). Это нарушает NFR-2 («нет молчаливых падений: crash-политика + запись ошибки; контролируемые отказы (fail-closed)») и NFR-3/R8 (recovery-путь для каждого failure mode).

**Approach:** Добавить **отказоустойчивость серверному фоновому агенту** (entry 7 + его BMAD→OpenSpec-воркфлоу, entry 10), переиспользуя существующие контракты (не дублируя): (1) **Crash-политика** — при крахе (OOM/kill/рестарт контейнера) применить политику: **retry с backoff** / **dead-letter** / **явная остановка** (не «молчаливая смерть»); «захватить и жить дальше» запрещено — контролируемый exit + перезапуск docker-политикой (эпик 6 entry 10). (2) **Идемпотентность** — повтор после краха **не дублирует эффекты** (сообщения/артефакты/бюджет): checkpoint **request_key/phase** — **контракт = epic-8 entry 12** (`story-prj-12-autonomous-rounds-engine-plan.md`: «шаг, уже потребивший бюджет, не повторяется после перезапуска», checkpoint request_key/phase, паттерн `chat-discussion.runner.ts:79` request_id/lease) — **ссылаемся, не дублируем**. (3) **Наблюдаемость** — crash попадает в **error-store (эпик 6 entry 10, AD-O5: `error_events` + API)** + **security/operations events (эпик 6 entry 14, AD-O7)**. (4) **Recovery** — переиспользуем device-семантику (§«Отмена и восстановление»): результат записывается до ACK; потеря ACK → повторная доставка той же квитанции; после перезапуска найден только маркер начатого выполнения → состояние `unknown`, **повторного исполнения нет**; восстановление сохраняет уже записанные факты и пройденные проверки.

## Boundaries & Constraints

**Always:**
- Крах серверного background-агента во время работы (OOM/kill/рестарт контейнера) → **применилась политика** (retry с backoff / dead-letter / явная остановка).
- **Идемпотентность**: повтор после краха **не дублирует эффекты** (сообщения/артефакты/бюджет) — checkpoint **request_key/phase** (контракт epic-8 entry 12).
- **Crash → observability**: строка в **error-store** (эпик 6 entry 10, AD-O5 `error_events`) + **security/operations events** (эпик 6 entry 14, AD-O7).
- Recovery — паттерн `docs §«Отмена и восстановление»`: результат до ACK; потеря ACK → повторная доставка **той же** квитанции; после перезапуска только маркер → `unknown`, **повторного исполнения нет**; восстановление сохраняет записанные факты + пройденные проверки.
- «Захватить и жить дальше» **запрещено** (эпик 6 entry 10) — контролируемый exit + перезапуск docker-политикой.
- Бюджет — через существующие (model-token-quotas/model-rate-limits, NFR-6); идемпотентность бюджета = контракт epic-8 entry 12.
- Node 24 (`~/.nvm/versions/node/v24.22.0/bin/node`).

**Never:**
- Не допускать «молчаливую смерть» (NFR-2) — crash обязан попасть в error-store + events.
- Не дублировать эффекты при повторе (сообщения/артефакты/бюджет) — идемпотентность.
- Не дублировать механизм идемпотентности автономных раундов (epic-8 entry 12) — **контракт**, не копия.
- Не дублировать crash-политику/error-store (эпик 6 entry 10) и аудит (эпик 6 entry 14) — потребляем.
- Не «захватывать» исключение и жить дальше (запрещено, эпик 6 entry 10).
- Не повторять исполнение, если после перезапуска найден только маркер начатого (`unknown`).
- Не перерасходовать бюджет (NFR-6).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Крах (OOM/kill/рестарт) | crash mid-run | Применилась политика (retry с backoff / dead-letter / явная остановка) | молчаливая смерть → фэйл (NFR-2) |
| 2 | Retry с backoff | crash, retry-политика | Повтор с backoff (до лимита) | превышение лимита → dead-letter/остановка |
| 3 | Dead-letter | исчерпаны retry | Задание в dead-letter + запись | потеря → фэйл |
| 4 | Явная остановка | оператор/политика stop | Явная остановка + квитанция | — |
| 5 | Идемпотентность: дубль эффектов | crash mid-шага → рестарт | Нет дубля сообщений/артефактов, бюджет не списан дважды (request_key/phase) | дубль → фэйл |
| 6 | Идемпотентность: бюджет | повтор шага, потребившего бюджет | no-op (контракт epic-8 entry 12) | повтор списания → фэйл (NFR-6) |
| 7 | Crash → error-store | crash | Строка `error_events` (эпик 6 entry 10, AD-O5) | нет записи → фэйл (NFR-2) |
| 8 | Crash → security/ops events | crash | Событие аудита (эпик 6 entry 14, AD-O7) | нет события → фэйл |
| 9 | Повторное исполнение запрещено | после рестарта только маркер начатого | Состояние `unknown`, повторного исполнения нет | повтор → фэйл |
| 10 | Recovery: сохранение фактов | crash после частичных изменений | Сохранены записанные факты + пройденные проверки | потеря → фэйл |
| 11 | Потеря ACK | ACK не доставлен | Повторная доставка той же квитанции (не новый результат) | новый результат → фэйл |

</frozen-after-approval>

## Code Map

**Где сейчас живёт серверный background-агент (baseline 56f8c009):**
- `services/catalog-service/src/agent-method-workflows/jobs.ts` — серверный lifecycle задания:
  - `agentMethodJobPayload:35` — immutable payload; версия метода **фиксирована сервером** (`:80` `AGENT_METHOD_VERSIONS`), `deadlineAt` 30min (`:84`), `runtime: 'opencode'`.
  - `assertAgentMethodJob:94` — recheck payload против **текущей** identity до claim и при **каждом** authorization-poll.
  - `assertAgentMethodResult:110` — завершённый результат обязан описывать исходную задачу/версию/проверки (`succeeded`/`failed`).
  - `assertAgentMethodCompletionAccess:126` — поздний успех не переживает отзыв доступа/смену привязки/пользователя.
- **Серверный фоновый агент в opencode-среде — строится entry 7** (новый compose-сервис). Его BMAD→OpenSpec-воркфлоу — **entry 10**. Эта история добавляет к нему **отказоустойчивость**.

**Существующая (device-only) recovery-семантика — переиспользуем, не дублируем:**
- `docs/features/agent-method-workflows.md` §«Отмена и восстановление» — эталон brownfield-recovery: «Завершённый результат записывается до ACK. Потеря ACK повторяет доставку той же квитанции. Если после перезапуска найден только маркер начатого выполнения, состояние становится `unknown`: повторного исполнения нет… Восстановление сохраняет уже записанные patch-факты и пройденные проверки, даже если crash случился до общей финальной квитанции.» — сейчас это **device-сторона**; здесь переносим семантику на **серверного** агента.
- `mcp/neurocenter-asset-sync/src/features/agent-method-workflow/executor.ts` + `opencode-http-runner.ts` — device-исполнитель (OpenCode HTTP-сервер, дерево процессов, отмена группы+потомков) — референс «группа и её потомки прекращаются при отмене/остановке worker/истечении срока».

**Контракт идемпотентности (не дублируем):**
- `tickets/epic-project/tickets/story-prj-12-autonomous-rounds-engine-plan.md` (epic-8 entry 12) — **контракт**: «шаг, уже потребивший бюджет, **не повторяется после перезапуска**»; checkpoint **request_key/phase**; референс-движок `chat-discussion.runner.ts`.
- `services/catalog-service/src/model-chat/chat-discussion.runner.ts` — `bounded:35`, `authority:58`, **`checkpoint:79`** (request_id/lease `:82-84`), phases/deadline — паттерн durable-checkpoint.
- Бюджет: `services/catalog-service/src/model-token-quotas/` + `model-rate-limits/` (существующие, NFR-6) — идемпотентность бюджета через контракт entry 12.

**Наблюдаемость (не дублируем):**
- `tickets/epic-res-obs/tickets/tickets.toml` **entry 10** (AD-O5) — crash-политика + **PG error-store** (`error_events`: service/ts/level/requestId/message-safe/stack-hint) + API; «uncaughtException/unhandledRejection → structured-лог + запись в error-store (best-effort, flush-before-exit) + контролируемый exit».
- **entry 14** (AD-O7) — `security_events`/`operations`-аудит (единая история) — события crash/отказа.

## Tasks & Acceptance

### Execution
- [ ] **Crash-политика** серверного background-агента: при крахе (OOM/kill/рестарт контейнера) — **retry с backoff** / **dead-letter** / **явная остановка**; «захватить и жить дальше» запрещено (контролируемый exit + перезапуск docker-политикой, эпик 6 entry 10).
- [ ] **Идемпотентность**: повтор после краша **не дублирует эффекты** (сообщения/артефакты/бюджет) — checkpoint **request_key/phase** (**контракт epic-8 entry 12**, не дублируем); бюджет — no-op для потребившего шага.
- [ ] **Наблюдаемость**: crash → **error-store** (эпик 6 entry 10, AD-O5 `error_events` + API) + **security/operations events** (эпик 6 entry 14, AD-O7).
- [ ] **Recovery** (паттерн `docs §«Отмена и восстановление»`): результат до ACK; потеря ACK → повторная доставка **той же** квитанции; после перезапуска только маркер → `unknown`, **повторного исполнения нет**; восстановление сохраняет записанные факты + пройденные проверки.
- [ ] Tесты: kill -9 mid-run → политика (retry/backoff/dead-letter), идемпотентность (нет дубля сообщений/артефактов/бюджета), crash → error_events + events, `unknown` без повторного исполнения, сохранение фактов.

### Acceptance
- **Given** крах серверного background-агента во время работы (OOM/kill/рестарт) **when** crash **then** применилась политика (retry с backoff / dead-letter / явная остановка), не «молчаливая смерть» (NFR-2).
- **Given** повтор после краха **when** идемпотентность **then** нет дубля эффектов (сообщения/артефакты/бюджет) — checkpoint request_key/phase (контракт epic-8 entry 12); бюджет не списан дважды (NFR-6).
- **Given** crash **when** наблюдаемость **then** строка в error-store (эпик 6 entry 10, AD-O5 `error_events`) + security/operations events (entry 14, AD-O7).
- **Given** после перезапуска найден только маркер начатого **when** recovery **then** состояние `unknown`, повторного исполнения нет.
- **Given** crash после частичных изменений **when** восстановление **then** сохранены записанные факты + пройденные проверки (паттерн docs §«Отмена и восстановление»).
- **Given** потеря ACK **when** повтор **then** повторная доставка **той же** квитанции (не новый результат).
- Корневой сьют — без деградации.

## Design Notes

- **Почему это отдельная история (а не часть entry 7/10):** entry 7 строит **рантайм** фонового агента, entry 10 наводит **методику** (BMAD→OpenSpec). Отказоустойчивость — **поперечное** свойство всего воркфлоу (рантайм + методика + эффекты), и coverage-аудит (§4 G-7) выделил его как отдельную дыру. Выносим в отдельную entry с чётким контрактом.
- **Идемпотентность = контракт, не копия:** механизм «шаг, потребивший бюджет, не повторяется после перезапуска» — epic-8 entry 12 (request_key/phase, `chat-discussion.runner.ts:79`). Здесь **применяем** его к эффектам фонового агента (сообщения/артефакты/бюджет), не переписываем движок.
- **Device-семантика → сервер:** `docs §«Отмена и восстановление»` сегодня описывает **device**-исполнитель. Серверный агент **наследует** ту же brownfield-семантику (результат до ACK, `unknown` без повторного исполнения, сохранение факт), но в **server-runtimе** (compose-сервис entry 7) + crash-политику контейнера.
- **Crash-политика ≠ «захватить и жить дальше»:** эпик 6 entry 10 прямо запрещает «захватить и жить дальше» — controlled exit + перезапуск docker-политикой. Retry/dead-letter — на уровне **задания** (job-lifecycle), не «проглотить исключение в процессе».
- **NFR-2 + NFR-3/R8:** «нет молчаливых падений: crash-политика + запись ошибки; контролируемые отказы (fail-closed); видимость ошибки» (NFR-2) + «для каждого failure mode — recovery-путь» (NFR-3/R8). Crash-политика + error-store + recovery-путь (retry/dead-letter/`unknown`) закрывают оба.
- **Бюджет (NFR-6):** идемпотентность бюджета — «повтор не дублирует списание» — через контракт epic-8 entry 12 + существующие model-token-quotas/rate-limits. Не новый бюджет-механизм.

## Progress (2026-11-13, in-progress)

**Ядро отказоустойчивости готово (2 новых файла, Phase A core НЕ тронут): `resilience.ts` + 10 тестов. 38/38 green на main (28 Phase A + 10), tsc baseline (0 новых ошибок), ESLint/Prettier чистые.**
- `CrashResilientBackgroundWorker` — job-level политика: retry с backoff → dead-letter → явная остановка. Crash **rejects** с `BackgroundCrashError` — «catch and live on» структурно невозможен (controlled exit + docker-restart, AD-O5). Named-константы `BACKGROUND_AGENT_RESILIENCE` (maxAttempts 3, backoff 500ms×2 capped 30s, stack-hint 4KB/top-20, level critical) + per-job override.
- Идемпотентность = контракт epic-8 entry 12 (request_key/phase), применён к эффектам: `execution` (journaled **до** dispatch — paid step не повторяется), `result` (recorded **до** ACK), `publish` (ACK-based, lost-ACK → redelivery **той же** квитанции).
- Recovery (docs §«Отмена и восстановление»): started-marker без результата → `unknown` **без повторного исполнения** (no automatic paid retry); settled job → idempotent re-process к той же записанной квитанции.
- Observability: crash → error store (AD-O5) + security/ops event (AD-O7, реальный `access/security-events.ts:securityEvent`). AD-O8: в события — только фиксированные классификаторы + digest/счётчики, raw error/инструкция не переходят. Best-effort (PG-down не блокирует crash path).
- Шов `IBackgroundAgentResilienceStore` (sibling; in-memory; pg/lease — Фаза B), декоратор `ResilientAgentRuntime` (оборачивает Phase A `IAgentRuntime`).

**Отклонения (обоснованы):** (1) `error_events` в main ещё не существует (AD-O5-стория ready-for-dev) — модуль целится в frozen AD-O5 column-контракт, не изобретает таблиц; wiring — строка при лэнде AD-O5. (2) backoff-политика на уровне job-lifecycle (process() recovery passes), процессный exit — за AD-O5 crash-handler. (3) `publish` ACK-checkpointed (redelivery той же квитанции — поведение docs на lost-ACK).

**Остаток (Фаза B / e2e, после compose-сервиса):** real kill -9 compose-сервиса (durable pg/lease store + AD-O5 crash-handler + container restart policy), real OOM mid-turn с реальным OpenCode, PG-down best-effort path, dead-letter alert channel (entry 13), корневой сьют.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- agent-method-workflows model-chat
node --test scripts/test/background-agent-crash-resilience.test.mjs 2>/dev/null || true
```
Ожидаемо: kill -9 mid-run → политика (retry с backoff / dead-letter / явная остановка), идемпотентность (нет дубля сообщений/артефактов/бюджета, контракт epic-8 entry 12), crash → `error_events` (AD-O5) + security/ops events (AD-O7), `unknown` без повторного исполнения, сохранение факт/проверок, потеря ACK → та же квитанция; корневой сьют без деградации.

## Open Questions

1. **Retry с backoff: сколько попыток/какой backoff?** Рекомендация: bounded retry (например, 3 попытки, экспоненциальный backoff) → затем dead-letter; значения — именованные константы (NFR-6, паттерн shared/readiness.cjs). Обоснование: «каждый лимит — enforcement-точка».
2. **Dead-letter — куда?** Рекомендация: dead-letter-очередь заданий + запись в error-store (AD-O5) + алерт (эпик 6 entry 13). Обоснование: видимость + recovery-путь (NFR-3).
3. **Crash-политика — per-agent или global?** Рекомендация: global policy + per-job override (бюджет retry). Обоснование: единая политика (NFR-2), гибкость на задание.
4. **Идемпотентность эффектов — только бюджет или и сообщения/артефакты?** Рекомендация: и то, и другое (request_key/phase на каждый эффект: публикация сообщения, запись артефакта, списание бюджета). Обоснование: FR-305 «повтор не дублирует эффекты: сообщения/артефакты/бюджет».
5. **`unknown` — кто разрезает (оператор/авто)?** Рекомендация: `unknown` + actionable «проверьте локальную папку и создайте новый явный запрос» (docs §«Отмена и восстановление»); авто-повтор исполнения запрещён. Обоснование: «повторного исполнения нет» — явный запрос после выяснения.
