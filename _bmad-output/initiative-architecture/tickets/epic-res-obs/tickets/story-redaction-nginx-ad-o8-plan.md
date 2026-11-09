---
title: 'Redaction: allowlist error-полей + nginx m/:ticket (AD-O8)'
type: 'feature'
ticket: '7'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'medium'
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

**Problem:** AD-O8: в логи попадают только allowlist-поля ошибки (name, code, cause.code); passthrough `error.message` в логи запрещён — message несёт URL/пути/секреты. В main passthrough реально: auth-guard.service.ts:112 (`console.error('... auth check failed:', error.message)`), proxy.service.ts:414 (console.error с message), oauth2-bridge auth.controller.ts:89 (уже только `error.name` — ратификация, сверить). Плюс: nginx access-лог (template:2, `$uri` в каждой строке) пишет полный путь `/api/mcp-host/m/<ticket>` в каждый запрос — ticket = bearer-билет MCP-сессии, json-file-логи (10m×3) = утечка действующего билета в артефакты логов. Диагностика при этом не теряется: requestId (entry 6) → error-store (entry 10).

**Approach:** (1) инвентарь ВСЕХ точек, передающих error.message (или эквивалент: `.message`, `String(error)`, template-string с error) в лог-вызовы в services/*/src (кроме CLI) — каждая заменяется на allowlist-форму через shared logger err-объект (entry 6); (2) drift-тест: статический поиск паттернов `error.message`/`e.message`/`err.message` в аргументах log-вызовов (console.*/logger.*/Logger.*) в services/*/src = фэйл (allowlist: тесты, *.cli.ts); (3) nginx: `map $uri $masked_uri` (regex `^/api/mcp-host/m/[^/]+` → `/api/mcp-host/m/REDACTED`) + log_format `path: $masked_uri` — маска на уровне nginx (owner механизма = этот AD; инвариант AD-5 runtime-trust ссылается, не дублирует); (4) клиенту — только фиксированные сообщения (AD-19, не дублируется; client-facing body — территория error-handling сервисов, здесь только логи).

## Boundaries & Constraints

**Always:**
- err в логах = {name, code, causeCode} (формат entry 6); message — нигде.
- Masking применяется к access-логу (log_format neurocenter) — все location'и проходят один log_format.
- Mask-механизм = nginx map (не post-processing) — маска в момент записи.
- Диагностика сохраняется: requestId → error-store (entry 10) — полный стек только там, в safe-представлении.

**Never:**
- Не маскировать другие пути (только m/:ticket — единственный bearer-сегмент в URL; sweep подтверждает, что других секретных URL-сегментов нет — OQ-2).
- Не менять client-facing ошибки (AD-19 отдельно; здесь — логи).
- Не удалять $request_id из log_format (correlation, entry 6).
- Не вводить allowlist-полей сверх AD-O8 (name/code/cause.code).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | auth-check упал | error с message='token 123456 invalid' | лог: err {name, code, causeCode} — '123456' отсутствует |
| 2 | proxy upstream-ошибка | fetch error (ECONNREFUSED) | лог: err.name/code — без URL upstream'а |
| 3 | Запрос /api/mcp-host/m/ABC123 | nginx access log | строка: path=/api/mcp-host/m/REDACTED, без ABC123 |
| 4 | Запрос /api/projects/123 | nginx access log | path не тронут (/api/projects/123) |
| 5 | Запрос /socket.io/ | access log | path не тронут; (requestId — entry 6) |
| 6 | Drift: новый `console.error(e.message)` | grep-тест | фэйл с указанием файла:строки |
| 7 | Error без cause | err-объект | causeCode отсутствует (не null-шум) |
| 8 | /api/mcp-host/m/ (пустой ticket) | regex | маска (сегмент m/ всегда mask) |

## Code Map

- `frontend/nginx.production.conf.template:2` — log_format neurocenter (escape=json, `$uri` → `$masked_uri`); top-level (http-контекст) — место для `map` (рядом с log_format/limit_req_zone :1-3)
- `services/api-gateway/src/features/mcp-host/mcp-host.controller.ts:28` — @Controller('api/mcp-host'), :140 @All('m/:ticket') (форма URL для regex)
- `services/api-gateway/src/auth/auth-guard.service.ts:112` — passthrough error.message → allowlist
- `services/api-gateway/src/proxy/proxy.service.ts:413-416` — console.error (message) → allowlist
- `services/oauth2-bridge/src/auth/auth.controller.ts:89` — уже error.name (ратификация; сверить при impl, что message не возвращается)
- `services/shared/logging.cjs` (entry 6) — err-allowlist writer (эта story — его consumer + drift)
- `scripts/test/` — новый redaction-drift.test.mjs (статический поиск) + nginx-маска-тест (live, production-stack harness)
- Инвентарь passthrough-точек (полный список — на impl; стартовые: 2 выше + grep `\.message` в src)

## Tasks & Acceptance

### Execution
- [ ] Инвентарь: grep `.message`/`String(error)`/template с error в log-вызовах services/*/src (excl. CLI/тесты) → список точек в PR-описании
- [ ] Замена точек: auth-guard:112, proxy:414, остальные из инвентаря → shared logger (entry 6) с err-объектом (без message)
- [ ] nginx: `map $uri $masked_uri { default $uri; ~^/api/mcp-host/m/ /api/mcp-host/m/REDACTED; }` (top-level) + log_format `path":"$masked_uri"`
- [ ] Drift-тест: redaction-drift.test.mjs — статический поиск passthrough-паттернов = 0 (allowlist: *.cli.ts, тесты с пометкой)
- [ ] Nginx-тест (live): запрос /api/mcp-host/m/TESTTICKET → access-лог (docker logs frontend / json-file) содержит REDACTED, не содержит TESTTICKET; /api/projects/1 → не тронут
- [ ] Regression: auth-guard/proxy ошибки → только allowlist-поля (fixture-ошибка с секретным message → assertion в логе)

