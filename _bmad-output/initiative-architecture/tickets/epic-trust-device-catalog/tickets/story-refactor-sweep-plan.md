---
title: 'Refactor sweep'
type: 'refactor'
ticket: '13'
created: '2026-11-09'
status: done
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md'
  - '_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md'
  - '_bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/epic-trust-device-catalog.md'
---

# 2.13 «Refactor sweep» (эпик trust-device-catalog)

## SCOPE: устанавливается на старте

По тикету: скоуп = cleanup, который эпик отложил. **Фреймворк ниже: 4 known-находки + 3 скан-процедуры + 2 decision-пункта.** Implementer на старте: (1) подтверждает known-находки по актуальному main (после мержа 2.1–2.12), (2) прогоняет сканы, (3) фиксирует финальный список в этом файле (секция «Финальный скоуп»), (4) реализует. Скоуп, вытесненный из другой сторис, — НОВАЯ сторис, не сюда.

### Known-находки (подтвердить по main на старте)

**K1. Остатки env-лимитов после миграции (entry 2/5)**
- Entry 1/2/5 убрали env-путь клиента (`NEUROCENTER_RUNTIME_MAX_*` из bridge) и limitEnv из контракта (`lib/asset.mjs:8-10`). Кандидаты: `services/shared/runtime/limits.cjs` (`LIMIT_ENV`-снимок — кто ещё читает?), re-экспорт'ы в `runtime-artifacts.cjs` фасад без потребителей, локальные `LIMITS`-копии в bridge (`model.ts:15-22`).
- Критерий: экспорт/константа без ни одного ссылающегося (кроме тестов на неё) — кандидат; фасад-поверхность НЕ кандидат (осознанная плоская поверхность).

