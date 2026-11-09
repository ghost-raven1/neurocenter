---
title: 'Отзыв билетов: TTL 24h + единый кэш re-check ≤60s + bridge re-issue + пул-квоты + pids/non-root (AD-4, entry 6)'
type: 'feature'
ticket: '6'
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

**Problem:** (1) TTL билета 30 дней (`ticket.ts:53`) — AD-4 требует 24h. (2) Bridge НЕ ре-выпускает билет при reconnect: `installation-planner.ts:213-222` «Билет живёт до истечения: обновление и восстановление не переподключают канал» — билет бессрочно действует после обновления. (3) Per-op re-check (`host.ts:342-364` → `mcp-host-access.ts:201`) — полная DB-транзакция в catalog на КАЖДУЮ операцию (ListTools/CallTool) — нагрузочный DoS; кэша нет. (4) Глобальный пул `MAX_HOSTS` (`host.ts:40`) — NaN-дыра (`NEUROCENTER_MCP_HOST_MAX=abc` → `Math.max(1, NaN)` → неограниченный пул, AD-9); нет per-project/per-device квот и cap на hostKey. (5) Child-MCP-процесс — без `pids_limit` и non-root (compose api-gateway: только shared `no-new-privileges`; `owned-stdio.ts:25-31` spawn detached; Dockerfile без USER) — форк-бомба в «одобренном» артефакте роняет gateway.

**Approach:** TTL 24h; bridge ре-выпускает билет при reconnect (connect лёгкий, ре-подпись HMAC) и САМ обновляет свой OpenCode-конфиг. Gateway проверяет привязку device↔project lookup'ом с ЕДИНЫМ кэшем ≤60s (connect-lookup + per-op); lookup error/timeout → 503 fail-closed (stale-while-error запрещён). Окно отзыва ≤ TTL кэша (60s). Пул: per-project/per-device квоты + cap на hostKey; NaN-дыра → fail-fast (AD-9). Child-MCP: `pids_limit` + non-root.

## Boundaries & Constraints

**Always:**
- TTL билета = 24h (`ticket.ts:53`), stateless (HMAC + exp).
- Bridge ре-выпускает билет при reconnect (connect — лёгкий, ре-подпись HMAC) и САМ обновляет свой OpenCode-конфиг (билет в URL канала — зона ответственности bridge).
- ЕДИНЫЙ кэш в gateway `McpHostService` для connect-lookup и per-op `authorize-session`: key = каноническая сессия (deviceId, projectId, assetId, version, manifest, artifactSha256), TTL ≤60s (рабочее 30–60s, AD-4 Deferred).
- Lookup error/timeout → 503, соединение отклоняется — fail-closed; stale-while-error запрещён.
- Окно отзыва (отвязка/деактивация устройства) ≤ TTL кэша (60s); per-ticket denylist не вводится.
- Пул: глобальный default 4; per-project/per-device квоты; cap активных каналов на hostKey; `NEUROCENTER_MCP_HOST_MAX` NaN/invalid → fail-fast (AD-9), не неограниченный пул.
- Child-MCP-процесс: `pids_limit` (compose api-gateway) + non-root (Dockerfile USER + ownership); live re-check на соединение И на каждую операцию (ListTools/CallTool).

**Never:**
- Бессрочное действие билета после обновления/reconnect (re-issue обязателен).
- Stale-while-error в кэше (error/timeout → 503, не старый результат).
- Per-ticket denylist (AD-4: не вводится).
- Неограниченный пул из-за NaN (fail-fast).
- Fork-бомба без `pids_limit`/non-root (обязательный hardening).
- Ротация `NEUROCENTER_MCP_HOST_SECRET` — осознанный residual (гасит все активные билеты, stateless-модель, AD-4).
- Периодический re-check long-lived каналов (AD-4 mid-session gap — Deferred).
- Территория retired-status (entry 7), error-body (entry 10) — не сюда.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| TTL_24H | issuance | `exp = now + 24h` (было 30d) | No error |
| REISSUE_RECONNECT | bridge reconnect/update/restore | ре-выпуск билета + обновление OpenCode-конфига | No error |
| CACHE_HIT | per-op, кэш свежий (≤60s) | без DB-транзакции (кэш) | No error |
| CACHE_MISS | per-op, кэш пуст/протух | DB-lookup (catalog), кэш обновлён | No error |
| LOOKUP_ERROR | catalog lookup error/timeout | 503, соединение отклонено (fail-closed) | 503 (no stale) |
| REVOCATION | отвязка/деактивация устройства | билет гаснет ≤60s (TTL кэша) | No error |
| POOL_QUOTA | per-project/per-device превышено | отказ нового хоста | actionable 503 |
| HOSTKEY_CAP | cap активных каналов на hostKey превышен | отказ | actionable 503 |
| NAN_MAX | `NEUROCENTER_MCP_HOST_MAX=abc` | fail-fast на старте (AD-9) | actionable |
| PIDS_LIMIT | child-MCP форк-бомба | ограничен `pids_limit` | не роняет gateway |
| NON_ROOT | child-MCP запуск | non-root (не root) | No error |

</frozen-after-approval>

## Code Map

- `services/api-gateway/src/features/mcp-host/ticket.ts:53` — `HOSTED_MCP_TTL_MS = 30 * 86400 * 1000` → `24 * 3600 * 1000`
- `services/api-gateway/src/features/mcp-host/host.ts:40` — `MAX_HOSTS = Math.max(1, Number(... || 4))` — NaN-дыра → fail-fast (AD-9) + per-project/per-device квоты + cap на hostKey
- `services/api-gateway/src/features/mcp-host/host.ts:342-364` — `authorizeSession` — ЕДИНЫЙ кэш ≤60s (connect-lookup + per-op); error/timeout → 503 fail-closed
- `services/api-gateway/src/features/mcp-host/host.ts:266-340` — `handle` + per-op re-check (ListTools :293, CallTool :297) — через кэш
- `services/catalog-service/src/devices/mcp-host-access.ts:201-210` — `authorizeHostedMcpSession` (live re-check, полная DB-транзакция) — источник для кэша
- `mcp/neurocenter-asset-sync/src/bridge/installation-planner.ts:211-222` — `previousIsHosted` «Билет живёт до истечения» → re-issue при reconnect + обновление конфига
- `mcp/neurocenter-asset-sync/src/features/mcp-host/connect.ts:20` — `requestHostedMcpConnection` (re-issue)
- `services/api-gateway/src/features/mcp-host/owned-stdio.ts:25-31` — `spawn` detached — child-MCP (pids/non-root via compose/Dockerfile)
- `compose.production.yml` (api-gateway) — + `pids_limit` + `user`/non-root + `cap_drop`; `services/api-gateway/Dockerfile` (без USER) — + USER + ownership
- `deploy/production/environment-model.json` (api-gateway) — `pidsLimit`/`user`/`capDrop` (сейчас null)
- Тесты: TTL, re-issue, кэш (hit/miss/error-fail-closed), окно отзыва, пул-квоты, NaN-fail-fast, pids/non-root (compose-проверка); регистрация

## Tasks & Acceptance

**Execution:**
- [ ] `ticket.ts` — TTL 24h
- [ ] `host.ts` — ЕДИНЫЙ кэш ≤60s (connect-lookup + per-op); error/timeout → 503 fail-closed (no stale-while-error)
- [ ] `host.ts` — NaN-дыра → fail-fast (AD-9); per-project/per-device квоты + cap на hostKey
- [ ] Bridge `installation-planner.ts` — re-issue при reconnect + обновление OpenCode-конфига (через `connect.ts`)
- [ ] `compose.production.yml` api-gateway + `Dockerfile` — `pids_limit` + non-root (USER + ownership); `environment-model.json`
- [ ] Тесты: TTL 24h, re-issue, кэш (hit/miss/error), окно отзыва ≤60s, пул-квоты, NaN-fail-fast, pids/non-root; регистрация

**Acceptance Criteria:**
- Given issuance, when билет, then `exp = now + 24h` (тест).
- Given bridge reconnect/update/restore, when установка, then билет ре-выпущен и OpenCode-конфиг обновлён (не старый билет, тест).
- Given per-op re-check, when кэш свежий (≤60s), then без DB-транзакции; кэш пуст/протух → DB-lookup; lookup error/timeout → 503 fail-closed (no stale-while-error, тест).
- Given отвязка/деактивация устройства, when следующий re-check, then билет гаснет ≤60s (тест).
- Given per-project/per-device квота / cap на hostKey превышен, when новый хост, then отказ (actionable 503, тест).
- Given `NEUROCENTER_MCP_HOST_MAX=abc`, when старт, then fail-fast (не неограниченный пул, тест).
- Given child-MCP, when compose/Dockerfile, then `pids_limit` + non-root (проверка compose-модели + Dockerfile USER).
- Корневой сьют — без деградации против baseline.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Единый кэш: AD-4 — «единый кэш для connect-lookup и per-op authorize-session». Кэш в gateway `McpHostService` (не в catalog): ключ = каноническая сессия, TTL 60s. Connect-lookup (issue) и per-op re-check используют один и тот же кэш/логику — без дублирования. Fail-closed: lookup error/timeout → 503 (не stale) — «stale-while-error запрещён». Окно отзыва = TTL кэша: после отвязки/деактивации устройство может действовать до протухания кэша (≤60s) — осознанный residual. Re-issue: bridge сам обновляет свой OpenCode-конфиг (билет в URL — зона ответственности bridge, AD-4); connect лёгкий (ре-подпись HMAC), поэтому re-issue при reconnect дешёвый. NaN-дыра (AD-9): `Math.max(1, Number('abc')) = Math.max(1, NaN) = NaN` → `hosts.size >= NaN` всегда false → неограниченный пул; фикс — fail-fast на старте (validated positive safe-integer). pids/non-root: child-MCP — недоверенный «одобренный» артефакт; форк-бомба не должна ронять gateway (pids_limit) и не должна работать root (non-root). Residuals (AD-4): ротация host-секрета гасит все билеты (stateless); mid-session gap (Deferred).

## Open Questions

- **OQ4 (блок-решение):** non-root для gateway — Dockerfile-модификация (USER + ownership) в скоупе этой entry или отдельно? Рекомендация: в скоупе AD-4-entry (hardening child-MCP). Owner: human.
- **OQ:** размер кэша live-binding lookup — 60s (рабочее 30–60s, AD-4 Deferred). Рекомендация: 60s.
- **OQ:** per-project/per-device квоты — значения (default)? Рекомендация: configurable, reasonable defaults (напр. per-device 2, per-project 8) — зафиксировать при реализации.

## Verification

**Commands:** (node-тесты — только `$NODE`)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `cd services/api-gateway && npm run build` → TTL/кэш/пул-тесты — expected: 0 fail
- Bridge re-issue-тест (reconnect → новый билет + конфиг обновлён) — expected: 0 fail
- `grep -n '30 \* 86400' services/api-gateway/src/features/mcp-host/ticket.ts` — expected: нет (TTL 24h)
- Compose-проверка: api-gateway `pids_limit` + non-root (USER в Dockerfile) — expected: присутствует
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации
