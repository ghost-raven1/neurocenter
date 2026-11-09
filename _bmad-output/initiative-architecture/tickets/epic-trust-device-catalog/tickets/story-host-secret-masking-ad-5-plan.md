---
title: 'Independent host-секрет без fallback + маскирование m/:ticket в nginx-логах (AD-5, entry 4)'
type: 'bugfix'
ticket: '4'
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
  - '_bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/epic-trust-device-catalog.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** (1) Fallback секрета мёртв в production: `ticket.ts:52` `secret() = NEUROCENTER_MCP_HOST_SECRET || NEUROCENTER_INTERNAL_TOKEN || ''` — fallback на INTERNAL_TOKEN **активен**, т.к. production setup не генерирует host-секрет (`configuration.mjs:210-211` создаёт только `postgres_password`+`internal_token`). Утечка internal-токена ⇒ подделка хост-билетов (AD-5). (2) Минимальная длина секрета = 16 (`ticket.ts:57,81`), AD-5 требует ≥32 байт. (3) Билет — секретный материал, но access-логи proxy пишут `m/:ticket` в `nginx $uri` (`nginx.production.conf.template:2`) — 30-дневные билеты (entry 6: 24h) попадают в json-file логи при каждом запросе.

**Approach:** `NEUROCENTER_MCP_HOST_SECRET` обязателен для mcp-host; fallback на `NEUROCENTER_INTERNAL_TOKEN` удалён. Отсутствие/короткий/дублирующий secret = **fail-fast на старте** (validateProduction api-gateway, не deferred-проверка на каждый issue/verify); минимальная длина ≥32 байт; разные trust-domain — разные значения (timing-safe assert `host != internal`). Production setup генерирует оба секрета независимо. Nginx-логи маскируют `/api/mcp-host/m/:ticket` (map → redacted path в log_format).

## Boundaries & Constraints

**Always:**
- `ticket.ts:52` — `secret() = process.env.NEUROCENTER_MCP_HOST_SECRET || ''` (fallback на INTERNAL_TOKEN удалён).
- `NEUROCENTER_MCP_HOST_SECRET` в `secretNames` (`runtime.cjs:5-19`) — читается из `NEUROCENTER_MCP_HOST_SECRET_FILE` (паттерн file-secrets).
- `validateProduction` (api-gateway): `NEUROCENTER_MCP_HOST_SECRET` обязателен, ≥32 байт (hex ≥64, как INTERNAL_TOKEN), `timing-safe host != internal` (разные trust-domain — разные значения, всегда).
- Минимальная длина в `ticket.ts` (issue/verify) — ≥32 байт (было 16).
- `configuration.mjs` — генерация `mcp_host_secret` независимо (`randomBytes(32).toString('hex')`).
- `compose.production.yml` api-gateway — `secrets: [..., mcp_host_secret]` + `NEUROCENTER_MCP_HOST_SECRET_FILE: /run/secrets/mcp_host_secret`; `deploy/production/environment-model.json` api-gateway — `secrets` + `requiredEnv`.
- Nginx: `map $uri $log_path { ~^/api/mcp-host/m/.+ → redacted; default $uri; }` + log_format использует `$log_path` (не `$uri`) — билет в access-log не читается.
- Значения секретов в отчёте/логах всегда маскируются (AD-9): имя — да, значение — нет.

**Never:**
- Fallback-цепочка секретов (AD-5): `MCP_HOST_SECRET` не читает `INTERNAL_TOKEN`.
- `host == internal` в production (fail-fast, timing-safe).
- Билет в access-логах (nginx): `m/:ticket` всегда маскирован.
- Deferred-проверка секрета на каждый issue/verify как единственный gate (fail-fast на старте обязателен; runtime-проверка — backup, не замена).
- Территория TTL/кэша/re-issue (entry 6) — здесь только секрет + маскирование логов.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| NO_FALLBACK | `MCP_HOST_SECRET` пуст, `INTERNAL_TOKEN` задан | secret = '' (не INTERNAL_TOKEN) | issue/verify отказ |
| MISSING_PROD | production, `MCP_HOST_SECRET` отсутствует | fail-fast на старте | actionable «заполните NEUROCENTER_MCP_HOST_SECRET» |
| SHORT | `MCP_HOST_SECRET` < 32 байт | fail-fast на старте | actionable «нужны 32+ байт» |
| DUPLICATE | `MCP_HOST_SECRET == INTERNAL_TOKEN` | fail-fast на старте | actionable «разные trust-domain — разные значения» |
| OK | `MCP_HOST_SECRET` ≥32 байт, ≠ internal | старт OK; issue/verify работают | No error |
| INDEPENDENT_GEN | production setup | оба секрета сгенерированы независимо (разные значения) | No error |
| NGINX_MASK | запрос `/api/mcp-host/m/<ticket>` | access-log path = redacted (билет не читается) | No error |
| NGINX_OTHER | запрос `/api/other` | access-log path = как есть (`$uri`) | No error |

</frozen-after-approval>

## Code Map

