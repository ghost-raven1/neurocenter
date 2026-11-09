---
title: 'Route-политика: декларативная таблица + completeness-тест + default-бюджеты (AD-6, entry 8)'
type: 'feature'
ticket: '8'
created: '2026-11-09'
status: done
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'high'
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

**Problem:** Бюджеты маршрутов gateway закодированы в диспетчерской логике прокси разрозненными inline-константами: `proxy.service.ts:364-372` (model-chats 64MB body, bridge-source/check 60s, tool-builds repository/npm 85s), `model-inference-forward.ts:37-38` (610s/910s, body 8/64MB), `tool-import-forward.ts:24` (540s), `proxy.service.ts:570,634` (embedding 115s×2), `device-channel-json.ts:4` (600KB), `tool-supply-stream.ts:48` (`maxContentLength: Infinity` — вся память), `bridge-supply.service.ts:27,189`. Нет единого места, где видно «какой маршрут какой бюджет имеет»; нет completeness-гарантии (новый маршрут = молча default без explicit-бюджета); default-маршрут (catch-all) — `Infinity`-ответ в tool-supply-stream, т.е. `maxResponseBytes: ∞`, прямо запрещённый AD-6.

**Approach:** Gateway владеет декларативной таблицей роут-политики: `route → {timeoutMs?, maxBodyBytes?, maxResponseBytes?, allowed?, rateLimit?}` — данные, не логика. Прокси (`ProxyService.forward` + special-forward'ы) — чистый механизм: читает таблицу, применяет. Таблица покрывает ВСЕ маршруты gateway (24 явных паттерна — см. Code Map — + special-подмаршруты прокси + default-маршрут). Default-маршрут — explicit бюджеты; `∞`/`Infinity`/`-1` запрещён (static-тест). Completeness-тест: каждый зарегистрированный в собранном app NestJS-маршрут обязан иметь строку в таблице (default-deny на уровне конфигурации); special-forward'ы прокси обязаны иметь строку (механизм-тест: в диспетчерском коде прокси нет inline-бюджетов). Completeness-тест — РАЗНЫЙ от shadowing-теста (entry 3): shadowing доказывает, КТО отвечает (dispatch-порядок), completeness доказывает, что У КАЖДОГО маршрута есть политика (конфигурация). Оба обязательны.

## Boundaries & Constraints

**Always:**
- Таблица — декларативные данные в `services/api-gateway/src/proxy/route-policy.ts` (+ типы): маршрутные строки (method + path-паттерн) + proxy-подмаршруты (supplyPath-паттерны внутри catch-all) + default-строка. Каждая строка: `{timeoutMs?, maxBodyBytes?, maxResponseBytes?, allowed?, rateLimit?}` (все поля опциональные, кроме default-строки, у которой `maxResponseBytes` ОБЯЗАТЕЛЕН).
- Прокси применяет таблицу: `forward()`/special-forward'ы получают бюджеты из `matchPolicy(path, method)`; в диспетчерском коде (`proxy.service.ts`, `*-forward.ts`, `*-stream.ts`) inline-таймаутов/лимитов больше нет (они переехали в таблицу со СТЕСМИ значениями — это чистый перенос, без изменения чисел).
- Default-маршрут (catch-all `/api/{*path}`) — explicit `maxResponseBytes` (finite); `Infinity`/`maxContentLength: -1` в ответном бюджете запрещён (static-тест по коду).
- Completeness-тест на собранном `AppModule` (интроспекция `router.stack`, паттерн entry 3): каждый NestJS-маршрут (все контроллеры + post-create `/api/docs`) имеет строку политики или явно помечен как covered-by-default; special-forward'ы — по описи механизмов прокси (каждый вызов special-forward'а соответствует строке).
- `allowed` — методы маршрута из декораторов (тест сверяет таблицу с реальными методами: строка с method'ом, которого нет в декораторе = фэйл).
- Значения в этом entry = ТЕКУЩИЕ (480/540/550, 610/910/920, 115, 64MB, 50mb, 600KB, 85s, 60s, 15s, 30s-default...) — изменение значений/лестниц/nginx-кромки/body-выравнивание/PG-rate-limit — entry 9.

**Never:**
- Не менять значения бюджетов (лестницы, nginx, body-выравнивание) — entry 9; не менять порядок регистрации (entry 3); не вносить PG rate-limit (entry 9).
- Не вводить `∞`/`Infinity`/`-1` в `maxResponseBytes`/`maxBodyBytes` (static-тест).
- Не делать completeness-тест дублем shadowing-теста (entry 3) — разная цель, разные ассерты; не убирать/не переносить контроллеры (только читать их маршруты).
- Не трогать body-парсер `main.ts` (50mb json + content-route-обход) — его значения становятся строками таблицы, но код main.ts правится минимально (только чтение из таблицы); выравнивание nginx≤gateway≤upstream — entry 9.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ROUTE_MATCHED | явный маршрут с таблицей (напр. `POST /api/mcp-host/connect`) | dispatch + политика строки (timeout/body/response/allowed) | No error |
| DEFAULT_MATCHED | `/api/whatever` (не явный) | catch-all + default-строка (explicit finite бюджеты) | No error |
| COMPLETENESS_MISS | новый маршрут без строки в таблице | completeness-тест ФЕЙЛ: «маршрут без политики: METHOD /path» | actionable |
| INFINITE_BUDGET | `maxResponseBytes: Infinity` (или `maxContentLength: -1`) | static-тест ФЕЙЛ: «unbounded response budget» | actionable |
| METHOD_DRIFT | строка таблицы с method'ом, отсутствующим в декораторе | completeness-тест ФЕЙЛ (drift таблица↔код) | actionable |
| PROXY_INLINE_BUDGET | `timeout:`/`maxContentLength:` в `proxy.service.ts`/`*-forward.ts`/`*-stream.ts` | механизм-тест ФЕЙЛ: «inline-бюджет вне таблицы» | actionable |
| SPECIAL_FORWARD | special-forward без строки proxy-подмаршрута | completeness-тест ФЕЙЛ: «forward без политики: /path» | actionable |
| RATE_LIMIT_FIELD | строка с `rateLimit` (заготовка) | поле парсится и валидируется (применение — entry 9) | No error |
| SHADOWING_REGRESSION | catch-all снова первым (entry 3 не применён/откат) | shadowing-тест entry 3 фэйлит (completeness при этом может быть зелёным — тесты разные) | — |

</frozen-after-approval>

## Code Map

**Где живут бюджеты СЕЙЧАС (все переносятся в таблицу со стежими значениями):**
- `services/api-gateway/src/proxy/proxy.service.ts:364-372` — inline: model-chats `maxContentLength: 64MB`; `POST /api/bridge-source/check` `timeout: 60000`; `GET /api/tool-builds/(repository|npm)` `timeout: 85000`; базовый `http = axios.create({timeout: 30000})` `:80`
- `services/api-gateway/src/proxy/model-inference-forward.ts:37-38` — `timeout: savedChat ? MODEL_CHAT_GATEWAY_TIMEOUT_MS : 610000`, `maxContentLength: (savedChat ? 64 : 8) * 1024 * 1024`
- `services/api-gateway/src/proxy/tool-import-forward.ts:24` — `timeout: TOOL_IMPORT_GATEWAY_TIMEOUT_MS` (540s, `services/shared/tool-import-deadline.cjs`)
- `services/api-gateway/src/proxy/proxy.service.ts:570,634` — embedding: client-timer `115000` + catalog `timeout: 115000` (race — значение чинит entry 9)
- `services/api-gateway/src/proxy/device-channel-json.ts:4` — `express.json({limit: 600*1024})` для `/api/device-channel`
- `services/api-gateway/src/proxy/tool-supply-stream.ts:48` — `maxContentLength: Infinity` (∞ — запрещён, заменить explicit)
- `services/api-gateway/src/proxy/discussion-attachment-download.ts:27` — `DISCUSSION_ATTACHMENT_MAX_BYTES`; `gguf-import-stream.ts:18` — 1MB chunk
- `services/api-gateway/src/bridge/bridge-supply.service.ts:27,189` — `128KB`, `artifact.bytes`
- `services/api-gateway/src/main.ts:38` — `express.json({limit: '50mb'})` (global) + content-route-обход `:34-43`; `:52-53` socket.io `/socket.io`

**Маршруты (24 явных паттерна, проверено по main):**
- `app.controller.ts` `@Controller()`: `GET /ready` :9, `GET /ready/dependencies` :15, `GET /health` :39
- `bridge/bridge.controller.ts` `@Controller(['bridge','api/bridge'])` (11 × 2 префикса): `GET config` :22, `install.sh` :51, `connect.sh` :57, `connect.ps1` :63, `install_opencode.sh` :74, `install.ps1` :80, `install_opencode.ps1` :86, `install_workspace.sh` :92, `install_workspace.ps1` :98, `opencode/:file` :104, `runtime/:file` :119
- `bridge/opencode-cli-supply.controller.ts` `@Controller('internal/bridge/opencode-cli-supply')`: `GET :target` :21
- `features/mcp-host/mcp-host.controller.ts` `@Controller('api/mcp-host')`: `POST /api/mcp-host/connect` :48 (axios→catalog `timeout: 15000` :78 — в таблицу), `ALL /api/mcp-host/m/:ticket` :140
- `features/research-mcp/research-mcp.controller.ts` `@Controller('internal/research-mcp')`: `POST list` :24, `POST call` :34
- `features/system-role-mcp/system-role-mcp.controller.ts` `@Controller('internal/system-role-mcp')`: `POST execute` :90, `POST close` :167
- `live/live.controller.ts` `@Controller('internal/events')`: `POST /internal/events` :9
- `proxy/proxy.controller.ts` `@Controller('api')`: `@All('{*path}')` :31 — catch-all (default-строка)
- post-create (вне NestJS-модулей): `/api/docs` + `/api/docs/*` (GET/HEAD, `docs/setup-api-documentation.ts:54`, регистрируется ПОСЛЕ bootstrap — empirically переживает catch-all, тест `scripts/test/api-documentation-http.test.cjs`), `/socket.io` (WS, `main.ts:52`)

**Механизм (НОВЫЙ):**
- `services/api-gateway/src/proxy/route-policy.ts` (new) — таблица + `matchPolicy(path, method)` + типы; default-строка с обязательным finite `maxResponseBytes`
- `proxy.service.ts` — `forward()`/special-forward'ы читают таблицу (перенос inline-бюджетов, значения те же)
- Тест (НОВЫЙ): `scripts/test/route-policy-completeness.test.mjs` — (а) собран `AppModule` (без PG: `LiveService`/`AuthGuardService`/`ProxyService` не коннектят при init — проверено), интроспекция `app.getHttpAdapter().getInstance()._router.stack` → все NestJS-маршруты (метод+паттерн) → каждая строка в таблице; (б) static: в `proxy.service.ts`/`*-forward.ts`/`*-stream.ts` нет `timeout:`/`maxContentLength:`/`Infinity` вне `route-policy.ts`; (в) special-forward-опись: каждый forward-вызов (`forwardModelInference`, `forwardToolImport`, `forwardBackupDownload`, `deviceEmbedding`, streams) имеет строку proxy-подмаршрута. Регистрация `check-tooling-tests.json` + expectedFiles.

## Tasks & Acceptance

**Execution:**
- [ ] `route-policy.ts` (new): типы + таблица (24 явных + proxy-подмаршруты + default со стежими текущими значениями) + `matchPolicy`
- [ ] Перенос inline-бюджетов в таблицу: `proxy.service.ts:364-372`, `model-inference-forward.ts:37-38`, `tool-import-forward.ts:24`, embedding :570/:634, `device-channel-json.ts`, `tool-supply-stream.ts:48` (∞ → explicit finite, значение = текущий effective limit — OQ1), `bridge-supply.service.ts`; `main.ts` json-лимит — строка таблицы
- [ ] `proxy.service.ts` — `forward()` применяет `matchPolicy` (default-строка для catch-all)
- [ ] `scripts/test/route-policy-completeness.test.mjs` (new): completeness (router.stack ↔ таблица), method-drift, static «no inline budgets», special-forward-опись; регистрация
- [ ] (entry 9 подключится к таблице: значения лестниц, nginx-кромка, body-выравнивание, `rateLimit` в PG — НЕ сюда)

**Acceptance Criteria:**
- Given любой явный маршрут gateway, when `matchPolicy`, then строка политики существует (completeness-тест зелёный); новый маршрут без строки → completeness-тест фэйл с указанием METHOD /path.
- Given catch-all (`/api/{*path}`), when dispatch, then default-строка с explicit finite `maxResponseBytes`; `Infinity`/`-1` в бюджете → static-тест фэйл.
- Given диспетчерский код прокси, when static-скан, then inline-таймаутов/лимитов нет (все в `route-policy.ts`).
- Given special-forward (inference/tool-import/backup/embedding/streams), when опись, then каждый имеет строку proxy-подмаршрута.
- Given значения после переноса, when сравнение с baseline, then числа идентичны (чистый перенос: 480/540/550, 610/910, 115/115, 64MB, 50mb, 600KB, 85s, 60s, 15s, 30s).
- Shadowing-тест (entry 3) и completeness — разные сьюты, оба зелёные; корневой сьют — без деградации против baseline.

## Implementation Notes

Почему два слоя строк (маршруты + proxy-подмаршруты): catch-all делегирует `/api/*` в `ProxyService.forward`, где по `supplyPath` выбираются special-forward'ы — их бюджеты (inference 610/910, tool-import 540, attachment/backup/embedding) сегодня и есть «тайминги, закодированные в диспетчерской логике» (AD-6 prevents). Таблица должна покрывать И NestJS-маршруты (completeness через router.stack), И proxy-подмаршруты (опись forward-вызовов). Default-строка — для остального `/api/*` (текущий effective: axios 30s timeout, json 50mb body, response — bounded finite, ∞ у tool-supply-stream заменяется). Post-create маршруты (`/api/docs`, `/socket.io`) — явные строки (доки: GET/HEAD only; socket.io — WS, бюджеты не применимы, строка с `allowed: ['WS']`-маркером). Метод-интроспекция из router.stack: layer.route.methods + layer.route.path (path-to-regexp) — нормализовать `{*path}` → `*` для сопоставления с таблицей.

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Completeness ≠ shadowing (entry 3).** Shadowing-тест (entry 3) — dispatch: «какой handler отвечает» (порядок в router.stack). Completeness-тест — конфигурация: «у каждого маршрута есть политика». Таблица без dispatch-теста не ловит регрессию порядка регистрации (все строки на месте, а маршрут поглощён catch-all); dispatch-тест без таблицы не ловит новый маршрут без бюджета. tickets.toml entry 8 явно: «оба обязательны».
2. **∞ в tool-supply-stream.** `tool-supply-stream.ts:48 maxContentLength: Infinity` — сейчас «ответ без лимита». AD-6: default `maxResponseBytes: ∞` запрещён. Explicit finite замена — значение = OQ1 (рекомендация: 2 GiB = ceiling unpacked из entry 1/2 — tool-supply это runtime-артефакты; если конкретный маршрут уже имеет `artifact.bytes`-лимит (`bridge-supply.service.ts:189`), таблица несёт его).
3. **Значения не меняются в этом entry.** Entry 8 — перенос + механизм + completeness; entry 9 — значения (лестницы из base+margins, nginx-кромка 600s→per-route, embedding 115==115→margin>0, body nginx≤gateway≤upstream, PG rate-limit). Граница позволяет независимые ревью и мержи.

## Open Questions (с рекомендациями)

- **OQ1 — `maxResponseBytes` для tool-supply (∞ → какое finite)?** Рекомендация: 2 GiB (ceiling `unpackedBytes` entry 1/2) как default-ответный бюджет catch-all; маршруты с `artifact.bytes` (bridge-supply) — своя строка. Подтвердить при реализации.
- **OQ2 — `main.ts` json-лимит (50mb): читать из таблицы или оставить в main?** Рекомендация: читать из таблицы (default-строка `maxBodyBytes`), main.ts — тонкий wrapper; content-route-обход (gguf/attachment/source/snapshot/archive) остаётся в main (это обход body-парсера, не бюджет).
- **OQ3 — Строка по каждому префиксу bridge (22 URL) или канонический паттерн с нормализацией `api/`?** Рекомендация: канонический паттерн `/bridge/*` + нормализация (matcher опционально снимает `api/`-префикс) — меньше строк, меньше drift'а; completeness-тест нормализует так же.

## Verification

**Commands:** (node-тесты — только `$NODE`)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `cd services/api-gateway && npm run build` → `$NODE scripts/test/route-policy-completeness.test.mjs` — expected: completeness зелёный (все 24 маршрута + post-create + default покрыты), static «no inline budgets» зелёный, special-forward-опись зелёная
- `$NODE scripts/test/mcp-host-route-shadowing.test.mjs` (entry 3) — expected: без регрессии (тесты независимы)
- `$NODE scripts/test/api-documentation-http.test.cjs` — expected: без регрессии (доки переживают catch-all, строки `/api/docs` в таблице не ломают dispatch)
- `grep -nE "timeout:|maxContentLength:|Infinity" services/api-gateway/src/proxy/*.ts` — expected: только `route-policy.ts` (и значения-заготовки, не dispatch-код)
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации (287 файлов, 3693 pass / 0 fail / 38 skipped)
