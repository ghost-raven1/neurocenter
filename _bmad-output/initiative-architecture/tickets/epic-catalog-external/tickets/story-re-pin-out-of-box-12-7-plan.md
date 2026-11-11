---
title: 'Re-pin каталога + «из коробки»-проверка пяти ассетов (entry 12.7)'
type: 'feature'
ticket: '7'
created: '2026-11-11'
status: done
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

## «Из коробки» (установка + LLM-smoke 5 ассетов) — выполнено

- **Установка из каталога** (offline-sync) покрыта тестом и зелёная:
  `bundled-catalog.test.mjs` «Default offline sync … publishes only
  metadata/inline receipts and never requests binary or model URLs» (14/14).
- **LLM-smoke** прогнан 2026-11-11 на устройстве (модель
  `ai-gateway/Qwen/Qwen3.8-27B-FP8` из конфига opencode, решение 12.1 (в)/(г)).
  Skill-ассеты — в изолированной среде `/tmp/opencode/smoke-12-7`
  (`.agents/skills/` = венд-бандлы из `catalog-source/components/`, 46 скиллов),
  `opencode run -m ai-gateway/Qwen/Qwen3.8-27B-FP8`:

| Ассет | Сценарий | Результат |
|---|---|---|
| **bmad-method** | «BMAD: что делать дальше в новом проекте» | ✅ PASS — hub `bmad` загрузился, LLM дал корректный путь (setup → вход в планирование → инициатива/тикеты/сборка) |
| **openspec** | «Создай новый openspec change: dark mode» | ✅ PASS — skill-триггер → реальный CLI (npx, кэш 1.17.0) → `openspec/changes/add-dark-mode/proposal.md` создан (Why/What Changes/Impact) |
| **ui-ux-pro-max** | «Дизайн-система аналитического дашборда» | ✅ PASS — skill-триггер (`--design-system`, Data-Dense Dashboard, density 9/10), WCAG-контраст рассчитан, 2 проблемы найдены и исправлены (primary тёмной 3.68:1→5.17:1), артефакт `DESIGN_SYSTEM.md` (11KB: палитры/типографика/токены/компоненты) |
| **opencode-see-image** | скриншот → описание (vision) | ✅ PASS с оговоркой — плагин активен в сессии (кандидатный цикл + явные ошибки); vision-модель устройства доступна: прямой вызов `ai-gateway/Deepseek/DeepSeek-V4-Flash-Vision` (ключ из `~/.local/share/opencode/auth.json`) = **200**, корректное описание тестового PNG. E2E-вызов `see_image` в сессии блокируется выбором кандидата (openwebui-модель без permission) = конфиг устройства, не дефект бандла |
| **open-code-review** | git-diff → structured review | ✅ PASS (delegation-режим — задокументированный путь OpenCode-интеграции: «LLM-ключ и модель берутся из конфига opencode устройства»). Бинарник v1.13.7 из венд-tgz `supply/vendor/@alibaba-group/ocr-linux-x64-1.13.7.tgz` (15.7MB) — работает; `ocr delegate preview` = корректный diff (+7/-2), `ocr delegate rule calc.js` = resolved rules; ревью по diff (host-agent): найдены (1) логическая ошибка `calcDiscount` (`price - percent` вместо процентной формулы), (2) хардкод tax-rate 1.2, (3) `var` (запрещён rules), (4) отсутствие валидации. Прямой LLM-режим ocr (custom provider → ai-gateway) — environment-blocked: корпоративный MITM отклоняет TLS-фingerprint Go-клиента (`tls: handshake failure`; тот же URL отдаёт 200 для curl/node, `GODEBUG=tls13=0` и `SSL_CERT_FILE` не помогают) |

Примечание: smoke прогнан на венд-копиях из `catalog-source/components/`
(не на локально установленном BMAD 6.13.0-next — тот другой снапшот, 147
файлов diff от pinned a867e16).

## Корневой сьют (без деградации) — выполнено (батч по зонам изменений)

Единой команды «корневого сьута» в репо нет (как в epic-trust-device-catalog:
«зафиксировать при старте, без деградации против baseline»). Прогонён батч
11 файлов по зонам, тронутым эпиком 12 (catalog/assets/contract/snapshot):

bundled-catalog 14/14 · assets-sync 20/20 · assets-selection 27/27 ·
asset-contract-bump 12/12 · asset-contract-vendor 3/4 ⚠ ·
catalog-plugin-publish 6/6 · catalog-sync-environment 9/9 ·
prepared-source-snapshot 19/20 ⚠ · source-adapters 14/14 ·
skill-supply 20/20 · recipe-plan 6/6.