- `services/api-gateway/src/features/mcp-host/ticket.ts:52` — `secret()` fallback → убрать `|| process.env.NEUROCENTER_INTERNAL_TOKEN`
- `services/api-gateway/src/features/mcp-host/ticket.ts:57,81` — `guard.length < 16` → `< 32` (issue + verify)
- `services/shared/runtime.cjs:5-19` — `secretNames` — + `'NEUROCENTER_MCP_HOST_SECRET'`
- `services/shared/runtime.cjs:87-188` — `validateProduction` — блок api-gateway: требовать `NEUROCENTER_MCP_HOST_SECRET` (≥32 байт/hex≥64) + timing-safe `!= NEUROCENTER_INTERNAL_TOKEN`
- `scripts/production/configuration.mjs:210-211` — + `await secret('mcp_host_secret', () => randomBytes(32).toString('hex'))`
- `compose.production.yml` (api-gateway) — `secrets: [metrics_token, internal_token, mcp_host_secret]` + env `NEUROCENTER_MCP_HOST_SECRET_FILE: /run/secrets/mcp_host_secret`
- `deploy/production/environment-model.json` (api-gateway) — `secrets` + `mcp_host_secret`, `requiredEnv.NEUROCENTER_MCP_HOST_SECRET_FILE`
- `frontend/nginx.production.conf.template:2` — `log_format ... "path":"$uri"` → `$log_path` (masked); добавить `map $uri $log_path { ~^/api/mcp-host/m/.+ /api/mcp-host/m/[REDACTED]; default $uri; }` (http-контекст, до server)
- Тесты: новый secret/masking-тест; обновление drift-теста compose→code (entry epic-release-baseline модель окружения); регистрация check-tooling-tests.json + expectedFiles

## Tasks & Acceptance

**Execution:**
- [ ] `ticket.ts` — убрать fallback; мин. длина 32
- [ ] `runtime.cjs` — `secretNames` + `NEUROCENTER_MCP_HOST_SECRET`; `validateProduction` api-gateway: требование + ≥32 + timing-safe `!= internal`
- [ ] `configuration.mjs` — генерация `mcp_host_secret`; `compose.production.yml` + `environment-model.json` (secrets + requiredEnv)
- [ ] `nginx.production.conf.template` — `map` + log_format `$log_path`
- [ ] Тесты: fail-fast (missing/short/duplicate), независимость генерации, nginx-masking (билет не в логе); drift-тест модели; регистрация

**Acceptance Criteria:**
- Given production без `MCP_HOST_SECRET`, when старт api-gateway, then fail-fast (validateProduction) с actionable; с коротким (<32) → fail-fast; с `host==internal` → fail-fast (timing-safe).
- Given `MCP_HOST_SECRET` задан, when `secret()` (ticket.ts), then НЕ читает `INTERNAL_TOKEN` (grep: fallback отсутствует).
- Given production setup, when configure, then `mcp_host_secret` и `internal_token` сгенерированы независимо (разные значения, тест).
- Given запрос `/api/mcp-host/m/<ticket>`, when nginx access-log, then path маскирован (билет в логе не читается, тест); другие пути — как есть.
- Drift-тест compose→code (модель окружения) — `mcp_host_secret` в модели; корневой сьют — без деградации.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Почему fail-fast на старте, а не только runtime-проверка: AD-5 — «отсутствие секрета = fail-fast на старте (не deferred-проверка на каждый issue/verify)». Runtime-проверка `secret().length < 32` (ticket.ts) остаётся как backup, но primary gate — validateProduction (агрегированный отчёт, единая точка AD-9). Timing-safe сравнение `host != internal` — единая реализация (AD-9: «Internal-токен сравнивается только timing-safe assert; `!==` в middlewares запрещено»); здесь `crypto.timingSafeEqual`. Nginx-masking через `map` (http-контекст): детерминированная подстановка path в log_format без изменения маршрутизации; regex `~^/api/mcp-host/m/.+` маскирует любой билет. Альтернатива — отдельный `access_log` c другим format для location `m/` (тяжелее, дублирует config); map чище. Секрет — file-secret (`_FILE`), как остальные (AD-9/конвенция «один secret на trust-domain»).

## Open Questions

- **OQ:** маскирование в nginx — `map` + общий log_format (рекомендация) или отдельный access_log для `m/` location? Рекомендация: map (минимально). Подтвердить при реализации.
- **OQ:** валидация `host != internal` — только в production (validateProduction) или и в dev? Рекомендация: production (dev может использовать один секрет для простоты; AD-5 — production-требование).

## Verification

**Commands:** (node-тесты — только `$NODE`)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `grep -n 'NEUROCENTER_INTERNAL_TOKEN' services/api-gateway/src/features/mcp-host/ticket.ts` — expected: нет (fallback удалён)
- `grep -n 'guard.length < 16' services/api-gateway/src/features/mcp-host/ticket.ts` — expected: нет (→ `< 32`)
- Новый secret-тест (fail-fast missing/short/duplicate + независимость генерации) — expected: 0 fail
- Новый nginx-masking-тест (билет не в access-log) — expected: 0 fail
- Drift-тест compose→code (модель окружения, `mcp_host_secret`) — expected: 0 dead-env
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации
