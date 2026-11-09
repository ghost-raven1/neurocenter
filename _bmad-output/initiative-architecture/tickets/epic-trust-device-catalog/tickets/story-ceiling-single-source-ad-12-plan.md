---
title: 'Единый источник ceiling: re-export из контракта + identity-тест (AD-12, entry 2)'
type: 'feature'
ticket: '2'
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

**Problem:** Два расходящихся значения ceiling в двух бинариях (AD-12, уже в коде): `connect` принимает артефакт ≤ **2 GiB** захардкожено (`mcp-host.controller.ts:116`), а `verify` — ≤ **256 MiB** из env (`ticket.ts:126` `LIMITS.compressedBytes` = env-дефолт `runtime/limits.cjs`). Ceiling-констант нигде нет как единого источника: `services/shared/runtime/limits.cjs` несёт только `LIMIT_DEFAULTS` (default-политика 256 MiB/1 GiB/20000/2 GiB cache) + env-map, но не ceiling. Контракт (entry 1) получает ceiling-константы в `lib/ceiling.mjs` — теперь нужно, чтобы shared и все сервисы импортировали их re-export'ом (не локальные константы), и bridge-клиент с server-verify видели один и тот же набор байтов.

**Approach:** Ceiling-константы живут ровно в одном месте — в pinned asset-контракте (entry 1, `lib/ceiling.mjs`). shared-модуль (`services/shared/runtime/limits.cjs`) ре-экспортирует их из контракта; фасад `runtime-artifacts.cjs` экспонирует `CEILING`; все сервисы (gateway verify, gateway connect) и bridge-клиент импортируют re-export'ом. Фикс рассогласования: `connect` и `verify` читают один `CEILING.compressedBytes` (interim 1 GiB). Identity-тест: значения, видимые bridge-клиентом и server-verify, обязаны совпадать (один модуль, один набор байтов).

## Boundaries & Constraints

**Always:**
- Ceiling-константы — только в контракте (`lib/ceiling.mjs`, entry 1); shared — re-export (не локальные литералы). `grep`: локальных ceiling-литералов (1 GiB/4 GiB/100000/8 GiB) в сервисных/shared-бинариях — нет.
- `services/shared/runtime/limits.cjs` получает `CEILING` (re-export из `@neurocenter/asset-contract`); `LIMIT_DEFAULTS` (default-политика) остаётся отдельным (это политика, не ceiling).
- Фасад `services/shared/runtime-artifacts.cjs` экспонирует `CEILING` (рядом с `LIMITS`/`LIMIT_DEFAULTS`).
- `ticket.ts` (verify) проверяет `claim ≤ CEILING` (AD-3), не `LIMITS` (политика); `mcp-host.controller.ts` (connect) проверяет артефакт ≤ `CEILING`.
- Identity-тест: bridge-клиент (`mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts` re-export) и server-verify (`ticket.ts`) видят идентичные ceiling-значения (один модуль, один набор байтов).
- Клиент применяет `min(descriptor.limits, ceiling)` — заготовка для entry 5 (полная миграция env-пути — там).

**Never:**
- Не дублировать ceiling-константы в shared/сервисах (только re-export, AD-12).
- Не смешивать ceiling и default-политику: `LIMIT_DEFAULTS` (256 MiB/1 GiB/20000/2 GiB) ≠ `CEILING` (1 GiB/4 GiB/100000/8 GiB). `ceiling > default` в каждой секции (инвариант AD-1, drift-флаг).
- Не менять семантику verify на «против текущей политики» (AD-3: лимиты — admission при публикации, не runtime-контроль).
- Не трогать runtime-limits DB/policy (epic-res-obs); здесь только единый источник ceiling-констант.
- Территория entry 1 (контракт) и entry 5 (env-миграция клиента) — не сюда.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SINGLE_SOURCE | ceiling-константы только в контракте, shared re-export | все бинарии читают один набор | No error |
| IDENTITY | bridge-клиент vs server-verify | идентичные ceiling-значения | No error (тест) |
| CONNECT_CEILING | connect, артефакт ≤ 1 GiB | принят | No error |
| CONNECT_ABOVE | connect, артефакт 2 GiB (> ceiling 1 GiB) | отклонён (было: принято) | actionable |
| VERIFY_CEILING | verify, claim.compressedBytes ≤ ceiling | проходит | No error |
| VERIFY_ABOVE | verify, claim > ceiling | invalid | actionable |
| DEFAULT_VS_CEILING | `LIMIT_DEFAULTS` vs `CEILING` | `ceiling > default` в каждой секции | drift-флаг, если нарушено |
| ENV_POLICY | `NEUROCENTER_RUNTIME_MAX_*` (политика) | не влияет на ceiling (ceiling = константа) | No error |

</frozen-after-approval>

## Code Map

- `services/shared/runtime/limits.cjs:3-8` — `LIMIT_DEFAULTS` (default-политика 256 MiB/1 GiB/20000/2 GiB cache) — остаётся; добавить `CEILING` (re-export из `@neurocenter/asset-contract`)
- `services/shared/runtime/limits.cjs:9-14` — `LIMIT_ENV` map (политика из env) — остаётся (политика, bootstrap AD-1); ceiling из env НЕ
- `services/shared/runtime/limits.cjs:15-27` — `limitValue`/`getLimits()` — политика; ceiling отдельно
- `services/shared/runtime-artifacts.cjs:5` — `require('./runtime/limits.cjs')` — импортировать + экспортировать `CEILING`
- `services/shared/runtime-artifacts.cjs:11-24` — `LIMITS` фасад (lazy getter) — рядом добавить `CEILING`
- `services/shared/runtime-artifacts.cjs:80-88` — `module.exports` — + `CEILING`
- `services/api-gateway/src/features/mcp-host/ticket.ts:2` — `import { LIMITS }` → + `CEILING`
- `services/api-gateway/src/features/mcp-host/ticket.ts:126,130,132` — verify `compressedBytes/unpackedBytes/filesCount > LIMITS.*` → `CEILING.*` (AD-3: claim ≤ ceiling)
- `services/api-gateway/src/features/mcp-host/mcp-host.controller.ts:116` — connect `(artifact.compressedBytes) > 2 * 1024 * 1024 * 1024` → `> CEILING.compressedBytes`
- `mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts:15-22` — re-export `LIMITS` из shared → + `CEILING` (bridge-клиент видит те же байты)
- Контракт (entry 1): `vendor/asset-contract/lib/ceiling.mjs` — источник; `@neurocenter/asset-contract` deps: root `package.json:5`, catalog `:25`, gateway `:37` (bridge — flat-copy `services/shared`, не зависит от контракта напрямую)
- Тесты: новый identity-тест; drift-тест `ceiling > default`; корневой сьют

## Tasks & Acceptance

**Execution:**
- [ ] `services/shared/runtime/limits.cjs` — `CEILING` re-export из `@neurocenter/asset-contract` (не локальные константы)
- [ ] `services/shared/runtime-artifacts.cjs` — экспортировать `CEILING` (рядом с `LIMITS`)
- [ ] `ticket.ts` — verify: `claim ≤ CEILING` (compressedBytes/unpackedBytes/filesCount)
- [ ] `mcp-host.controller.ts` — connect: артефакт ≤ `CEILING.compressedBytes` (убрать захардкоженное 2 GiB)
- [ ] `model.ts` (bridge) — re-export `CEILING` из shared
- [ ] Identity-тест: bridge-клиент и server-verify — идентичные ceiling; drift-тест `ceiling > default` в каждой секции; регистрация check-tooling-tests.json + expectedFiles

**Acceptance Criteria:**
- Given ceiling-константы только в контракте, when grep сервисов/shared по ceiling-литералам (1 GiB/4 GiB/100000/8 GiB), then только re-export (0 локальных литералов).
- Given connect с артефактом ≤ 1 GiB, when connect, then принят; артефакт 2 GiB → отклонён (рассогласование 2 GiB vs 256 MiB закрыто).
- Given verify с claim ≤ ceiling, when verify, then проходит; claim > ceiling → invalid.
- Given identity-тест, when сравнение bridge-клиент vs server-verify ceiling, then идентичные значения (один модуль, один набор байтов).
- Given `ceiling` vs `default` в каждой секции, when drift-тест, then `ceiling > default` (иначе фэйл).
- Корневой сьют — без деградации против baseline.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Почему re-export, а не константы в shared: AD-12 — «ceiling-константы существуют ровно в одном месте — в pinned asset-контракте; shared и все сервисы импортируют их re-export'ом из shared-модуля, сшитого с контрактом (не локальные константы)». Kлючевой invariant — «один модуль, один набор байтов»: bridge (flat-copy `services/shared`) и server (gateway) читают ceiling через один и тот же shared-модуль, который ре-экспортирует из контракта. identity-тест фиксирует, что два бинария (client bridge, server verify) видят идентичные значения. `LIMIT_DEFAULTS` (default-политика AD-1) и `CEILING` — разные вещи: default ≤ policy ≤ ceiling; invariant `ceiling > default` (вырожденный ceiling = drift-флаг). verify (AD-3) проверяет против ceiling, не против текущей политики — политика = admission при публикации (epic-res-obs).

## Open Questions

- **OQ:** verify — строго `claim ≤ CEILING` (AD-3) или `claim ≤ min(policy, ceiling)`? Архитектура (AD-3) говорит ceiling (политика не в runtime-verify). Рекомендация: ceiling; enforcement политики — epic-res-obs. Подтвердить при реализации.
- **OQ:** interim ceiling 1 GiB/4 GiB/100000/8 GiB (AD-1) — зафиксировать как `ceiling.mjs` (entry 1) сейчас. Если human меняет значения — новый релиз контракта + re-pin + bump-тест (AD-12).

## Verification

**Commands:** (node-тесты — только `$NODE`)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `$NODE scripts/test/ceiling-identity.test.cjs` (новый) — expected: bridge=server ceiling; `ceiling > default`
- `grep -rn '1024 \*\* 3\|1073741824\|4294967296\|34359738368' services/*/src mcp/neurocenter-asset-sync/src services/shared/runtime/limits.cjs` — expected: 0 ceiling-литералов (только re-export)
- `grep -n '2 \* 1024 \* 1024 \* 1024' services/api-gateway/src/features/mcp-host/mcp-host.controller.ts` — expected: нет (захардкоженное 2 GiB удалено)
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации (287 файлов, 3693 pass / 0 fail / 38 skipped)
