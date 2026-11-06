---
title: 'Поставка: локальные registry + vendor-схема (AD-15)'
type: 'feature'
ticket: '9'
created: '2026-11-06'
status: 'ready-for-dev'
baseline_revision: '90b92af3f5bf47c8a5e320a115f33463d8c0d56a'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md
  - _bmad-output/initiative-architecture/architecture-runtime-trust/dep-registry-audit.md
  - _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md
  - _bmad-output/initiative-architecture/tickets/epic-release-baseline/epic-release-baseline.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Поставка npm-зависимостей идёт через `registry.npmjs.org` (13 lockfile, 9 `.npmrc`, 8 Dockerfile), хотя AD-15 требует поставку только из локальных источников, а npmjs.org с этой машины недостижим (TCP timeout).

**Scheme Change (2026-11-06, решение человека):** публикация в `ppod-npm-trusted` СНЯТА ПОЛНОСТЬЮ (publish-пути в кодовой базе не существует). Недостающее снабжение вендорится в репозиторий (git-tracked) по существующему паттерну проекта (`vendor/asset-contract`, `mcp/neurocenter-asset-sync/vendor/ollama-runtime` — file:-зависимости).

**Approach:** (1) 13 lockfile переписываются по трём корзинам: пары, присутствующие в `ppod-npm-trusted` и актуальные для linux-x64 — `resolved` → локальный registry (694 в исходном аудите; фактическое измерение на срезе — 824); пары, пропускимые npm на linux-x64 по os/cpu (бинарники других ОС, 103) — `resolved` НЕ трогать (npmjs, при install на linux-x64 не запрашивается); остальные актуальные пары (187 из `~/.npm/_cacache` + 40 недостающих везде = 227) — `resolved` → `file:` на `supply/vendor/<scope>/<base>-<version>.tgz` (npm-семантика file:-тарбола верифицирована empirically, см. Design Notes). (2) Тарболы из кэша извлекаются в `supply/vendor/` с обязательной sha512-сверкой с integrity lockfile ДО записи; недостающие 40 отчитываются ЯВНО (`supply/vendor-pending/` + fetch-скрипт для интернет-машины), статус pending — не фейл. (3) 9 `.npmrc` + 8 Dockerfile + host-скрипты — свита на локальный registry (auth-механика `NPM_REGISTRY_AUTH_B64` без изменений). (4) `supply/vendor/` git-tracked, входит в supply-манифест (хэши); pin-каскад producer-closure пересчитан.

## Boundaries & Constraints

