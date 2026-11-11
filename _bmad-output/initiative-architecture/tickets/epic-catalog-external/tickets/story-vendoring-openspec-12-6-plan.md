---
type: story-plan
story: 12.6
title: "Вендинг Fission-AI/OpenSpec (бандл 12 skills + CLI, pinned main @ 579fcac5)"
status: implemented
---

# Story plan — 12.6 Вендинг Fission-AI/OpenSpec

## Decision: ОДИН бандл-ассет `kind=skill` + vendor'd npm-тарбол CLI (НЕ 2 ассета)

Форма **один бандл-ассет `id=skill-openspec`, `kind=skill` «OpenSpec (SDD метод)`**, внутри которого
два артефакта одной инструментальной единицы:
- **skill-контур** `skills/` — 12 скиллов openspec-* (единый SDD-метод; дробление на 12 карточек ломает
  поток workflow и перекрёстные ссылки, которые сохраняются только в едином дереве).
- **CLI** — vendor'd npm-тарбол `@fission-ai/openspec@1.17.0` (`bin openspec`) в `cli/openspec-1.17.0.tgz`
  (AD-15: закрытая поставка, тарбол пинится по SHA в составе component source).

Основание: skills драйвят CLI (`allowed-tools: Bash(openspec:*)`), `openspec` — это и есть инструмент
метода. Разделение на 2 карточки (skill-бандл + отдельный `tool`) потребовало бы нового `kind=tool`
и вводило бы неоднозначность назначения; единый бандл соответствует рекомендации тикета («как BMAD»)
и NOTE FR-308 (BMAD → OpenSpec-поток агент-команды). CLI-зависимость закрыта тем же бандлом.

## Pinned source (подтверждено)

- `repository`: https://github.com/Fission-AI/OpenSpec
- `commit`: `579fcac57ae00c2dff38f971b6d88b6f1f098b8a` — СВЕРЕНО: `git ls-remote https://github.com/Fission-AI/OpenSpec main`
  = этот SHA (не сдвинулся с известного клона), локальный клон `/tmp/opencode/openspec` = тот же SHA.
- `npm`: `@fission-ai/openspec@1.17.0`, `bin openspec → ./bin/openspec.js` (подтверждено в `package.json` клона).
  Проверка: `npm view @fission-ai/openspec@1.17.0` (registry.npmjs.org; локальный Artifactory `ppod-npm-trusted`
  содержит только 1.13.0 — валидно, тарбол взят по точной версии с npmjs для венединга, SHA-пин).
- `version` (ассета): `1.17.0`; `sourceRevision`: `git-579fcac5...`.

## Прямая сверка «из коробки» (ядро CLI)

Тарбол `openspec-1.17.0.tgz` (633 KiB, sha256 `f344f717...`, 648627 байт) содержит runnable CLI
(`package/dist/**`, `package/bin/openspec.js`, `package/schemas/**`). После установки production-
dependency-closure: `openspec --version` → **1.17.0**, `--help` → 25 команд (`version`, `init`, `update`,
`install`, `list`, `view`, `change`, `archive`, `spec`, `config`, `schema`, `store` и др.).

## Scope контура и исключения

