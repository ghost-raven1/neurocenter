---
title: 'FR-602: hosting-модель — action cancel'
type: 'feature'
ticket: '4'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-project/epic-project.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Hosting-действия подготовленной модели = `['start','stop','check']` (hosting.service.ts); prepare-intents gguf-runtime.service.ts = RESERVED/CREATE_SENT/CREATED. Нет явного **cancel** (FR-602: «prepare/start/check/stop/cancel/recovery с прогрессом и ресурсными лимитами»). Сейчас in-flight prepare/start нельзя отменить операторским действием — только ждать завершения или recovery (interruptStale — восстановление после сбоя, не отмена). Отказ в середине тяжёлого prepare/start (GGUF blob → ollama create) оставляет частичное состояние, которое можно только recovery'нуть.

**Approach:** Добавить action **`cancel`** в hosting (hosting.service.ts): отменить in-flight prepare/start — снять advisory-лок (single executor), вернуть состояние в чистый (RESERVED/незапущенный), зачистить частичный GGUF/бандл (Ollama-артефакт + локальные файлы), записать receipt-статус (cancelled). Idempotent по request_key (повторный cancel = no-op). Cancel ≠ recovery: recovery (interruptStale) — восстановление после НЕОЖИДАННОГО сбоя; cancel — операторское отключение ЗАПУЩЕННОГО действия. Ресурсные лимиты (NFR-6) соблюдаются: cancel освобождает ресурсы лока/бандла.

## Boundaries & Constraints

**Always:**
- Cancel снимает advisory-лок single executor (hosting.service.ts) и возвращает состояние в чистый.
- Зачистка частичного артефакта (GGUF blob/бандл/Ollama-модель, если создана частично) — idempotent.
- Receipt-статус `cancelled` (провенанс, R9): кто, когда, что отменено.
- Idempotency: повторный cancel / cancel уже завершённого = no-op (request_key).
- Ресурсные лимиты (NFR-6): cancel освобождает ресурсы (лок, бандл-память/диск).

**Never:**
- Не путать cancel с recovery (interruptStale — отдельный путь восстановления после сбоя, не трогать).
- Не отменять уже УСПЕШНО завершённый prepare/start (созданная модель не «откатывается» cancel'ом — это stop, существующий action).
- Не ломать start/stop/check (существующие action, не деградируют).
- Не вводить частичную зачистку «fire-and-forget»: зачистка подтверждена (receipt) до возврата состояния.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Cancel in-flight prepare | action cancel, prepare RUNNING | Лок снят, состояние чистое, частичный артефакт зачищен, receipt cancelled |
| 2 | Cancel in-flight start | action cancel, start RUNNING | Лок снят, состояние чистое, receipt cancelled |
| 3 | Повторный cancel | cancel ещё раз | no-op (idempotent, request_key), без ошибок |
| 4 | Cancel завершённого prepare | cancel, prepare DONE | no-op (успешный не откатывается — это stop) |
| 5 | Cancel без in-flight действия | cancel, ничего не запущено | no-op (нет чего отменять) |
| 6 | Recovery после сбоя (не cancel) | сбой, interruptStale | Recovery-путь (не cancel), не деградирует |
| 7 | Start/stop/check | существующие action | Работают как прежде (не деградируют) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/models/hosting.service.ts` — actions `['start','stop','check']` — добавить `'cancel'`; single executor advisory lock; progress; watchdog; interruptStale recovery (не трогать).
- `services/catalog-service/src/models/gguf-runtime.service.ts` — prepare: blob→create via ollama API, intents RESERVED/CREATE_SENT/CREATED, manifest proof — частичный артефакт для зачистки.
- `services/catalog-service/src/models/gguf-import/gguf-import.service.ts` — state-machine (entry 3 — стык, не менять).
- `services/catalog-service/src/models/models.repository.ts` — advisory lock pattern `asset-management:model:<id>` (:336,:369) — паттерн лока.
- Frontend: Operations-очередь (OperationsQueue) — cancel-кнопка in-flight операции (DESIGN.md: долгая мутация → «Операции», retry/cancel через CAS requestKey+expectedDigest, bff.ts:153-174).

## Tasks & Acceptance

### Execution
- [ ] `hosting.service.ts` — добавить action `'cancel'`: снять advisory-лок single executor, вернуть состояние в чистый, зачистить частичный GGUF/бандл (ollama API + локальные файлы), receipt-статус `cancelled`.
- [ ] Idempotency: cancel по request_key (повтор = no-op); cancel завершённого/отсутствующего = no-op.
- [ ] Зачистка частичного артефакта (gguf-runtime.service.ts intents RESERVED/CREATE_SENT/CREATED): если GGUF создан частично — удалить (ollama API / файлы), подтверждено до возврата состояния.
- [ ] Receipt: `cancelled` (actor, время, что отменено) — провенанс (R9).
- [ ] UI: cancel-кнопка in-flight prepare/start в Operations-очереди (CAS requestKey+expectedDigest, DESIGN.md rule 7).
- [ ] Тесты: cancel in-flight prepare/start (лок снят, состояние чистое, зачистка, receipt); повторный cancel (no-op); cancel завершённого (no-op); recovery (interruptStale) не деградирует; start/stop/check не деградируют.

### Acceptance
- **Given** in-flight prepare/start **when** action cancel **then** advisory-лок снят, состояние чистое, частичный артефакт зачищен, receipt `cancelled`.
- **Given** повторный cancel **when** run **then** no-op (idempotent, request_key).
- **Given** завершённый prepare/start **when** cancel **then** no-op (успешный не откатывается — это stop).
- **Given** сбой (не cancel) **when** recovery **then** interruptStale-путь работает (не деградирует).
- **Given** start/stop/check **when** run **then** работают как прежде.
- Корневой сьют — без деградации.

## Design Notes

- **Cancel ≠ recovery:** recovery (interruptStale) — восстановление после НЕОЖИДАННОГО сбоя (watchdog). Cancel — операторское отключение ЗАПУЩЕННОГО действия. Разные триггеры, разные пути. Не смешивать.
- **Почему отдельный action, не флаг:** FR-602 явно перечисляет cancel как действие lifecycle. Флаг/таймаут не дают операторского контроля.
- **Зачистка частичного GGUF:** prepare = blob→create (ollama). Если create прерван — частичная модель/бандл. Cancel зачищает (ollama API delete + локальные файлы). Idempotent (повторная зачистка = no-op).
- **Стык с entry 3 (FR-601):** gguf-import state-machine (WAITING→…→ACCEPTED) — импорт; hosting (prepare/start) — запуск после импорта. Cancel = hosting-уровень (отменить prepare/start), не импорт-уровень.
- **Стык с entry 16 (sweep):** cancel-кнопка в Operations-очереди — проверять в sweep (UI consistency, DESIGN.md rule 7).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- hosting gguf-runtime
```
Ожидаемо: cancel-тесты зелёные (in-flight prepare/start → лок снят/зачистка/receipt; повторный no-op; завершённый no-op); recovery/start/stop/check без деградации; корневой сьют без деградации.

## Open Questions

1. **Cancel prepare на стадии blob-download vs create?** Рекомендация: cancel работает на любом in-flight этапе (снимает лок + зачищает частичное на текущей стадии). Обоснование: оператор не должен знать внутреннюю стадию.
2. **Зачистка через ollama API или файлы?** Рекомендация: оба (ollama API delete модели + локальные файлы бандла), idempotent. Обоснование: частичный артефакт может быть и в ollama, и на диске.
3. **Cancel в UI — отдельная кнопка или в Operations-очереди?** Рекомендация: в Operations-очереди (CAS requestKey+expectedDigest, DESIGN.md rule 7 — долгая мутация → Операции). Обоснование: единый паттерн долгих операций.
