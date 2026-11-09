---
title: 'Refactor sweep'
type: 'refactor'
ticket: '13'
created: '2026-11-09'
status: 'ready-for-dev'
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

## Verification

- Поведение не изменилось: корневой сьют — без деградации против baseline (числа baseline зафиксировать на старте; load-флейки — реран изолированно, прецедент эпика 1).
- Список cleanup закрыт: финальный скоуп (known + сканы) выполнен, по каждому пункту — коммит-ссылка или решение «вне скоупа» с причиной.
- Регистрация новых тест-файлов (если появятся) в `check-tooling-tests.json` + `expectedFiles` (union+sort).
- `node scripts/assets/catalog-source-pin.mjs --check` — pin-каскад НЕ сломан sweep'ом (после любой правки closure — ДО коммита).

## Implementation Notes

- Один коммит на пункт финального скоупа (атрибуция) ИЛИ один общий — по размеру; sweep low-risk, без изменения поведения.
- Порядок: K1/K2 (identity-критичные) → K3 (комментарии) → K4/S3 (дубли) → S1 (dead code) → D-решения.
- НЕ сюда: e2e-находки 2.14 (они в 2.14), новая функциональность (новая сторис), изменения ceiling/политик (только удаление мёртвых литералов, значения не меняются).