### Acceptance
- **Given** `grep` passthrough-паттернов в services/*/src (excl. allowlist) **when** после замены **then** 0 (drift-тест зелёный)
- **Given** live-запрос /api/mcp-host/m/<ticket> **when** проверка access-лога **then** path=/api/mcp-host/m/REDACTED, ticket отсутствует в строке
- **Given** live-запрос любого другого /api/ пути **when** проверка access-лога **then** path без изменений
- **Given** auth/proxy-ошибка с message='secret 42' **when** лог-строка **then** '42' отсутствует, err.name/code присутствуют

## Design Notes

- **Почему nginx map, а не маскировка в log_format-выражении:** nginx не имеет условных выражений в log_format; map — стандартный механизм (работает с regex, top-level http-контекст — в template уже log_format/limit_req_zone, map ставится рядом).
- **Mask = фиксированный сегмент, не хэш:** REDACTED (constant) — достаточно для «билета в логах нет»; хэш (для группировки) — осознанно не вводится (AD-O8 не требует; correlation = requestId, entry 6).
- **Почему regex `~^/api/mcp-host/m/` без якоря конца:** ticket может быть последним сегментом или иметь хвост; маска всего, что после m/ (безопаснее: перемаскируем, а не пропустим).
- **Drift-тест статический (не runtime):** runtime-интерцепт логгера (entry 6) уже не даёт message (writer-формат); drift ищет НОВЫЕ прямые console/Logger-вызовы с message — это защита от обхода логгера.
- **Секретные URL-сегменты кроме m/:ticket:** sweep на impl (OQ-2) — если найдутся, regex расширяется (механизм тот же).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/redaction-drift.test.mjs
# Live-nginx (dev-стек):
docker compose up -d
curl -s https://localhost:8443/api/mcp-host/m/TESTTICKET123 -o /dev/null -k
docker compose logs frontend | grep mcp-host   # → REDACTED, без TESTTICKET123
```
Ожидаемо: drift-тест 0; access-лог маскирует ticket, остальные пути нет; корневой сьют — без деградации.

## Open Questions (с рекомендациями)

1. **Маска для /socket.io/?** — сейчас /socket.io/ не несёт секретных сегментов (auth — в заголовке, не в URL). Рекомендация: не маскировать; sweep (OQ-2) подтверждает на impl.
2. **Полный список секретных URL-сегментов**: только m/:ticket vs расширенный список (OQ-2 sweep: grep controller'ов на `:ticket`/`:token`/`:key`/`:code` params). Рекомендация: sweep на impl; если найдутся — regex-список расширяется до того же map (один механизм).
3. **allowlist err-полей: расширить cause.code до cause.name?** AD-O8 фиксирует name/code/cause.code. Рекомендация: не расширять (канон AD); если impl покажет необходимость — изменение AD, не story.
4. **Нужна ли маска для request-лога (если появится request-logging)?** Сейчас только access-лог. Рекомендация: маска в log_format (единый источник) — request-лог, если будет, унаследует; отдельной работы нет.