**Always:**
- Нулевые изменения версий в lockfile — меняется только форма `resolved` (registry-URL / file:-путь); версии, `integrity`, `os`/`cpu`-поля не трогать.
- Единый registry поставки: `https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/`.
- Корзина «другие платформы» (103 пары с os/cpu, исключающими linux-x64) — `resolved` НЕ трогать (исходный npmjs-URL): при `npm ci` на linux-x64 эти tarball'ы не запрашиваются.
- Любой align-срез lockfile = обязательный re-pin: `node scripts/assets/catalog-source-pin.mjs --write` (каскад producer.json → manifest.json → bundled-catalog.lock.json одним вызовом).
- Каждый вендоримый tarball сверяется: sha512 тарбола == integrity в lockfile ДО записи в `supply/vendor/` (не совпало → стоп + список, пакет в vendor не попадает).
- Pending-набор (40) отчитывается ЯВНО: `vendor.mjs --check` печатает полный список «N pending: ждём тарболы», manifest-статус `pending` — не молча, не фейлом.
- `npmjs.org` не является источником поставки: 9 `.npmrc`, 8 Dockerfile, `prepare-opencode.mjs`, `npm-build-environment.mjs` — только trusted; в lockfile npmjs-URL разрешены ТОЛЬКО корзина «другие платформы».
- Граница с entry 10 (TLS): этот план меняет ТОЛЬКО registry-значения (`registry=` в `.npmrc`, `NPM_CONFIG_REGISTRY`, `--registry=`) и добавляет auth (ARG + RUN + env/args). Строки `strict-ssl=false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `node-options=--import=...` (api-gateway `.npmrc`) и механизм `NEUROCENTER_NPM_STRICT_SSL` snapshot-verifier — НЕ трогаются.

**Never:**
- НИКАКОЙ публикации: ни `npm publish`, ни publish-скриптов, ни `--run`-режимов в кодовой базе. Publish-пути не существует.
- Не понижать версии под локальный registry.
- Не вендорить бинарники «других платформ» (103) — они не нужны linux-x64 install'у.
- Не изменять `catalog-source/components/fetch-mcp/source/pnpm-lock.yaml`.
- Не добавлять в Dockerfile ARG/COPY/ADD-строки, содержащие подстроки `.npmrc`/`npm_config_` (regex в `npm-build-isolation.test.mjs:324`) — имя `NPM_REGISTRY_AUTH_B64` выбрано с этим в расчёте.
- Не коммитить auth-токены в репозиторий (токен только через env/build-arg).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CLEAN_CHECKOUT_VENDORED | чистый checkout, 187+39 tarball'ов в `supply/vendor/`, `NPM_REGISTRY_AUTH_B64` задан, npmjs недоступен | `npm ci` в workspace'ах без pending-пар в closure завершается 0 (824 из registry + 187 via file:); версий в lockfile не изменилось | No error expected |
| CLEAN_CHECKOUT_PENDING | pending-тарболы ещё не принесены (40 отсутствуют в `supply/vendor/`) | `vendor.mjs --check` — явный отчёт «40 pending: ждём тарболы» + список; `npm ci` в workspace'ах, чья closure НЕ содержит pending-пар — 0; workspace'ы с pending-парами — `npm ci` падает ENOENT с путём к отсутствующему vendor-файлу (явная причина) | exit ≠ 0 только в workspace'ах с pending-парами; список — в отчёте --check |
| VENDOR_CORRUPTED | байты tarball'а в `supply/vendor/` отличаются от manifest | `vendor.mjs --check` → стоп со списком; `npm ci` (чистый кэш) → EINTEGRITY с integrity-ожидаемым/полученным | явная ошибка, файл в vendor не «прощается» |
| CACACHE_MISMATCH | извлечение из кэша: sha512 извлечённого тарбола ≠ integrity lockfile | `vendor.mjs --extract` останавливается с пер-пакет списком расхождений; расходящиеся пакеты в vendor не попадают | exit ≠ 0, список |
| AUTH_MISSING | `NPM_REGISTRY_AUTH_B64` не задан | `npm ci`/Docker-сборка падает 401 (fail-closed) с явной ошибкой про переменную | явное сообщение, никакого npmjs-fallback |
| REGISTRY_DRIFT | локальный registry лишился версии (re-sync) | офлайн-гард (закоммиченный snapshot) зелёный; drift ловится сборкой `npm ci` | E404 с (name,version) в логе |
| REBASE_ENTRY_10 | entry 10 правит TLS-строки в тех же ENV-блоках/RUN | rebase без конфликтов: строки entry 9 = registry-значения + ARG/RUN auth; строки entry 10 = TLS | — |

</frozen-after-approval>

## Code Map

Измеренный срез (source of truth — 13 lockfile; скрипт `scripts/supply/classify.mjs`, артефакт `scripts/supply/classification.json`):
- **1154** уникальных (name,version) пар (6880 `resolved`-URL + 4 file:-зависимости).
- **824** — в `ppod-npm-trusted` И актуальны для linux-x64 → `resolved` → trusted registry. (В исходном аудите «694» — срез 987 пар; актуальное измерение — 824.)
- **103** — пропускимые npm на linux-x64 по os/cpu (102 бинарника других ОС/arch + `fsevents` darwin) → `resolved` НЕ трогать. (Измерение оркестратора — 93; расхождение 10 закрыто осознанно: классификация по os/cpu-полям из самих lockfile-манифестов, а не по именам.)
- **187** — нет в registry, есть в `~/.npm/_cacache`, актуальны → vendor (file:). (СДЕЛАНО: извлечены.)
- **40** — нет нигде, актуальны → vendor (file:) + статус pending. (= 39 из списка оркестратора + `@opencode-ai/plugin@1.14.48` из `.opencode/package-lock.json` — живая неотвечаемая зависимость, проверено E404 в registry.)
- **ОБНОВЛЕНИЕ 2026-11-06 (оркестратор):** 39 из 40 уже скачаны С ЭТОЙ МАШИНЫ (`/home/region.cbr.ru/69starodubtsevae/projects/nc-wt/supply-39/`, flat-имена `<name с / на ->-<ver>.tgz`, sha512 сверены с lockfile) и приняты через `vendor.mjs --add`. Итог: **226 vendored / 1 pending** (`@opencode-ai/plugin@1.14.48`, closure только `.opencode`). `fetch-on-online-machine.sh` + `needed.json` (1 пара) — FALLBACK-артефакты.
- Pending-распределение по lockfile (до приноса): fetch-mcp/source=33, .opencode=5, api-gateway=1, catalog-service=1, oauth2-bridge=1; остальные (root, frontend, mcp, coverage, verifier, feature-flags, rag-sync, skills) — 0 pending. После приноса: pending = 1 (`.opencode`).

Цели правок (registry-значения — территория entry 9):
- 9 × `.npmrc` — строка 1 `registry=` → trusted (СДЕЛАНО: свита выполнена, `install-links=true` и TLS-строки не тронуты)
- 8 × Dockerfile — ENV `NPM_CONFIG_REGISTRY` + `--registry=` → trusted + `ARG NPM_REGISTRY_AUTH_B64` + RUN-запись globalconfig (СДЕЛАНО); НОВОЕ: добавить `COPY supply/vendor` в build-контекст каждого Dockerfile, где `npm ci` использует lockfile с file:-зависимостями (проверить `.dockerignore` — `supply/vendor` не игнорируется)
- 13 `package-lock.json` — bucket-aware переписка `resolved`: 824 → trusted URL; 227 → `file:<rel>/supply/vendor/<scope>/<base>-<version>.tgz` (rel — от каталога lockfile до корня); 103 → исходный npmjs URL (восстановление из git-HEAD, без реконструкции); integrity при этом: registry-корзина — без изменений; vendor-корзина — без изменений (npm пишет для file:-тарбола ровно sha512 самого тарбола — проверено); platform-корзина — без изменений
- `supply/vendor/` — НОВОЕ git-tracked дерево: 227 .tgz (187 извлечены из кэша + 40 после приноса) + `manifest.json` (name, version, path, sha512, status vendored|pending)
- `supply/vendor-pending/` — НОВОЕ: `needed.json` (40 пар: name, version, исходный npmjs tarball URL, ожидаемый sha512) + `fetch-on-online-machine.sh` (bash+curl+sha512sum/shasum; самодостаточен для интернет-машины)
- `scripts/supply/vendor.mjs` — НОВОЕ CLI: `--extract` (cacache → supply/vendor, sha512-сверка до записи), `--add <dir>` (принесённые тарболы: сверка с needed.json, запись, статус→vendored), `--check` (гард: весь supply-набор на месте и верифицирован; pending — ЯВНЫЙ отчёт), `--snapshot` (read-only регенерация registry-availability.json)
- `scripts/supply/align-locks.mjs` — bucket-aware переписчик 13 lockfile (заменяет равномерный host-rewrite) + pin-каскад
- `scripts/supply/registry.mjs` — helpers БЕЗ publish-кода (publishTarball удалён): константы, LOCKFILES/NPMRC_FILES/DOCKERFILES, scanLockfilePairs, cacacheRead, sriDigest
- `scripts/supply/provision.mjs` — УДАЛЯЕТСЯ (publish-пути не существует)
- `scripts/workspace/npm-build-environment.mjs`, `dev-snapshots.mjs`, `prepare-opencode.mjs`, `compose.production.yml` — registry-свита + auth (СДЕЛАНО, без изменений по новой схеме)
- `scripts/prepare-bridge-runtimes.mjs` — «минимальный открытый контекст» Docker-сборки linux-x64: добавить vendor-тарболы, нужные closure lockfile `mcp/neurocenter-asset-sync` (75 пар)
- `scripts/test/npm-supply-lockfile.test.mjs` — офлайн-гард (ПЕРЕПИСАТЬ под новую схему): каждое `resolved` — ровно одна из трёх допустимых форм (trusted URL + пара в snapshot; file: supply/vendor + manifest-запись со sha512; npmjs URL + пара в platform-корзине); 0 npmjs в 9 `.npmrc` + 8 Dockerfile; точный trusted URL в registry-строках
- `scripts/supply/registry-availability.json` — закоммиченный snapshot (824 пары, source=registry) — офлайн-источник гарда
- `scripts/supply/classification.json` — артефакт classify (824/103/187/40) — вход для align и отчётов

Существующие ассерты, подлежащие перевороту (СДЕЛАНО + доп. находки):
- `scripts/test/npm-build-isolation.test.mjs`, `bundled-catalog.test.mjs`, `dev-snapshots-build.test.mjs` (план-список) + `bridge-runtime-sdk`, `workspace-check`, `gateway-tls`, `compose-install-integration`, `dev-cli` — перевёрнуты на trusted; + все fixture-списки копирования дополнены `supply/registry.mjs` (зависимость `npm-build-environment.mjs`)
- `scripts/test/prepare-bridge-runtimes.test.mjs` — `contextScripts` + production-контекст: + vendor-тарболы mcp-closure

Проверенные факты окружения:
- npm 11.19.1 / node 24.22.0, чистый кэш (= docker-условие): file:-тарбол — `npm install` пишет `resolved: "file:<rel>"` + `integrity: sha512-<тарбола>`; `npm ci` с чистым кэшем ПРОВЕРЯЕТ integrity file:-тарбола (коррупция → EINTEGRITY, exit 1) и ТРЕБУЕТ наличия файла (отсутствие → ENOENT, exit 254, с путём); `npm ci --dry-run` НЕ проверяет file:-тарболы (стат/интегрита не трогает) — dry-run НЕ является адекватным offline-эквивалентом для vendor-файлов, подменяется `vendor.mjs --check`
- sha512 кэшированного тарбола == integrity lockfile (проверено `@esbuild/linux-x64@0.28.2`: совпадение) — byte-copy из кэша верифицируется существующими integrity-значениями
- tarball-путь в trusted: `<name>/-/<base>-<version>.tgz` (scoped: `@scope/name/-/base-version.tgz`)
- npm запрещает double-loading одного файла как user+global config (два разных пустых файла)

Не трогать: TLS-строки entry 10 (см. Always); `install-links=true`; pnpm-lock.yaml; лимиты pin-скрипта; `check-tooling-tests.json`; 4 file:-зависимости (`vendor/asset-contract` ×3, `file:vendor/ollama-runtime`).

## Tasks & Acceptance

**Execution:**
- [x] registry-свита: 9 × `.npmrc`, 8 × Dockerfile (+auth ARG/RUN), `npm-build-environment.mjs` (+auth globalconfig), `dev-snapshots.mjs` (+add-host trusted, pass-through build-arg), `prepare-opencode.mjs` (+shasum fallback), `compose.production.yml` (8 build.args)
- [x] переворот ассертов (план-список + 5 доп. файлов) + fixture-списки + `supply/registry.mjs` в зависимости
- [x] `scripts/supply/classify.mjs` — bucket-классификация 1154 пар из lockfile (source of truth)
- [x] scratch-верификация npm file:-семантики (lockfile-форма, EINTEGRITY, ENOENT, dry-run-ограничение)
- [x] `scripts/supply/vendor.mjs` — `--extract` / `--add` (flat- + fetch-script-расклады) / `--check` / `--snapshot` / `--rebuild-pending` (без publish; supplySet читает post-align `file:`-формы)
- [x] `--extract`: 187 tarball'ов cacache → `supply/vendor/` (sha512-сверка до записи, 0 mismatches)
- [x] `supply/vendor/manifest.json` — 227 записей (name, version, path, sha512, status); 226 vendored / 1 pending
- [x] `supply/vendor-pending/needed.json` + `fetch-on-online-machine.sh` — FALLBACK (39 уже получены с этой машины 2026-11-06; актуально 1 пара)
- [x] `--add` supply-39: 39 принято (digest-сверка с lockfile integrity), 0 ошибок; 1 pending явный
- [x] `scripts/supply/align-locks.mjs` v2 — bucket-aware: 824 → trusted; 227 → file:; 103 → npmjs (из git-HEAD) → `catalog-source-pin.mjs --write` (выполнен; git diff = только `"resolved":` строки, 6460/6460)
- [x] удаление `scripts/supply/provision.mjs` + publish-кода из `registry.mjs`
- [x] Dockerfile: `COPY supply/vendor` (9 вставок: rag-sync ×2) + `.dockerignore`-проверка (тест в гарде)
- [x] `prepare-bridge-runtimes.mjs` + `package-bridge-runtime.mjs` — vendor-тарболы mcp-closure (75 пар) в минимальный контекст/stage (общий helper `lockfileVendorTarballs`)
- [x] `scripts/test/npm-supply-lockfile.test.mjs` — переписан под новую схему (3 допустимые формы resolved + manifest-инварианты + Dockerfile COPY)
- [x] unit-тесты `vendor.mjs` — `scripts/test/supply-vendor.test.mjs` (8 тестов: expectedDigests-регрессия, flatName, --add flat/fetch-script/mismatch/unknown, --check реальное + failure-путь)
- [ ] offline-проверка: `npm ci` (реальный, Node 24) в workspace'ах без pending-пар (rag-sync-service — closure с lancedb, 0 pending) + `vendor.mjs --check`

**Acceptance Criteria:**
- Given чистый checkout, when `vendor.mjs --check`, then 226 vendored верифицированы (sha512 == manifest == lockfile integrity), 1 pending (`@opencode-ai/plugin@1.14.48`) — явный отчёт со списком
- Given align v2 выполнен, when офлайн-гард `node --test scripts/test/npm-supply-lockfile.test.mjs`, then каждое resolved в допустимой форме, 0 npmjs вне platform-корзины, 0 npmjs в .npmrc/Dockerfile
- Given align v2 выполнен, when `node scripts/assets/catalog-source-pin.mjs --check`, then пина согласованы
- Given 226 vendored + workspace без pending-пар, when `npm ci` (Node 24, офлайн), then exit 0; версий в lockfile не изменилось
- Given pending-тарболы отсутствуют, when `npm ci` в workspace'е с pending-парами, then ENOENT с путём к vendor-файлу + полный список в отчёте `vendor.mjs --check` (явное ожидание, не «фейл без объяснения»); полная docker-сборка такого workspace'а (`.opencode`) возможна после приноса 1 пары (не блок закрытия 1.9)

## Implementation Notes

- 2026-11-06 (оркестратор): 39 «с другой машины» уже скачаны с этой машины (npmjs достижим по IPv4, TLS валиден), каталог `nc-wt/supply-39/` (flat-имена `<name с / на ->-<ver>.tgz`), VERIFY.txt с sha512. `vendor.mjs --add` дополнен flat-раскладом (в дополнение к fetch-script-раскладу); 39 приняты с digest-сверкой. `fetch-on-online-machine.sh` + `needed.json` — FALLBACK-артефакты (актуальный набор — 1 пара).
- Найден и исправлен баг генерации `needed.json`: поле `expected[].hex` было `sha512(digest-байтов SRI)` вместо hex-репрезентации digest'а (fetch-скрипт и `--add` бы не приняли ни один принесённый тарбол). Исправлено в `expectedDigests()` + добавлен `--rebuild-pending`.
- Найден и исправлен баг `vendor.mjs --check` после align: `supplySet()` сканировал только `https://` resolved, post-align supply-пары — `file:`; supplySet теперь читает обе формы (file: в supply/vendor — авторитетная post-align форма, https — bootstrap/pre-align).
- `vendor.mjs` импортируем (guarded CLI-dispatch) + экспорт `expectedDigests`/`flatName`/`npmjsTarballUrl`; тест-хук `NC_SUPPLY_ROOT` для песочницы unit-тестов.
- Ожидание оркестратора «226/226, pending=0» расходится с измерением: supply-набор = 227 (39 из их списка + `@opencode-ai/plugin@1.14.48`, которого в supply-39 нет). Итог 226 vendored / 1 pending — отчитан явно.

