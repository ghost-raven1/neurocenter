---
title: 'Error visibility: admin UI Error-модуль + frontend-репортинг (AD-O5)'
type: 'feature'
ticket: '11'
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
  - frontend/src/modules/Audit/AuditModule.tsx
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-O5(3): ошибки видны в admin UI. Entry 10 даёт error_events + API (GET /api/errors) — но нет UI (оператор копает в psql) и нет frontend-репортинга (упавший SPA = тишина: ErrorBoundary/window.onerror в frontend отсутствуют). AD-O8/AD-19: в error-store попадают только safe-поля — client-репорт НЕ НЕСЁТ payload/URL-параметры/cookies (это и AD-O8, и приватность).

**Approach:** (1) admin UI: новый Error-модуль в frontend/src/modules/ (рядом с Audit — паттерн: ModuleBase + ProtectedRoute + lazySection, AuditModule.tsx:15-27): список error_events (API entry 10), фильтры service/requestId/period, только safe-поля (message-safe, stack-hint, requestId → переход в Audit-историю по correlation); (2) frontend-репортинг: ErrorBoundary + window.onerror + window.onunhandledrejection → POST /api/errors/client (rate-limited) {component, message-фикс (safe), stack-hint, requestId} — URL-параметры, cookies, payload НЕ отправляются; gateway → error-store (через catalog internal API entry 10); (3) message-safe = фиксированное сообщение (без passthrough — AD-O8/AD-19, тот же принцип для client-facing).

## Boundaries & Constraints

**Always:**
- UI — только safe-поля (API entry 10 отдаёт только safe; UI не запрашивает «больше»).
- Client-репорт: фиксированный набор полей (component, message-фикс, stack-hint, requestId) — payload/URL/cookies запрещены (тест).
- Rate-limit на client-репорт (всплеск = 429, не затопление error_events).
- requestId в client-репорте = X-Request-ID из контекста (entry 6) — correlation с логами/аудитом.

**Never:**
- Не отправлять в репорт: URL-параметры, query-строку, cookies, localStorage, request/response тела.
- Не показывать в UI сырой stack (только stack-hint — safe-представление entry 10).
- Не дублировать Audit-модуль (Error = ошибки; Audit = действия; переход по requestId — ссылка, не копия).
- Не вводить новый канал доставки (client → gateway → catalog — существующая топология /api/).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Render-ошибка в SPA | throw в компоненте | ErrorBoundary → POST /api/errors/client (safe-поля) → error_events (source=client) |
| 2 | window.onerror | runtime-ошибка | репорт (safe-поля), страница не падает (boundary) |
| 3 | unhandledrejection | rejected promise | репорт (safe-поля) |
| 4 | Всплеск репортов | 100/мин с одного IP | rate-limit → 429 (остальные не теряются безлимитно — OQ-2) |
| 5 | UI-список | GET /api/errors?service=rag | события rag (safe-поля) |
| 6 | Переход по requestId | клик по requestId | Audit-история (entry 14 единая) с тем же requestId |
| 7 | Client-репорт с payload в error | error c data-объектом | в записи нет payload (только component/фикс/stack-hint) |
| 8 | UI без прав (не admin) | GET /api/errors | 403 (admin-роут, паттерн ProtectedRoute) |
| 9 | stack-hint в UI | запись c stack-hint | показан safe-stack (кадры), не сырые значения |

## Code Map

- `frontend/src/modules/Audit/AuditModule.tsx:15-27` — паттерн модуля (ModuleBase, ProtectedRoute, lazySection, AUDIT_ROUTE)
- `frontend/src/modules/index.ts` — регистрация модулей (новый Error-модуль)
- `frontend/src/core/baseRoutes` — роуты (новый error-роут)
- `frontend/src/features/UserBlock/permissions` — AUDIT_ROUTE (паттерн прав для ERROR_ROUTE)
- `frontend/src/common/components/` — ProtectedRoute, LazySection (переиспользование)
- `services/catalog-service/src/catalog/catalog.controller.ts:612` — @Get('audit') (паттерн admin-API; errors-API = entry 10)
- `frontend/nginx.production.conf.template:3,32-34` — limit_req-паттерн (neurocenter_login zone) для /api/errors/client
- `services/api-gateway/src/proxy/` — прокидка /api/errors/client → catalog (entry 10 internal)
- Entry 10: GET /api/errors (admin), POST /internal/error-events (outbox-канал) — consumer этой story

## Tasks & Acceptance

### Execution
- [ ] Error-модуль: frontend/src/modules/Error/ (ErrorModule.tsx по паттерну AuditModule; Error.tsx — список + фильтры service/requestId/period; errorPresentation.ts — safe-поля; index.ts)
- [ ] Регистрация: modules/index.ts + baseRoutes (error-роут) + permissions (ERROR_ROUTE, admin)
- [ ] UI: список (пагинация — паттерн Audit), фильтры, detail (message-safe + stack-hint + requestId-ссылка → Audit)
- [ ] Client-репорт: frontend/src/common/error-reporting/ (ErrorBoundary.tsx + installWindowHandlers: onerror/onunhandledrejection → reportClientError())
- [ ] reportClientError(): POST /api/errors/client {component, message: fixed, stackHint, requestId (из X-Request-ID контекста entry 6)} — БЕЗ payload/URL/cookies (allowlist-сбор полей)
- [ ] Gateway: роут /api/errors/client → catalog internal (entry 10) — rate-limit: nginx limit_req (новый zone errors_client, OQ-1) ИЛИ app-level (token bucket) — решение OQ-1
- [ ] Тесты: (а) e2e-frontend: симуляция render-ошибки (fixture-компонент) → ErrorBoundary → POST → error_events (source=client); (б) unhandledrejection fixture → репорт; (в) payload/URL в error → в записи отсутствуют (assertion полей); (г) rate-limit: всплеск → 429; (д) UI-фильтры (fixture error_events)
- [ ] UI-тест: переход по requestId → Audit (correlation)

### Acceptance
- **Given** render-ошибка в SPA (fixture) **when** ErrorBoundary **then** POST /api/errors/client (safe-поля) → запись в error_events
- **Given** unhandledrejection (fixture) **when** handler **then** репорт (safe-поля)
- **Given** error с payload/URL-параметрами **when** репорт **then** в записи payload/URL отсутствуют (только component/фикс/stack-hint/requestId)
- **Given** всплеск репортов **when** rate-limit **then** 429 (не затопление)
- **Given** UI Error-модуль **when** фильтры service/requestId/period **then** события (safe-поля), переход по requestId → Audit

## Design Notes

- **Модуль по паттерну Audit:** ModuleBase + ProtectedRoute + lazySection — минимальный путь (без нового механизма). Error ≠ Audit: Error = crash/исключения (error_events), Audit = действия (operations/security_events); связь = requestId (correlation, entry 6/14).
- **Client-репорт = allowlist-полей (не dump):** AD-O8/AD-19 — в store только safe. reportClientError собирает ТОЛЬКО фиксированный набор (component name, fixed message, stack-hint, requestId) — не error-объект целиком (иначе payload утащит). Тест (в) — защита от регрессии.
- **Rate-limit:** nginx limit_req (паттерн neurocenter_login :3/:32-34) — простой, уже в template; app-level — гибче. OQ-1: рекомендация nginx (единый механизм, без нового кода в gateway).
- **source=client vs service:** error_events.service для client-репортов = 'frontend' (фиксированное значение) — отличает от сервис-крэшей (entry 10: service = имя сервиса). OQ-3.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
# e2e-frontend (dev-стек):
docker compose up -d
# Симуляция render-ошибки (fixture-роут /__test-error) → ErrorBoundary → репорт
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "localhost:4000/api/errors?service=frontend" | jq '.items[0]'
# Rate-limit:
for i in $(seq 50); do curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:4000/api/errors/client -d '{}'; done | sort | uniq -c
```
Ожидаемо: client-репорт в error_events (safe); payload/URL отсутствуют; всплеск → 429; UI-фильтры зелёные; корневой сьют — без деградации.

## Open Questions (с рекомендациями)

1. **Rate-limit механизм**: nginx limit_req (рекомендация — паттерн :3/:32-34, без нового gateway-кода) vs app-level token bucket (гибче, но код в gateway). Рекомендация: nginx (zone errors_client, 10r/m per IP + burst).
2. **Потеря при 429**: при rate-limit репорт отбрасывается (не в outbox). Рекомендация: да (client-репорт = best-effort; crash-loop на клиенте = сигнал в metric, не в each-запись). OQ: batch-коаляция на клиенте (1 репорт/мин) — рекомендация: да, коаляция (уменьшает и нагрузку, и 429).
3. **service='frontend' для client-репортов**: фиксированное значение vs 'frontend:<component>'? Рекомендация: 'frontend' (фиксированное — кардинальность; component в message-safe/stack-hint).
4. **UI: отдельный модуль vs вкладка в Audit?** Рекомендация: отдельный модуль (Audit — действия, Error — ошибки; разные модели, разные права). Переход по requestId — ссылка.
