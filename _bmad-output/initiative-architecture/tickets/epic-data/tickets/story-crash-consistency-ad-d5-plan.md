---
title: 'Crash consistency: ратификация 4 паттернов + artifact SHA (AD-D5)'
type: 'feature'
ticket: '12'
created: '2026-11-09'
status: done
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/tickets/epic-data/epic-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-D5: «четыре канонических паттерна — все уже в коде, ратифицируются как **единственный выбор** для любого нового durable-store … Новый store без зафиксированного паттерна = фэйл». Паттерны есть в коде, но не зафиксированы как единый источник (операция → паттерн), и нет инварианта «новый store только через 4 паттерна». Плюс **fix**: `forwardRuntimeArtifact` (gateway-стрим, runtime-artifact-stream.ts:7-60) — сейчас стрим **только по длине** (256MiB-чек :35, received>length :49), **верификации SHA у получателя нет** (AD-D5: «SHA-256 в response-header + client-верификация … sha256 уже несётся в дескрипторе»).

**Approach:** (1) **Ратификация**: таблица «операция → паттерн» как единый источник (документ + code-референсы, OQ-1: где) — 4 паттерна с file:line; (2) **SHA fix**: gateway `forwardRuntimeArtifact` считает SHA-256 при стриме → response-header `X-Neurocenter-SHA256` (+ длина уже есть); client (device) верифицирует SHA против ожидаемого (sha256 уже в дескрипторе/URL `:sha256`, device.controller.ts:236-246); mismatch → ошибка, файл не активирован + security event; (3) **Инвариант**: новые записи в shared volumes только через 4 паттерна (review-чеклист / grep-invariant — OQ-1).

## Boundaries & Constraints

**Always:**
- 4 паттерна — единственный выбор для durable-store (AD-D5). Таблица фиксирует все 4 impl + runtime-artifact.
- SHA fix: gateway считает SHA-256 **в процессе стрима** (не буферизация — runtime-artifact-stream.ts:6 «архив не буферизуется»); header добавляется, длина-чеки сохраняются.
- Client-верификация: ожидаемый SHA = из дескриптора/URL (`:sha256`, device.controller.ts:240-244 уже валидирует `/^[a-f0-9]{64}$/`).
- Sender (catalog `RuntimeArtifacts.open`, runtime-artifacts.ts:159-208) уже верифицирует SHA файла перед стримом — не менять (источник достоверен).

**Never:**
- Не менять 4 ratified-паттерна (runtime-artifacts tmp+link+dirsync, snapshot blob_writes, leases, unique+row-lock) — только зафиксировать.
- Не буферизовать архив в gateway (только стрим + инкрементный SHA).
- Не отключать length-чеки (256MiB, received>length) — SHA **дополняет**, не заменяет.
- Не менять device-протокол за рамками SHA-header (lease, authorize — как есть).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Корректный стрим | device GET runtime/:sha256 | стрим + header X-Neurocenter-SHA256 = sha256; client верифицирует ок, файл активирован |
| 2 | Битый SHA в транзитах | стрим с ошибкой | client: SHA mismatch → ошибка, файл НЕ активирован, security event |
| 3 | Стрим прерван (length < declared) | disconnect | текущее поведение (502/destroy) + SHA не совпадёт → client-ошибка |
| 4 | Oversize (> 256MiB) | стрим | length-чек (как сейчас) + SHA не до конца |
| 5 | Ратификация: новый durable-store | review | паттерн из 4 (таблица), иначе фэйл |
| 6 | Ратификация: существующие 4 impl | таблица | все 4 покрыты file:line |
| 7 | Client без SHA-верификации (старый) | стрим | работает (header игнорируется) — backward-compat; верификация = опция клиента (OQ-2) |

## Code Map

**4 ratified-паттерна (file:line, main @ 3433b1d1):**
- Pattern 1 (tmp+rename/link+fsync): `services/catalog-service/src/runtime-artifacts/runtime-artifacts.ts:61-129` — `importCheckedArchive` (tmp `.partial` :68, sha-during-copy :74-94, `output.sync()` :98, `fs.link` :105, dirsync :112-122); также `source-upload.files.ts:67-105`, `gguf-import.files.ts:61-96`, `backup.ts:173-179`
- Pattern 2 (2-фазные + recover-таблица): `services/catalog-service/src/snapshots/snapshot-storage.ts:418` — recoverWrite, blob_writes recover; `snapshot-gc.ts:9-150` — 2-фазный DELETING
- Pattern 3 (lease-токены с recheck): `services/catalog-service/src/models/gguf-runtime/gguf-runtime.service.ts:141-143` — advisory lock, :377-399 — lease; job-lease headers (runtime-artifact-stream.ts:24 `x-neurocenter-job-lease`); verifier lease
- Pattern 4 (unique + row-lock idempotency): `services/catalog-service/src/devices/device-job-requests.ts:23-61` — `findDeviceJobRequest`/`saveDeviceJobRequest`, UNIQUE(email,request_key) + ON CONFLICT DO NOTHING :55

**SHA fix:**
- `services/api-gateway/src/proxy/runtime-artifact-stream.ts:7-60` — `forwardRuntimeArtifact` (length-чек :34-39, стрим :44-53 — добавить SHA-Transform + header)
- `services/api-gateway/src/proxy/proxy.service.ts:434` — caller
- `services/catalog-service/src/devices/device.controller.ts:236-246` — `GET internal/device-channel/jobs/:id/runtime/:sha256` (sender; `approvedRuntimeArtifact` :246), `RuntimeArtifacts.open` :159-208 (SHA-верификация источника)

**Ратификация-документ:**
- `_bmad-output/initiative-architecture/architecture-data/architecture-data.md` — AD-D5 (Rule, :64-68)
- `scripts/test/check-tooling-tests.json` — реестр инвариант-тестов

## Tasks & Acceptance

### Execution
- [ ] Документ-ратификация: таблица «операция → паттерн (file:line)» для 4 impl + runtime-artifact (OQ-1: где — architecture-data.md AD-D5 секция vs отдельный doc)
- [ ] `runtime-artifact-stream.ts`: SHA-256 Transform в pipeline (инкрементный, без буферизации); после стрима `res.setHeader('x-neurocenter-sha256', digest)` — **проблема**: headers должны быть до тела → OQ-3 (двухфазный: заголовок после? нет — headers before body; решение: SHA считается, но header должен быть до — значит либо chunked + trailer, либо client считает сам из body и сверяет с ожидаемым из URL — см. OQ-3)
- [ ] Client (device): верификация SHA полученного стрима против ожидаемого (`:sha256`); mismatch → ошибка + security event, файл не активирован
- [ ] Инвариант: review-чеклист / grep — новые записи в shared volumes только через 4 паттерна (OQ-1)
- [ ] Тесты: стрим + SHA header; bit-flip → client mismatch; length-чеки сохранены; backward-compat (client без верификации)

### Acceptance
- **Given** корректный runtime-artifact **when** device GET **then** стрим + SHA совпадает с ожидаемым, файл активирован
- **Given** битый байт в транзите **when** device GET **then** client SHA mismatch → ошибка, файл не активирован, security event
- **Given** 4 ratified-impl **when** таблица ратификации **then** все покрыты file:line
- **Given** новый durable-store (review) **when** нет паттерна из 4 **then** фэйл (инвариант)

## Design Notes

- **SHA header — ключевая техническая проблема (OQ-3)**: HTTP headers отправляются **до** тела. Стрим считается на лету → SHA известен только **после** тела. Варианты: (a) **HTTP trailer** (`x-neurocenter-sha256` в trailer — работает с chunked, не с content-length); (b) **client считает SHA сам** из принятого body и сверяет с ожидаемым из URL `:sha256` (gateway не нужен для SHA — только client-верификация); (c) gateway отдаёт `content-length` + client верифицирует. Рекомендация: **(b)** — client уже знает ожидаемый SHA (из URL/дескриптора), считает SHA принятого потока, сверяет; gateway-роль = длина (уже есть) + опциональный trailer. AD-D5 говорит «SHA-256 в response-header + client-верификация» — трактовка: SHA доступен клиенту (header/trailer/дескриптор) + клиент верифицирует. Уточнить (OQ-3).
- Sender (catalog) уже доверен: `open()` ре-верифицирует SHA файла + inode/mtime-стабильность (runtime-artifacts.ts:185-202). Значит битость возможна только в транзите gateway→device — client-верификация закрывает.
- Ратификация = зафиксировать, не менять. Инвариант «новый store через 4 паттерна» — review-чеклист (не автоматический grep, т.к. «durable-store» — семантическое понятие).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/api-gateway && npm test -- runtime-artifact
cd services/catalog-service && npm test -- runtime-artifacts device
```
Ожидаемо: runtime-artifact-тесты (SHA-верификация, bit-flip, length) зелёные; 4 impl покрыты таблицей.

## Open Questions

1. **Где таблица ратификации**: секция AD-D5 в architecture-data.md (рекомендация — уже там Rule, добавить таблицу file:line) vs отдельный `docs/crash-consistency.md`?
2. **Client-верификация**: обязательная (старый client без верификации = фэйл) vs опциональная (backward-compat)? Рекомендация: опциональная на переходный период, обязательная после rollout (edge 7).
3. **SHA-механизм**: (b) client считает SHA из body и сверяет с URL `:sha256` (рекомендация) vs (a) HTTP trailer vs (c) gateway-шаг. AD-D5 «SHA в response-header» — уточнить трактовку.
4. **Security event при mismatch**: в security_events (catalog) — кто пишет (device/gateway)? — dev-уточнение.
5. **Инвариант**: review-чеклист (рекомендация) vs автоматический grep — семантика «durable-store» не формализуема grep'ом.
