---
title: 'TRUST-01: приёмка устройственного канала и каталога (e2e)'
type: 'feature'
ticket: '14'
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

**Problem:** Эпик 2 (trust-device-catalog) закрыт по частям (2.1–2.13), но ни одна линия не доказала на **production-стеке** целиком, что **устройственный канал и каталог** работают как записано в AD/FR: mcp-host жив (shadowing закрыт, connect→билет→канал), билет верифицируется (ceiling + claim↔descriptor), отзыв работает (TTL/кэш/re-issue/пул/pids/non-root), retire необратим с аудитом, gateway-политики (роут-таблица/лестницы/body/error-body) действуют в проде, ceiling — единый источник (identity client=server), UJ-2 работает (карточка с SHA + immutable-версии + одобренный комплект). Каждая часть проверена изолированно (unit/integration/свой сьют), но связка «устройство→gateway→catalog→контракт» на развёрнутом production-стеке — нет. TRUST-01 — приёмка эпика 2 целиком (аналог REL-01 для эпика 1) и предпосылка волн 7/8/9 (живой mcp-host, верифицированные билеты, версии каталога).

**Approach:** Новая e2e-линия `scripts/test/trust-device-e2e.mjs` (driver), оркестрирующая 7 фаз на **production-стеке** (паттерн `production-stack.mjs`: unique compose-проект, fresh volumes, local Blitz fixture, чистая сборка с кандидата): (T1) mcp-host жив — connect→билет→канал 200 (scripted device-клиент, паттерн `mcp-host-install.test.ts`), shadowing закрыт (live: `/api/mcp-host/connect` отвечает контроллером, не прокси), билет в nginx-логах **замаскирован**; (T2) билет верифицируется — HMAC+exp+claim≤ceiling+claim↔descriptor (descriptorSha256), retired-версия → отказ; (T3) отзыв — TTL 24h (claim exp), re-check ≤60s (кэш), re-issue при reconnect, пул-квоты (MAX_HOSTS), pids/non-root (docker inspect контейнера api-gateway); (T4) retire необратим — новые назначения запрещены, запуск в mcp-host + проверка билета не проходят, аудит (security_events), провенанс сохранён; (T5) gateway — route-таблица + completeness + лестницы + body-бюджеты + error-body (static-тесты на развёрнутом коде + live: 40MB upload проходит, 5xx — fixed-body, hostname:port в client-body нет); (T6) контрактная версия + ceiling — identity (значения, видимые bridge-клиентом и server-verify, идентичны — на развёрнутом стеке); (T7) UJ-2 — карточка (версия+SHA+источник+время+издатель, API-уровень автоматически, UI-уровень HITL), immutable-версии, SHA-опись, одобренный комплект (pin-only). Кандидат заморожен (commit SHA, HITL-выбор). Большая часть фаз автоматизируется (scripted device-клиент, docker inspect, API-чеки); HITL — выбор кандидата, запуск/ресурсы стека, UI-проверка UJ-2, решение «принят/отклонён».

## Boundaries & Constraints

**Always:**
- Линия стартует с **чистого git-checkout** кандидата (паттерн `release-candidate-e2e.mjs`/`production-stack.mjs`); commit SHA кандидата — в отчёте.
- **Кандидат заморожен**: оператор выбирает commit (HITL); driver **сверяет** `git rev-parse HEAD` == аргумент, не создаёт тег (тег — релизный процесс, не TRUST-01).
- Все проверки T1–T7 — на **production-стеке** из `setup.mjs build` (не dev-стек, не `latest`).
- Device-клиент — **scripted** (паттерн `mcp-host-install.test.ts`/`mcp-host-access-http.test.mjs`): реальное устройство/паринг НЕ требуются для гейта (HITL-реальное устройство — опциональный усиленный прогон, H3).
- Privated-значения (секреты, билеты) из стека в плане/отчёте/логах НЕ раскрываются; билет в nginx-логах — маскирован (T1 проверяет именно это).
- Тесты/сборка — `~/.nvm/versions/node/v24.22.0/bin/node`; docker build — sequential + cooldown (load < 8, прецедент эпика 1).
- Повторяемый гейт — на этой машине (вариант B эпика 1, если применимо); истинный «чистый хост» — вне TRUST-01 (REL-01).

**Never:**
- Не править production-код сервисов — e2e-линия **конsumирует** артефакты 2.1–2.13, не пересобирает (баг на e2e-этапе = дефект сторис, эскалация, не фикс в e2e).
- Не обходить чистого-checkout гейта и `--pull never` (закрытый контур); внешние registry не источник.
- Не выполнять T1–T7 на dev-стеке как «достаточно» (production-стека — обязательное условие).
- Не подменять scripted device-клиент «доверять любому билету» (fail-closed, NFR-2).
- Не раскрывать билеты/секреты в отчёте (маскирование — проверяемое требование T1).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| T1_MCPHOST_LIVE | scripted device → connect → билет → `m/:ticket` | канал отвечает (200/jsonrpc), shadowing закрыт (контроллер, не прокси) | 404/прокси-ответ = фэйл (HITL-эскалация) |
| T1_LOG_MASKED | запрос `m/:ticket`, затем nginx access-log | билеты в логах НЕТ (маскирование entry 4) | билет в логе = фэйл (CRIT) |
| T2_VERIFY_OK | билет: HMAC+exp+claim≤ceiling+descriptorSha256 | verify проходит (channel работает) | — |
| T2_CEILING | claim > ceiling | отказ (invalid) | actionable |
| T2_RETIRED | версия retired (entry 7), затем authorize-session | отказ (retire-gate) | actionable |
| T3_TTL | claim exp = issuance + 24h | после exp — отказ; re-issue при reconnect — новый билет | — |
| T3_CACHE | отозвать device, запрос в окне ≤60s | re-check ≤60s (кэш), затем отказ | — |
| T3_POOL | MAX_HOSTS активных хостов | (N+1)-й — отказ (квота) | actionable |
| T3_PIDS_NROOT | `docker inspect` api-gateway | pids_limit + user (non-root) по entry 6 | расхождение = фэйл |
| T4_RETIRE | retire версии: новое назначение, запуск mcp-host, verify билета | все три — отказ; аудит (security_events); провенанс сохранён | — |
| T4_IRREVERSIBLE | попытка «раз-retire» (active после retired) | отказ (необратимо, entry 7/assertIndexEvolution) | actionable |
| T5_ROUTE_TABLE | static: completeness + лестницы + body-инварианты (на коде кандидата) | все зелёные (entry 8/9/10) | фэйл с маршрутом/парой |
| T5_BODY_40MB | live: upload 40MB (nginx→gateway→catalog) | проходит (не 413 глубоко) | 413 = фэйл |
| T5_ERROR_BODY | live: upstream 5xx / транспортный сбой | fixed-body, hostname:port в client-body НЕТ | leak = фэйл |
| T6_IDENTITY | ceiling-значения bridge-клиента vs server-verify (развёрнутый стек) | идентичны (entry 2) | рассогласование = фэйл (CRIT) |
| T7_CARD | `GET /versions` + `/package` (active version) | 5 полей: версия + SHA (manifest) + источник + время + издатель | отсутствие поля = фэйл |
| T7_IMMUTABLE | re-publish same version / UPDATE-скан | отказ / INSERT-only | — |
| T7_KIT | установка c version/manifest ≠ pin проекта | отказ (pin-only) | actionable |
| T7_UI | (HITL) карточка в браузере | провенанс-секция видна | — |
| CANDIDATE | commit SHA (HITL-выбор) | driver сверяет HEAD == кандидат | расхождение → фэйл до стека |

</frozen-after-approval>

## Code Map

**E2E-harness (существующий, переиспользовать):**
- `scripts/test/production-stack.mjs` — **e2e-harness** (build→up→~30 live-чеков; local Blitz fixture, unique compose-проект, fresh volumes); TRUST-01 переиспользует `configureProduction`+override-ports+`request()`+fixtures
- `scripts/test/production-bridge.fixture.mjs` — live-фикстуры bridge-endpoints (паттерн для T1-смежных чеков)
- `scripts/production/setup.mjs` — `build`/`configure`/`seed`/`up` (точка врезки развёртывания)
- `services/shared/runtime.cjs` — `validateProduction` (production-валидация на импорте — включена в старт стека)

**mcp-host (T1/T2/T3):**
- `mcp/neurocenter-asset-sync/integration/test/mcp-host-install.test.ts` — **scripted device-клиент** (паттерн для T1)
- `scripts/test/mcp-host-access-http.test.mjs` — per-controller HTTP-тесты catalog (CATALOG_TEST_PG_URL; паттерн для T2/T4 live-сегмента)
- `services/api-gateway/src/features/mcp-host/mcp-host.controller.ts:48,140` — connect + канал (T1 live)
- `services/api-gateway/src/features/mcp-host/ticket.ts` — TTL 24h (entry 6), verify (entry 5) (T2/T3)
- `services/catalog-service/src/devices/mcp-host-access.ts:201-210` — authorize-session (re-check ≤60s, retire-gate) (T2/T3/T4)
- `frontend/nginx.production.conf.template:2` — log_format (T1 маскирование: читать access-log контейнера frontend после запроса `m/:ticket`)

