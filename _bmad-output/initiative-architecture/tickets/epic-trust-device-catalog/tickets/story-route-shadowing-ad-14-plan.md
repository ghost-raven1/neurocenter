---
title: 'Route shadowing: catch-all после явных роутов + регрессионный тест (AD-14, entry 3)'
type: 'bugfix'
ticket: '3'
created: '2026-11-09'
status: 'ready-for-dev'
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
  - '_bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/epic-trust-device-catalog.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** CRIT-дефект (recon v2, подтверждено живым прогоном): catch-all прокси `ProxyController` (`@Controller('api')` + `@All('{*path}')`, `proxy.controller.ts:10,21`) стоит ПЕРВЫМ в списке контроллеров `ProxyModule` (`proxy.module.ts:16`). Express/Nest матчит роуты по порядку регистрации — catch-all `api/{*path}` поглощает ВСЕ явные роуты под префиксом `api`, включая `McpHostController` (`/api/mcp-host/connect`, `/api/mcp-host/m/:ticket`) — **mcp-host мёртвый код в production**. Жертвы shadowing — все контроллеры ProxyModule, зарегистрированные после ProxyController. Существующий `mcp-host-access-http.test.mjs` создаёт per-controller изолированный Nest app (без ProxyController) — он НЕ ловит shadowing, поэтому дефект не замечен.

**Approach:** Фикс — порядок регистрации: catch-all `ProxyController` регистрируется ПОСЛЕ всех явных контроллеров ProxyModule (mcp-host, research-mcp, system-role-mcp). Shadowing-тест = регрессионный: каждый явный роут каждого контроллера ProxyModule достижим через СОБРАННЫЙ app (полный `AppModule` с ProxyModule), а не per-controller изолированно; роут, поглощённый catch-all = фэйл сьюта.

## Boundaries & Constraints

**Always:**
- Порядок в `proxy.module.ts:16`: `[McpHostController, ResearchMcpController, SystemRoleMcpGatewayController, ProxyController]` — catch-all ПОСЛЕ явных.
- Shadowing-тест — на СОБРАННОМ app (полный `AppModule` → `ProxyModule`), не per-controller: для каждого явного роута каждого контроллера ProxyModule — маршрут достижим и матчит явный handler, не catch-all `api/{*path}`.
- Метод теста: интроспекция Express-router'а собранного app (`app.getHttpAdapter().getInstance()._router.stack`) — для явного path (напр. `POST /api/mcp-host/connect`) первый matching layer = явный handler (McpHostController), не ProxyController.all; ЛИБО live-запрос через собранный app отвечает явным handler'ом (не proxy-forward на catalog).
- Покрытие: все явные роуты всех контроллеров ProxyModule (mcp-host `connect` + `m/:ticket`; research-mcp `list`+`call`; system-role-mcp `execute`+`close`).
- Shadowing-тест и completeness-тест роут-таблицы (entry 8) — РАЗНЫЕ тесты, оба обязательны.

**Never:**
- Не переносить явные контроллеры из ProxyModule (они остаются там); фикс — только порядок.
- Не изменять поведение catch-all (он по-прежнему проксирует `/api/*`, не покрытое явными роутами, на catalog).
- Не полагаться на per-controller изолированные тесты для shadowing (анти-паттерн `mcp-host-access-http.test.mjs`).
- Не трогать root-контроллеры `AppModule` (AppController/BridgeController/OpenCodeCliSupplyController — регистрируются раньше ProxyModule, не в тени) и `/internal/*` (вне префикса `api`, не в тени).
- Не менять роут-таблицу/бюджеты (entry 8/9) — здесь только порядок регистрации + регрессионный тест.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| ORDER_FIXED | catch-all после явных в ProxyModule | явные роуты матчат явные handler'ы | No error |
| MCPHOST_CONNECT | `POST /api/mcp-host/connect` на собранном app | матчит McpHostController.connect (не proxy-forward) | No error |
| MCPHOST_CHANNEL | `ALL /api/mcp-host/m/:ticket` на собранном app | матчит McpHostController.channel | No error |
| RESEARCH_ROUTES | `POST /internal/research-mcp/{list,call}` | матчит ResearchMcpController (не в тени, но покрыт тестом) | No error |
| SYSTEMROLE_ROUTES | `POST /internal/system-role-mcp/{execute,close}` | матчит SystemRoleMcpGatewayController | No error |
| CATCHALL_FALLTHROUGH | `GET /api/other-route` (не явный) | матчит ProxyController.all → proxy на catalog | No error |
| REGRESSION_ORDER | catch-all снова первым | shadowing-тест фейлит (явный роут поглощён) | actionable «роут поглощён catch-all» |

</frozen-after-approval>

## Code Map

