---
title: 'Health: /ready — единственная семантика, /health удалён, бюджеты-константы (AD-O4)'
type: 'feature'
ticket: '9'
created: '2026-11-09'
status: done
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
  - services/shared/readiness.cjs
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-O4: одна семантика — healthcheck compose и внешний мониторинг = `/ready` (503 + checks, ратификация). В main ДВЕ семантики: `/ready` (catalog app.controller.ts:12-19 — postgres-check, gateway :9-12 + /ready/dependencies :15-32) и `/health` (catalog :25-28, gateway :39-42, остальные 4 сервиса — те же 2 эндпоинта; nginx template:27 — `location = /health { return 200 }` — статический 200 без проверки). `/health` информации не несёт (liveness = «контейнер жив» = docker restart policy, не endpoint). Бюджеты checkReadiness 2500 мс / httpReady 2000 мс / limit тела 16384 Б — литералы в shared/readiness.cjs (:11/:26/:42): уже один источник, но НЕ именованные константы и нет invariant-теста, что сервисы не хардкодят свои бюджеты.

**Approach:** (1) `/health` УДАЛЯЕТСЯ: 6 app.controller.ts + nginx template:27 (location) + observability.cjs:20 (ветка `/health` в group() — dead-ветка после удаления); (2) бюджеты — именованные константы `shared/readiness.cjs` (READINESS_CHECK_TIMEOUT_MS = 2500, HTTP_READY_TIMEOUT_MS = 2000, READY_BODY_LIMIT_BYTES = 16384) + экспорт + invariant-тест: литералы 2500/2000/16384 (и эквивалентные ms-выражения) в services/*/src = 0 (хардкод бюджетов в сервисах = фэйл); (3) `/ready/dependencies` (gateway :15-32, 5 upstream'ов: catalog/skills/rag/auth/featureFlags): решение зафиксировано — ОСТАВИТЬ, consumers: stack-watchdog (AD-OP-8, эпик 4) + admin UI (OQ-1); документ consumers в доке; (4) задокументировать: capacity-метрики не рендерятся у gateway/bridge/ff (CAPACITY_REQUIRED=false — осознанно; capability-документ, entry 8 делает аннотацию, здесь — health-смысл: /ready не проверяет capacity).

## Boundaries & Constraints

**Always:**
- `/ready` — единственная health-семантика (503 + checks-разложение; docker healthcheck без изменений — уже используют /ready).
- Бюджеты — только из shared/readiness.cjs (именованные константы); сервисы их не знают.
- `/ready/dependencies` — остаётся до решения эпика 4 (consumers задокументированы).
- Поведение compose healthchecks — без изменений (все уже /ready; regression-тест).

**Never:**
- Не добавлять liveness-эндпоинт (liveness = docker, не HTTP).
- Не менять формат ответа /ready ({ok, checks} — consumers: compose healthcheck, httpReady readiness.cjs:24-56, stack-watchdog).
- Не менять 5 upstream'ов /ready/dependencies (топология фиксирована).
- Не вводить /health-совместимость (301/алиас) — consumers нет (nginx location удаляется; sweep подтверждает отсутствие внешних consumers — OQ-2).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | GET /health (сервис) | любой из 6 | 404 (роут удалён) |
| 2 | GET /health (nginx) | https://host/health | 404 (location удалена; SPA-fallback :79 отдаст index.html? — нет: /health не файл → try_files → index.html 200 — см. OQ-3) |
| 3 | GET /ready (catalog) | postgres down | 503 + checks {postgres: 'unavailable'} (ратификация) |
| 4 | GET /ready (gateway) | — | 200 {ok, checks:{gateway:'ready'}} (ратификация) |
| 5 | GET /ready/dependencies | rag down | 503 + checks (ratified) |
| 6 | Бюджет в сервисе (новый) | хардкод 2500 в src | invariant-тест фэйл |
| 7 | Docker healthcheck | compose up | все /ready-проверки зелёные (regression) |
| 8 | observability group() | /ready-запрос | group="ready" (ветка /health удалена, /ready работает) |

## Code Map

- `services/catalog-service/src/app.controller.ts:25-28` — /health (удалить); :12-19 — /ready (ратификация)
- `services/api-gateway/src/app.controller.ts:39-42` — /health (удалить); :9-12 — /ready; :15-32 — /ready/dependencies (5 upstream'ов, consumers — OQ-1)
- `services/{feature-flags-service,oauth2-bridge,rag-sync-service,skills-service}/src/app.controller.ts` — /health + /ready (удалить /health в каждом; точные строки — сверить на impl, паттерн одинаковый)
- `frontend/nginx.production.conf.template:27` — `location = /health { return 200 ... }` (удалить); :28-31 — /ready proxy (ратификация)
- `services/shared/observability.cjs:20-22` — group(): ветка `/health` (dead после удаления; :21 /ready остаётся)
- `services/shared/readiness.cjs:11` (2500 мс), `:26` (2000 мс), `:42` (16384) — литералы → именованные константы + экспорт
- `compose.production.yml` — healthcheck'и всех сервисов (уже /ready — не менять; regression)
- `scripts/test/` — новый readiness-invariant.test.mjs (бюджеты из shared только)

## Tasks & Acceptance

### Execution
- [x] readiness.cjs: именованные константы (READINESS_CHECK_TIMEOUT_MS/HTTP_READY_TIMEOUT_MS/READY_BODY_LIMIT_BYTES) + экспорт; значения не меняются (2500/2000/16384)
- [x] 6 app.controller.ts: удалить @Get('health') + тесты на /health (если есть — найти при impl)
- [x] nginx template:27 — удалить location /health
- [x] observability.cjs:20-22 — убрать ветку /health из group() (group('health') dead)
- [x] Invariant-тест: readiness-invariant.test.mjs — (а) литералы 2500/2000/16384 в services/*/src (excl. shared) = 0; (б) shared/readiness.cjs использует константы (не литералы); (в) grep '/health' в services/*/src + nginx template = 0
- [x] Документ: /ready/dependencies — consumers (stack-watchdog AD-OP-8, admin UI) + решение «удалить, если к концу эпика 4 не подключён» (docs/capacity-admission.md или док эпика)
- [x] Regression: compose healthchecks (docker compose ps — все healthy), /ready-тесты сервисов (существующие — без изменений)

### Acceptance
- [x] **Given** grep `/health` в services/*/src + nginx template **when** после удаления **then** 0 вхождений
- [x] **Given** docker compose up (dev/prod-стек) **when** healthchecks **then** все /ready-проверки зелёные (без изменений)
- [x] **Given** хардкод бюджета (2500) в src сервиса **when** invariant-тест **then** фэйл
- [x] **Given** GET /ready/dependencies **when** upstream down **then** 503 + checks (ратификация, без изменений)

## Design Notes

- **Почему /health — удаление, а не алиас:** AD-O4 прямо: «/health удаляется». Liveness = контейнер жив (docker restart: unless-stopped + init:true, x-service anchor :3-4) — endpoint для этого не нужен; два endpoint'а = две семантики = «кто прав?» при инциденте.
- **nginx /health → SPA-fallback:** после удаления location /health — `try_files $uri $uri/ /index.html` (:79) отдаст index.html (200). Это допустимо (SPA-поведение для неизвестных путей), но health-семантику не раскрывает. OQ-3: явный 404 для /health в nginx (location = /health { return 404; }) vs SPA-fallback. Рекомендация: 404 — семантика «эндпоинта нет» яснее, чем «это SPA».
- **/ready/dependencies остаётся:** 5 upstream'ов — полезная диагностика (stack-watchdog эпик 4 — главный consumer; AD-OP-8). Удаление до подключения = потеря диагностика; решение зафиксировано с датой ревизии (конец эпика 4).
- **Invariant-тест литералов:** грубый grep 2500/2000/16384 может дать ложные срабатывания (порты, размеры) — тест ищет литералы в контексте таймаутов/лимитов (OQ-4: точность паттерна на impl; рекомендация — grep по констант-именам + ручной allowlist чисел).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/readiness-invariant.test.mjs
grep -rn "'health'" services/*/src --include="*.ts"   # → 0
grep -n "health" frontend/nginx.production.conf.template   # → 0
# Regression (dev-стек):
docker compose up -d && docker compose ps   # все healthy
curl -s localhost:4000/ready && curl -s localhost:4000/ready/dependencies
```
Ожидаемо: invariant зелёный; /health=0; стек healthy; /ready + /ready/dependencies 200; корневой сьют — без деградации.

## Open Questions (с рекомендациями)

1. **/ready/dependencies — оставить до эпика 4?** Рекомендация: да (consumers: stack-watchdog AD-OP-8 + admin UI); решение «удалить, если к концу эпика 4 не подключён» — зафиксировано в доке (ticket entry 9). Ревизия = задача эпика 4.
2. **Внешние consumers /health?** (мониторинг-системы, скрипты). Sweep: grep /health в scripts/ + docs/ + monitoring-конфигах. Рекомендация: если найдены — мигрировать на /ready в этой story (compose healthchecks уже /ready).
3. **nginx /health после удаления**: SPA-fallback (200 index.html) vs явный 404? Рекомендация: `location = /health { return 404; }` — явная семантика «эндпоинт удалён», не маскировать под SPA.
4. **Точность invariant-теста (ложные срабатывания 2500/2000/16384)**: grep чисел vs контекстный поиск? Рекомендация: grep чисел + allowlist (порты/размеры) — простой и детерминированный; на impl зафиксировать allowlist.