- **В контуре**: `skills/` (12 `openspec-*/SKILL.md` + `skills/README.md`, SHA-опись — FR-201) +
  `cli/openspec-1.17.0.tgz` (vendor'd npm-тарбол).
- **Вне контура (scope-заметка в NOTICE.md / SOURCE.json)**: `src/`, `docs/`, `docs-lab/`,
  `openspec-parallel-merge-plan.md`, `.github/`, `tests/`, build-инструменты; npm production-dependency
  closure CLI (поставляется по AD-15 в trusted-registry, не вендорится в дерево).

## Компоненты каталога

1. **Component** `catalog-source/components/openspec/`:
   - `skills/` — 12 скиллов (инструкции, не тяжёлый runtime), `skills/README.md`.
   - `cli/openspec-1.17.0.tgz` — vendor'd npm-тарбол CLI (AD-15).
   - `SOURCE.json` — repository/commit/license(MIT)/scope/scopeNote/version(1.17.0)/versionNote + `npm`
     (name/version/bin/tarball sha256/bytes/engines) + SHA-опись 14 файлов (13 skills + tarball).
   - `NOTICE.md` — attribution + scope + runtime-заметка (CLI dep closure).
   - `recipe.json` — recipe установки бандла (skill-группа + CLI).
2. **Metadata-карта** `catalog-source/metadata/173b90a6….json` (`metadataSha256` = sha256 файла карты):
   `id=skill-openspec`, `kind=skill`, `name`, `slug=openspec`, `compatibility.packageFormat=5`,
   `source` (git, path `skills/`), `license` (MIT), `version 1.17.0`.
3. **Recipe** `catalog-source/recipes/skill-openspec.json` (+ зеркало в component `recipe.json`).
4. **Manifest** `catalog-source/manifest.json`: `current[34→35]` + `files[109→128]` (+19: 17 component
   `components/openspec/**` + `recipes/skill-openspec.json` + `metadata/173b90a6….json`).
5. **Pin-каскад**: `node scripts/assets/catalog-source-pin.mjs --write` (181 файл, producerSha256 `30240947…`),
   обновляет `bundled-catalog.lock.json`; `--check` PASS.

## Отклонения / примечания

- `recipe-schema.mjs::validateRecipe` допускает только `kind: mcp|plugin`; для skill-бандла recipe —
  **advisory/install-документ** (не проходит build-валидацию) и не привязан через `delivery.recipe`
  (skill-доставка — `delivery.type: inline`, как у существующих скиллов). Глубокая сборка/индексация —
  story 12.7 (re-pin + index + сквозная «из коробки»-проверка).
- Producer-замыкание (`PREPARED_SOURCE_MAX_FILES = 183`, сейчас 181/183) НЕ включает венд openspec;
  венд хранится как component + SHA-опись в SOURCE.json, замыкание не изменено, `pin --check` проходит.
- CLI npm dependency-closure (`commander`, `zod`, `yaml`, `chalk`, `ora`, `@inquirer/*` и транзитивные)
  в **локальном Artifactory `ppod-npm-trusted` отсутствует частично** (не найден `mute-stream@^3.0.0`,
  `@changesets/*`, часть `@inquirer/*`). Тарбол CLI взят по точной версии с npmjs для венединга и
  SHA-пинится; установка CLI на устройство требует provisioned dep-closure в trusted-registry
  (фиксируется как compatibility-заметка, НЕ блокирует установку skills). Это отклонение AD-15,
  валидирующее vendor-схему, — зафиксировать в story-plan (см. ниже).

## Verification выполнено (без тяжёлых side-эффектов)

- `pin --check` (после `--write`) — PASS (181 файл, producerSha256 `30240947…`).
- Manifest-инварианты `bundled-catalog` (schemaVersion, kind, current≤100, files≤300, index/sha256,
  истории ≤100, per-file sha256/bytes, hash-сверка новых entries) — PASS (current 35, files 128).
- Skill-проба `/tmp/opencode/skill-probe-12-6/`: 12 скиллов, у каждого SKILL.md с frontmatter
  `name === dirname` и `description`; README-контур — 12/12 PASS.
- CLI статически: `openspec --version` → `1.17.0`, `--help` → 25 команд — PASS.
- **Ручной шаг (тяжёлый e2e, НЕ выполнен)**: полный цикл `openspec init → new change → propose → apply →
  verify` требует живого git-репо/`openspec/`-жерла и записи в FS; выполнен статически на dev-стейдже
  путём распаковки тарбола + `npm install` в `/tmp/opencode/cli-probe-12-6/`. Сквозной e2e-сценарий —
  story 12.7 (собранный каталог + «из коробки»-проверка пяти ассетов), мусор в репо не создавался.

## Result

Ассет `skill-openspec` добавлен в каталог (component+metadata+recipe+manifest), пин сверен с актуальным
HEAD (не сдвинулся) и зафиксирован (`579fcac5`). Корневой сьют / index-генерация / сквозная «из коробки»
проверка — story 12.7 (re-pin после мержа веток).
