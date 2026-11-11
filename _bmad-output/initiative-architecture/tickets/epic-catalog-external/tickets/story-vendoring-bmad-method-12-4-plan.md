---
type: story-plan
story: 12.4
title: "Вендинг BMAD-METHOD (бандл 32 skills, pinned main @ a867e160)"
status: implemented
---

# Story plan — 12.4 Вендинг BMAD-METHOD

## Decision: одна бандл-карточка (НЕ дробление на 32)

Форма **ОДИН бандл-ассет `kind=skill` «BMAD Method»** (id `skill-bmad-method`).
Основание: `skills/` — это единый метод-контур из 32 скиллов (`bmad-*` + `bmod-*`) с hub `bmad`,
который ссылается на другие скиллы и запускает helper-скрипты через `uv run`. Дробление на 32
карточки ломает метод (перекрёстные ссылки и управление установкой `bmad setup`/`bmad migrate`
работают только в едином дереве). Решение зафиксировано: соответствие примечанию тикета.

## Pinned source (подтверждено)

- `repository`: https://github.com/bmad-code-org/BMAD-METHOD
- `commit`: `a867e1604b365d48ea03cbd109da1066ba0c84bc` (проверен по локальному клону; `git ls-remote origin main` = этот SHA)
- `git describe`: `v6.12.0-266-ga867e160` → **`6.13.0-next`** (линия разработки к v7 alpha, ветка `main`).

## Сверка версии с локально установленным BMAD (NOTE тикета)

- Установленный BMAD инициативы (neurocenter, `.agents/skills/`): `bmod-core-tools` и `bmod-method`
  оба `version = "6.13.0-next"`; установлен 30-скилловый набор (core-tools + method; toolsmith/founder не установлены).
- Пин `a867e160` = `6.13.0-next` → **СОВПАДАЕТ** с версией, на которой идёт инициатива. Вердикт: пин корректен,
  брать текущий `main @ a867e160`, НЕ V6.12.
- Про `V6.12`: в тикете формулировка «stable-линия = V6.12». Фактически `V6.12` — это **отдельная legacy-ветка**
  (в AGENTS.md: «Legacy npm installer is maintained separately on V6.12 branch»). Текущий `main @ a867e160`
  = `6.13.0-next` (уже после v6.12.0 и поглощает v6.12, идёт к v7 alpha). Поэтому «stable V6.12» для этого пина
  не применяется; зафиксировано как `stableLine` в SOURCE.json.

## Scope контура и исключения

- **В контуре**: `skills/` (все 32 папки, SHA-опись в SOURCE.json — FR-201), включая hub `bmad`
  (SKILL.md + references/ + assets/ + scripts/) и модульные манифесты `bmod-*/bmod.toml`.
- **Вне контура (scope-заметка в NOTICE.md)**: `tools/`, `docs-site/`, `docs/`, `.github/`, `CHANGELOG.md`,
  `action.yml`, и репозиторные метаданные.

## Компоненты каталога

1. **Component** `catalog-source/components/skill-bmad-method/`:
   - `skills/` — 32 папки (вендовое дерево, 498 файлов).
   - `SOURCE.json` — repository/commit/license(MIT)/scope/version/stableLine + SHA-опись 498 файлов.
   - `NOTICE.md` — attribution + scope + runtime-заметка.
   - `recipe.json` — recipe установки бандла как skill-группы.
2. **Metadata-карта** `catalog-source/metadata/8d5ee542….json`: `id=skill-bmad-method`, `kind=skill`,
   `origin` (github + commit), `revision`, `compatibility.packageFormat=5`, `source` (git, path `skills/`).
   **Compatibility-метка**: skill-формат opencode + Python/uv (BMad-setup) — НЕ блокирует установку скиллов.
3. **Recipe** `catalog-source/recipes/skill-bmad-method.json` (+ зеркало в component `recipe.json`).
4. **Manifest** `catalog-source/manifest.json`: `current[34]` + `files` (+503 записи: 498 skills + SOURCE/NOTICE/recipe + card + recipes).
5. Pin-каскад: `node scripts/assets/catalog-source-pin.mjs --write` (обновлён `bundled-catalog.lock.json`).

## Отклонения / примечания

- `recipe-schema.mjs::validateRecipe` допускает только `kind: mcp|plugin`; для skill-бандла recipe — это
  **advisory/install-документ** (не проходит build-валидацию) и не привязан через `delivery.recipe`
  (skill-доставка — `delivery.type: inline`, как у существующих скиллов). Глубокая сборка/индексация —
  story 12.7 (re-pin + index + сквозная проверка «из коробки»).
- Producer-замыкание (`PREPARED_SOURCE_MAX_FILES = 183`, сейчас 183/183) не позволяет включить 498 файлов
  венда; поэтому венд хранится как component + SHA-опись в SOURCE.json, а НЕ в `PREPARED_SOURCE_INPUTS`.
  Замыкание не изменено; `pin --check` проходит.

## Verification выполнено

- `pin --check` (после `--write`) — PASS.
- Skill-проба в `/tmp/opencode/skill-probe-12-4/` (статически, без тяжёлых side-эффектов): 32 скилла,
  у каждого SKILL.md с frontmatter `name === dirname` и `description`; hub `bmad` отсылает к методу
  («что делать дальше / next step»), упоминает `uv run` и has references (help/initiative/migrate/setup);
  `bmad-build` присутствует; 4 bmod-модуля с `bmod.toml` версии `6.13.0-next`.

## Result

Ассет добавлен в каталог (component+metadata+recipe+manifest), пин подтверждён и сверен с локальным BMAD
инициативы (совпадает). Корневой сьют / индекс-генерация — story 12.7 (re-pin).
