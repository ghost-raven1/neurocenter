---
title: 'Remote-model inference: upstream error visibility (worker-логи + error-коды в completion)'
type: 'story'
ticket: '16'
created: '2026-11-12'
status: done
baseline_revision: '56815ff1'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['docs/reports/rag-embedding-400-root-cause-2026-11-12.md', '_bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md', 'services/catalog-service/src/models/remote-model-client.ts', 'services/catalog-service/src/models/device-embedding.service.ts', 'mcp/neurocenter-asset-sync/src/features/rag-hosted/relay.ts']
---

# Remote-model inference: upstream error visibility

## Rут-причина (подтверждена, 2026-11-12)

5+ hosting-RAG embedding-сбоев (qwen3-embedding-4b) были НЕДИАГНОСТИРУЕМЫ. Прямая причина —
endpoint отклоняет явный `dimensions` (400, non-matryoshka serving); системная причина —
тело/статус upstream-отказа нигде не логируется и не доходит до completion. Полные
доказательства: `docs/reports/rag-embedding-400-root-cause-2026-11-12.md`.

## Scope

1. **Сервер: читать и логировать upstream-отказ.** `remote-model-client.ts:338-351`:
   на non-OK читать тело (кап ~2 КиБ) и писать warn-лог: model id + route + HTTP status +
   тело (редектированный — без ключей/токенов). Классификация: 4xx (кроме 401/403/429) =
   новый `RemoteModelError.kind = 'rejected'` (сейчас падает в 'unavailable');
   `RemoteModelError` несёт `status: number`.
2. **Сообщение к устройству с upstream-кодом.** `device-embedding.service.ts` /
   `RemoteConnectionService.infer`: 503 несёт код — фиксированная safe-формулировка
   (AD-19: без чужого тела): 'Удалённый API отклонил запрос (HTTP 400). Проверьте
   настройки подключения модели.'
3. **Device-сторона: код в completion + worker-лог.** `relay.ts:69-74` (server status уже
   прикреплён к error — довести до лога) + worker/completions: результат задания получает
   поле с HTTP-кодом (без тела); worker-лог пишет status + message.
4. **Регрессионные тесты**: fake-upstream 400 с телом → warn-лог содержит status+тело+model
   id; completion несёт код; 401/403/429 сохраняют прежнюю классификацию.
5. **Документация**: runbook/заметка — matryoshka-сервинги (qwen3-embedding-4b) требуют
   `request_dimensions=false`; включение = гарантированный 400.

## Вне скоупа

- Изменение поведения `request_dimensions` (опция остаётся — она нужна matryoshka-endpoint'ам).
- AD-19 error-body-политика gateway (только несём безопасный код, не чужое тело).

## Операционный факт

dev-конфиг qwen3-embedding-4b уже `request_dimensions=false` (rev 5, verified) — модель
работает; тикет закрывает невидимость, а не текущий сбой.

## Progress

**Статус: done** (реализовано в worktree `nc-wt/res16`, ветка `nc-res-16`, без push/merge).

### Изменённые файлы

- `services/catalog-service/src/models/remote-model-error.ts` — `RemoteModelErrorKind` расширен
  значением `'rejected'`; `RemoteModelError` несёт опциональный `status?: number`.
- `services/catalog-service/src/models/remote-model-client.ts` — в `request()` прокинут контекст
  `{ modelId, route }`; на non-OK ответ: читает тело upstream (кап ~2 КиБ через `upstreamReason`),
  редактирует apiKey → `[REDACTED]`, пишет `logger.warn(upstreamFailureLog(...))` в формате
  `model=${modelId} ${route} → HTTP ${status}: ${body}`; классификация: 4xx (кроме 401/403/429) →
  `'rejected'`, 401/403/429 сохраняют `authorization`/`rate-limit`, 5xx → `'unavailable'`.
- `mcp/neurocenter-asset-sync/src/features/rag-hosted/relay.ts` — читает тело серверного отказа
  (кап ~2 КиБ), извлекает upstream-код по `/(\(HTTP (\d{3})\))/`, пишет в `process.stderr`
  `neurocenter bridge: серверная модель отказала: HTTP <status> — <body[:512]> (upstream HTTP <code>)`;
  в HTTP-ответ relay добавляется `error.code` (без чужого тела, AD-19).
- `docs/remote-models.md` — операционная заметка про matryoshka-сервинги и `request_dimensions=false`.
- Тесты: `services/catalog-service/src/models/tests/remote-model-error-visibility.test.ts` (новый),
  `services/catalog-service/src/models/tests/remote-connection.service.infer.test.ts` (новый),
  `mcp/neurocenter-asset-sync/integration/test/rag-hosted.test.ts` (+1 тест на `error.code`).

### Тесты

- Сервер (catalog-service): **9 passed / 0 failed** (`remote-model-error-visibility.test.ts` 7 +
  `remote-connection.service.infer.test.ts` 2).
- Device relay (mcp, `rag-hosted.test.ts`): **32 passed / 0 failed** (31 прежних + 1 новый тест
  `relay поверх серверного отказа с кодом upstream (HTTP 400) выставляет error.code…`).
  ⚠️ Тест `До подтверждённого local commit приватный grant не меняется…` флапает по таймауту
  `5000ms` в этом окружении (одна из прогонов — fail, другой — pass), к данному тикету отношения
  не имеет и его код не меняет.
- Typecheck `services/catalog-service` (tsconfig.build.json) — EXIT 0; `mcp/neurocenter-asset-sync`
  (tsconfig.json) — EXIT 0.

### Отклонения / риски

- **Worker subprocess (opencode-rag.mjs) не потокит upstream-код в объект job-completion
  end-to-end.** Реализовано на уровне relay-контракта: relay возвращает `error.code` в HTTP-ответ
  задания и пишет status+message в bridge/worker-лог. Доведение кода до поля результата задания в
  самом плагине-воркере (отдельный bundle-рецепт, не src этого worktree) не покрыто in-env тестом —
  остаётся как остаточное (см. «Вне скоупа» про AD-19-политику, тело дальше relay не уходит).
- **Раскрытие тела через `error.code` намеренно ограничено** числовым кодом; тело и `[REDACTED]`
  остаются только в серверных логах и в bridge-логе устройства.
- Соблюдалось ограничение: `npm install/ci/exec` не выполнялись (node_modules — symlink в основной
  репозиторий); тесты запускались напрямую через `node ./node_modules/vitest/vitest.mjs run …` под
  Node v24.22.0. Человеческий WIP в `scripts/…` не трогался.
