---
title: 'Вендинг alibaba/open-code-review (CLI + plugin, pinned main @ e170728) — story 5'
type: 'story'
ticket: '5'
created: '2026-11-10'
status: done
baseline_revision: 'c8e54bb5345702ed53dc0418a8ac851672d9b693'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['_bmad-output/initiative-architecture/tickets/epic-catalog-external/epic-catalog-external.md', '_bmad-output/initiative-architecture/tickets/epic-catalog-external/tickets/tickets.toml']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Полный перенос alibaba/open-code-review в каталог Neurocenter (epic-catalog-external, story 5):
CLI-инструмент AI code review, выращенный на git-diff. Состав поставки — npm-лаунчер
`@alibaba-group/open-code-review` (`bin/ocr.js`) + нативный linux-x64 Go-бинарный биндинг
`@alibaba-group/ocr-linux-x64` (bin `opencodereview`) + OpenCode-плагин-обёртка
(`plugin.mjs`, оборачивает `ocr review --audience agent --format json`).

Пининг источника — **main @ e170728a2f05cada736aa481ce7ef26bbbadd3fb**
(«refactor(cli)!: remove --tools overrides (#1894)», 2026-11-10 19:06 +0800).
HEAD сверен через `git ls-remote`; HEAD на момент первого клона (f15c6dbb) дрейфовал,
поэтому коммит пере-пинен на актуальный удалённый main.

## Decision: форма ассета

**kind = `plugin`** (runtime-artifacts доставка).

Rationale (ожидаемая форма по тикету была `kind=tool`):

- `kind=tool` **отклонён** закрытым объединением `const KINDS = ['mcp','plugin','skill','model','bridge','agent']`
  в `vendor/asset-contract/lib/validation.mjs`. `validateAsset`/`validateIndex` бросают
  `"Unsupported asset schema, ID or kind"` для `tool` — схема каталога не допускает
  этот kind (независимо от «нового kind» в тексте тикета).
- Прецедент — **`plugin-opencode-snip`** (нативная CLI-бинарность + plugin,
  `runtime-artifacts` доставка, `linux-x64-glibc`). Оба представляют «запускаемый
  инструмент на устройстве» и потому кладутся одинаково.

## Boundaries & Constraints

**Always:**

- In-tree component: `catalog-source/components/open-code-review/` = JS-контур
  (`bin/ocr.js`, `scripts/*.js`, `package.json`, `LICENSE`, `README.md`,
  `npm/linux-x64/package.json`) + `SOURCE.json` (provenance, SHA-опись) + `recipe.json`.
- Pin: commit `e170728…` + pinned npm-версии launcher `@alibaba-group/open-code-review@1.13.7`
  и native `@alibaba-group/ocr-linux-x64@1.13.7`; для каждой — integrity + tarball SHA256.
- AD-15 vendor supply: исходные npm-тарболы положены в
  `supply/vendor/@alibaba-group/open-code-review-1.13.7.tgz` и
  `supply/vendor/@alibaba-group/ocr-linux-x64-1.13.7.tgz`.
- Метadata-карта: `catalog-source/metadata/d67c8d23….json`, id `plugin-open-code-review`,
  kind `plugin`, delivery `runtime-artifacts` (descriptor sha256 `7b39a5e5…`).
- Manifest entry в `catalog-source/manifest.json` (`current[8]`, после `plugin-opencode-snip`).
- LLM-ключ и модель — проектный model set из конфига opencode устройства, никогда не хардкод.

**Never (deviations & deferrals):**

- Нативный Go-бинар **не** коммитится in-tree producer-файлом: доставлен как runtime
  artifact (AD-15), согласовано с корневым `runtimeBinariesIncluded: false` и
  `bundled-catalog` тестом «no runtime binaries or model weights».
- Компонент **не** добавляется в `PREPARED_SOURCE_INPUTS` → файлы компонента не входят
  в producer-closure (producer.json / manifest.files). Это корректно: open-code-review —
  prepared-рецепт с runtime-artifact, а не inline-исходник producer-closure.
- Build-времени recipe-adapter (`prepareOpenCodeReview` в `source-adapters.mjs` +
  `scripts/catalog-plugins/recipes/adapters/open-code-review.mjs`) **вне scope story 5**:
  каталог-данные (карточка+рецепт+descriptor) checked-in; план создаётся как
  `state !== 'ready'`. Реальный пин build-adapter + источник — story 7.
- Полный «из коробки» diff-review smoke-запуск (реальный дифа → structured comments,
  LLM-ключ проектного model set) и корневой сьют — story 7 (cross-asset smoke всех 5
  новых ассетов). На story 5 сделан **статический probe** `ocr --help`/`--version`.
- Vendor-тарболы open-code-review — источник upstream-материала компонента, НЕ
  project-lockfile-зависимости, поэтому не регистрируются в `supply/vendor/manifest.json`
  и `classification.json` (эти файлы для пар из 13 lockfile).

## I/O & Edge-Case Matrix

| Scenario        | Input / State                                        | Expected Output / Behavior                                  | Error Handling                               |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| HEAD drift      | первый клон f15c6dbb, удалённый main ушёл            | re-pin на e170728; клон пере-чекаут                         | сверка `git ls-remote`                       |
| KIND validation | kind=tool                                            | @neurocenter/asset-contract бросает Unsupported schema      | выбран kind=plugin                           |
| Static probe    | `ocr --version` / `ocr --help` на runtime            | v1.13.7 linux/amd64 + subcommand-список                     | exit≠0 → probe FAIL                          |
| Producer pin    | `--write` затем `--check`                            | producer.json sha256 неизменен, lock.sha256=manifest digest | stale → fail (напоминает --write)            |
| Binary in-tree  | `.tgz/.tar/.exe/.bin` в producer files               | bundled-catalog тест фэйлит                                 | native бинарь — runtime artifact, не in-tree |
| Build adapter   | recipe adapter `open-code-review` не зарегистрирован | план создаётся `state !== 'ready'`                          | story 7 (build+нем ready)                    |

## Verification (story-5 scope)

- [x] `node scripts/assets/catalog-source-pin.mjs --write` затем `--check` — PASS
      (producerSha256 `30240947…`, revision `a69197ab…`).
- [x] `scripts/test/bundled-catalog.test.mjs` — 13/13 PASS (baseline plans count 13→14:
      добавлен ровно один source-plan open-code-review; assets 21, model plans 2, no binaries).
- [x] metadata-карта validateAsset (kind=plugin) — OK; `manifest.current[8].metadataSha256`
      == sha256(metadata-файл) == `d67c8d23…`.
- [x] SOURCE.json SHA-опись (9 files) сверилась с файлами на диске — OK.
- [x] Статический probe `ocr --help`/`--version` на linux-x64 runtime — PASS (exit 0).
- [~] `scripts/test/npm-supply-lockfile.test.mjs` — vendor-счётчик `943 !== 1025`
  (pre-existing baseline-drift на базовом коммите c8e54bb5, НЕ вызван story 5:
  ни один из 13 package-lock не изменён; тарболы open-code-review не в LOCKFILES).

## Files

- Added: `catalog-source/components/open-code-review/{SOURCE.json,recipe.json,source/**}`
- Added: `catalog-source/metadata/d67c8d2365e1f0ee343dabdeab968b1be7808615f5fd38e8fec51e224610db94.json`
- Added: `supply/vendor/@alibaba-group/open-code-review-1.13.7.tgz`, `…/ocr-linux-x64-1.13.7.tgz`
- Modified: `catalog-source/manifest.json` (current[8] + producer.json hash + lock.sha256)
- Modified: `services/shared/bundled-catalog.lock.json` (lock.sha256 + components)
- Modified: `scripts/test/bundled-catalog.test.mjs` (plans baseline 13→14)

</frozen-after-approval>