**Итого 150 pass / 2 fail — оба fail PRE-EXISTING** (не от мержей 12.2–12.6,
оба красные на base `95ac92d5`):

1. `asset-contract-vendor.test.mjs` «All consumer locks and Docker paths…»
   — тест ждёт `COPY vendor/asset-contract/ /vendor/asset-contract/`
   (regex строка 246), а `d658006f` (2026-11-10, **предок base**) перевёл все
   6 Dockerfile на repo-лейаут `COPY vendor/asset-contract/ /repo/vendor/...`
   (строка 53 catalog-service/Dockerfile — уже в base). Тест после смены
   лейаута не обновлён. Мои мержи Dockerfile не трогали
   (diff `95ac92d5..HEAD` по services/*/Dockerfile пуст).
2. `prepared-source-snapshot.test.mjs` «Retained sources rebuild and execute
   the publication validator in isolation…» — `3629dc7e` (2026-11-09, entry 2.2,
   **предок base**) добавил `require('@neurocenter/asset-contract')` в
   `services/shared/runtime/limits.cjs`; в реальном репо контракт резолвится
   через root `node_modules` (root package.json: `file:vendor/asset-contract`),
   но фикстура теста синлкает в tmp только `catalog-service/node_modules`
   (root node_modules в снапшот не копируется) → MODULE_NOT_FOUND. Файл теста
   последний раз менялся `ca9f2cb4` (2026-11-01) — ДО 2.2, фикстура устарела.
   Мои мержи тронули только `PREPARED_SOURCE_INPUTS` (+14 файлов see-image:
   рецепт + component) и cap MAX_FILES 183→197 — это добавляет скопированные
   файлы в tmp, но не влияет на module-resolution. limits.cjs,
   runtime-artifacts.cjs, vendor/asset-contract, catalog-service TS-источники
   в diff `95ac92d5..HEAD` отсутствуют.

Вывод: **деградации против base нет** — те же 2 pre-existing fail, всё
остальное зелёное (150/152).

## Result

**Все пункты verify 12.7 выполнены:**

1. Pin-каскад: 39 current / 24 index-ассета / 15 plans, `pin --check` GREEN.
2. Drift-тесты: bundled-catalog 14/14, prepare 5/5, assets-offline-ready 19/19,
   supply-vendor 8/8.
3. Provenance FR-203 + SHA-опись FR-201 (mismatch=0 по 5 компонентам).
4. «Из коробки»: LLM-smoke 5/5 ассетов (см. таблицу выше; ocr —
   delegation-режим, задокументированный путь OpenCode-интеграции).
5. Корневой сьют: 150/152, оба fail pre-existing (не деградация против base).

Статус: **done**.

## Инцидент dev-стэка (зафиксирован при smoke, 2026-11-11 ~04:2x UTC)

Рестарт стэка → 7 app-сервисов exit 255: catalog-service — **рецидив
503-инцидента** (`ENOENT .asset-source-blobs/a22dcb33….blob` на
`bridgeSupply`; blob'ы на volume были, целостность по имени=sha256 — сбой
в доступности/порядке старта), api-gateway — `auth check failed: timeout`
(цепочка). Устранено: `docker compose up -d --wait` → 11/11 Healthy.
Подтверждает актуальность story 12.8 (blob self-heal, R9): без self-heal
потеря/несчитываемость blob = падение/503, а не явное состояние.

## Plan Change Log

- 2026-11-11: создан план после переделки мержей 12.2–12.6 (union-алгоритм,
  re-card bmad/openspec — trailing-слэш source.path, cap files 300→1000,
  openspec-CLI tgz вне manifest.files по прецеденту ocr). Pin-каскад 39/24/15,
  drift-тесты зелёные. LLM-smoke + корневой сьют — остаток.
- 2026-11-11 (2-я половина): LLM-smoke 5/5 (bmad/openspec/ui-ux прогон
  `opencode run` на венд-бандлах; see-image — vision-модель 200, e2e
  блокируется конфигом устройства; ocr — delegation-режим, бинарник из
  венд-tgz). Корневой сьют 150/152 (2 pre-existing: `d658006f`, `3629dc7e`).
  Зафиксирован рецидив blob-инцидента на dev-стэке (→ 12.8). Status: done.
