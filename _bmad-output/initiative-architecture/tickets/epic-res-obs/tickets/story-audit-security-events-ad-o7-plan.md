---
title: 'Аудит: FR-903 admin-мутации + новые security_events (AD-O7)'
type: 'feature'
ticket: '14'
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
  - services/catalog-service/src/catalog/audit-history.ts
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-O7: административные мутации — аудируются. Store = security_events (единая таблица, DDL-owner catalog — эпик 1 entry 11) + operations (транзакционный аудит длинных операций — FR-903, ратификация) + единая история (audit-history.ts listAuditHistory :44-107, пагинация — ратификация). Пробелы в main: (1) НЕТ фэйл-теста — «любая admin-мутация без записи = фэйл» не обеспечено (новые мутации могут молча не аудироваться); (2) device.revoke (device-store.ts:262-292) — securityEvent НЕ пишется (только recordDeviceOperation; device.pair/bind — есть: install-plans.ts:182, device-enqueue.ts:159 — верифицировать ратификацию); (3) login/session (успех + отказ) — oauth2-bridge сейчас 0 security events (auth.controller.ts); (4) auth-решения gateway (ticket verify успех/отказ — mcp-host.controller.ts:140) — 0 security events; (5) писатели без прямого PG (oauth2-bridge, api-gateway) — нет канала доставки в catalog.

**Approach:** (1) Фэйл-тест: ЛЮБАЯ admin-мутация без записи (operations ИЛИ security_events) = фэйл — тест-драйвер обходит мутационные роуты (@Post/@Patch/@Put/@Delete в controller'ах catalog) с fixture-auth и проверяет запись в store (count до/после); инвентарь admin-мутаций сгенерирован из controller'ов (каждая покрыта либо operations, либо security_events, либо явный allowlist «не мутация»); (2) Новые обязательные события: device.revoke (securityEvent в транзакции device-store.revoke), login/session успех+отказ (oauth2-bridge), auth-решения gateway (ticket verify успех/отказ, mcp-host.controller.ts:140); (3) Писатели без прямого PG (oauth2-bridge, api-gateway) — доставка через outbox/HTTP-канал в catalog (паттерн skills-service: skill-audit-outbox.ts:16-217 — file outbox + 2s timer; deliver = internal HTTP POST в catalog); (4) UI: Audit-модуль (ратификация) — новые события в единой истории (audit-history.ts UNION подхватывает автоматически, source='security'); OQ: presentation security-событий (новое представление или существующее).

## Boundaries & Constraints

**Always:**
- Store = security_events + operations (единые таблицы; DDL-owner catalog — не менять).
- Новая мутация = новая запись (fail-тест ловит пропуск).
- Писатели без PG — через outbox/HTTP (не прямой PG-доступ — ратификация).
- Единая история (audit-history.ts) — новые события видны (source='security', пагинация).
- Idempotency-безопасность: securityEvent в той же транзакции (device.revoke) — атомарность.

**Never:**
- Не вводить новую audit-таблицу (security_events/operations — единственные store; AD-O7).
- Не дублировать запись (мутация → ОДНА запись в operations ИЛИ security_events, не обе).
- Не менять DDL security_events/operations (эпик 1 entry 11 — зафиксировано).
- Не отправлять в security-события payload/секреты (before/after-state — safe, AD-O8-принцип).
- Не вводить real-time push (единая история — polling, ратификация).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Admin-мутация (например, project create) | POST /projects | запись в operations/security_events (fail-тест) |
| 2 | Новая мутация БЕЗ записи | POST /new-route | фэйл-тест (нет записи) |
| 3 | device.revoke | DELETE /api/devices/:id | securityEvent device.revoke (транзакция) |
| 4 | device.pair/bind | install | securityEvent (ратификация, верифицировать) |
| 5 | Login успех | oauth2-bridge /auth/callback | securityEvent login.success (через outbox) |
| 6 | Login отказ | oauth2-bridge (битый code) | securityEvent login.failure (через outbox) |
| 7 | Ticket verify успех | gateway mcp-host m/:ticket | securityEvent ticket.granted (через outbox) |
| 8 | Ticket verify отказ | gateway (битый ticket) | securityEvent ticket.denied (через outbox) |
| 9 | Catalog down (outbox-сервис) | login при down catalog | outbox-файл, доставка после up (retry) |
| 10 | Единая история | GET audit-history | новые события (login/ticket/device.revoke) видны, пагинация |

## Code Map

- `services/catalog-service/src/access/security-events.ts:12-24` — securityEvent-хелпер (писатели)
- `services/catalog-service/src/devices/device-store.ts:262-292` — revoke() БЕЗ securityEvent (фикс: +securityEvent в транзакции)
- `services/catalog-service/src/devices/install-plans.ts:182` + `device-enqueue.ts:159` — securityEvent (device.pair/bind — ратификация, верифицировать)
- `services/oauth2-bridge/src/auth/auth.controller.ts:89` — code exchange (0 security events — фикс: +login.success/failure через outbox)
- `services/api-gateway/src/features/mcp-host/mcp-host.controller.ts:140` — @All('m/:ticket') (0 security events — фикс: +ticket.granted/denied через outbox)
- `services/skills-service/src/storage/skill-audit-outbox.ts:16-217` — outbox-паттерн (file outbox, 2s timer, deliver, epoch)
- `services/catalog-service/src/catalog/audit-history.ts:8-19` (UNION operations+security_events), `:44-107` (listAuditHistory, пагинация)
- `services/catalog-service/src/catalog/catalog-schema.ts:50-66` — operations-таблица (DDL)
- `frontend/src/modules/Audit/` — Audit-модуль (UI, ратификация; новые события в истории)
- Controller'ы catalog (инвентарь мутаций): @Post/@Patch/@Put/@Delete (projects, members, settings, plugins, models, devices, restore, maintenance, feature-flags, agents, requests, snapshots, package-build, asset-sources, discussions, operations, chat, remote-providers, bridge-source)

## Tasks & Acceptance

### Execution
- [ ] Инвентарь admin-мутаций: генерация из controller'ов (@Post/@Patch/@Put/@Delete) → таблица «роут → store (operations/security_events) / allowlist (не мутация)»
- [ ] Фэйл-тест: test-драйвер обходит мутационные роуты (fixture-auth admin) → assert запись в store (count до/после operations+security_events); allowlist-мутации (read-only/идемпотентные) — явные
- [ ] device.revoke: +securityEvent в транзакции (device-store.ts:262-292, рядом с recordDeviceOperation)
- [ ] Верификация device.pair/bind (install-plans.ts:182, device-enqueue.ts:159) — ратификация (если не пишут — фикс)
- [ ] oauth2-bridge: login.success/login.failure — securityEvent через outbox (file outbox + 2s timer, deliver = POST /internal/security-events в catalog)
- [ ] api-gateway: ticket.granted/ticket.denied — securityEvent через outbox (mcp-host.controller.ts:140)
- [ ] Outbox-канал: internal API catalog POST /internal/security-events (internal_token; idempotency не нужна — unique event_id)
- [ ] Outbox для oauth2-bridge/api-gateway: file outbox (паттерн skill-audit-outbox: 2s timer, deliver, retry, epoch) — security-события в outbox при недоступности catalog
- [ ] UI: audit-history.ts — новые action-имена (device.revoke, login.*, ticket.*) в единой истории (UNION подхватывает; presentation — OQ)
- [ ] Тесты: fail-тест (обход роутов), device.revoke regression, login/ticket события (fixture), outbox-доставка (kill catalog → retry), единая история (пагинация)

### Acceptance
- **Given** admin-мутация (обход роутов) **when** fail-тест **then** запись в operations/security_events (0 пропусков)
- **Given** device.revoke **when** DELETE **then** securityEvent device.revoke (транзакция, regression)
- **Given** login успех/отказ **when** oauth2-bridge **then** securityEvent login.success/failure (через outbox)
- **Given** ticket verify успех/отказ **when** gateway **then** securityEvent ticket.granted/denied (через outbox)
- **Given** catalog down **when** outbox-событие **then** не теряется (retry после up)
- **Given** единая история **when** GET audit-history **then** новые события видны (пагинация)

## Design Notes

- **Fail-тест = защита от регрессии:** AD-O7 «любая admin-мутация — запись». Fail-тест (обход роутов) — единственный способ гарантировать (не rely на «разработчик не забудет»). Инвентарь сгенерирован (из controller'ов) — новые роуты автоматически в тесте.
- **Outbox для non-PG писателей:** oauth2-bridge/api-gateway не имеют PG-доступа (топология). Outbox (file, 2s timer) — ратификация (skill-audit-outbox). Security-события = асинхронные (audit не блокирует login/ticket — best-effort, как skill-audit).
- **device.revoke в транзакции:** securityEvent + UPDATE в одной транзакции (атомарность: revoke + audit или ничего). Паттерн — другие securityEvent-вызовы (в транзакции).
- **login/ticket = security, не operation:** login/ticket — короткие действия (не длинные операции). security_events (action-based), не operations (transaction-based, FR-903). Разграничение: operation = длинная (install, restore, backup), security = короткое действие (login, ticket, revoke).
- **Единая история подхватывает автоматически:** audit-history.ts UNION operations+security_events — новые action-имена в security_events видны без изменения SQL (source='security'). Presentation (как отображать) — OQ (новое представление или generic).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/audit-fail-test.mjs        # обход мутационных роутов
node --test scripts/test/security-events.test.mjs   # device.revoke, login, ticket
# Live (dev-стек):
# device.revoke → security_events
docker compose exec postgres psql -U nc_owner -d catalog -c "select action from security_events order by created_at desc limit 5"
# Единая история:
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "localhost:4000/api/audit?page=1" | jq '.items[].action'
```
Ожидаемо: fail-тест 0 пропусков; device.revoke/login/ticket в security_events; outbox-доставка; единая история с новыми событиями; корневой сьют — без деградации.

## Open Questions (с рекомендациями)

1. **Presentation security-событий в Audit UI**: новое представление (login/ticket/revoke — специфичные поля) vs generic (action + before/after)? Рекомендация: generic (action + safe before/after) + OQ-расширение (специфичные представления при необходимости). Единая история — generic.
2. **Порог «admin-мутация»**: все @Post/@Patch/@Put/@Delete vs только «административные» (require admin)? Рекомендация: все мутационные роуты (fail-тест строгий); allowlist для read-only/идемпотентных (явные).
3. **Outbox vs прямой HTTP (oauth2-bridge/gateway)**: file outbox (перезаряжаемость, ратификация) vs прямой HTTP с retry (проще, но потеря при crash)? Рекомендация: file outbox (надёжность, паттерн skill-audit).
4. **Idempotency security-событий**: unique event_id (randomUUID) — повторная доставка не дублирует (ON CONFLICT DO NOTHING)? Рекомендация: да (idempotency — защита от double-delivery outbox).
5. **Сколько новых security-событий (полный список)**: device.revoke, login.success/failure, ticket.granted/denied (минимум) + ? Рекомендация: минимум (P0-RES); расширение (logout, session-refresh) — при необходимости.
