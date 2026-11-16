---
title: 'Баг: имя remote-модели без префикса провайдера → 404 на gateway (валидация на входе)'
type: 'bugfix'
ticket: '18'
created: '2026-11-13'
status: done
baseline_revision: 'd51c49b05da8b4b68096ff3e7d6ab78d6b688559'
route: 'auto'
route_source: 'auto'
risk: 'medium'
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

**Problem:** Модель `model-1262cefa` (ai-gateway, chat) имела в каталоге `descriptor.model = "Qwen3.8-27B-FP8"` — БЕЗ префикса провайдера. Шлюз (LiteLLM) требует `Qwen/Qwen3.8-27B-FP8` → `404 ModelNotFound` (`litellm.NotFoundError: model='Qwen3.8-27B-FP8' is not configured`). Данные исправлены ad hoc через admin-API `PATCH /api/models/:id` (revision 1→2, end-to-end check пройден, д. 2026-11-13), но **корневая причина — отсутствие валидации на входе**: при импорте/создании remote-модели имя модели не сверяется с тем, что gateway знает (GET /v1/models), и «недопрефикс» проходит в каталог молча, превращаясь в 404 при первом check.

**Approach:** Валидация имени remote-модели на входе (создание/импорт/PATCH): (1) при сохранении подключения с `authMode != none` server-side check сравнивает имя модели с ответом gateway `GET /v1/models` (когда gateway поддерживает список — LiteLLM-совместимые); (2) mismatch → явная ошибка с СПИСКОМ доступных имён («модель «X» не найдена; доступные: …») — не тихое сохранение + 404 позже; (3) если gateway не поддерживает /v1/models (404 на самом endpoint) — деградация: предупреждение, не блокировка (имя не верифицируемо). Стык с UX-аудитом (P0-3/P1): единый статус проверки + следующий шаг — ошибка mismatch = «следующий шаг» (выбрать из списка/поправить имя).

## Boundaries & Constraints

**Always:**
- Валидация — server-side (remote-connection.service.ts / remote-model-client.ts), не только UI (импорт/создание/PATCH — все пути записи).
- Mismatch → ошибка с доступными именами (GET /v1/models), fail-closed на сохранение (или явный операторский override-флаг, если решение — не блокировать; см. OQ 1).
- Gateway без /v1/models → предупреждение (degraded), не блокировка.
- Не ломать существующие успешные подключения (check/verification-поток не меняется).

**Never:**
- Не хранить список имён в каталоге «для всех gateway» (gateway-специфично — LiteLLM-совместимые поддерживают /v1/models; остальные нет).
- Не менять уже сохранённые данные каталога ad hoc (коррекция данных — только через admin-API, как в d51c49b0-инциденте).
- Не блокировать сохранение подключения с `authMode = none` (без ключа check невозможен — валидация имени по /v1/models тоже невозможна).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Имя без префикса, gateway знает с префиксом | `Qwen3.8-27B-FP8`, /v1/models даёт `Qwen/Qwen3.8-27B-FP8` | Ошибка: «не найдена; доступные: …» (fail-closed или warning, см. OQ 1) |
| 2 | Имя точно в списке | `Qwen/Qwen3.8-27B-FP8` | Сохранение проходит, check — 200 |
| 3 | Gateway без /v1/models | 404 на /v1/models | Предупреждение «имя не верифицируемо», сохранение (degraded) |
| 4 | authMode = none (без ключа) | нет ключа | Валидация пропущена (check невозможен), как сейчас |
| 5 | PATCH смены имени модели | новое имя не в списке | Ошибка/предупреждение (тот же поток) |
| 6 | Существующие успешные подключения | — | Не деградируют |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/models/remote-model-client.ts` — URL-building, model field в теле запроса, network/HTTP catch («Не удалось соединиться» / «Удалённый API недоступен (HTTP …)»).
- `services/catalog-service/src/models/remote-connection.service.ts` — `check()` (vision-фикстура → `{number:'42',color:'red'}`), save/revoke/status — точка валидации.
- Admin-API `PATCH /api/models/:id` (принимает `model`, сбрасывает verificationSha256) — путь, которым правили данные (не обходить, а валидировать на нём).
- Frontend: `RemoteConnectionModal` / `OpenCodeImportModal` — показ ошибки с доступными именами (стиль — единый статус/next-step из UX-аудита).

## Tasks & Acceptance

### Execution
- [x] `remote-model-client.ts`: метод `listModels(baseUrl, credential)` → GET /v1/models (degraded: 404/нет списка → null).
- [x] `remote-connection.service.ts`: на save/PATCH при `authMode != none` — сверка имени модели с listModels: mismatch → ошибка с доступными именами (fail-closed, OQ-1); нет списка → warning.
- [x] `PATCH /api/models/:id` (смена `model`) — та же валидация (`ModelsService.update` → `assertRenamedRemoteModel`).
- [x] Frontend: показ предупреждения `nameUnverified` в RemoteConnectionModal (Alert warning); mismatch — ошибка от server с доступными именами.
- [x] Тесты: `remote-model-name-check.test.ts` (10 кейсов: none-skip, match, mismatch, null-warning, пустой список, legacy stored/env, revoked head, db-sбой, corrupted secret) + frontend warning-кейс.

## Progress

**2026-11-16 — done (в main, 654258fd).** Реализовано: `remote-model-name-check.ts` (ядро сверки: personal key → legacy stored/env key, fail-closed mismatch с `REMOTE_MODEL_NAME_MISMATCH` + список имён, degraded → `REMOTE_MODEL_NAME_UNVERIFIED` warning), `RemoteModelClient.listModels` (GET /v1/models, null = недоступен, [] = явный пустой список = mismatch), интеграция в `RemoteConnectionService.save` (до записи, warning пробрасывается в view `nameUnverified`) и `ModelsService.update` (PATCH смены имени, тот же поток). OQ-1 решён как fail-closed (mismatch блокирует; только degraded — warning). OQ-2: все имена в ошибке. Тесты: catalog 10/10 (remote-model-name-check), frontend ModelCatalog 33/33, tsc 0. Примечание: 3 pre-existing faila в `system-roles` (system-role-agent-call) — на baseline 632b622e ДО agt-08, не связаны с тикетом (отдельный баг).

### Acceptance
- **Given** имя `Qwen3.8-27B-FP8`, gateway знает `Qwen/Qwen3.8-27B-FP8` **when** сохранение/PATCH **then** явная ошибка с доступными именами (не тихое сохранение + 404 позже).
- **Given** имя в списке **when** сохранение + check **then** 200, verified.
- **Given** gateway без /v1/models **when** сохранение **then** предупреждение «не верифицируемо», сохранение (degraded).
- **Given** authMode none **when** сохранение **then** валидация пропущена (как сейчас).
- Корневой сьют — без деградации.

## Design Notes

- **Почему server-side, не UI:** импорт/создание/PATCH — разные пути записи (UI, импорт OpenCode, admin-API); единая валидация на server — все пути закрыты. UI показывает то, что вернул server.
- **Почему /v1/models:** LiteLLM-совместимые gateway (ai-gateway) поддерживают; это стандарт OpenAI-совместимого API. Не-OpenAI-совместимые (OpenWebUI chat.ehd-zr) — degraded-путь (нет списка → warning), их 401/400 — данные провайдера, не наш баг.
- **Стык с UX-аудитом (P0-3/P1):** единый статус проверки + next-step — ошибка mismatch = явный next-step (выбрать из списка/поправить). Не дублировать статусы.
- **Данные vs код:** инцидент d51c49b0 — данные (один `descriptor.model`); корень — отсутствие валидации (код). Этот тикет — код; коррекция данных осталась за admin-API (не ad hoc SQL).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- remote-model remote-connection
```
Ожидаемо: валидация-тесты зелёные (матрица 6 строк); существующие check/verification без деградации; корневой сьют без деградации.

## Open Questions

1. **Fail-closed (блокировать сохранение) или warning (сохранить + пометить)?** Рекомендация: fail-closed на mismatch (имя точно не в списке — сохранение = гарантированный 404); warning только на degraded (нет /v1/models). Обоснование: тихое сохранение неверифицируемого имени — и есть корень этого бага; degraded — отдельный случай (имя не верифицируемо вовсе, блокировка = false-negative).
2. **Список имён в ошибке — все или топ-N?** Рекомендация: все (LiteLLM-списки короткие; топ-N — доп. сложность без пользы). Обоснование: оператору нужен полный список для выбора.
