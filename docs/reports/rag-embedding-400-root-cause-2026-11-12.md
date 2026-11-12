# RAG embedding-сбои: root cause (2026-11-12)

## Вопрос

5+ неудач hosting-RAG embedding на dev-стеке (qwen3-embedding-4b) без диагностируемой
причины: completion показывает generic 503, логи — ничего. Гипотеза для проверки:
endpoint 400-ит только при явном `dimensions`.

## Вердикт: гипотеза ПОДТВЕРЖДЕНА

### 1. Живое воспроизведение (2026-11-12, host → dev-контур)

`http://qwen3-embedding-4b.apps.k8s.ehd-zr.cbr.ru/v1/embeddings` (модель qwen3-embedding-4b,
нативная размерность 2560 по descriptor):

| Запрос | Статус | Тело |
|---|---|---|
| `{model, input}` (без dimensions) | **200** | вектор 2560 ✓ |
| `{model, input, dimensions:1024}` | **400** | `{"error":{"message":"Model \"qwen3-embedding-4b\" does not support matryoshka representation, changing output dimensions will lead to poor results.","type":"BadRequestError","code":400}}` |
| `{model, input, dimensions:2560}` | **400** | та же ошибка — endpoint отклоняет `dimensions` даже в размере, равном нативному |

Вывод: serving qwen3-embedding-4b не поддерживает matryoshka и **отклоняет любой
явный параметр `dimensions`**, независимо от значения.

### 2. След в dev-БД (model_remote_connections, model-1ee50491-0e50-4484-aaeb-85321ffbd1db)

| revision | base_url | request_dimensions | verified |
|---|---|---|---|
| 1–3 | qwen3-embedding-4b…/v1 | f | t |
| **4** | qwen3-embedding-4b…/v1 | **t** | **f** ← probe с `dimensions` упал, CAS не закрепил |
| 5 | qwen3-embedding-4b…/v1 | f | t |

Механика: `RemoteModelClient.infer` (services/catalog-service/src/models/remote-model-client.ts:65)
ставит в payload `dimensions: model.dimension` при `connection.requestDimensions === true`.
Rev 4 — попытка включить `request_dimensions`; verification (check → тот же client.infer)
получил 400 → `verified=f` → конфигурация не закрепилась, оператор откатился на rev 5.
Период, когда rev 4 был pinned (последняя non-revoked строка), и есть 5+ фактических
неудач embedding-запросов устройств.

### 3. Почему сбой был НЕДИАГНОСТИРУЕМ (информационные разрывы)

1. **Сервер выбрасывает тело 400**: `remote-model-client.ts:338-351` — на любой non-OK
   `await response.body?.cancel()` ДО чтения; причина от upstream ("does not support
   matryoshka…") теряется. Ошибка классифицируется как `RemoteModelError('unavailable',
   'Удалённый API недоступен (HTTP 400).')` — 4xx-отклонение помечается как «unavailable».
2. **Лога нет нигде**: observability.cjs — только статус-счётчики; ни model id, ни route,
   ни status, ни body не пишутся в журнал catalog-service.
3. **Device relay уплощает**: `mcp/.../rag-hosted/relay.ts:69-74` — любой non-OK становится
   'Серверная модель недоступна или подключение изменилось. Проверьте модель и права на
   проект.' (status прикреплён к error, но в completion-сообщение не попадает).
4. **Worker/completion**: в результат задания попадает только generic-сообщение; upstream
   HTTP-код и тело никуда не фиксируются.

## Итог

- **Прямая причина сбоев**: явный `dimensions` в payload → 400 от non-matryoshka serving.
  Операционный фикс: держать для этой модели `request_dimensions=f` (фактически так — rev 5).
- **Системная причина (баг)**: отсутствие error-visibility — тело/статус upstream-отказа
  не логируется и не доходит до completion, поэтому любая аналогичная проблема
  (другая модель, другой 4xx) снова будет «невидимой».
- **Тикет**: epic-res-obs entry 16 — «Remote-model inference: upstream error visibility
  (worker-логи + error-коды в completion)» — см.
  `tickets/epic-res-obs/tickets/story-remote-model-error-visibility-plan.md`.
