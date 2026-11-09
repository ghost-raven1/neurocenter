---
title: 'Лестницы дедлайнов + nginx-кромка + body-бюджеты + PG rate-limit (AD-6, entry 9)'
type: 'feature'
ticket: '9'
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
  - '_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md'
  - '_bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/epic-trust-device-catalog.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** (1) Лестницы дедлайнов — ручные числа в трёх местах: tool-import 480/540/550 (`tool-import-deadline.cjs`), model-chat 900/910/915/920 (`model-chat-deadline.json`), embedding 115s==115s (`proxy.service.ts:570,634` — client-timer и catalog-вызов ОДИН срок = race: кто сработает первым, тот и владелец ответа, client может ответить 408 раньше, чем upstream реально упал). (2) Nginx-кромка рвёт раньше innermost: `nginx.production.conf.template:65-71` `location /api/` `proxy_read_timeout 600s` — покрывает ВСЕ model-chat-маршруты, кроме `turns` (regex location :58-64, 915s); маршруты model-chats, которые используют gateway-бюджет >600s (inference 910s — не через turns; attachments-загрузки 64MB), рвутся nginx'ом на 600s до gateway-дедлайна. (3) Body-бюджеты растут к центру: nginx `client_max_body_size 50m` (:18) → gateway `50mb` (`main.ts:38`) → catalog `35mb` (`catalog-service/src/main.ts:24`): запрос 40MB проходит nginx и gateway и умирает в catalog (413 глубоко внутри — opaque для клиента). (4) Rate-limit счётчики в памяти реплики: `proxy.service.ts:66` `pairLimits` (in-memory Map, 60s-окно, pairing: start 15/min, poll 6000/min, per-code 60/min) — multi-replica = N раз слабее; oauth2-bridge token-exchange (`/auth/callback`) без rate-limit (nginx `:24-29` лимитит только `/auth/login`).

**Approach:** (1) Все лестницы выводятся из `base + margins` — один источник (`services/shared/deadline-ladders.mjs` new): `{base, margins: [...]} → [server, gateway, edge, client]`; текущие числа получаются из формулы (480+60+10; 900+10+15+5; embedding base+margin); invariant-тест: порядок строго возрастает, каждый margin > 0. (2) Nginx-кромка: per-route location'ы для model-chats (все маршруты, не только turns) + archive; invariant-тест (static, парсинг nginx-шаблона): для каждого маршрута с `timeoutMs` в таблице entry 8 — nginx-edge ≥ gateway + margin (outermost не рвёт раньше innermost). (3) Body: выравнивание `nginx ≤ gateway ≤ upstream` (рекомендация: поднять catalog 35mb→50mb, nginx 50m и gateway 50mb оставить — 40MB проходит всю цепь; archive-исключение 8g — streaming, без json-парсинга). (4) Rate-limit → PG: таблица rate-limit-окон (создаётся catalog schema migration — DDL-owner инвариант 1.11 сохраняется), gateway получает PG-пул (new env), pairing-счётчики — в PG; oauth2-bridge token-exchange — rate-limit (nginx limit_req на `/auth/callback` + PG-счётчик в bridge — OQ3).

## Boundaries & Constraints

**Always:**
- Лестницы — из `base + margins` (`services/shared/deadline-ladders.mjs` new, потребители: `tool-import-deadline.cjs`, `model-chat-deadline.json`/`.cjs`, embedding в `route-policy.ts`/`proxy.service.ts`): формула фиксирована, текущие значения воспроизводятся из неё (480/540/550, 900/910/915/920); новые лестницы — только через формулу.
- Invariant-тест лестниц: для каждой пары (внешний, внутренний) — внешний > внутренний, margin > 0; embedding race 115s==115s исправлен (client 115s, upstream 110s — margin 5s; значения — OQ1).
- Nginx-кромка: model-chats — location покрывает ВСЕ model-chat-маршруты (не только `turns`), edge-timeout ≥ gateway + margin; archive (8g body) — свой location (уже есть :46-56); invariant-тест static (nginx-шаблон ↔ таблица entry 8): outermost не раньше innermost.
- Body-бюджеты: `nginx ≤ gateway ≤ upstream` для каждого маршрута (инвариант в completeness/инвариант-тесте); 40MB запрос проходит nginx→gateway→catalog (catalog 35mb→50mb, OQ2); archive 8g — исключение (streaming, json-парсер не участвует).
- Rate-limit pairing (start/poll/per-code) — в PG (таблица, 60s-окно, atomic counter): multi-replica-safe; in-memory `pairLimits` удалён; fail-открыт НЕ: PG недоступен → 503 (fail-closed, AD-19-совместимый ответ).
- OAuth2-bridge token-exchange (`GET /auth/callback`) — rate-limit (значение OQ3).
- Все значения — в таблице entry 8 (`route-policy.ts`) + nginx-шаблоне; inline-литералы не возвращаются.