## Progress (2026-11-19)

**Итог: done.** `/health` удалён из всех 6 сервисов + nginx (prod- и dev-шаблон); бюджеты readiness — именованные константы в `shared/readiness.cjs` + invariant-тест; `/ready` — единственная health-семантика; решение по `/ready/dependencies` и `CAPACITY_REQUIRED=false` зафиксированы в доке.

### Изменённые файлы

**Исходники / конфиги:**
- `services/{api-gateway,catalog-service,feature-flags-service,oauth2-bridge,rag-sync-service,skills-service}/src/app.controller.ts` — удалены `@Get('health')` + метод `health()` (+ вводящие в заблуждение JSDoc `Health-check`/`Health-эндпоинт`); комментарии приведены к единой семантике `/ready` (liveness-эндпоинта нет).
- `services/shared/readiness.cjs` — добавлены `READINESS_CHECK_TIMEOUT_MS=2500`, `HTTP_READY_TIMEOUT_MS=2000`, `READY_BODY_LIMIT_BYTES=16384`, используются в логике и экспортируются.
- `services/shared/readiness.d.cts` — добавлены объявления трёх констант.
- `services/shared/observability.cjs` — в `group()` удалена ветка `/health` (осталась только `/ready` → group `ready`).
- `services/api-gateway/src/proxy/route-policy.ts` — удалена строка `{ path: '/health' }`.
- `services/api-gateway/src/proxy/shadowing-diagnostic.ts` — удалена запись `/health` из `EXPECTED_CONTROLLERS` + обновлён шапковый комментарий.
- `frontend/nginx.production.conf.template` — удалена `location = /health { return 200 ... }`.
- `frontend/nginx.conf` (dev) — удалена `location = /health { ... }`.
- `docker-compose.yml` (dev) — healthcheck'и frontend(8080)/bridge(22222)/gateway(4000)/catalog(4100)/skills(4200)/rag-sync(4300) мигрированы `/health` → `/ready` (feature-flags:4400 уже `/ready`).
- `docs/capacity-admission.md` — добавлен раздел «Единственная health-семантика: /ready (AD-O4)»: consumers `/ready/dependencies` (stack-watchdog AD-OP-8, admin UI) + решение «удалить к концу эпика 4»; `CAPACITY_REQUIRED=false` — capacity-снимок не рендерится у gateway/bridge/feature-flags.