**Retire/аудит (T4):**
- `services/catalog-service/src/catalog/catalog.controller.ts:686,715` — versions/activate (retire — entry 7 эндпоинт, сверить при реализации)
- `security-events` (DDL catalog, 1.11) — аудит-записи retire (T4)

**Gateway-политики (T5):**
- `services/api-gateway/src/proxy/route-policy.ts` (entry 8) + `scripts/test/route-policy-completeness.test.mjs` — static-сегмент T5
- `services/shared/deadline-ladders.mjs` (entry 9) + nginx-инвариант — static-сегмент T5
- error-body (entry 10): static + live (5xx fixed, no hostname:port)

**Identity (T6):**
- `scripts/test` (entry 2 identity-тест) — live-сегмент: значения ceiling у bridge-клиента (развёрнутый образ) vs server-verify (развёрнутый gateway)

**UJ-2 (T7):**
- `services/catalog-service/src/catalog/catalog.controller.ts:686,728` — `/versions` + `/package` (API-уровень T7)
- `frontend/src/modules/Store/StoreDetailsModal.tsx` (entry 12) — UI-уровень T7 (HITL)
- `services/catalog-service/src/publication/plugin-repository.ts:528-539` — INSERT-only (T7 immutability)

**Тест (НОВЫЙ):** `scripts/test/trust-device-e2e.mjs` (driver T1–T7) + регистрация `check-tooling-tests.json` + expectedFiles

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/test/trust-device-e2e.mjs` (new, driver) — T1–T7 как матрица; переиспользовать `production-stack.mjs` (configureProduction/override/request/fixtures) + scripted device-клиент (паттерн `mcp-host-install.test.ts`)
- [ ] T1 — mcp-host live: connect→билет→канал 200 (scripted device), shadowing (live: контроллер отвечает), nginx-лог маскирован (чтение access-log после запроса `m/:ticket`)
- [ ] T2/T4 — verify (ceiling/descriptorSha256/retired) + retire-необратимость (назначение/запуск/verify — отказ; security_events; провенанс)
- [ ] T3 — TTL 24h (claim exp), re-check ≤60s, re-issue при reconnect, пул-квоты, `docker inspect` (pids_limit/user)
- [ ] T5 — static (completeness/лестницы/body-инварианты/error-body на коде кандидата) + live (40MB upload, 5xx fixed, no hostname:port)
- [ ] T6 — identity: ceiling у bridge-клиента (развёрнутый) == server-verify (развёрнутый)
- [ ] T7 — API-уровень (5 полей провенанса, immutability, pin-only) автоматически; UI-уровень — HITL (H4)
- [ ] HITL-ранбук `docs/trust-device-e2e.md` (new): выбор кандидата (H1), запуск (H2), UI-проверка (H4), интерпретация отчёта (H5)
- [ ] Регистрация: `check-tooling-tests.json` + expectedFiles (union+sort)

**Acceptance Criteria:**
- Given production-стек с кандидата, when T1, then mcp-host жив: connect→билет→канал 200, shadowing закрыт, билет в nginx-логах маскирован.
- Given билет (HMAC+exp+claim≤ceiling+descriptorSha256), when T2, then verify проходит; retired-версия → отказ (T2/T4).
- Given отзыв/TTL/кэш/пул, when T3, then TTL 24h, re-check ≤60s, re-issue при reconnect, квоты, pids/non-root — все зелёные.
- Given retire версии, when T4, then необратимо (назначение/запуск/verify — отказ), аудит (security_events), провенанс сохранён.
- Given gateway-политики, when T5, then completeness/лестницы/body/error-body — static+live зелёные (40MB проходит, 5xx fixed, no hostname:port).
- Given ceiling, when T6, then identity: bridge-клиент == server-verify (развёрнутый стек).
- Given UJ-2, when T7, then карточка (5 полей) + immutable + SHA + одобренный комплект (API автоматически, UI — HITL).
- Отчёт `trust-device-e2e.json` (кандидат, результаты T1–T7) записан; оператор подтверждает «эпик принят» (H5).

## Implementation Notes

- **Граница с `production-stack.mjs`:** harness уже делает build→up→live-чеки (rel-линия). TRUST-01 **добавляет** T1–T7 (mcp-host/verify/retire/policies/identity/UJ-2) и **переиспользует** инфраструктуру (не переписывает).
- **Scripted device-клиент вместо реального устройства:** `mcp-host-install.test.ts`/`mcp-host-access-http.test.mjs` уже поднимают device-сессию скриптом (local Blitz fixture) — TRUST-01 делает то же на production-стеке; реальное устройство (H3) — опциональный усиленный прогон, не обязательный для гейта.
- **Nginx-лог маскирования (T1):** access-log контейнера frontend (`/dev/stdout` → docker logs) — после live-запроса `m/:ticket` скан лога на presence ticket-строки (маскирование entry 4: `m/:ticket` → маска). CRIT-признак: билет в логе.
- **T6 identity на развёрнутом стеке:** bridge-клиент и gateway — разные образы; identity = значения ceiling, которые каждый реально использует (из развёрнутого кода/образа), не из исходника — проверка на расхождение образов (stale build).

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Семь фаз = семь линий tickets.toml entry 14.** T1–T7 1:1 соответствуют пунктам (1)–(7) в description entry 14; driver-отчёт F-подобный (`trust-device-e2e.json`) — по фазам, каждая идемпотентна.
2. **HITL-точки:** (H1) **выбор кандидата** — commit SHA (продуктивное решение: какой commit принимается); (H2) **запуск стека** — docker build+up, ресурсоёмко (sequential + cooldown); (H3) **реальное устройство** — опционально (усиленный прогон; гейт — scripted); (H4) **UI-проверка UJ-2** — карточка в браузере (API-уровень автоматом, UI — человек); (H5) **интерпретация отчёта + решение** «эпик принят/отклонён» (TRUST-01 = GO/NO-GO для эпика 2, предпосылка волн 7/8/9). Автоматизируем (без HITL): T2/T3/T4/T5/T6/T7-API, T1 (scripted device).
3. **Почему не dev-стек:** production-стек — другой compose (12 сервисов, file-secrets, `--pull never`, validateProduction), другой nginx (production-конфиг с маскированием/лестницами), другие образы (release). Dev-стек не покрывает T1-маскирование (nginx production-конфиг), T3-pids/non-root (production-compose), T5-body (nginx production-лимиты).

## Verification

**Commands:** (node 24 обязателен: `~/.nvm/versions/node/v24.22.0/bin/node`; docker build — sequential + cooldown load < 8)
- `node scripts/test/trust-device-e2e.mjs --candidate <commit>` -- expected: T1–T7 зелёные, `trust-device-e2e.json` записан; эпик принят (H5)
- `node --test scripts/test/trust-device-e2e.mjs --static-only` (если driver структурирован так) -- expected: T5-static (completeness/лестницы/body/error-body) без docker
- `node --test scripts/test/production-stack.mjs --build` (существующий harness) -- expected: без регрессии (TRUST-01 не ломает его)
- `node scripts/workspace/check.mjs --tooling` -- expected: driver в tooling-списке, гейт зелёный
- **HITL (H2):** чистый checkout кандидата → `setup.mjs build` + `up` (sequential) → стек healthy (12 сервисов)
- **HITL (H4):** браузер → карточка артефакта → провенанс-секция (версия+SHA+источник+время+издатель) видна
- **HITL (H5):** отчёт `trust-device-e2e.json` — оператор подтверждает «эпик принят»

## Open Questions (с рекомендациями)

- **OQ1 — Реальное устройство в гейте (H3) или scripted достаточно?** Рекомендация: **scripted** (детерминированно, покрывает все T-фазы; реальное устройство — опциональный усиленный прогон, когда устройство доступно). Обоснование: device-сессия скриптом уже доказана (`mcp-host-install.test.ts`); реальное устройство добавляет только «железо», не логику доверия.
- **OQ2 — T3 re-check ≤60s: как замерить live (кэш)?** Рекомендация: отозвать device-доступ, запросить authorize-session в окне ≤60s (должен пройти по кэшу) и после 60s (должен отказать); тайминг — wall-clock в driver. Подтвердить.
- **OQ3 — Кандидат TRUST-01: HEAD main после мержа 2.1–2.13 или отдельный tag?** Рекомендация: **HEAD main** (commit SHA, HITL-выбор); релизный тег — за REL-01/релиз-процесс (не смешивать приёмку эпика с релизом).
- **OQ4 — T6 identity: из развёрнутых образов или из исходника кандидата?** Рекомендация: **из развёрнутых образов** (docker exec: значения ceiling в gateway-процессе vs bridge-клиенте в образе) — ловит stale-build; исходник — pre-гейт (T5-static).