**Never:**
- Не менять механизмы entry 8 (таблица/completeness/default) — только значения и nginx; не трогать ticket/TTL/ceiling (entry 2/5/6/7).
- Не снижать body-лимит к центру (инвариант `nginx ≤ gateway ≤ upstream` — нарушать запрещено); не вводить `∞` (entry 8).
- Не делать rate-limit fail-открытым при PG-сбое (fail-closed 503); не убирать nginx limit_req на `/auth/login` (первая линия, остаётся).
- Не создавать ДDL из gateway/bridge (DDL-owner = catalog service, инвариант 1.11): rate-limit-таблицы — в catalog schema migration.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LADDER_TOOL_IMPORT | tool-import (base 480) | 480/540/550 из формулы; nginx /api/ 600s ≥ 550 | No error |
| LADDER_MODEL_CHAT | model-chat (base 900) | 900/910/915/920 из формулы; nginx-edge (model-chats location) ≥ 910 + margin | No error |
| LADDER_EMBEDDING | embedding (base+margin) | upstream < client, margin > 0 (115==115 исправлен) | No error |
| LADDER_INVARIANT | margin = 0 (пары равны) | invariant-тест ФЕЙЛ: «pair equal: X» | actionable |
| NGINX_EDGE_BROKEN | model-chat маршрут без location, /api/ 600s < gateway 910s | invariant-тест (nginx↔таблица) ФЕЙЛ | actionable |
| MODEL_CHAT_ATTACHMENTS | POST model-chats attachments (64MB, >600s) | не рвётся nginx'ом на 600s (location покрывает) | No error |
| BODY_40MB | upload 40MB (nginx 50m, gateway 50mb, catalog 50mb) | проходит всю цепь (не 413 в catalog) | No error |
| BODY_CENTER_GROWS | nginx 50m > gateway X (X < 50m) | invariant-тест ФЕЙЛ: «body grows to center» | actionable |
| PAIR_PG | pairing start/poll при N репликах | счётчики общие (PG), лимит один раз слабее не становится | No error |
| PAIR_PG_DOWN | PG недоступен при pairing | 503 fail-closed (не fail-open) | 503 |
| TOKEN_EXCHANGE_RL | флуд `GET /auth/callback` | rate-limit 429 (nginx zone и/или PG-счётчик) | 429 |

</frozen-after-approval>

## Code Map

**Лестницы (сейчас — ручные числа):**
- `services/shared/tool-import-deadline.cjs` — `TOOL_IMPORT_TIMEOUT_MS=480000`, `CLEANUP_MARGIN=60000`, gateway=+60s, client=+10s (уже из формулы — перевести на shared-ladders)
- `services/shared/model-chat-deadline.json` — `{round:900000, gateway:910000, edge:915000, client:920000}`; `.cjs` — re-export
- `services/api-gateway/src/proxy/proxy.service.ts:566-570` — client-timer `115000`; `:633-635` — catalog POST `timeout: 115000` (race), `maxContentLength: 8MB`
- Потребители: `tool-import-forward.ts:24`, `model-inference-forward.ts:3` (MODEL_CHAT_GATEWAY_TIMEOUT_MS), `services/shared` consumers (server-side 480/900 — найти при реализации: catalog tool-builds/model-chats round)

**Nginx-кромка:**
- `frontend/nginx.production.conf.template` — `:18 client_max_body_size 50m`; `:24-29 /auth/login limit_req 10r/m burst=10`; `:46-56 /api/asset-sources/archive 8g + 600s`; `:58-64 model-chats turns regex 915s`; `:65-71 /api/ 600s`; `:73-78 /socket.io/ 75s`; `:40-43 /ready 5s`
- Инвариант-тест (new): static-парсинг шаблона (location + proxy_read_timeout + client_max_body_size) ↔ `route-policy.ts` (entry 8): для каждого маршрута с timeout — edge ≥ gateway + margin

**Body:**
- `services/api-gateway/src/main.ts:38` — `50mb` json; `:34-43` content-route-обход (`ggufImportContentRoute` и др., `services/shared/*-route.cjs`)
- `services/catalog-service/src/main.ts:24` — `35mb` (→ 50mb)
- `services/api-gateway/src/proxy/proxy.service.ts:366` — model-chats `maxContentLength: 64MB` (upstream-бюджет запроса gateway→catalog)
- archive: `assetSourceArchiveRoute` (streaming, nginx 8g :47; gateway json-парсер не участвует)

**Rate-limit:**
- `services/api-gateway/src/proxy/proxy.service.ts:66` — `pairLimits` Map; `:461-489` — budgets: `:start` 15/min, `:poll` 6000/min, per-code 60/min, 60s-окно, 429 «Слишком много попыток подключения...»
- Gateway: PG-пул НОВЫЙ (в gateway `pg` нет: grep пусто), env — new (`compose.production.yml:269-291` api-gateway-блок + `deploy/production/environment-model.json` + `services/shared/runtime.cjs` requiredEnv)
- Rate-limit-таблица — catalog schema migration (DDL-owner): `services/catalog-service/src/catalog/catalog-schema.ts` (паттерн `ai_plugin_versions:40-49`)
- `services/oauth2-bridge/src/auth/auth.controller.ts:61` — `@Get('callback')` (token-exchange, без rate-limit); nginx `:24-29` — limit_req только на `/auth/login`

**Таблица entry 8:** `services/api-gateway/src/proxy/route-policy.ts` — значения `timeoutMs`/`maxBodyBytes`/`maxResponseBytes`/`rateLimit` (этот entry заполняет/меняет значения)

## Tasks & Acceptance

**Execution:**
- [ ] `services/shared/deadline-ladders.mjs` (new): `ladder(base, margins) → {server, gateway, edge, client}` + инструмент-тест (порядок, margin>0); рефакт `tool-import-deadline.cjs`/`model-chat-deadline.json` на формулу (значения идентичны)
- [ ] Embedding: `proxy.service.ts:566-570,633-635` — из формулы (client 115s, upstream 110s — OQ1); race закрыт
- [ ] Nginx: `frontend/nginx.production.conf.template` — model-chats location: regex → все model-chat-маршруты (или prefix location), edge ≥ gateway+margin; `/auth/callback` limit_req zone (new zone)
- [ ] Body: `catalog-service/src/main.ts:24` 35mb→50mb (OQ2); инвариант-тест body `nginx ≤ gateway ≤ upstream` (static: nginx-шаблон ↔ route-policy ↔ catalog)
- [ ] Инвариант-тест nginx-кромки (static): edge ≥ gateway + margin для каждого timeout-маршрута
- [ ] Rate-limit PG: схема (catalog migration: `rate_limit_windows` — key, window_start, count; atomic upsert), gateway PG-пул + env (compose + environment-model + runtime.cjs requiredEnv + Dockerfile? — pg-зависимость api-gateway), `proxy.service.ts:461-489` → PG (in-memory удалён), fail-closed 503 при PG-сбое
- [ ] oauth2-bridge: rate-limit `/auth/callback` (nginx zone + OQ3)
- [ ] Тесты: лестницы (invariant, embedding race), nginx-кромка (model-chats attachments не рвётся — static + e2e-сегмент OQ4), body 40MB (upload-тест), PG pairing (multi-replica-симуляция: 2 инстанса → один счётчик), fail-closed; регистрация

**Acceptance Criteria:**
- Given лестницы tool-import/model-chat/embedding, when расчёт из `base+margins`, then текущие значения воспроизведены (480/540/550; 900/910/915/920; embedding с margin>0); margin=0 → invariant-тест фэйл.
- Given model-chat маршрут вне `turns` (attachments), when nginx, then не рвётся на 600s (location покрывает; invariant-тест зелёный).
- Given upload 40MB, when nginx→gateway→catalog, then проходит (catalog 50mb); body-инвариант `nginx ≤ gateway ≤ upstream` зелёный.
- Given pairing-запросы с N gateway-реплик, when PG-счётчик, then лимит общий (2 реплики × 15 start/min = 15 total); PG down → 503.
- Given флуд `/auth/callback`, when rate-limit, then 429; `/auth/login` nginx zone сохранена.
- Корневой сьют — без деградации против baseline.

## Implementation Notes

Лестница — формула `server = base; gateway = base + m1; edge = gateway + m2; client = edge + m3` (m_i > 0): tool-import (480; +60; nginx 600 уже ≥ client 550 — nginx-мargins для tool-import НЕ в формуле, nginx-edge проверяется инвариант-тестом отдельно); model-chat (900; +10; +15; +5). Nginx-кромка — static-инвариант (без live nginx): парсинг `location` + `proxy_read_timeout`/`client_max_body_size` из шаблона (regex-локации нормализовать в path-паттерны). Body 40MB: nginx 50m = 52 428 800 B = gateway `50mb` (50×1024²) — равны (≤ ок); catalog 35mb = 36 700 160 B — узкое место; 40MB = 41 943 040 B > 35mb → 413 в catalog. PG rate-limit: таблица `rate_limit_windows(scope TEXT, key TEXT, window_start TIMESTAMPTZ, count INT, PK(scope,key,window_start))`, `INSERT ... ON CONFLICT DO UPDATE SET count=count+1` + `DELETE WHERE window_start < now()-interval '1 min'` (purge); gateway — read-write пул (2-3 коннекции), env `NEUROCENTER_RATE_LIMIT_DB_URL` (или существующий формат catalog DB URL — сверить с `catalog-service` env при реализации). Model-chats nginx location: текущий regex `^/api/model-chats/[a-f0-9-]{36}/turns(...retry)?$` → заменить на prefix `location ^~ /api/model-chats/` (покрывает turns + attachments + files + retry), `proxy_read_timeout 915s`.

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Nginx-edge в формуле или в инвариант-тесте?** Ladder-формула охватывает server/gateway/client (коды, под контролем проекта). Nginx — отдельный конфиг (шаблон): его значения фиксируются ИНВАРИАНТ-ТЕСТОМ (edge ≥ gateway + margin) + значением в шаблоне. Это честно отражает «лестница включает nginx-кромку» (AD-6) без ложной детерминации (nginx-read-timeout ≠ код).
2. **Gateway-пул PG — цена entry 9.** Gateway сейчас без state; PG-пул — новая зависимость (env, compose, environment-model, runtime.cjs). Альтернатива (rate-limit в catalog через internal-вызов) отвергнута: poll до 6000/min — DB-roundtrip на каждый poll = нагрузка; локальный пул (1-2 коннекции) дешевле. DDL-owner (инвариант 1.11: DDL security_events только catalog) сохраняется: таблицу создаёт catalog migration.
3. **Embedding race 115==115.** Сейчас client-timer и upstream-вызов с одним сроком: при ~115s бросок — неопределено, кто ответит первым (client 408 vs upstream ECONNABORTED→502). Фикс: upstream 110s + client 115s (client всегда позже — владелец «истёк» = client, upstream падает первым с margin 5s).

## Open Questions (с рекомендациями)

- **OQ1 — Embedding-значения: base 110 + margin 5 (client 115) или другие?** Рекомендация: upstream 110s / client 115s (сохранить клиентский срок 115s, не менять UX-ожидание). Подтвердить.
- **OQ2 — Body-выравнивание: поднять catalog 35mb→50mb (внутрь) или опустить nginx/gateway (наружу)?** Рекомендация: **поднять catalog до 50mb** (nginx 50m и gateway 50mb уже в проде, опустили бы — сломали бы существующие 40-50MB uploads; archive 8g — отдельный streaming-путь). Подтвердить.
- **OQ3 — Rate-limit token-exchange: nginx zone (single-edge) или PG-счётчик в bridge (строго AD-6)?** Рекомендация: nginx limit_req zone на `/auth/callback` (edge — одна инстанс nginx, фактически shared) + PG-счётчик в bridge — ОЦЕНИТЬ при реализации (bridge без PG: новый пул = цена; если дорого — только nginx zone с пометкой). AD-6-формулировка «(pairing, login) — в PG» — pairing точно PG (multi-replica gateway); login — nginx (edge) достаточно, так как edge един.
- **OQ4 — Nginx-инвариант: static (парсинг шаблона) или live (nginx в контейнере)?** Рекомендация: static (детерминированно, без docker) + e2e-сегмент в TRUST-01 (entry 14) на развёрнутом стеке.

## Verification

**Commands:** (node-тесты — только `$NODE`; node 24)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `$NODE scripts/test/deadline-ladders.test.mjs` (new) — expected: лестницы из формулы (480/540/550; 900/910/915/920), margin>0, embedding 110<115
- `$NODE scripts/test/nginx-edge-invariant.test.mjs` (new, static) — expected: model-chats location покрывает все model-chat-маршруты, edge ≥ gateway+margin; 40MB body-инвариант nginx≤gateway≤catalog
- `$NODE scripts/test/rate-limit-pg.test.mjs` (new, CATALOG_TEST_PG_URL; skip без БД) — expected: 2 инстанса → общий счётчик; PG down → 503
- `cd services/api-gateway && npm run build && cd services/catalog-service && npm run build` → gateway/catalog сьюты — без регрессии
- Upload-тест 40MB (e2e-сегмент или интеграция): nginx→gateway→catalog — 202/200, не 413
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации
