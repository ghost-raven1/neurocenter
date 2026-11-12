---
title: 'Remote-model inference: upstream error visibility (worker-логи + error-коды в completion)'
type: 'story'
ticket: '16'
created: '2026-11-12'
status: ready-for-dev
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
