---
title: 'Контракт: bump AD-2/12/13/16 — limits + contractVersion + status + [min,max] (AD-2, AD-12, AD-13, AD-16, entry 1)'
type: 'feature'
ticket: '1'
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

**Problem:** Пин-контракт `@neurocenter/asset-contract` 1.2.1 (byte-pinned vendor, commit e1255b4e) не несёт полей, обязательных AD-2/12/13/16: нет `limits` в дескрипторе (AD-2), нет `contractVersion` (AD-13), нет `status: active|retired` в index-entry/версии (AD-16), `packageFormat`/`bridgeProtocol` — только floor (`===5`/`===2`), а не диапазон `[min,max]` (AD-13). Ceiling-константы артефакт-секции AD-1 (interim 1 GiB/4 GiB/100000/8 GiB cache) не существуют как константы: контракт читает лимиты из env (`lib/asset.mjs:10` `NEUROCENTER_RUNTIME_MAX_*`) — AD-2/AD-12 запрещают env-путь в security-логике клиента и требуют единый источник ceiling.

**Approach:** Один bump контракта 1.2.1 → 1.2.2, расширяющий контракт четырьмя полями (все additive, backward-совместимы для existing published bytes — `assertIndexEvolution` не ломается): (1) `RuntimeArtifact.limits` — обязательное поле дескриптора `{compressedBytes, unpackedBytes, filesCount, cacheBytes}`; (2) `contractVersion` (semver) в `AssetBase` и index-entry; (3) `status: 'active'|'retired'` в index-entry/версию, retired необратим; (4) `packageFormat`/`bridgeProtocol` — `[min,max]`. Ceiling-константы артефакт-секции становятся константами контракта (не env). Source: in-tree поправка `vendor/asset-contract` (закрытый контур, без сети) — рекомендовано; альтернатива push в `github.com/ghost-raven1/neurocenter-assets` + re-pin — OQ1 (HITL/сеть). Re-pin каскадом официальным тулингом.

## Boundaries & Constraints

**Always:**
- Все четыре расширения additive и валидируются strict-схемой контракта (`validation.mjs object()` — неизвестные поля = фэйл): новые поля добавляются в allowlist'ы `object(...)` в `asset.mjs`/`repository.mjs`.
- `limits` — **обязательное** поле дескриптора runtime-artifact: отсутствует/некорректно = invalid descriptor (fail-closed, AD-2). Значения вне `[1..ceiling]` = invalid.
- Ceiling-константы артефакт-секции (interim: compressedBytes 1 GiB, unpackedBytes 4 GiB, filesCount 100000, cacheBytes 8 GiB) — константы в контракте, единый источник (AD-12). `limitEnv`/`NEUROCENTER_RUNTIME_MAX_*` из `lib/asset.mjs:9-10` удаляются.
- `status` — необратим: `assertIndexEvolution` получает проверку `retired→active запрещено` (в дополнение к существующим «published не исчезают / bytes не меняются», `repository.mjs:27-34`).
- Версия контракта (package.json) bump'ится 1.2.1 → 1.2.2; `contractVersion` в новых дескрипторах = `1.2.2`.
- Provenance: `SOURCE.json` как metadata (базовый внешний commit e1255b4e + задокументированная локальная поправка); `SHA256SUMS` регенерируется; re-pin каскадом `node scripts/assets/catalog-source-pin.mjs --write`.
- Любое будущее изменение ceiling = новый релиз контракта + re-pin + bump-тест (AD-12).

**Never:**
- Не менять byte published version'ов (immutable — `assertIndexEvolution`): расширение additive, существующие `asset.json` без `limits`/`contractVersion`/`status` остаются валидными при чтении (default/optional при READ), но новые публикации обязаны их нести (mandatory при WRITE/produce).
- Не читать лимиты из env в контракте (AD-2/AD-12): ceiling = константа.
- Не делать `retired` обратимым; не удалять retired-версию из index (провенанс сохраняется, FR-204).
- Не пушить во внешний репо без human-решения (OQ1): in-tree — дефолт закрытого контура.
- Не менять `schemaVersion` (остаётся 1); не трогать `bin/assets.mjs`-CLI-поведение без необходимости.
- Территория entry 2 (shared re-export + identity-тест) — здесь только контракт, не shared-модули.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| NEW_DESCRIPTOR_LIMITS | дескриптор с `limits` в `[1..ceiling]` | `validateAsset` проходит | No error |
| MISSING_LIMITS | дескриптор runtime-artifact без `limits` | invalid (produce-path) | actionable «limits обязательны» |
| LIMITS_ABOVE_CEILING | `limits.compressedBytes > 1 GiB` | invalid | actionable «превышает ceiling» |
| ENV_LIMITS_GONE | `NEUROCENTER_RUNTIME_MAX_*` задан | игнорируется (константы) | No error (env не читается) |
| CONTRACT_VERSION | `AssetBase.contractVersion='1.2.2'` + index-entry несёт | валидно | No error |
| STATUS_ACTIVE | index-entry `status:'active'` | валидно, назначение разрешено | No error |
| STATUS_RETIRED | index-entry `status:'retired'` | валидно в index; новые назначения запрещены (entry 7) | No error в validate |
| RETIRE_RESTORE | evolution `retired→active` | `assertIndexEvolution` бросает | actionable «retired необратим» |
| FORMAT_RANGE | `packageFormat` в `[min,max]` | валидно; `5`/`2` floor-значения остаются валидными | No error |
| FORMAT_OUT_OF_RANGE | `packageFormat` вне `[min,max]` | invalid (graceful-handshake — entry 11) | actionable «обнови контракт» |
| EXISTING_PUBLISHED | старый `asset.json` без новых полей (read) | читается (additive default) | No error (backward) |
| RE_PIN | правка vendor/asset-contract | pin-каскад пересчитан (producer.json→manifest.json→bundled-catalog.lock.json) | фэйл, если не пересчитан |

</frozen-after-approval>

## Code Map

- `vendor/asset-contract/package.json:3` — `version: 1.2.1` → `1.2.2`
- `vendor/asset-contract/index.d.ts:2-6` — `RuntimeArtifact`: добавить `limits?: {compressedBytes:number;unpackedBytes:number;filesCount:number;cacheBytes:number}` (обязательное при produce)
- `vendor/asset-contract/index.d.ts:11-17` — `AssetBase`: добавить `contractVersion?: string` (semver)
- `vendor/asset-contract/index.d.ts:15` — `compatibility: {packageFormat?:5;bridgeProtocol?:2}` → диапазон `[min,max]` (тип + константы min/max)
- `vendor/asset-contract/index.d.ts:43` — `IndexEntry {id,kind,version,path,sha256,current}`: добавить `status?: 'active'|'retired'`
- `vendor/asset-contract/index.d.ts:53` — `assertIndexEvolution` — контракт: + retired-необратимость
- `vendor/asset-contract/lib/asset.mjs:8` — `limitDefaults` (256 MiB/1 GiB/20000) — interim-default политики (остаётся как default, НЕ ceiling)
- `vendor/asset-contract/lib/asset.mjs:9-10` — `limitEnv` + `limits`-env-снимок (`NEUROCENTER_RUNTIME_MAX_*`) — УДАЛИТЬ (ceiling = константа, AD-2/12)
- `vendor/asset-contract/lib/asset.mjs:43-45` — валидация RuntimeArtifact-descriptor: allowlist `object(artifact.descriptor,[...])` + `limits`-поле + ceiling-проверка (ceiling-константы, не env)
- `vendor/asset-contract/lib/asset.mjs:77` — allowlist полей Asset `object(value,[...])` — добавить `contractVersion`
- `vendor/asset-contract/lib/asset.mjs:81-84` — floor `packageFormat!==5`/`bridgeProtocol!==2` → проверка `[min,max]` (константы min/max)
- `vendor/asset-contract/lib/ceiling.mjs` — НОВЫЙ: константы ceiling артефакт-секции (1 GiB/4 GiB/100000/8 GiB cache), единый источник (AD-12); экспорт
- `vendor/asset-contract/lib/repository.mjs:13` — allowlist IndexEntry `object(entry,['id','kind','version','path','sha256','current'])` — добавить `status`
- `vendor/asset-contract/lib/repository.mjs:27-34` — `assertIndexEvolution`: + проверка `retired→active запрещено`
- `vendor/asset-contract/lib/validation.mjs` — helpers (`object`/`pin`/`sha`/`positive`) — переиспользовать; semver-check для `contractVersion` (add `semver()` helper)
- `vendor/asset-contract/SOURCE.json` — provenance: базовый commit e1255b4e + поле локальной поправки (in-tree amendment), пересчёт `files[].sha256`
- `vendor/asset-contract/SHA256SUMS` — регенерация после правки
- `vendor/asset-contract/docs/contract.md` — документация новых полей (limits/contractVersion/status/[min,max])
- Deps: `package.json:5` (root `file:vendor/asset-contract`), `services/catalog-service/package.json:25`, `services/api-gateway/package.json:37` — `file:`-зависимости (не меняются, но потребляют bump)
- Pin-каскад: `scripts/assets/catalog-source-pin.mjs` (`pinCatalogSource --write`), `scripts/catalog-plugins/prepared-source-snapshot.mjs:12-36` (PREPARED_SOURCE_INPUTS включает `vendor/asset-contract/*`), `catalog-source/producer.json` → `catalog-source/manifest.json` → `services/shared/bundled-catalog.lock.json`
- Тесты: `vendor/asset-contract/test/*.test.mjs` (если есть) / корневой сьют; новый/обновлённый drift/bump-тест контракта

## Tasks & Acceptance

**Execution:**
- [ ] `lib/ceiling.mjs` (НОВЫЙ) — константы ceiling артефакт-секции (interim 1 GiB/4 GiB/100000/8 GiB cache) + экспорт; `lib/asset.mjs:9-10` — удалить `limitEnv`/env-снимок, использовать ceiling-константы
- [ ] `lib/asset.mjs` — `limits` в RuntimeArtifact-descriptor (обязательное при produce, `[1..ceiling]`); `contractVersion` в AssetBase (semver); `packageFormat`/`bridgeProtocol` → `[min,max]`
- [ ] `lib/repository.mjs` — `status` в IndexEntry (optional при read, default `active`); `assertIndexEvolution` + `retired→active запрещено`
- [ ] `index.d.ts` — типы `limits`/`contractVersion`/`status`/`[min,max]`; `docs/contract.md` — документация
- [ ] `package.json` 1.2.1→1.2.2; `SOURCE.json` (provenance + локальная поправка) + `SHA256SUMS` регенерация
- [ ] Re-pin каскад: `node scripts/assets/catalog-source-pin.mjs --write` (producer.json → manifest.json → bundled-catalog.lock.json)
- [ ] Тесты: bump-тест (все 4 поля), backward (старые bytes читаются), retired-необратимость, re-pin-каскад зелёный; регистрация `scripts/workspace/check-tooling-tests.json` + expectedFiles

**Acceptance Criteria:**
- Given новый дескриптор с `limits` в `[1..ceiling]`, when `validateAsset`, then проходит; без `limits` (produce) → invalid «limits обязательны»; `limits > ceiling` → invalid.
- Given `AssetBase.contractVersion='1.2.2'` и index-entry несёт версию, when validate, then валидно; `contractVersion` не-semver → invalid.
- Given index-entry `status:'retired'`, when `assertIndexEvolution` к `active`, then бросает «retired необратим»; published bytes/kind не меняются (существующие проверки сохраняются).
- Given `packageFormat`/`bridgeProtocol` в `[min,max]`, when validate, then валидно (floor 5/2 — в диапазоне); вне `[min,max]` → invalid.
- Given `NEUROCENTER_RUNTIME_MAX_*` задан, when контракт валидирует, then env игнорируется (ceiling = константа, AD-2/12).
- Given правка `vendor/asset-contract`, when pin-каскад, then `producer.json`/`manifest.json`/`bundled-catalog.lock.json` пересчитаны (тест); корневой сьют — без деградации.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Additive vs breaking: расширение additive — существующие published `asset.json` (без `limits`/`contractVersion`/`status`) остаются читаемыми (default/optional при READ, `assertIndexEvolution` не ломается, immutable bytes не меняются). Обязательность новых полей действует на WRITE/produce-пути (новые публикации обязаны нести `limits`/`contractVersion`; index-entry по умолчанию `active`). Это сохраняет backward-совместимость уже выпущенных версий (FR-202 immutable) при вводе новой политики. `limitEnv` удаляется из контракта: ceiling — константа компиляции, а не env (AD-12 «не локальные константы», AD-2 «env-лимитов у клиента нет»). `lib/ceiling.mjs` — единый источник ceiling, который entry 2 ре-экспортирует в shared. In-tree bump (закрытый контур): `SOURCE.json` фиксирует базовый внешний commit + задокументированную локальную поправку; AD-17 residual («push в git = компромисс поставки») не усиливается, т.к. всё остаётся внутри уже доверенного git-дерева. Альтернатива (push в `github.com/ghost-raven1/neurocenter-assets` + re-pin с нового commit) требует сети/HITL — OQ1.

## Open Questions

- **OQ1 (блок-решение):** источник bump — (A) in-tree поправка `vendor/asset-contract` (закрытый контур, без сети, `SOURCE.json` = базовый commit + локальная поправка) — **рекомендация**; (B) push в `github.com/ghost-raven1/neurocenter-assets` + re-pin с нового commit (чистый provenance, но сеть/HITL/push, усиливает AD-17 residual). Owner: human (пользователь). Дефолт при реализации — (A).
- **OQ (ceiling-values):** interim ceiling 1 GiB/4 GiB/100000/8 GiB cache (AD-1) фиксировать как константы контракта сейчас (да, по AD-1 Deferred «подтвердить при реализации») или оставить placeholder. Рекомендация: фиксировать interim (единственный до финализации).

## Verification

**Commands:** (node-тесты — только `$NODE`, системный v16 не подходит)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `$NODE --test vendor/asset-contract/test/*.test.mjs` (или контракт-тест) — expected: все зелёные (bump + backward + retired-необратимость)
- `node scripts/assets/catalog-source-pin.mjs --check` — expected: pin-каскад согласован (0 drift)
- `grep -rn 'NEUROCENTER_RUNTIME_MAX' vendor/asset-contract/lib/` — expected: нет совпадений (env-путь удалён)
- `jq '.version' vendor/asset-contract/package.json` — expected: `1.2.2`
- Корневой сьют (конвенция: `node scripts/workspace/check.mjs`) — без деградации против эталона (287 файлов, 3693 pass / 0 fail / 38 skipped)
