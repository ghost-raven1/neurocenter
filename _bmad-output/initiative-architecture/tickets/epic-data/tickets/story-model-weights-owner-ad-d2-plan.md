---
title: 'model-weights: один write-owner + GGUF→ollama путь (AD-D2, gate M-6)'
type: 'feature'
ticket: '5'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/tickets/epic-data/epic-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** На volume `model-weights` **два write-owners**: ollama (compose:36, `model-weights:/root/.ollama` — owner) и catalog (compose:155, `model-weights:/data/models:rw` + `MODEL_STORAGE_PATH: /data/models` :152). Прямой FS-райтер catalog = `ModelBundleRuntime.prepare` (model-bundle-runtime.ts:19-80, bundle-hydration → MODEL_STORAGE_PATH) + `scripts/models/bundle.mjs` (writeModelBundle :115-313, promote :315-361). Решение пользователя (2026-11-05, AD-D2): **owner = ollama; catalog-хидратация — только через ollama API (pull/manifest), прямой FS-запись из catalog запрещён**. M-6 (gate эпика): путь GGUF→ollama «не зафиксирован (dual-writer в compose); ждёт решение пользователя на точечный фикс spine».

**Approach:** (1) **HITL-решение M-6** — механизм реворка bundle-hydration (варианты и рекомендация в Open Questions); (2) по решению: убрать rw-монтирование model-weights у catalog (compose:155) + `MODEL_STORAGE_PATH` из env-модели; (3) реворк `ModelBundleRuntime.prepare` + `bundle.mjs`: hydration через ollama API (blobs/manifest/create — путь уже существует для GGUF: gguf-runtime.service.ts:169-179, :210-227), activate/promote = DB-состояние + API-вызовы, без прямой FS-записи в volume; (4) GGUF-источники (download.mjs → /data/models/gguf) — по варианту M-6 (a: через ollama /api/blobs; b: отдельный volume). Drift-тест story 6 закрепит «один write-owner = ollama».

## Boundaries & Constraints

**Always:**
- Write-owner model-weights = **ollama** (решение 2026-11-05, не подлежит повторному обсуждению в этой story).
- GGUF-модели продолжают работать через ollama API (gguf-runtime.service.ts: prepare :43-109, create :110-122, blobs :169-179, pull :210-227, advisory lock :141-143, lease :377-399) — этот путь не трогается.
- Activate/promote = изменение DB-состояния (какая версия активна) — без FS-записи в model-weights.
- Crash-совместимость: hydration — через AD-D5 паттерны (ollama API = внешний writer; локальные tmp-файлы — pattern 1).

