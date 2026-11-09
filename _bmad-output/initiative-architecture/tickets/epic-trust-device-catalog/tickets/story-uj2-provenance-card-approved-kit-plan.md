---
title: 'UJ-2: SHA-версии + провенанс-карточка + одобренный комплект (FR-201, FR-202, FR-203, entry 12)'
type: 'feature'
ticket: '12'
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
  - '_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md'
  - '_bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/epic-trust-device-catalog.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** UJ-2 (пользователь видит доверенную версию инструмента и проверяет её происхождение) не работает как записан в PRD: (FR-203) у карточки артефакта НЕТ полного провенанса — карточка витрины (`catalogCards.ts:5-15` → `IStoreApp`) показывает только `origin` + `revision`; НЕТ SHA (manifest.sha256), времени публикации, издателя; (FR-202) immutability версий — структурно есть (INSERT-only в `ai_plugin_versions`), но не зафиксирован тестом; назначение в проект — через `project_assets` pin (одрёбленный точный комплект с зависимостями) — работает, но «одобренность» = текущий pin администратора (OQ1); (FR-201) упаковка из доверенных источников с SHA-описью — `bundle-package.ts` (per-file sha256 + manifest.sha256) уже есть, `GET /api/ai-plugins/:id/package?version=N` отдаёт self-verified пакет — но карточка к нему не ведёт.

**Approach:** (FR-203) Провенанс-карточка: `StoreDetailsModal` (витрина) показывает для активной версии: **версия** (number), **SHA** (`manifest.sha256` — из `GET /api/ai-plugins/:id/package?version=N`), **источник** (`origin` + `revision`), **время** (`createdAt` версии), **издатель** (`author` версии); данные — из существующих эндпоинтов (`/versions`, `/package`) — без нового API (OQ2: новый consolidated-эндпоинт — опционально). (FR-202) Immutability-тест: (а) static — нет UPDATE/DELETE по `ai_plugin_versions` (INSERT-only, `plugin-repository.ts:528-539`); (б) behavior — повторная публикация той же версии = отказ (pkey conflict, не молчаливая перезапись); (в) vendor-уровень — `assertIndexEvolution` (entry 1) запрещает изменение/исчезновение опубликованной версии. (FR-201) SHA-опись: `verifyPackage` (bundle-package.ts:88+) — self-verification (per-file + manifest + filesCount) вызывается при отдаче пакета и при установке (bridge); 4 источника FR-201 (npm/публичный GitHub/архив/ready-runtime) — source envelope (origin/revision) валидируется при публикации (существующий импорт) — тест на 4 типа. (FR-202 комплект) назначение — только одобренный точный комплект с зависимостями: `pinProjectAsset` (level ≥3) фиксирует version+manifest; зависимости — `dependencies` pin'ы (IDependencyPin); установка bridge — только из закреплённого пина (`mcp-host-access.approvedPackage` — сверка version+manifest.sha256) — это уже есть, фиксируем тестом.

## Boundaries & Constraints

**Always:**
- Карточка (FR-203) показывает ПЯТЬ полей провенанса: версия + SHA (manifest.sha256) + источник (origin+revision) + время (createdAt) + издатель (author); данные — из `/versions` + `/package` (существующие эндпоинты); SHA — НЕ вычисляется клиентом (server-issued, self-verified пакет).
- Immutability (FR-202): INSERT-only `ai_plugin_versions` (static-тест: нет UPDATE/DELETE); повторная публикация версии = отказ (pkey conflict → 409, не перезапись); vendor-уровень — `assertIndexEvolution` (entry 1) — опубликованные байты не меняются, retired не активизируется.
- SHA-опись (FR-201): per-file sha256 + manifest.sha256 (над упорядоченным `path:sha256`) + filesCount; `verifyPackage` — при отдаче `GET /package` (server-side self-check) и при установке bridge; mismatch = отказ установки (actionable).
- Одобренный комплект (FR-202): назначение в проект — только точная версия + manifest (project_assets pin); bridge-установка сверяет version+manifest.sha256 с пином (`approvedPackage`); зависимости — pin'ы (kind/id/version/manifest) — сверяются при установке (existing, фиксировать тестом).
- Retire (entry 7) сохраняет провенанс: retired-версия остаётся в каталоге, карточка показывает провенанс + статус retired (связка с entry 7 — поле статуса, OQ3).
- «Одобренность» комплекта = текущий pin проекта, установленный администратором (level ≥3) — OQ1 (отдельный шаг одобрения — вне скоупа, если OQ1 не решит иначе).

