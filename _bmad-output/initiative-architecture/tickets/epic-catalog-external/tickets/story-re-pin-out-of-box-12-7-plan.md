---
title: 'Re-pin каталога + «из коробки»-проверка пяти ассетов (entry 12.7)'
type: 'feature'
ticket: '7'
created: '2026-11-11'
status: in-progress
baseline_revision: 'a1612f29967fafc408d7264798cd99fa6c6b2e14'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '_bmad-output/initiative-architecture/tickets/epic-catalog-external/epic-catalog-external.md'
  - '_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md'
---

# Story plan — 12.7 Re-pin каталога + «из коробки»-проверка пяти ассетов

## Intent

Финализация эпика 12: re-pin каталога по стандартному каскаду (producer.json →
manifest.json (34→39) → bundled-catalog.lock.json) + index, drift-тесты зелёные,
сквозная «из коробки»-проверка 5 новых ассетов (see-image, ui-ux-pro-max, BMAD,
open-code-review, OpenSpec) и provenance/SHA-опись.

## Timing-гейт (2.7 / 2.10) — закрыт

- 2.7 (`64282b43`) — в main и origin/main.
- 2.10 — контент в main через `4e6afb4c` (закрыт как done, отдельного merge нет;
  см. story-error-body-policy-ad-19-plan).
→ pin-каскад не конфликтует с их коммитами.

## Pin-каскад (выполнено, верифицировано)

После мержа 12.2–12.6 (main запушен `c8e54bb5..a1612f29`):

- `catalog-source/manifest.json`: **39 current-строк** (34 base + 5 новых),
  files=755, index=`c40bc6cc…` (39 entries, **24 index-ассета**).
- `catalog-source/producer.json`: 195 файлов, producerSha256=`47126ae9…`.
  Бандлы bmad/openspec — НЕ в `PREPARED_SOURCE_INPUTS` (component + SHA-опись в
  SOURCE.json), замыкание не раздуто.
- `services/shared/bundled-catalog.lock.json`: sha256=digest(manifest),
  components=4 пина (codex-connector, fetch-mcp, opencode-see-image, ui-ux-pro-max).
- `pin --check` (без записи) — **GREEN** (revision `cafa511a…`).

Счётчик «34→39» закрыт: **39 current / 24 index-ассета / 15 source plans**.

## Drift-тесты каталога (выполнено, верифицировано)

| Сьют | Результат |
|---|---|
| `scripts/test/bundled-catalog.test.mjs` | 14/14 |
| `scripts/catalog-plugins/test/prepare.test.mjs` | 5/5 |
| `scripts/test/assets-offline-ready.test.mjs` | 19/19 |
| `scripts/test/supply-vendor.test.mjs` | 8/8 |
| `scripts/assets/catalog-source-pin.mjs --check` | GREEN |

Примечание: `scripts/test/system-assets.test.mjs` (12.1, интеграционный на PG) —
SKIP без `CATALOG_TEST_PG_URL`; прогоняется на dev-стеке (см. «Остаток»).

## Provenance (FR-203) и SHA-опись (FR-201) (выполнено, верифицировано)

- Все 5 карточек несут: `version` + `source` (repo + commit) + `license`;
  SHA = `source.commit` (upstream) + собственный digest карточки
  (`metadata/<sha>.json`, self-named).
- «Время / издатель» (PRD FR-203): schema карточки (`contract.validateAsset`)
  не допускает произвольных полей, поэтому время (commit-timestamp) и издатель
  (repo-owner / receipt) резолвятся из supply-receipt
  (`asset_source_receipts` / `bridge_source_settings`) — провенанс доступен
  «из карточки + receipt».
- FR-201: SHA-опись в SOURCE.json у всех 5 компонентов сверена с диском
  (мismatch=0): see-image=11, ui-ux=92, bmad=498, ocr=9, openspec=14 файлов.

## «Из коробки» (установка + LLM-smoke) — ЧАСТИЧНО

- **Установка из каталога** (offline-sync) покрыта тестом и зелёная:
  `bundled-catalog.test.mjs` «Default offline sync … publishes only
  metadata/inline receipts and never requests binary or model URLs» (14/14).
- Венды 12.2–12.6 верифицировали ассеты **статически** (skill-probe: наличие
  файлов, frontmatter `name===dirname`, hub-ссылки, bmod-модули) и
  **сознательно отложили сквозной LLM-сценарий в 12.7**.
- **LLM-smoke каждого ассета** (часть verify 12.7) требует dev-стэка с
  сконфигурированными моделями opencode (решение 12.1 (в)/(г)):
  - see-image: скриншот → описание (vision-модель из конфига opencode);
  - ui-ux-pro-max: дизайн-запрос → триггер skill + рекомендации;
  - BMAD: hub `bmad` → ответ «что делать дальше»;
  - open-code-review: git-diff → structured review (LLM-ключ = проектный model set);
  - OpenSpec: новый change → `openspec propose` → статус.
  Лог/артефакт сценария — добавить в эту секцию после прогона.

## Корневой сьют (без деградации) — ОСТАТОК

Полный прогон корневого сьита на dev-стеке — финальный шаг (тяжёлый).

## Result

Pin-каскад + drift-тесты + provenance (FR-203) + SHA-опись (FR-201) — **выполнено
и верифицировано (зелёное)**. «Из коробки»: установка из каталога — покрыта
тестом (зелёная); LLM-smoke 5 ассетов + корневой сьют — **остаток на dev-стэке**
(нужны сконфигурированные модели). Status: in-progress — НЕ помечать done, пока
не пройдёт сквозной LLM-сценарий и корневой сьют.

## Plan Change Log

- 2026-11-11: создан план после переделки мержей 12.2–12.6 (union-алгоритм,
  re-card bmad/openspec — trailing-слэш source.path, cap files 300→1000,
  openspec-CLI tgz вне manifest.files по прецеденту ocr). Pin-каскад 39/24/15,
  drift-тесты зелёные. LLM-smoke + корневой сьют — остаток.