- `services/api-gateway/src/proxy/proxy.module.ts:16` — `controllers: [ProxyController, McpHostController, ResearchMcpController, SystemRoleMcpGatewayController]` → переупорядочить: catch-all `ProxyController` ПОСЛЕ
- `services/api-gateway/src/proxy/proxy.controller.ts:10,21` — `@Controller('api')` + `@All('{*path}')` — catch-all (поведение не меняется)
- `services/api-gateway/src/features/mcp-host/mcp-host.controller.ts:28,48,140` — `@Controller('api/mcp-host')`, `@Post('connect')`, `@All('m/:ticket')` — жертвы shadowing
- `services/api-gateway/src/features/research-mcp/research-mcp.controller.ts:21,24,34` — `@Controller('internal/research-mcp')`, `list`/`call`
- `services/api-gateway/src/features/system-role-mcp/system-role-mcp.controller.ts:23,90,167` — `@Controller('internal/system-role-mcp')`, `execute`/`close`
- `services/api-gateway/src/app.module.ts:15-21` — root-контроллеры `[AppController, BridgeController, OpenCodeCliSupplyController]` (регистрация до ProxyModule — не в тени; контекст)
- `services/api-gateway/src/bridge/bridge.controller.ts:13` — `@Controller(['bridge','api/bridge'])` (root-level, не в тени — контекст)
- Тест (НОВЫЙ): `scripts/test/mcp-host-route-shadowing.test.mjs` — сборка полного AppModule, интроспекция/ live-запросы; регистрация `check-tooling-tests.json` + expectedFiles
- Анти-паттерн (контекст, не менять): `scripts/test/mcp-host-access-http.test.mjs:16-30` (per-controller изолированный app)

## Tasks & Acceptance

**Execution:**
- [ ] `proxy.module.ts` — переупорядочить `controllers`: `[McpHostController, ResearchMcpController, SystemRoleMcpGatewayController, ProxyController]`
- [ ] Новый `scripts/test/mcp-host-route-shadowing.test.mjs`: собрать полный `AppModule` (gateway); для каждого явного роута каждого контроллера ProxyModule — интроспекция router.stack (первый matching layer = явный handler, не `api/{*path}`) ИЛИ live-запрос → явный ответ; роут, поглощённый catch-all = фэйл
- [ ] Регистрация теста: `scripts/workspace/check-tooling-tests.json` + expectedFiles `scripts/test/workspace-check-tooling.test.mjs`

**Acceptance Criteria:**
- Given `proxy.module.ts` с catch-all ПОСЛЕ явных, when сборка полного app, then порядок регистрации: явные до catch-all (тест порядка).
- Given `POST /api/mcp-host/connect` и `ALL /api/mcp-host/m/:ticket` на СОБРАННОМ app, when dispatch, then матчат McpHostController (не ProxyController.all proxy-forward).
- Given все явные роуты всех контроллеров ProxyModule (mcp-host/research-mcp/system-role-mcp), when shadowing-тест, then каждый достижим через явный handler.
- Given регрессия (catch-all снова первым), when shadowing-тест, then фэйл с actionable «роут поглощён catch-all».
- `GET /api/other-route` (не явный) → catch-all proxy на catalog (поведение сохранено).
- Корневой сьют — без деградации против baseline.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Почему именно порядок, а не приоритет: Nest/Express матчит по порядку регистрации в router.stack; явного «приоритета» у роутов нет. AD-14 — «catch-all `{*path}` регистрируется после всех явных роутов (или явные роуты явно имеют приоритет)». Переупорядочивание массива `controllers` — минимальный, точечный фикс, не меняющий поведение catch-all. Почему тест на собранном app, а не per-controller: per-controller изолированный app (`mcp-host-access-http.test.mjs`) не включает ProxyController → shadowing невидим; только полный `AppModule` воспроизводит production-порядок. Интроспекция `._router.stack` — прямой способ доказать, что явный path матчит явный handler раньше catch-all (детерминированно, без live-upstream). Альтернатива — live-запрос с assertion на ответ явного handler; оба допустимы, интроспекция быстрее и не требует upstream.

## Open Questions

- **OQ:** метод shadowing-теста — интроспекция `._router.stack` (детерминированный, без upstream) или live-запрос через собранный app (ближе к production, нужен mock upstream). Рекомендация: интроспекция + один live-запрос smoke. Подтвердить при реализации.
- **OQ:** фикс — только порядок массива, или добавить явный guard (тест, запрещющий ProxyController первым)? Рекомендация: тест порядка (shadowing-тест уже ловит).

## Verification

**Commands:** (node-тесты — только `$NODE`)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `cd services/api-gateway && npm run build` → `$NODE scripts/test/mcp-host-route-shadowing.test.mjs` — expected: все явные роуты ProxyModule достижимы (0 поглощений catch-all)
- `$NODE scripts/test/workspace-check-tooling.test.mjs` — expected: новый тест в fixed-списке
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации (287 файлов, 3693 pass / 0 fail / 38 skipped)
