---
title: 'Единая лог-схема: shared/logging.cjs + correlation id (AD-O1/O2)'
type: 'feature'
ticket: '6'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-observability/architecture-observability.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
  - frontend/nginx.production.conf.template
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-O1: единая лог-схема (JSON lines в stdout: ts RFC3339 UTC / level / service / requestId / msg / err-структура). В main схема отсутствует: raw `console.log/error` в 6 main.ts (catalog:52, gateway:115, skills:37, ff:15, rag:38, oauth:28) + feature-коде (proxy.service.ts:414, auth-guard.service.ts:112, oauth auth.controller.ts:89) + Nest `Logger(...)` в 8 местах (catalog.service.ts:50, database/pool.ts:6 ×2, flags.service.ts:17, skill-audit-outbox.ts:17, auto-update.service.ts:59, hosting.service.ts:39, package-build.service.ts:113) — три разных формата в одном стеке, поиск инцидента = три разных инструмента. AD-O2: requestId обязателен в каждом сервис-логе и во всех внутренних вызовах — сейчас `X-Request-ID` middleware нигде нет (nginx уже шлёт `$request_id` только для /auth/ и /api/, template :38/:44/:55/:63/:70; /socket.io/ :72-78 — не шлёт), сервисы заголовок не читают.

**Approach:** (1) новый shared-модуль `services/shared/logging.cjs` (+.d.cts, PREPARED_SOURCE_INPUTS): `createLogger(service)` → {info, warn, error, child(bindings)}; JSON line в stdout: {ts, level, service, requestId, msg, err: {name, code, causeCode} (AD-O8 — только allowlist-поля), ...bindings}; requestId из AsyncLocalStorage-контекста (отсутствует → «background»-маркер, фоновые работы кладут jobId в то же поле); (2) shared middleware `request-context.cjs`: читает `X-Request-ID` (нет → генерация UUID4), кладёт в ALS, повторяет в ответном заголовке; включается в 6 main.ts (рядом с createObservability.middleware, catalog main.ts:22 — паттерн врезки); (3) прокидка во ВСЕ внутренние HTTP-вызовы: gateway proxy (proxy.service.ts — fetch upstream), catalog → rag/skills (fetch-вызовы), outbox-доставки (skill-audit-outbox deliver); (4) замена: console.* в 6 main.ts + 3 feature-точки → shared logger; Nest Logger в 8 местах → shared logger (Nest-формат не несёт requestId/JSON-схему); CLI/setup-скрипты (migrate.cli.ts, production-init.cli.ts, bootstrap-admin.cli.ts, import.cli.ts) — за скобками (профиль не production-рантайм, allowlist drift-теста); (5) retention: json-file в x-service anchor (compose.production.yml:7-9, 10m×3 ≈ 30 МБ) — поднять для gateway/catalog (OQ-1). Долговременная видимость инцидентов — не через retention (AD-O5, entry 10).

## Boundaries & Constraints

**Always:**
- JSON line в stdout (docker json-file захватывает) — один формат во всех 6 сервисах; schema: ts/level/service/requestId/msg/err(+bindings).
- err — только allowlist-поля (name, code, cause.code — AD-O8; entry 7 доводит инвентарь, здесь — формат).
- X-Request-ID: входящий заголовок уважается; отсутствует → UUID4 (детерминированность сквозной трассировки nginx→gateway→сервис).
- Все внутренние HTTP-вызовы несут X-Request-ID (drift-тест на fetch-обёртку).
- Background-работы (backup-тик, queue, job-leases, outbox-flush) — jobId в поле requestId (корреляция «фоновая работа → её лог-строки»).