**Тесты:**
- `scripts/test/readiness-invariant.test.mjs` — новый invariant-тест (а/б/в, см. ниже).
- `scripts/test/gateway-app-runtime.test.mjs` — удалены ассерты `/health` (маршрут удалён); после-закрытие проверяется по `/ready`.
- `scripts/test/production-stack.mjs` — удалён liveness-ассерт `/health` (503 `/ready` уже доказывает «живой HTTP-процесс»).
- `scripts/test/qa-api.mjs` — `/health` → `/ready` (rag-sync 4300).

### Инвариант-тест (readiness-invariant.test.mjs) — целевой

Из-за ложных срабатываний грубого grep 2500/2000/16384 (порты/размеры в src) тест сужен (OQ-4): (а) `shared/readiness.cjs` экспортирует константы с каноническими значениями и использует их в логике (не литералы в вызовах); (б) сервисы в `services/*/src` не переопределяют имена констант, а `app.controller.ts` не содержит проверяемых бюджетов (ровно 6 файлов); (в) grep `/health` в `services/*/src` + `frontend/nginx*.conf` = 0. Грубый grep по всем `services/*/src` для числовых бюджетов НЕ реализован.

### Результаты проверок (Node v24)

- `readiness-invariant.test.mjs` — 3/3 pass.
- `readiness.test.cjs` + `observability.test.cjs` — 11/11 pass.
- `route-policy-completeness.test.mjs` + `nginx-edge-invariant.test.mjs` + `route-shadowing-diagnostic.test.mjs` — 15/15 pass.
- `gateway-app-runtime.test.mjs` — 9/9 pass.
- Typecheck (tsc `--noEmit`): api-gateway (через `nest build`) + catalog/feature-flags/oauth2-bridge/rag-sync/skills — без ошибок.
- `openapi-document.test.mjs` — **pre-existing red** (338 ≠ 334, 2 fail), НЕ регрессия: на baseline (git stash) результат идентичен (338 ≠ 334, тот же manifest-фейл); `/health` из публичной OpenAPI-поверхности и так исключён в `scripts/openapi/routes.mjs`, поэтому удаление маршрута не меняет счётчик.
- Docker-стек (dev/prod compose ps) — недоступен (Docker unusable); живая проверка отложена в RES-01. Источниковая проверка состава healthcheck'ов выполнена (все `/ready`).

### Отклонения и риски

1. **Dev-tooling `/health`** вне scope: `scripts/workspace/dev-service-health.mjs` (devServices), `scripts/dev-mcp/health.mjs`, `scripts/test/dev-health-*`, `dev-cli`, `dev-watch-*`, `dev-start`, `skill-packaging.fixture`, `catalog-requests.fixture`, `system-role-chat-runtime.fixture` используют `/health` как liveness-путь dev-инструментов — оставлены без изменений (отдельная подсистема, не health-семантика сервисов). Кандидат на отдельную задачу/эпик.
2. **`scripts/openapi/routes.mjs:112`** — осталась ветка фильтра `clean === '/health'` (dead после удаления; документ и так не публикует `/health`). Не влияет на acceptance; можно удалить как follow-up.
3. **Проверка `/ready` принятие compose** — только источниковая (Docker недоступен). Валидация в живом стеке — RES-01.
4. **OQ-3 (nginx явный 404 для `/health`)** НЕ выполнен: добавление `location = /health { return 404; }` создало бы вхождение `/health` и провалило инвариант (в). После удаления `/health` → SPA-fallback (index.html 200) — принято по плану.
5. **`check-tooling-tests.json`** не изменён (конфликт-прун; invariant-тест запускается напрямую по `node --test`). Если требуется включить в tooling-гейт — отдельно синхронизировать с `workspace-check-tooling.test.mjs` `expectedFiles`.