**Never:**
- Не оставлять catalog с rw-монтированием model-weights после story (это и есть dual-writer).
- Не делать «обход» через bind-mount/маленький трюк — фикс = compose + code.
- Не менять ollama-контейнер (image, /root/.ollama, env) — owner не трогается.
- Не реализовывать enforcement/квоты весов (GGUF-лимиты `model_gguf_uploads.limits` + pending-сумма — ратификация, AD-D4(5) — уже есть, не трогать).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Bundle-hydration (новый бандл) | prepare(model) | файлы весов появляются в volume только через ollama (проверка: ollama list/api), у catalog rw-монтирования нет |
| 2 | GGUF-модель | gguf prepare → blobs → create | работает как сейчас (API-only) |
| 3 | activate/promote | DB-операция | DB-состояние обновлено; FS-записи в model-weights нет |
| 4 | Ollama недоступен во время hydration | API-ошибка | явная ошибка (не «частичный FS-файл»); состояние бандла = pending/failed, retry-абилен |
| 5 | Crash во время hydration (kill -9) | restart | нет битых частичных файлов в volume (ollama — owner, свои partial'ы; catalog — только API-вызовы) |
| 6 | Drift-тест (story 6) | compose после story | model-weights: один rw (ollama), catalog — ro или без монтирования |
| 7 | Существующие данные (уже загруженные модели) | после переключения | ollama list — модели на месте (volume не трогался); catalog DB — версии активны |

## Code Map

- `compose.production.yml:33-43` — ollama service (`model-weights:/root/.ollama` :36), :152 — catalog `MODEL_STORAGE_PATH: /data/models`, :155 — catalog `model-weights:/data/models:rw` (dual-writer, убирается)
- `services/catalog-service/src/models/model-bundle-runtime.ts:19-80` — `ModelBundleRuntime.prepare` (hydrate → MODEL_STORAGE_PATH) — реворк
- `scripts/models/bundle.mjs:115-313` — writeModelBundle (bundle-cache), :315-361 — promote, :363-382 — activate
- `services/catalog-service/src/models/gguf-runtime/gguf-runtime.service.ts:43-109` — prepare (manifest + blobs + create), :110-122 — create, :169-179 — createBlob (POST /api/blobs), :210-227 — pullImageFromOllama, :141-143 — advisory lock, :377-399 — lease
- `services/catalog-service/src/models/gguf-runtime/gguf-runtime.manifest.ts` — manifest (сейчас читает volume напрямую — проверить, при M-6(a) — через API)
- `scripts/models/download.mjs` — GGUF-загрузка (куда пишет — по варианту M-6)
- `deploy/production/environment-model.json:210` — `MODEL_STORAGE_PATH: /data/models`, :182 — `model-weights:/data/models:rw`
- `scripts/production/environment-model.mjs:268-290` — structuralDrift
- `services/catalog-service/src/catalog/catalog-migrations.ts:302-306` — max v52 (DB-состояние activate/promote — без миграции)

## Tasks & Acceptance

### Gate (HITL)
- [ ] **Решение M-6** (пользователь): вариант механизма bundle-hydration (OQ-1). Story не стартует до решения.

### Execution
- [ ] По решению: compose — убрать `model-weights:/data/models:rw` у catalog (:155), `MODEL_STORAGE_PATH` из env (:152)
- [ ] environment-model.json: убрать volume/env у catalog; drift-тест
- [ ] model-bundle-runtime.ts: prepare → ollama API (blobs/manifest/create) вместо прямой FS-записи; MODEL_STORAGE_PATH из кода
- [ ] bundle.mjs: writeModelBundle/promote — по варианту (a: API-only; b: отдельный volume); activate — только DB
- [ ] gguf-runtime.manifest.ts: если читает volume напрямую — через API (по варианту)
- [ ] download.mjs (GGUF-источники): по варианту (a: /api/blobs; b: отдельный volume)
- [ ] Тесты: bundle-hydration на fixture (ollama API mock/real) — без rw-монтирования; GGUF-путь regression-тест; activate/promote — только DB

### Acceptance
- **Given** новый model-bundle **when** prepare **then** веса в volume только через ollama API; у catalog rw-монтирования model-weights нет
- **Given** GGUF-модель **when** prepare/activate **then** работает (API-only), без regressions
- **Given** crash во время hydration **when** restart **then** нет частичных файлов от catalog в volume
- **Given** drift-тест volume map (story 6) **when** run **then** model-weights write-owner = ollama (единственный rw)

## Design Notes

- **М-6 — точечный фикс spine**, не redesign: GGUF-путь уже API-only (ratified), реворк касается только bundle-hydration (GGUF-бандлы, не GGUF-модели напрямую) + source-файлов.
- Варианты M-6 (OQ-1): **(a) full API-only** — GGUF-источники и bundle-cache тоже через ollama /api/blobs (volume = только ollama; catalog — API-client); **(b) отдельный volume** — bundle-cache живёт в своём volume (write-owner = catalog), publish в model-weights через ollama API (pull из локального пути? — ollama не поддерживает local-file pull без blobs; значит promote = upload blobs). (a) чище по AD-D2 (один owner, ноль локальных FS-райтеров), (b) проще по данным (bundle-cache не зависит от ollama-доступности).
- Риск (a): ollama-доступность становится критичной для hydration (сейчас FS-запись независима от ollama). Митигция: retry + явный pending-статус (edge 4).
- ROLLBACK: story не меняет данные в volume (только пути записи) — откат = вернуть compose-mount + code (до решения M-6 данные untouched).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- model-bundle gguf
node scripts/models/bundle.test.mjs 2>/dev/null || npm test -w catalog-service -- bundle
# drift:
node scripts/test/check-tooling.test.mjs 2>/dev/null || true
```
Ожидаемо: bundle/gguf-тесты зелёные без rw-монтирования model-weights; drift compose↔model зелёный; compose: у catalog нет `model-weights:...:rw`.

## Open Questions

1. **M-6: механизм bundle-hydration** (HITL): (a) full API-only (GGUF-источники + bundle-cache через ollama /api/blobs; volume = только ollama) — **рекомендация** (чистый AD-D2, ноль локальных FS-райтеров); (b) отдельный volume для bundle-cache (write-owner = catalog) + publish через ollama blobs. Влияние: (a) — hydration зависит от ollama-доступности; (b) — лишний volume + publish-шаг.
2. **GGUF-источники (download.mjs)**: кто и куда пишет исходные .gguf — по варианту M-6. Если (a): download.mjs пишет в /api/blobs (нужен local-path → blobs путь); если (b): отдельный volume.
3. **Manifest-чтение**: gguf-runtime.manifest.ts сейчас читает volume напрямую — при (a) через API (есть ли ollama-эндпоинт для manifest? dev-проверка).
4. **Существующие данные**: после переключения ollama list должен видеть все уже загруженные модели (volume не мигрируется) — проверить на приёмке (DATA-01).