**Never:**
- Не писать логи в файлы напрямую (только stdout → docker logging driver; retention — compose-опции).
- Не логировать error.message / тела запросов / заголовки / URL-параметры (AD-O8/AD-19 — entry 7 sweep).
- Не менять Nest DI/структуру сервисов ради логгера (logger — инъекция значения, не рефакторинг).
- Не трогать nginx log_format (entry 7 — m/:ticket маска).
- Не валидировать/читать env при импорте logging.cjs (ленивость — ратификация AD-7).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Запрос через nginx /api/ | X-Request-ID от nginx ($request_id) | сервис-лог: requestId == значение nginx; response-заголовок возвращён |
| 2 | Запрос без заголовка (прямой) | нет X-Request-ID | сгенерирован UUID4, сквозной (лог + ответ) |
| 3 | Внутренний вызов gateway→catalog | proxy-запрос | catalog-лог несёт тот же requestId |
| 4 | Фоновая работа (backup-тик) | запуск по расписанию | jobId в поле requestId; строки тика группируются |
| 5 | Ошибка (throw) | error с code/cause | err: {name, code, causeCode} — без message |
| 6 | Лог-строка без requestId | любой log-вызов вне контекста | строка с requestId="background" (не null/отсутствие — schema-тест) |
| 7 | Drift: console.log в src | grep-тест | фэйл (allowlist: *.cli.ts, CLI-файлы) |
| 8 | /socket.io/ (nginx без X-Request-ID) | websocket-запрос | middleware генерирует UUID4 (regression) |
| 9 | High-load (1000 req/s) | нагрузка | overhead логгера не меняет p95 (benchmark-тест, OQ-3) |

## Code Map

- `services/shared/` — новый модуль logging.cjs (+logging.d.cts) + request-context.cjs (+.d.cts); регистрация в PREPARED_SOURCE_INPUTS (паттерн observability.cjs — уже в списке, services 8-15)
- `services/catalog-service/src/main.ts:22` — врезка middleware (рядом с `createObservability({...}).middleware`); :52 — console.log → logger
- `services/api-gateway/src/main.ts:115` — console.log → logger; `src/proxy/proxy.service.ts:414` — console.error(error.message) → logger.error(safe) + прокидка X-Request-ID в upstream-вызов
- `services/api-gateway/src/auth/auth-guard.service.ts:112` — console.error(error.message) → logger (entry 7 — поле)
- `services/oauth2-bridge/src/main.ts:28` + `src/auth/auth.controller.ts:89` — console.error → logger
- `services/skills-service/src/main.ts:37`, `services/feature-flags-service/src/main.ts:15`, `services/rag-sync-service/src/main.ts:38` — console.log → logger
- Nest Logger → shared: `catalog/catalog.service.ts:50`, `catalog/database/pool.ts:6`, `rag-sync-service/database/pool.ts:6`, `feature-flags/flags.service.ts:17`, `skills/storage/skill-audit-outbox.ts:17` (logger.warn :53), `catalog/plugin-auto-updates/auto-update.service.ts:59`, `catalog/models/hosting.service.ts:39`, `catalog/package-build/package-build.service.ts:113`
- `frontend/nginx.production.conf.template:38,44,55,63,70` — `proxy_set_header X-Request-ID $request_id` (ратификация — не менять); :72-78 /socket.io/ без заголовка (middleware генерирует)
- `compose.production.yml:7-9` — json-file 10m×3 (retention OQ-1)
- `services/shared/observability.cjs:8-15` — канон списка 6 сервисов (logging-схема по тем же именам)
- `scripts/test/` — новый logging.test.mjs (schema/middleware/drift)

## Tasks & Acceptance

