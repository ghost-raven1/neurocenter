---
title: 'Supply-манифест: сборка с чистого git-checkout (AD-OP-2)'
type: 'feature'
ticket: '1'
created: '2026-11-06'
status: done
baseline_revision: '90b92af3'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md
  - docs/implementation-readiness.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Production-релиз не собирается воспроизводимо: `setup.mjs build` не проверяет чистый checkout, не фиксирует commit SHA и не производит артефакт, связывающий образы, supply (bridge-dist, установщики, vendor-контракт) и миграции с исходным commit. REL-01, DR-restore и установщики устройств строятся на этом предположении.

**Approach:** Расширить build-режим `setup.mjs`: чистый-checkout гейт + нормализация mtime контекста сборки к `SOURCE_DATE_EPOCH` commit → `docker compose build` (не менять) → захват image ID 7 app-образов + postgres → опись миграций из закреплённых образов (готовый `inspectSchemaManifests`) → supply-опись (SHA256 с пересчётом) → манифест `neurocenter-release-v1` с верификацией (preflight) в конце сборки.

## Boundaries & Constraints

**Always:**
- Манифест `neurocenter-release-v1`: commit, release (метка из .env), images (7 сервисов, image ID `sha256:<64hex>`), postgresImage, supply (runtime/opencode-архивы + installer-шаблоны + vendorContract), migrations (3 schema-сервиса из образов).
- Чистый checkout: `git status --porcelain` ≠ пусто → фэйл сборки до docker; commit SHA из `git rev-parse HEAD` в манифесте.
- Детерминизм: mtime всех файлов build-контекста = `SOURCE_DATE_EPOCH` (commit timestamp) до `docker compose build`; исключения — `.git` и всё, что режет `.dockerignore`.
- Supply-опись = архивы, реально присутствующие в bridge-dist на момент сборки (пусто = легально); при наличии `.sha256`-сайдкара он обязан совпасть с пересчётом.
- Не менять: теговую схему `${NEUROCENTER_RELEASE}`, pinned-базы Dockerfile'ов, `applicationServices`, контракт `neurocenter-update-v1`.

**Never:**
- Нет изменений update-flow (`update.mjs`), compose-схем, shared-слоя — это сторис 1.2–1.13.
- Нет обхода dirty-гейта, нет кросс-платформенной сборки всех 8 supply-целей на хосте (windows/darwin-цели — существующие job'ы), нет подписания/отправки манифеста.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CLEAN_BUILD | чистый checkout, docker есть | манифест в `<dir>/releases/<release>/release-manifest.json`, верификация пройдена | — |
| DIRTY_TREE | незакоммиченные/неотслеживаемые (не-ignored) изменения | фэйл до docker build | явное сообщение, exit 1 |
| IMAGE_MISMATCH | image ID не совпал с манифестом после перепроверки | фэйл сборки | список расхождений |
| SUPPLY_DRIFT | `.sha256`-сайдкар ≠ пересчёт hash | фэйл сборки | имя файла в сообщении |
| EMPTY_SUPPLY | в bridge-dist нет архивов (чистый checkout) | supply.runtime/opencode = [] , манифест валиден | — |
| NOT_A_REPO | каталог вне git | фэйл сборки | явное сообщение |

</frozen-after-approval>

## Code Map

- `scripts/production/setup.mjs` — build-режим L112-118 (точка врезки); `compose()` L88-94.
- `scripts/production/compose-client.mjs` — `applicationServices` L11-19 (7 сервисов); `serviceImageIds(config)` L235-246 (image ID через `docker image inspect`); `composeConfiguration(client)` (полный compose-конфиг, `services.postgres.image`).
- `scripts/production/schema-migrations.mjs` — `schemaServices` L1; `inspectSchemaManifests(images, run)` L37-75 — опись миграций из pinned-образа, `run` = docker CLI-раннер (тот же, что в preflight `update.mjs`).
- `scripts/production/update.mjs` — `sha()` L28, `imagePattern` L29, `releasePattern` L30, idiom `atomicWrite`/`privateFolder` L116-135 (0600, rename, fsync каталога) — переиспользовать как есть.
- `compose.production.yml` — build-блоки `context: .` (L95/128/169/192/216/250/276/303); postgres `pgvector/pgvector:pg16@sha256:…` L46 (digest-pin уже есть).
- `.dockerignore` — исключения контекста: `**/node_modules`, `**/dist`, `**/build`, `.git`, `.env*`, `data/`, `deploy/production/local/`, `**/secrets/`, `docker/build-ca/*` (кроме .gitkeep/ca-*.pem) — тот же набор исключений для mtime-нормализации.
- `vendor/asset-contract/SOURCE.json` — version/commit + per-file sha256 (14 файлов); `SHA256SUMS`.
- `bridge-dist/` — `runtime/*.tgz`(+`.sha256`/`.json`), `opencode/*.tgz`(+`.sha256`), git-tracked шаблоны: `install.sh/.ps1`, `install_opencode.sh/.ps1`, `install_workspace.sh/.ps1`, `connect.sh/.ps1` (плейсхолдеры не трогать — их проверяют `bridge-installer-*.test.mjs`).
- `scripts/test/production-setup.test.mjs` — fixture-паттерн: отдельный checkout в tmp + мок docker через injected deps — шаблон для нового теста.
- `scripts/workspace/check-tooling-tests.json` — явный список tooling-тестов: новый файл обязан туда войти (coverage-inventory-тест проверяет полноту).
- Не менять: Dockerfile'ы (pinned-базы, `NEUROCENTER_BUILD_CA_*`), `migrate.cli.js`, `NEUROCENTER_RELEASE`-механику `configuration.mjs`.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/production/release-manifest.mjs` (new) -- схема `neurocenter-release-v1` + `validateReleaseManifest` (формат полей, `imagePattern`), `buildReleaseManifest`, `writeReleaseManifest` (atomic 0600, idiom из update.mjs), `verifyReleaseManifest(manifest, actuals)` → список расхождений; `supplyInventory(root)` — runtime/opencode `.tgz` (streaming sha256, сверка с `.sha256`-сайкаром), 8 installer-шаблонов, vendorContract из `SOURCE.json` + проверка `SHA256SUMS`; `normalizeBuildContext(root, epoch)` — рекурсивный обход + `fs.utimes`, исключения по `.dockerignore` + `.git`; `assertCleanCheckout(root, gitRunner)` — `rev-parse HEAD` + `status --porcelain`.
- [ ] `scripts/production/setup.mjs` -- build-режим: (1) `assertCleanCheckout` (git-раннер injectable для тестов); (2) `SOURCE_DATE_EPOCH = git log -1 --format=%ct` + `normalizeBuildContext` до build; (3) после `client.run(['build'])`: `serviceImageIds` + postgres ID из `composeConfiguration` → `inspectSchemaManifests` (3 schema-сервиса) → `supplyInventory` → `buildReleaseManifest` → `writeReleaseManifest` в `<dir>/releases/<release>/release-manifest.json` → `verifyReleaseManifest` (пересчёт: image ID + supply hash + migrations) — любое расхождение = фэйл.
- [ ] `scripts/test/release-manifest.test.mjs` (new) + регистрация в `scripts/workspace/check-tooling-tests.json` -- validate (валидный/битый digest/недостающие поля), build-flow с мок-docker (fixture как в production-setup.test.mjs): манифест записан со всеми секциями, dirty tree → фэйл до docker, IMAGE_MISMATCH/SUPPLY_DRIFT → фэйл верификации, EMPTY_SUPPLY → валидный манифест, normalizeBuildContext (tmp-дерево: mtime = epoch, исключения не тронуты), write (0600, атомарность).

**Acceptance Criteria:**
- Given чистый checkout commit X, when `setup.mjs build`, then записан манифест `neurocenter-release-v1` с commit=X, release из .env, 7 image ID + postgresImage (`sha256:<64hex>`), supply-описью с пересчитанными SHA256 и описью миграций 3 schema-сервисов из образов; верификация прошла.
- Given два чистых checkout одного commit, when два build, then image-digest'ы всех 7 образов в манифестах идентичны.
- Given незакоммиченные или неотслеживаемые (не-ignored) изменения, when `setup.mjs build`, then фэйл до docker build с явным сообщением.
- Given манифест, when фактическое состояние (image ID / supply hash / миграции) отличается, then `verifyReleaseManifest` возвращает непустой список расхождений и сборка завершается ошибкой.
- Given архив в bridge-dist с `.sha256`-сайкаром, не совпадающим с реальным hash, when build, then фэйл с именем файла.
- Given дерево build-контекста, when нормализация, then mtime всех файлов контекста = timestamp commit (`.git` и `.dockerignore`-исключения не трогаются).

## Implementation Notes

- Риск детерминизма: `npm ci`/`npm run build` внутри образов — детерминированы при одинаковом контексте; переменная часть — mtime файлов COPY из checkout. Если два build дают разные image ID несмотря на нормализацию контекста, искать следующий источник (эмпирическая проверка — hitl-шаг, см. Verification).

## Plan Change Log

## Review Triage Log

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | `contextExcluded` режет `data/offline-assets/.run/playwright-mcp` на любой глубине, а `.dockerignore` — только root: вложенные каталоги с этими именами попадают в docker-контекст без нормализации mtime (латентный источник недетерминизма) | medium | Подтверждено: `.dockerignore` L13-14/19/24 без префикса `**/` (root-only), код `excludedNames.has(name)` (release-manifest.mjs:312) — any-depth; `.git/node_modules/dist/build/secrets` в обоих any-depth — совпадают | patch |
| 2 | `gitCommand` не читает `child.stderr` — при неудаче git-команды чистого-checkout гейта ошибка без диагностики | medium | Подтверждено: release-manifest.mjs:349-362 собирает только stdout; idiom репо (compose-client.mjs) держит tail stderr в диагностике | patch |
| 3 | `docs/production-setup.md` / `docs/docker-build-ca.md` не описывают новый build-режим `setup.mjs` (гейт, нормализация, манифест `neurocenter-release-v1` и верификацию) | medium | Frozen-intent entry не охватывает обновление доков; гейт падает с явным сообщением, ущерб оператору ограничен; доки — территория entry 1.12 (Refactor sweep: «осиротевшие… доки») | defer |
| 4 | Фичафлаги AGENTS.md не применены к чистого-checkout гейту | false | Гейт — жёсткое требование AD-OP-2 (frozen Boundaries), не фичафлаг; правило AGENTS.md о фичафлагах к build-гейтам неприменимо | reject |
| 5 | Diff старше дерева по `lenses_ran` | false | Поле frontmatter `lenses_ran` пишется после снапшота diff (step-04: после запуска линзы) — артефакт порядка, не изменение кода | reject |

## Verification

**Commands:**
- `node --test scripts/test/release-manifest.test.mjs` -- expected: all green
- `node --test scripts/test/production-setup.test.mjs scripts/test/production-update.test.mjs scripts/test/asset-contract-vendor.test.mjs` -- expected: без регрессии
- `npm run check` (или узкий шаг tooling-тестов) -- expected: зелёный, coverage-inventory видит новый файл
- HITL: `node scripts/production/setup.mjs build --directory <prod-dir>` -- expected: манифест записан, верификация «OK», стек собирается с образов манифеста
- HITL (главная): два `git clone` одного commit → `setup.mjs build` в каждом → сравнить секцию `images` обоих манифестов -- expected: идентичны; затем `touch` незакоммиченное изменение → build → expected: фэйл