**K2. Hardcoded ceiling-литералы, выжившие мимо identity (entry 2)**
- `mcp-host.controller.ts:116` — `2 * 1024 * 1024 * 1024` (connect limit) — entry 2 обязан перевести на shared-ceiling; если выжил — сюда (identity-тест entry 2 ловит рассогласование, но literal'ы вне identity — сюда).
- Скан: `grep -rnE "2 \* 1024 \* 1024 \* 1024|256 \* 1024 \* 1024|1024 \* 1024 \* 1024" services/*/src mcp/*/src` — ceiling-литералы вне `vendor/asset-contract`/shared-re-export = кандидат.

**K3. Осиротевшие комментарии/док-строки после 2.3 (shadowing) и 2.8/2.9 (route-политика)**
- `proxy.module.ts` — комментарии о порядке контроллеров (после переупорядочивания entry 3 — актуален ли текст?); `tool-import-deadline.cjs`/`model-chat-deadline.json` — комментарии «ручная пересборка лестницы» после перевода на формулу (entry 9).
- Док-строки AD-14/AD-6 в комментариях кода, описывающие OLD-состояние («первый в списке»).

**K4. Passthrough-инфраструктура после 2.10 (error-body)**
- Entry 10 заменил 17 passthrough-точек фиксированными body. Кандидаты: осиротевшие error-классы/импорты (`BadRequestException` без использования в файле), дублирующиеся фиксированные строки (одинаковый user-safe текст в N местах — кандидат в shared-константу, если ≥3 дубля).

### Скан-процедуры (на старте, по актуальному main)

**S1. Dead code после contract-bump (2.1) и re-pin каскада**
- Осиротевшие require/import после: (а) 2.1 — vendor bump (новые поля limits/contractVersion/status — старые in-place-валидаторы без потребителей), pin-каскад (catalog-source/producer.json → manifest.json → bundled-catalog.lock.json); (б) 2.2 — ceiling re-export (локальные константы, заменённые re-export'ом); (в) 2.5 — descriptorSha256 (старые claim-поля без читателей).
- Критерий: модуль/функция/константа без ссылающихся — кандидат.

**S2. Осиротевшие комментарии/доки**
- Комментарии-решения, чья сторис закрыта (2.1–2.12); stale-«TODO»/«OQ»-пометки, решённые в планах; доки, описывающие removed-механизмы (env-лимиты клиента, in-memory pairLimits после 2.9, maxContentLength: Infinity после 2.8).

**S3. Дубли**
- Дублирующие фиксированные error-тексты (K4), дубли ceiling/limit-литералов (K2), дублирующие fixture-объекты (session/claim fixtures в mcp-host-тестах после расширения 2.5/2.6).

### Decision-пункты (решение фиксируется на старте, до реализации)

**D1. lint/typecheck pre-existing ошибки**
- По факту на старте (grep/prettier/tsc): pre-existing ошибки, не вызванные 2.1–2.12 — решение: вне скоупа (если не вызваны эпиком) / в скоуп (если вызваны).

**D2. expectedFiles-конфликты после 12 story**
- 2.1–2.12 добавляли тест-файлы (check-tooling-tests.json + expectedFiles union+sort). На старте: сверить union+sort (memlog-ловушка эпика 1: конфликтная зона при мерже); расхождение — в скоуп (одна строка на расхождение).

## Pre-scan оркестратора (2026-11-09, по baseline 3433b1d1 — ДО мержа 2.1–2.12)

Подтверждено implementer'ом на старте (по main после мержа):

- **K2 — локация точная**: `mcp-host.controller.ts:116` — `(artifact.compressedBytes as number) > 2 * 1024 * 1024 * 1024` (connect-валидация, hardcoded 2 GiB) — ровно та точка, которую entry 2 обязан перевести на shared-ceiling (rассогласование 2 GiB vs 256 MiB из tickets.toml entry 2). Если entry 2 закрыл — K2 пусто.
- **K1 — точные локации**: `services/shared/runtime/limits.cjs` (LIMIT_DEFAULTS + LIMIT_ENV), `services/shared/runtime-artifacts.cjs:11-24` (фасад LIMITS), `mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts:15-22` (re-export). После 2.2/2.5 — проверить потребителей.
- **K3 — proxy.module.ts**: после entry 3 порядок `[McpHostController, ResearchMcpController, SystemRoleMcpGatewayController, ProxyController]` — комментарий «catch-all ПОСЛЕ явных» должен быть ДОБАВЛЕН entry 3 (если нет — в скоуп: закрепить инвариант комментарием).
- **S1/S3 — после мержа 2.1–2.12** (pre-scan смысла нет: bump/re-pin/error-body создают/удаляют dead code).

## Финальный скоуп (Phase 1, 2026-11-10)

Базис анализа: HEAD `6780cffa` (64282b43 + docker/bmad-коммиты параллельной работы; `services/*/src`, `mcp/`, `scripts/` с 64282b43 не менялись — git diff 64282b43..6780cffa: только Dockerfile/compose/package.json bmad-доки). Критерий K1 применён дословно: экспорт/константа без ссылающихся (кроме тестов) — кандидат; фасад-поверхность (`runtime-artifacts.cjs`, осознанная плоская поверхность AD-7) — НЕ кандидат.

### Таблица пунктов

| # | item | location | действие | решение + причина |
|---|------|----------|----------|-------------------|
| K1.a | LIMIT_ENV-снимок | `services/shared/runtime/limits.cjs:15-20` | — | **вне скоупа**: жив — серверная admission-политика AD-1: `getLimits()` → фасадный `LIMITS`; потребители: `services/shared/github-release-source.cjs:45`, `archive-source.cjs:18`, `scripts/catalog-plugins/*` (6 файлов) |
| K1.b | фасад-реэкспорт без потребителей | `services/shared/runtime-artifacts.cjs:137` (`LIMIT_DEFAULTS`) | — | **вне скоупа**: только тесты (`runtime-limits`, `runtime-targets`, `ceiling-identity`), НО фасад-поверхность = осознанная плоская поверхность (критерий K1); `ceiling-identity.test.mjs:42-43` использует инвариант ceiling > defaults. Остальные фасад-экспорты (TARGETS/LIMITS/CEILING/portablePath/normalizeRuntimeArtifacts/validateRuntimeArtifactEntrypoints/inspectRuntimeArchive/runtimeDescriptorDigest) — все с production-потребителями |
| K1.c | локальная LIMITS-копия в bridge | `mcp/.../runtime-artifacts/model.ts:15-22` | — | **закрыто**: в текущем main копия отсутствует — `model.ts:15` реэкспортирует без LIMITS, `model.ts:19-21` — комментарий «LIMITS … не реэкспортируется сюда» (entry 2/5) |
| K2.a | hardcoded 2 GiB connect limit | `mcp-host.controller.ts:116` (pre-scan) | — | **закрыто**: entry 2 перевёл на `CEILING.compressedBytes` (текущая локация `:132`); литерала нет |
| K2.b | ceiling-литерал 10 GiB | `services/api-gateway/src/features/mcp-host/artifact-cache.ts:255` | — | **вне скоупа**: global cap тома кэша (entry 5.2, AD-D2), env-оверрайд `NEUROCENTER_MCP_HOST_CACHE_MAX_BYTES` — отдельная серверная политика, не artifact-ceiling AD-12 |
| K2.c | ceiling-литерал 1 GiB | `mcp/.../local-configuration/private-store.ts:10` | — | **вне скоупа**: бюджет локального private-хранилища клиента; pre-эпик (b9caa2e1, Initial release), не artifact-ceiling |
| K2.d | ceiling-литерал 256 MiB | `mcp/.../runtime-probe/index.ts:112` | — | **вне скоупа** (decision point, пересмотреть при Phase 2 при разногласии): pre-эпик (b9caa2e1), семантически read-guard размера бинарника openCode перед хэшированием — отдельный бюджет, не ceiling доставки; привязка к `CEILING.compressedBytes` = изменение политики, план: «изменения ceiling/политик — НЕ сюда (только удаление мёртвых литералов)» |
| K3.1 | **false positive shadowing-диагностики на `/api/health`** | `services/api-gateway/src/proxy/shadowing-diagnostic.ts` (matchPolicy/OQ3-нормализация) + вызов в `proxy.service.ts` forward(); тест `scripts/test/route-shadowing-diagnostic.test.mjs` | **в скоуп**: инцидент только если входящий URL — зарегистрированный вариант явного роута. Для `/api/...`-URL это роуты с зарегистрированным /api/-вариантом: `/bridge/*` (`@Controller(['bridge','api/bridge'])`, dual prefix), `/mcp-host/*` (`@Controller('api/mcp-host')`). `/health`, `/ready`, `/ready/dependencies` (AppController, /api/-варианта нет), `/api/internal/*`, `/api/docs`, `/api/socket.io` → НЕ инцидент → обычное catch-all-поведение (проксирование в catalog). Тесту добавить non-incident кейс `/api/health` | **в скоуп** — runtime-дефект (гейт (б) 2026-11-10): `GET /api/health` → 500 `route-configuration-error` + ложный shadowing-лог ×3. Природа: `matchPolicy` нормализует `/api/health` → `/health` (OQ3) и матчит явную строку AppController, но /api/-URL-варианта у роута НЕТ — URL легитимно в домене catch-all. Клиентов `/api/health` в репо нет (compose healthcheck → `/health`; nginx/frontend/deploy — 0 ссылок). Порядок контроллеров корректен (AppController из AppModule регистрируется до catch-all; `/health` → 200) — менять нечего; дублирующего `/api/health` в AppController нет — убирать нечего. Тест entry 10 кейс `/api/health` не фиксирует — false positive не намеренный. Изменение поведения: 500 → pre-2.10 (прокси в catalog, 404) — дефект entry 10 diagnostics, зона K3 (shadowing) |
| K3.2 | комментарий о порядке контроллеров | `proxy.module.ts:15-19` | — | **закрыто**: AD-14-комментарий присутствует, порядок `[McpHost, ResearchMcp, SystemRoleMcpGateway, Proxy]` совпадает с pre-scan |
| K3.3 | «ручная пересборка лестницы» | `services/shared/tool-import-deadline.cjs`, `services/shared/model-chat-deadline.json/.cjs` | — | **закрыто**: entry 2.9 перевёл на формулу `deadlineLadder` (+ frozen anchor с assert); stale-комментариев нет (grep «ручная/пересборка лестницы» — 0) |
| K3.4 | AD-14/AD-6 док-строки OLD-состояния | `services/api-gateway/src/**` | — | **закрыто**: grep — все AD-6/AD-14-комментарии описывают ТЕКУЩЕЕ состояние (route-политика, инвариант порядка); «первый в списке» и т.п. — 0 |
| K4.a | осиротевшие error-классы/импорты после 2.10 | 23 файла diff 4e6afb4c | — | **закрыто**: diff entry 2.10 = комментарии + только используемые импорты (пройдены все файлы; `BadRequestException` в `source-upload.service.ts` — в использовании) |
| K4.b | дубли фиксированных user-safe текстов | см. ниже | — | **вне скоупа** (порог плана ≥3 дубля не достигнут): «Сервис подключений недоступен.» ×2 (`proxy.service.ts:606,702`, device-channel-специфичный текст, не дубль константы UPSTREAM_UNAVAILABLE); «Хост MCP недоступен.» ×2 точных (`mcp-host.controller.ts:179`, `host.ts:529`) + 1 вариант с продолжением (`mcp/.../mcp-host/connect.ts:124`); «Сервис хоста MCP ответил некорректно. Повторите позже.» ×2 (`mcp-host.controller.ts:105,141`); совпадение сообщений UPSTREAM_UNAVAILABLE/UPSTREAM_ERROR — намеренно (разные коды, `error-policy.ts`) |
| S1.a | in-place-валидаторы после vendor bump 2.1 | `services/catalog-service/src/asset-sources/*`, `package-build/*` | — | **закрыто**: валидация ассетов — через контракт `validateAsset` (local-skill-ingest, local-asset-ingest, supply-export, build-skill, package-build.service, asset-source-client.cjs:165) — дублирующих локальных валидаторов нет |
| S1.b | локальные ceiling-константы после re-export 2.2 | `mcp-host/ticket.ts`, `mcp-host.controller.ts` | — | **закрыто**: замена in-place (LIMITS→CEILING), осиротевших локальных констант нет |
| S1.c | старые claim-поля без читателей (2.5) | `mcp-host/ticket.ts` IHostedMcpClaim | — | **закрыто**: все 14 полей имеют читателей — artifact-cache.ts:134-166 (compressedBytes/unpackedBytes/filesCount), host.ts (session/entrypoint/executable/name/exp/researchSessionId/operationSessionId/operationRemote/operationArgs), descriptorSha256 — AD-3-связка (verify fail-closed + connect-ответ), contractVersion — verify/issuance |
| S1.d | pin-каскад (producer.json → manifest.json → bundled-catalog.lock.json) | `catalog-source/` | — | **закрыто**: `catalog-source-pin.mjs --check` exit 0, 0-drift (181 файл, producerSha256 `30240947…`, см. baseline) |
| S2 | осиротевшие комментарии/доки (env-лимиты клиента, in-memory pairLimits, maxContentLength: Infinity) | `services/`, `mcp/` | — | **закрыто**: 0 находок — `pairLimits` — 0 совпадений; `maxContentLength: Infinity` — нет в коде (только упоминания «finite» в route-policy, актуальны); client-env-комментарии точны («env-лимитов у клиента нет» — model.ts:19, cache.ts:443, runtime-artifact-download.ts:16); OQ1/OQ3 в error-policy/route-policy — актуальные записи решений, не stale |
| S3.a | **дубли claim-fixture'ов в mcp-host-тестах** | `services/api-gateway/src/features/mcp-host/tests/`: `ticket-ttl.test.ts:4-18`, `host-pool.test.ts:75-94`, `host-auth-cache.test.ts:56-75` | **в скоуп**: вынести общий claim-factory (± limits-объект: `host-pool.test.ts:68-74` / `host-auth-cache.test.ts:56-62`, dups с различающимся `authzCacheTtlMs`) в helper `tests/claim.fixture.ts` (не `*.test.ts` → регистрация в check-tooling-tests.json НЕ нужна; при Phase 2 — проверить file-count-чеки workspace) | **в скоуп** — 3 почти идентичные фабрики (~85% общих полей: entrypoint/executable/compressedBytes/session-форма; различия — name/assetId) после расширения 2.5/2.6. Кросс-harness дубли в `scripts/test/` (mcp-host-ticket.test.cjs, mcp-host-secret.test.mjs) — **вне скоупа** (CJS/ESM, разные раннеры) |
| S3.b | дубли error-текстов | → K4.b | — | **вне скоупа** (см. K4.b) |
| S3.c | дубли ceiling/limit-литералов | → K2.b/c/d | — | **вне скоупа** (см. K2; литералы не дублируют друг друга — разные бюджеты) |

### Решения D1/D2

**D1 — lint/typecheck pre-existing ошибки: ВНЕ СКОУПА (нахождений нет).**
Факты на старте (HEAD 6780cffa): tsc с service-pinned TS 5.9.3 — api-gateway `0` ошибок, mcp `0`, catalog-service `0` (все `--noEmit`, exit 0); eslint `src/proxy` + `src/features/mcp-host` (эпичные зоны 2.8–2.10) — `0`. Единственная аномалия: при запуске root-инструментом TS 6.0.3 (root `package.json`) на service-tsconfig — TS5101/TS5107 (deprecation `baseUrl`/`moduleResolution node10`) — это mismatch корневой toolchain'и, а не ошибки сервиса и не следствие 2.1–2.12 → вне скоупа.

**D2 — expectedFiles-конфликты: РАСХОЖДЕНИЙ НЕТ (в скоуп — 0 строк).**
- `scripts/workspace/check-tooling-tests.json`: 68 записей = cap (trail повышения 64→65 entry 2.8, →66 entry 2.11, →68 entry 2.10 задокументирован комментарием в `check-plan.mjs:91`), строго отсортирован, 0 дублей, все 68 файлов существуют на диске.
- Зеркало `expectedFiles` (`scripts/test/workspace-check-tooling.test.mjs:16-82`): то же множество, 68==68, diff пуст (union+sort сверен).
- Эпичные .mjs-тесты: 6 tooling-зарегистрированы (ceiling-identity, contract-version-handshake, error-body-policy, mcp-host-route-shadowing, route-policy-completeness, route-shadowing-diagnostic); остальные 8 (asset-contract-bump, deadline-ladders, mcp-host-secret, nginx-edge-invariant, rate-limit-pg, u2-provenance-card, version-retirement-measure-contract, version-retirement-pg) покрываются auto-discovery root-сьюта (`nodeTestFiles`, `check-plan.mjs:60`) — не осиротели.

### Baseline для Verification

- **pin-каскад**: 181 файл / 2 018 014 B, producerSha256 `30240947a9636a56872ee5dee1fc7104ba57898174f092cb8c08305b5c26d104`, revision `4419ba5227a8b8282f00c2dcc2686a1adf88c8467c44c2d65d1be60b19e413af`, exit 0. Окружение: ТОЛЬКО `node v24.22.0` (`$HOME/.nvm/versions/node/v24.22.0/bin/node`) — дефолтный node в PATH (v16.19.1) падает с ERR_REQUIRE_ESM на `require('@neurocenter/asset-contract')`.
- **tooling-список**: 68 файлов (= cap).
- **tsc 5.9.3**: api-gateway 0, mcp 0, catalog-service 0 ошибок.
- **корневой сьют**: зафиксировать при старте Phase 2 (долгий — не запускался в Phase 1 по load-ограничению). Ориентиры из коммитов: после 2.2 — «289 файлов / +5 pass» (root-эталон); гейт (б) 2026-11-10 — 9/9 контейнеров healthy.

**Итог: в скоупе 2 пункта (K3.1, S3.a).** Реализация — Phase 2 после сигнала оркестратора; порядок: K3.1 (identity/маршрутизация) → S3.a (тестовые fixture'ы).

## Verification

- Поведение не изменилось: корневой сьют — без деградации против baseline (числа baseline зафиксировать на старте; load-флейки — реран изолированно, прецедент эпика 1).
- Список cleanup закрыт: финальный скоуп (known + сканы) выполнен, по каждому пункту — коммит-ссылка или решение «вне скоупа» с причиной.
- Регистрация новых тест-файлов (если появятся) в `check-tooling-tests.json` + `expectedFiles` (union+sort).
- `node scripts/assets/catalog-source-pin.mjs --check` — pin-каскад НЕ сломан sweep'ом (после любой правки closure — ДО коммита).

## Implementation Notes

- Один коммит на пункт финального скоупа (атрибуция) ИЛИ один общий — по размеру; sweep low-risk, без изменения поведения.
- Порядок: K1/K2 (identity-критичные) → K3 (комментарии) → K4/S3 (дубли) → S1 (dead code) → D-решения.
- НЕ сюда: e2e-находки 2.14 (они в 2.14), новая функциональность (новая сторис), изменения ceiling/политик (только удаление мёртвых литералов, значения не меняются).