### Execution
- [ ] `services/shared/logging.cjs` (+.d.cts): createLogger, JSON-line writer (stdout), err-allowlist (name/code/causeCode), child(), ALS-контекст requestId; PREPARED_SOURCE_INPUTS
- [ ] `services/shared/request-context.cjs` (+.d.cts): middleware (X-Request-ID валидация/генерация UUID4, ALS, response-header) + injectRequestContext(fetch) — обёртка для внутренних вызовов
- [ ] 6 main.ts: middleware до observability + console.log → logger
- [ ] Замена 11 точек (3 feature console.error + 8 Nest Logger) → shared logger; grep-счёт = 0 (allowlist CLI)
- [ ] Прокidка: proxy.service.ts (upstream-вызовы), catalog fetch → rag/skills, skill-audit-outbox deliver — X-Request-ID
- [ ] Background-работы: backup-тик/queue/job-leases/outbox-flush — jobId в контекст (инвентарь точек — в PR-описании)
- [ ] Тесты: logging.test.mjs — schema-строки (все ключи, ts RFC3339 UTC), err без message, UUID4-генерация, прокидка (fetch-обёртка), background-marкер, drift: `console\.(log|error|warn|info)` в services/*/src = 0 (allowlist *.cli.ts/setup)
- [ ] e2e-сегмент (production-stack harness или supertest-цепочка): nginx→gateway→catalog requestId сквозной (заголовок в == requestId в логе)
- [ ] Retention (OQ-1): max-size/max-file для gateway+catalog в compose (recommendation 50m×10) + шапка-комментарий

### Acceptance
- **Given** запрос через nginx с $request_id **when** сервис логирует **then** requestId в лог-строке == значение заголовка, формат JSON со всеми ключами
- **Given** запрос без заголовка **when** middleware **then** UUID4 сгенерирован, в ответе и логе
- **Given** внутренний вызов gateway→catalog **when** catalog логирует **then** тот же requestId
- **Given** `grep -rn "console\.\(log\|error\|warn\|info\)" services/*/src` (excl. CLI) **when** после замены **then** 0 matches (drift-тест зелёный)

## Design Notes

- **AsyncLocalStorage, а не explicit-параметр:** logger-вызовы в deep-коде (repositories) не должны тянуть requestId вручную; ALS даёт «прокидку» без сигнатур. Цена: минимальный overhead (измерить — OQ-3).
- **Nest Logger → shared:** Nest-формат `[Cls] message` не несёт requestId/JSON — схема AD-O1 требует единого формата. Замена механическая (logger.warn → this.log.warn), DI-граф не трогается.
- **CLI за скобками:** migrate.cli/production-init/bootstrap/import — single-shot, оператор читает stdout напрямую; allowlist в drift-teste = честный exception (профиль не production-рантайм).
- **/socket.io/ без nginx-заголовка:** не правим nginx в этой story (entry 7 — nginx-scope); middleware генерирует UUID4 — семантика AD-O2 выполнена.
- **err-формат уже AD-O8-совместим:** {name, code, causeCode} — entry 7 только инвентарит passthrough-точки и доводит drift, формат здесь фиксирован.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/logging.test.mjs
# Drift:
grep -rnE "console\.(log|error|warn|info)" services/*/src --include="*.ts" | grep -v "\.cli\.ts"
# Сквозной requestId (на dev-стеке):
docker compose up -d && curl -H 'X-Request-ID: test-123' -s localhost:8080/api/ready >/dev/null && docker compose logs catalog-service | grep test-123
```
Ожидаемо: logging-тесты зелёные; grep = 0 (allowlist); docker-логи — JSON-строки c requestId=test-123; корневой сьют — без деградации против baseline.

## Open Questions (с рекомендациями)

1. **Retention gateway/catalog**: поднять 10m×3 → 50m×10 (≈500 МБ) vs оставить (30 МБ, «долговременная видимость — AD-O5, не retention»)? Рекомендация: поднять для gateway+catalog (hot-операторская диагностика 1–2 дней), остальные — anchor-значения; зафиксировать в compose-шапке.
2. **UUID4 vs ULID** для сгенерированного requestId: UUID4 (node:crypto randomUUID — уже есть, crypto-безопасный) vs ULID (хронологический)? Рекомендация: UUID4 — nginx $request_id тоже opaque, хронология не требуется.
3. **Overhead-бюджет**: benchmark (1k req/s, p95 Δ < 2 мс) — включить в verification как soft-check? Рекомендация: да, один benchmark-тест (fast-check на writer), не CI-гейт.
4. **Объект-логирование (bindings)**: child({projectId}) в hot-путях — разрешить? Рекомендация: разрешить, но bindings — только fixed-ключи (no произвольные значения — AD-O1 «без произвольных полей»).