## Plan Change Log
- 2026-11-06: ПЕРЕКОНСПЕКЦИЯ по решению человека — publish-схема заменена vendor-схемой. Измеренный срез: 1154 пар = 824 registry + 103 platform + 187 vendored + 40 pending. Publish-код из кодовой базы исключён. npm file:-семантика верифицирована empirically (npm 11.19.1, чистый кэш).
- 2026-11-06 (вечер): 39 pending получены с этой машины (supply-39), приняты через `--add`; pending 40→1 (`@opencode-ai/plugin@1.14.48`). Выявлены и исправлены два бага (hex в needed.json, supplySet post-align). Unit-тесты vendor.mjs (8). Реальный `npm ci --offline` (Node 24): rag-sync-service exit 0 (507 пакетов); mcp/neurocenter-asset-sync (lancedb-closure) — в выполнении.

## Review Triage Log

## Design Notes

**Vendor-формат: .tgz (не распакованные каталоги).** Критерии — компактность в git, проверяемость, совместимость с file:-семантикой npm:
1. Проверяемость: integrity в lockfile — это sha512 именно ТАРБОЛА. Byte-copy из cacache верифицируется существующими integrity-значениями без пересчёта (проверено совпадение). Распакованный каталог не имеет «свого» хэша: npm пересоберёт tarball при pack, байты пересборки зависят от npm/платформы → проверяемость деградирует.
2. Совместимость: `file:<путь>.tgz` — нативная npm-форма (npm сам пишет `resolved: "file:..."` + `integrity` для таких зависимостей — проверено); установка идентична registry-пакету (npm unpacks tarball).
3. Компактность: тарболы уже сжаты (187 ≈ 182 МБ); распаковка даёт 2–5× больший git-размер.

**npm file:-семантика (проверено, npm 11.19.1 / node 24.22.0, ЧИСТЫЙ кэш = docker-условие):**
- `npm install` с `dependencies: {name: "file:../x.tgz"}` → lockfile: `resolved: "file:<rel>"`, `integrity: "sha512-<тарбола>"`, `name`-поле записывается.
- `npm ci` (чистый кэш): целый тарбол — OK; закорюченный — **EINTEGRITY** (exit 1, wanted/got в ошибке); отсутствующий — **ENOENT** (exit 254, с абсолютным путём). Т.е. integrity и наличие ПРОВЕРЯЮТСЯ реальным ci.
- `npm ci --dry-run`: file:-тарболы НЕ проверяет и не статы — dry-run НЕ адекватный offline-эквивалент для vendor; подменяется `vendor.mjs --check`.
- Кэш-маскировка: при непустом кэшем `npm ci` может «успеть» с отсутствующим файлом (берёт по integrity из кэша) — в docker-сборке кэш чистый, маскировки нет.

**Pending (40).** Тарболы приносит пользователь с интернет-машины через `fetch-on-online-machine.sh` (curl + sha512-проверка, самодостаточный bash). `vendor.mjs --add <dir>` сверяет принесённые по needed.json и переводит в vendored. До приноса: manifest-статус `pending`, lockfile уже указывают на file:-пути (единая финальная форма); workspace'ы с pending-парами в closure (fetch-mcp/source, .opencode, api-gateway, catalog-service, oauth2-bridge) не строятся до приноса — ЯВНО документировано; workspace'ы без pending (root, frontend, mcp, coverage, verifier, feature-flags, rag-sync, skills) строятся полностью.

**Auth-механика** (без изменений от исходной схемы). `NPM_REGISTRY_AUTH_B64` = base64 двух npmrc-строк trusted host; Docker: `ARG` + RUN-запись в `/tmp/neurocenter-empty-global.npmrc`; host: temporary globalconfig в `withNpmBuildEnvironment` (fail-closed на malformed base64).

**Гард.** `scripts/supply/registry-availability.json` (824 пары, source=registry) — офлайн-доказательство registry-покрытия; `classification.json` — вход для align; `vendor.mjs --check` — верификация vendor-дерева + явный pending-отчёт; `npm-supply-lockfile.test.mjs` — форма resolved в lockfile. Разделение: гард ловит дрейф РЕПОЗИТОРИЯ, сборка `npm ci` ловит дрейф REGISTRY (E404).

**Host-ные node_modules на этой машине ЛАГАЮТ lockfile** (наблюдено: cssstyle и др. не в lockfile-версиях) — host-верификация только через vendor.mjs/офлайн-тесты инструмента + реальный `npm ci` в чистых каталогах (workspace'ы без pending-пар), не через «полные тесты на host-ных node_modules».

## Verification

**Commands:**
- `node scripts/supply/vendor.mjs --extract` -- expected: 187 tarball'ов в `supply/vendor/`, 0 integrity-расхождений (иначе стоп + список) — ВЫПОЛНЕНО (187, 0 mismatches)
- `node scripts/supply/vendor.mjs --check` -- expected: 227 supply-пар; 226 vendored OK; «1 pending: ждём тарболы» (`@opencode-ai/plugin@1.14.48`) — ВЫПОЛНЕНО, exit 0
- `node scripts/supply/vendor.mjs --add <dir>` — flat-расклад (39 из supply-39) принят, digest-сверка с lockfile integrity — ВЫПОЛНЕНО (39, 0 ошибок)
- `node scripts/supply/align-locks.mjs` -- expected: 824 → trusted / 227 → file: / 103 → npmjs(из git-HEAD) / 0 версионных изменений; pin-каскад перезаписан — ВЫПОЛНЕНО (git diff: только `"resolved":` строки, 6460/6460)
- `node scripts/assets/catalog-source-pin.mjs --check` -- expected: OK — ВЫПОЛНЕНО
- `node --test scripts/test/npm-supply-lockfile.test.mjs scripts/test/npm-build-isolation.test.mjs scripts/test/bundled-catalog.test.mjs scripts/test/prepare-bridge-runtimes.test.mjs scripts/test/supply-vendor.test.mjs` -- expected: 0 fail — ВЫПОЛНЕНО (55 тестов: 54 pass / 1 skip / 0 fail)
- `npm ci --offline` (Node 24, чистые scratch-каталоги, supply/ симлинком) в rag-sync-service — exit 0 (507 пакетов); в mcp/neurocenter-asset-sync (closure с lancedb, 0 pending) — в выполнении
- РЕЗЕРВ (если нужен реальный registry-проход с auth, а не cache-offline): `npm ci` (Node 24, `NPM_REGISTRY_AUTH_B64` в env) — секрет отсутствует на этой машине (не в .env/.env.local/профилях), запрашивается у оркестратора
- `docker build -f services/rag-sync-service/Dockerfile --build-arg NPM_REGISTRY_AUTH_B64=<b64> -t probe-registry .` [HITL] -- expected: образ собран, поставка = trusted registry + file: vendor (зависит от секрета)
- `node scripts/workspace/check.mjs` (полный план, с `NPM_REGISTRY_AUTH_B64` в env) -- expected: без деградации относительно доизменения прогона (0 новых fail) [HITL: требует секрет]