**Never:**
- Не вводить новый формат пакета/SHA (bundle-package — self-verified, формат не меняется); не вычислять manifest-ша клиентом (server-issued).
- Не менять `pinProjectAsset`-семантику (level ≥3, точная версия) — только фиксировать тестом.
- Не удалять retired-версии из каталога (провенанс сохраняется, FR-204/entry 7).
- Не трогать retire-механику (entry 7), ticket (entry 5/6), контракт (entry 1) — только потреблять их артефакты.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CARD_PROVENANCE | карточка артефакта (активная версия) | версия + SHA (manifest) + источник + время + издатель | No error |
| CARD_SHA_MISMATCH | manifest.sha256 в `/package` ≠ пересчёт (verifyPackage) | 409/500 server-side (self-check упал) — не отдаёт битый пакет | actionable |
| REVISION_IMMUTABLE | UPDATE/DELETE по ai_plugin_versions (static) | static-тест ФЕЙЛ | actionable |
| REPUBLISH_SAME | повторная публикация той же версии | отказ 409 (pkey), не перезапись | 409 |
| VENDOR_IMMUTABLE | изменение байтов опубликованной версии (vendor index) | assertIndexEvolution (entry 1) — throw | throw |
| FR201_SOURCES | публикация из 4 источников (npm/GitHub/архив/ready-runtime) | source envelope (origin+revision) валиден, SHA-опись полная | invalid → отказ |
| KIT_PIN_ONLY | bridge-установка c version/manifest ≠ pin проекта | отказ (approvedPackage mismatch) | actionable |
| KIT_DEPENDENCIES | комплект с зависимостями (pins kind/id/version/manifest) | зависимости сверяются при установке | actionable |
| RETAINED_PROVENANCE | retired-версия (entry 7) | карточка: провенанс + статус retired (не удалена) | No error |
| ADMIN_ONLY | назначение комплекта level < 3 | 403 | 403 |

</frozen-after-approval>

## Code Map

**Пакет/SHA (FR-201):**
- `services/catalog-service/src/catalog/bundle-package.ts:6-84` — `buildPackage` (per-file sha256 :73, manifest `packageHash` :77, `manifest.sha256` :83), `verifyPackage` :88+ (per-file + manifest + filesCount)
- `services/catalog-service/src/catalog/catalog.controller.ts:726-733` — `GET /api/ai-plugins/:id/package?version=N` (self-verified delivery-пакет)
- `catalog.controller.ts:684-689` — `GET /api/ai-plugins/:id/versions` (listAiPluginVersions); `:713-723` — `POST .../versions/:v/activate` (main-admin)
- `catalog.controller.ts:700-711` — `GET /api/ai-plugins/:id/files?path&version`
- `mcp/neurocenter-asset-sync` — bridge-установка: сверка version+manifest (через project pin; `mcp-host-access.ts:91-111 approvedPackage` — context)

**Версии/иммутабельность (FR-202):**
- `services/catalog-service/src/catalog/catalog-schema.ts:40-49` — `ai_plugin_versions (ai_plugin_id, version, files JSONB, config JSONB, author, note, created_at)` pkey (ai_plugin_id, version) (+`metadata` JSONB — миграция)
- `services/catalog-service/src/publication/plugin-repository.ts:528-539` — `insertVersion` (INSERT-only; metadata: origin/revision/dependencies)
- `catalog.controller.ts:399-407` — `pinProjectAsset` (level ≥3, точный комплект); `:409-427` — `addProjectAsset`
- `project-asset-pins.ts` — pin-схема (version+manifest+dependencies)
- `vendor/asset-contract/lib/repository.mjs:27-34` — `assertIndexEvolution` (entry 1: retired→active запрещён, байты не меняются)

**Карточка (FR-203):**
- `frontend/src/features/Catalog/catalogCards.ts:5-15` — `fromPlugin` → `IStoreApp` (origin+revision, config, files)
- `frontend/src/core/api/interfaces.ts:438-454` — `IAiPlugin` (origin, revision, createdAt/updatedAt; files: IAiPluginFile {path,size,digest} :370-376)
- `frontend/src/modules/Store/StoreDetailsModal.tsx` — деталки карточки (здесь провенанс-секция); `Store.tsx`, `AppCard.tsx`
- `services/catalog-service/src/catalog/dto.ts:221-232` — `IAiPluginVersion` (version/files/config/**author**/note/**createdAt**/metadata{origin,revision})
- `frontend/src/core/api/interfaces.ts:379+` — `IAiPluginVersion` (frontend-зеркало)

**Тесты (новые):** immutability (static INSERT-only + re-publish 409), FR-201 4-источника (source envelope + SHA-опись), FR-203 карточка (API-данные: версия/SHA/источник/время/издатель), FR-202 pin-only (mismatch → отказ), retired-provenance (с entry 7). Регистрация.

## Tasks & Acceptance

**Execution:**
- [ ] `StoreDetailsModal.tsx` — провенанс-секция: версия + SHA (manifest.sha256 из `/package`) + источник (origin+revision) + время (createdAt) + издатель (author); data — `/versions` + `/package` (без нового API, OQ2)
- [ ] `catalog.controller.ts` `/package` — `verifyPackage` self-check ПЕРЕД отдачей (mismatch → 500 actionable, битый пакет не отдаётся)
- [ ] Immutability-тесты: static (нет UPDATE/DELETE `ai_plugin_versions`), behavior (re-publish same version → 409, не перезапись)
- [ ] FR-201-тест: 4 источника (npm/GitHub/архив/ready-runtime) — source envelope + SHA-опись полная; `verifyPackage` при отдаче
- [ ] FR-202-тест: pin-only установка (version/manifest ≠ pin → отказ); зависимости (pins) сверяются
- [ ] Retired-provenance: карточка retired-версии (entry 7) — провенанс + статус (OQ3)
- [ ] Регистрация тестов

**Acceptance Criteria:**
- Given карточка артефакта, when открытие деталок, then видно: версия + SHA (manifest.sha256) + источник + время + издатель (FR-203).
- Given `/package` с повреждённым manifest, when self-check, then 500 (не отдаёт); валидный — 200 c SHA.
- Given ai_plugin_versions, when static-скан, then 0 UPDATE/DELETE (INSERT-only); re-publish same version → 409 (FR-202).
- Given публикация из 4 источников, when source envelope + SHA-опись, then валидна, опись полная (FR-201).
- Given bridge-установка c version/manifest ≠ pin, when approvedPackage, then отказ (FR-202 комплект); зависимости — сверяются.
- Given retired-версия, when карточка, then провенанс сохранён + статус (FR-204/entry 7).
- Корневой сьют — без деградации против baseline.

## Implementation Notes

Provenance-данные уже в API: `GET /versions` → `IAiPluginVersion` (author, createdAt, metadata.origin/revision, files[].digest); `GET /package?version=N` → `manifest.sha256` + per-file sha256. Карточка не вычисляет SHA — берёт server-issued (self-verified). Immutability: в main нет UPDATE/DELETE по `ai_plugin_versions` (проверено grep'ом) — INSERT-only + pkey = append-only history; `activate` меняет только head (ai_plugins.version), не строки history. FR-201 «4 доверенных источника»: source envelope (origin/revision) — git (публичный GitHub: origin=repo, revision=commit), npm (origin=name@version), archive (origin=sha256, revision=—), ready-runtime (origin=runtime target). Тест 4 источников — по source envelope + presence SHA-описи. OQ1 «одобренный комплект»: в PRD «назначение — только одобренный точный комплект» — текущая механика = админ проекта (level ≥3) назначает точную версию+зависимости (pinProjectAsset); отдельный шаг «одобрения» (approval-flow) в PRD не описан — ASSUMPTION: одобрение = назначение админом.

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Почему нет нового consolidated-эндпоинта.** `/versions` + `/package` уже несут все 5 полей провенанса; новый эндпоинт = дубль + drift. Карточка делает 2 GET (versions → active version, package?version=N → SHA). OQ2 — если perf-вопрос (2 запроса) — consolidated `GET /ai-plugins/:id/provenance` (опционально, не в базовом скоупе).
2. **Immutability на двух уровнях.** App-уровень: `ai_plugin_versions` INSERT-only (pkey conflict = отказ). Vendor-уровень: `assertIndexEvolution` (entry 1) — опубликованные версии в vendor-index не меняются/не исчезают, retired необратим. FR-202 «версии immutable» — оба уровня, оба теста.
3. **SHA в карточке — manifest.sha256, не per-file.** Provenance «SHA» (PRD: версия + SHA + источник + время + издатель) = SHA пакета (manifest) — один проверяемый отпечаток; per-file digest'ы — в деталях пакета (для верификации установки).

## Open Questions (с рекомендациями)

- **OQ1 — «Одобренный комплект» (FR-202): одобрение = текущий pin админом или отдельный approval-flow?** Рекомендация: **текущий pin админом** (level ≥3) — в PRD отдельного шага одобрения нет; ASSUMPTION фиксируем. Если нужен approval-flow (оператор одобряет) — новая сторис (UX-проектирование).
- **OQ2 — Consolidated provenance-эндпоинт (1 запрос) или 2 GET (versions+package)?** Рекомендация: 2 GET (нет нового API, нет drift); consolidated — опционально при perf-проблеме.
- **OQ3 — Статус retired в карточке: какое поле (entry 7 даёт)?** Рекомендация: entry 7 добавляет status в версию/index; карточка показывает статус, если поле есть (координировать при мерже entry 7 → 12).

## Verification

**Commands:** (node-тесты — только `$NODE`; CATALOG_TEST_PG_URL — skip без БД)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `cd services/catalog-service && npm run build` → `$NODE scripts/test/u2-provenance-card.test.mjs` (new) — expected: FR-203 (5 полей в API-данных), FR-201 (4 источника + SHA-опись), immutability (static INSERT-only, re-publish 409), pin-only (mismatch → отказ) 0 fail
- `cd frontend && npm test` (StoreDetailsModal-тест: провенанс-секция) — expected: 0 fail
- `grep -rn "UPDATE ai_plugin_versions\|DELETE FROM ai_plugin_versions" services/catalog-service/src` — expected: пусто (INSERT-only)
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации
