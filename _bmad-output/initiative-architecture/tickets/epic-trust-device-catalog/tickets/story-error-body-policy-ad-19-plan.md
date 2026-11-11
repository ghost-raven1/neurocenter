---
title: 'Error-body-политика: фиксированные сообщения + нормализация proxy (AD-19, entry 10)'
type: 'feature'
ticket: '10'
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
  - '_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md'
  - '_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md'
  - '_bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/epic-trust-device-catalog.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Body внешних ошибок — passthrough внутренних `error.message` (~16 мест, см. Code Map — проверено по main): axios-ошибки с внутренними `hostname:port` (напр. `connect ECONNREFUSED catalog-service:4100` из model-chat-контекстов catalog), SDK-ошибки (`spawn ENOENT`, пути ФС) через `errMsg` в MCP-результаты, git-ошибки `source-client` в HTTP-ответы. AD-19: body внешних ошибок = фиксированный набор (code + user-safe текст); passthrough запрещён (исключение — validated domain-ошибки с явным allowlist). Proxy обязан нормализовать upstream-ошибки: внутренний hostname/порт/маршрут в body клиенту не уходит. Shadowing-инцидент (entry 3) должен давать **actionable** диагностику (какой роут, какой роут-паттерн его поглотил), а не generic «не разрешил».

**Approach:** (1) Inventory-фикс: каждая точка passthrough (17 мест) заменяется фиксированным сообщением (code + user-safe текст) либо переводится в **allowlist** (задокументированный список validated domain-ошибок, которые ЛЕГИТИМНО несут текст — напр. «папка изменилась», «недостаточно места»: текст формирует домен, не exception). (2) Proxy-нормализация: upstream 5xx-ответ в catch-all/device-channel — фиксированный body (status сохранить), 4xx-доменные — передавать как есть (это user-safe тексты домена); axios-транспортные ошибки (ECONNREFUSED/ETIMEDOUT/ENOTFOUND) — 502/504 с фиксированным текстом, детали (hostname:port) — только в server-лог. (3) Shadowing-диагностика: catch-all, получивший запрос на роут, который ПО ТАБЛИЦЕ (entry 8) является явным (не должен доходить до прокси) → log с actionable-диагностикой (route + паттерн + expected controller) + client-ответ фиксированный (без internal-деталей). (4) SDK: `errMsg` (stdio.ts) — транспортные/FS-ошибки маппятся на фиксированные user-safe сообщения; детали — в local-лог bridge.

## Boundaries & Constraints

**Always:**
- Фиксированный набор сообщений: `code` (машина-читаемый, напр. `upstream-unavailable`, `route-configuration-error`) + user-safe текст; полный allowlist domain-ошибок (текст от домена) — задокументирован в `route-policy.ts`/комментариях + покрыт тестом.
- Passthrough `error.message` в external-body запрещён (static-тест: grep-инвариант по паттернам, allowlist исключён явно).
- Proxy-нормализация: upstream 5xx → фиксированный body (status сохранён, текст — «Сервис временно недоступен. Повторите позже.»); транспортные axios-ошибки → 502 (connect) / 504 (timeout) фиксированные; hostname:port/маршрут — только `console.error` (server-лог).
- Shadowing-диагностика: catch-all на явном роуте (по таблице entry 8) → server-лог содержит `route + pattern + expected controller` (actionable); client — фиксированный actionable-текст (не generic «не разрешил», без internal-деталей).
- SDK (asset-sync): инфраструктурные ошибки (spawn/ENOT/fs) → фиксированные user-safe результаты tool'а; raw `error.message` клиенту не уходит; детали — в local-лог.
- Секреты в server-логах — маскированы (AD-9/entry 4: билеты/секреты не печатаются; этот entry не ослабляет маскирование).

**Never:**
- Не менять status-коды domain-ошибок (409/403/404 — семантика домена сохраняется; меняется только ТЕКСТ там, где passthrough).
- Не логировать секреты/билеты в server-лог (AD-9); не выводить hostname:port/internal-маршруты в client-body.
- Не «чинить» поведение (fix'и logic) — только тексты/нормализацию; баги логики — другие сторис.
- Не трогать shadowing-фикс (entry 3), route-таблицу (entry 8) — только читать таблицу для диагностики.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| PASSTHROUGH_GONE | axios ECONNREFUSED в model-chat-контексте | фиксированный body (code+текст), нет `catalog-service:4100` в ответе | 502/504 фикс |
| UPSTREAM_5XX | upstream ответил 500 с internal-текстом | status 500, фиксированный user-safe body | details в log |
| DOMAIN_4XX | upstream 409 «Папка проекта изменилась...» | передаётся как есть (allowlist domain-текст) | No error |
| SHADOWED_ROUTE | catch-all получил явный роут (таблица entry 8) | log: route+pattern+expected; client: фиксированный actionable | actionable log |
| SDK_SPAWN | `spawn opencode ENOENT` в tool-вызове | tool-результат: фиксированное user-safe (не raw message) | local-лог с деталями |
| STATIC_PASSTHROUGH | `error.message` в external-body вне allowlist | static-тест ФЕЙЛ | actionable |
| LOG_NO_SECRET | server-лог при ошибке | hostname/порт в логе (ок), секретов/билетов нет | — |
| ALLOWLIST_DOC | allowlist domain-ошибок | задокументирован + тест «allowlist стабилен» | — |

</frozen-after-approval>

## Code Map

**Passthrough-точки (проверено по main; 17 мест):**
- `services/api-gateway/src/bridge/bridge.controller.ts:152` — `message: error.message`
- `services/api-gateway/src/features/mcp-host/host.ts:276,329` — `e.message || 'Хост MCP недоступен.'` (jsonrpc-error body)
- `services/api-gateway/src/features/research-mcp/research-mcp.controller.ts:88` — `message: error.message`
- `services/catalog-service/src/asset-sources/source-client.ts:15,18,20` — `BadRequest/ServiceUnavailable/ConflictException(failure.message)` (git-ошибки)
- `services/catalog-service/src/models/gguf-import/gguf-import.capacity.ts:21` — `HttpException(failure.message, failure.statusCode)`
- `services/catalog-service/src/source-upload/source-upload.service.ts:253` — `BadRequestException(error.message.slice(0,500))`
- `services/catalog-service/src/model-chat/chat-project-context.ts:194,260` — `HttpException({code, message: error.message})` (LLM-provider axios)
- `services/catalog-service/src/model-chat/chat-learning-context.ts:119` — то же
- `services/catalog-service/src/model-chat/chat-research-tools.ts:151` — то же
- `services/catalog-service/src/features/require-feature-enabled.ts:21` — `message: error.message`
- `services/catalog-service/src/devices/installation-set.ts:301` — интерполяция `error.message` в текст
- `services/rag-sync-service/src/rag/rag-features.ts:15` — `message: error.message`
- `services/skills-service/src/skills/feature-policy.guard.ts:80` — `message: error.message`
- SDK: `mcp/neurocenter-asset-sync/src/lib/stdio.ts:35` `errMsg(e)` → `fail(errMsg(e))` (`index.ts:169` все tool'ы); CLI `index.ts:123,158` (stdout error)

**Proxy-нормализация:**
- `services/api-gateway/src/proxy/proxy.service.ts:412-419` — catch: log `error.message` (ok, server-лог) + `502 {error:'upstream-unavailable'}` (фикс — усилить: 504 для timeout, upstream 5xx-нормализация)
- `proxy.service.ts:557-559` — deviceChannel catch: `502 'Сервис подключений недоступен.'` (уже фикс)
- upstream 5xx-нормализация — в `forward()` (копирует status+body: добавить 5xx→fixed-body)

**Shadowing-диагностика:**
- `proxy.controller.ts:31` (catch-all) + `route-policy.ts` (entry 8): явный роут, дошедший до catch-all → диагностика (route+pattern+expected) в log, фиксированный client-body
- Тест: `scripts/test/route-shadowing-diagnostic.test.mjs` (new): симуляция (catch-all на явном роуте) → assert log-поле route+pattern

**Тесты (новые/расширенные):** static-инвариант «no passthrough» (grep по `message: (error|err|e|failure)\.message` + allowlist); proxy-нормализация (5xx fixed, 4xx domain passthrough, no hostname:port в body); shadowing-диагностика; SDK errMsg-mapping. Регистрация в `check-tooling-tests.json` + expectedFiles.

## Tasks & Acceptance

**Execution:**
- [ ] Inventory-фикс 17 точек: фиксированные body (code + user-safe) или явный allowlist (документ + тест)
- [ ] Proxy-нормализация: upstream 5xx → fixed-body (status сохранён); axios-транспорт → 502/504 фиксированные; hostname:port — только log
- [ ] Shadowing-диагностика: catch-all на явном роуте (таблица entry 8) → log route+pattern+expected + фиксированный client-body; тест
- [ ] SDK: `errMsg`-маппинг (инфраструктурные → user-safe фиксированные; детали → local-лог); CLI stdout — фиксированные коды
- [ ] Static-инвариант «no passthrough outside allowlist» + allowlist-тест; регистрация

**Acceptance Criteria:**
- Given axios-ошибка с hostname:port (ECONNREFUSED internal), when external response, then hostname:port в body НЕТ (фиксированный text); в server-логе — да.
- Given upstream 5xx, when proxy, then status сохранён, body фиксированный; 4xx domain (allowlist) — как есть.
- Given shadowed explicit route, when catch-all отвечает, then server-лог содержит route + pattern + expected controller (actionable), client — фиксированный actionable (не generic).
- Given SDK spawn ENOENT, when tool-result, then user-safe фиксированное сообщение (не raw `error.message`).
- Static-тест: `error.message`-passthrough в external-body только allowlist (0 вне).
- Корневой сьют — без деградации против baseline.

## Implementation Notes

Allowlist = validated domain-ошибки, где ТЕКСТ — часть доменного контракта с клиентом (UI показывает его напрямую): пример — `assertExpectedBinding`/`managedBinding` (device-compatibility.ts: «Папка проекта изменилась...»), `requireFeaturesEnabled` (фича отключена — текст домена), `installation-set` (зависимость — имя+версия из данных, не exception). Критерий allowlist: текст формируется из **данных домена** (имя папки/зависимости/фичи), а не из `Exception.message` (stack/транспорт). Passthrough-фикс: `code` (машина-читаемый, стабильный) + `message` (фиксированный или domain-данные). Shadowing-диагностика использует таблицу entry 8: `matchPolicy` знает, что роут ЯВНЫЙ (есть строка, не default) → если запрос дошёл до `ProxyService.forward` по строке, которая НЕ default → incident. Log-формат: `[api-gateway] shadowing: route=POST /api/mcp-host/connect pattern=api/{*path} expected=McpHostController.connect`.

## Plan Change Log

- 2026-11-11: status → done без отдельного merge-коммита. Содержимое entry уже в main через `4e6afb4c` («feat: entry 2.10 — error-body-политика (AD-19)», Nov 10): byte-идентично во всех 23 файлах (`git diff 4e6afb4c b88a5753` по зонам 2.10 пуст, проверка сабэджентом read-only). Мерж worktree `entry-2-10` не выполняется: добавляет только 2 ложных add/add-конфликта (shadowing-diagnostic, доработанный 2.13 K3.1) и регрессит 2.13. Worktree/ветка — удалить.

## Review Triage Log

## Design Notes

1. **5xx-нормализация меняет поведение 502→(502/504).** Сейчас любой транспортный сбой = 502. Раздельно: connect-refused/DNS = 502 (upstream unavailable), timeout = 504 (gateway timeout). Status-семантика для клиента улучшается; retry-логика клиента (если есть по 502) — проверить при реализации (OQ1).
2. **SDK errMsg: «client» = OpenCode/пользователь.** MCP tool-результат читает оператор в UI Нейроцентра — это external-body по AD-19. Raw `spawn ENOENT: no such file... /home/user/.local/bin/opencode` раскрывает ФС-структуру устройства — user-safe: «Локальный исполняемый файл не найден. Обновите мост.»; детали в local-лог bridge (worker).

## Open Questions (с рекомендациями)

- **OQ1 — 502→504 split ломает клиентские retry?** Рекомендация: проверить retry-логику фронта/моста (grep по status 502/504); если клиент retry'ит по 502 — добавить 504 в тот же набор. Подтвердить при реализации.
- **OQ2 — Upstream 5xx: всегда fixed-body или только при обнаружении internal-паттернов (hostname:port)?** Рекомендация: всегда fixed-body для 5xx (5xx = internal по определению; 4xx = домен). Строже и проще; domain-тексты живут в 4xx. Подтвердить.
- **OQ3 — Shadowing-диагностика: log + client, или log только?** AD-19 требует actionable (не generic «не разрешил») — client видит actionable-текст («Маршрут временно недоступен из-за ошибки конфигурации. Повторите позже.»), оператору — log c route+pattern. Рекомендация: оба. Подтвердить.

## Verification

**Commands:** (node-тесты — только `$NODE`)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `$NODE scripts/test/error-body-policy.test.mjs` (new) — expected: 0 hostname:port в external-body, 5xx fixed, 4xx domain passthrough, no-passthrough static (allowlist только)
- `$NODE scripts/test/route-shadowing-diagnostic.test.mjs` (new) — expected: log содержит route+pattern+expected; client — фиксированный actionable
- `cd services/api-gateway && npm run build && cd services/catalog-service && npm run build` — сервисные сьюты без регрессии
- `grep -rnE "message: *(error|err|e|failure)\.message" services/*/src mcp/*/src --include="*.ts"` — expected: только allowlist-точки (перечислены в тесте)
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации
