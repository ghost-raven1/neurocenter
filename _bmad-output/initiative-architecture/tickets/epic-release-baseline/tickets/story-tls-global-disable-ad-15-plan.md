---
title: 'TLS: глобальное отключение запрещено (AD-15, AD-OP-7)'
type: 'bugfix'
ticket: '10'
created: '2026-11-06'
status: 'done'
baseline_revision: '90b92af3f5bf47c8a5e320a115f33463d8c0d56a'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md'
  - '_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md'
  - 'docs/docker-build-ca.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Глобальное отключение TLS-верификации захардкожено разрозненными значениями в 8 Dockerfile'ах, 2 compose, 9 .npmrc, host-скриптах и main.ts gateway — MITM на backend-сети возможен (H2), защиту держит только lockfile integrity; нет единой точки управления политикой.

**Approach:** (human-owned директива) Один флаг `tls.disableTlsVerification` в общем конфиге проекта `neurocenter.config.json` (root, git-данные): все локации отключения TLS ВЫВОДЯТСЯ из него, независимых захардкоженных значений нет. Production — fail-closed: флаг dev-only, production-путь не применяет его (strict-сборка), validateProduction отказывает старт с отключением, drift-тест запрещает ключ в production-модели (матрица AD-OP-5). Dev/закрытый контур: флаг on — текущее поведение корпоративной MITM-сети сохранено.

## Boundaries & Constraints

**Always:**
- Единственный источник политики TLS = `neurocenter.config.json` (root, git) + local-override `neurocenter.config.local.json` (gitignored, паттерн `.env.local`); чтение только через единый модуль `scripts/workspace/project-config.mjs` (strict-схема: неизвестные ключи = фэйл).
- Каждая локация (Dockerfile ARG→ENV, compose build-args + env, host-скрипты, .npmrc CLI-флаги) получает значения только выводом из флага (производные: `NEUROCENTER_TLS_DISABLE` 0/1, `NEUROCENTER_NPM_STRICT_SSL` true/false).
- Production fail-closed в трёх слоях: (1) production-сборка (setup.mjs) форсирует `NEUROCENTER_TLS_DISABLE=0`, ARG-дефолты в Dockerfile = strict; (2) validateProduction отказывает старт любого сервиса с `NODE_TLS_REJECT_UNAUTHORIZED=0` (исключение api-gateway убрано); (3) production-конфиг/модель не содержит ключ (AD-OP-5: dev-only обход).
- Доверие CA — существующий механизм (docker/build-ca/ + sha256 → NODE_EXTRA_CA_CERTS); snapshot-verifier остаётся strict-по-умолчанию.
- Новые тесты: `scripts/workspace/check-tooling-tests.json` + expectedFiles `scripts/test/workspace-check-tooling.test.mjs`.

**Never:**
- Независимые захардкоженные значения TLS-off вне вывода из флага (literals `NODE_TLS_REJECT_UNAUTHORIZED=0`, `strict-ssl=false`, `rejectUnauthorized: false`, preload) — в production-путях и compose.
- Применение флага production-путём: production-образ/рантайм с отключённой верификацией; «доверять всем адресам» (scoped allowlist — только задокументированный residual).
- Территория entry 1.9: registry-строки, lockfile, pin-каскад — 1.10 меняет только TLS-строки.
- snapshot-verifier.Dockerfile (своя параметризованная механика, strict-дефолт), plain-HTTP internal-каналы (residual AD-OP-7(5)), edge-сертификат (AD-OP-7(3)).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| FLAG_OFF | флаг false | ни одна локация не содержит отключения: образы strict, исходящие вызовы верифицируются | No error expected |
| FLAG_ON_DEV | флаг true (закоммиченный дефолт) | dev-сборки/инсталлы работают как раньше (MITM-контур) | No error expected |
| PRODUCTION_BUILD | setup.mjs build, флаг true в конфиге | образ strict (`NEUROCENTER_TLS_DISABLE=0`) | No error expected |
| PRODUCTION_FLAG_ON | production-старт, env TLS0 | старт отклонён (validateProduction, любой сервис) | actionable-ошибка |
| OUTBOUND_BAD_CERT | флаг off, self-signed upstream | connect reject; с NODE_EXTRA_CA_CERTS — ok | cert-error в логах |
| BUILD_STRICT_NO_CA | флаг off, MITM-прокси, CA не staged | фэйл сборки | actionable cert-error; со staged CA — проход |

</frozen-after-approval>

## Code Map

- `neurocenter.config.json` (НОВЫЙ, root) — `{"tls": {"disableTlsVerification": true}}`; `neurocenter.config.local.json` — local-override (gitignore)
- `scripts/workspace/project-config.mjs` (НОВЫЙ) — единый ридер: strict-схема, merge local-override, производные значения
- Build-env staging (вывод флага в Docker-сборки): `scripts/workspace/docker-build-ca.mjs:152-194` (withDockerBuildCa — добавляет `NEUROCENTER_TLS_DISABLE`/`NEUROCENTER_NPM_STRICT_SSL` в build-env); вызовщики: `scripts/docker-build.mjs` (dev), `scripts/production/setup.mjs:112-116` (production — форсирует 0), `scripts/workspace/dev-snapshots.mjs`
- Dockerfile'ы (8) — замена захардкоженных строк на `ARG NEUROCENTER_TLS_DISABLE=0` + `ARG NEUROCENTER_NPM_STRICT_SSL=true` → `ENV NODE_TLS_REJECT_UNAUTHORIZED/NPM_CONFIG_STRICT_SSL`: api-gateway 14,20,25,40,41; catalog 19,23-33,39,45,46 (apt Verify-Peer/Verify-Host=false, curl --insecure — строгие, CA в системные корни до apt); feature-flags 19,23,26; oauth2-bridge 19,23,26,27; rag-sync 21,32,36,37,42,45,46; skills 19,23,26,27; frontend 19,22,25
- Compose: `compose.production.yml:281` — строку удалить + build-args всех 8 сервисов: `NEUROCENTER_TLS_DISABLE: ${NEUROCENTER_TLS_DISABLE:-0}`; `docker-compose.yml:82` — вывод из env + те же build-args (паттерн строк 75-78)
- Runtime: `services/api-gateway/src/main.ts:1-2` — удалить (значение только из env); `services/shared/runtime.cjs:108` — убрать api-gateway-исключение; `services/catalog-service/src/package-build/npm-source-transport.ts:10` — убрать rejectUnauthorized:false
- Host-скрипты (вывод из флага): `scripts/workspace/npm-build-environment.mjs:8,34-36,40`, `scripts/workspace/check.mjs:114`, `scripts/workspace/isolated-build.mjs:154`, `scripts/workspace/dev-watch-runtime.mjs:27` (захардкоженный `?? '0'` → `?? '1'` strict-по-умолчанию; реальное dev-значение приходит из `process.env`, который dev.mjs:701 заполняет выводом из флага), `scripts/prepare-opencode.mjs:9`, `scripts/catalog-plugins/recipes/upstream.mjs:176`; dev CLI (dev.mjs) экспортирует `NEUROCENTER_TLS_DISABLE` в build/up env
- Зависимое closure (найдено верификацией): `scripts/workspace/project-config.mjs` добавлен в (a) staging-list `scripts/prepare-bridge-runtimes.mjs` (офлайн bridge-runtime), (b) `PREPARED_SOURCE_INPUTS` в `scripts/catalog-plugins/prepared-source-snapshot.mjs` + re-pin `node scripts/assets/catalog-source-pin.mjs --write` (обновились `catalog-source/producer.json`, `catalog-source/manifest.json`, `services/shared/bundled-catalog.lock.json`), (c) `COPY ... /tools/...` в `services/catalog-service/Dockerfile` (публичный /tools-producer), (d) fixture-copy-списки тестов: workspace-check-report, production-setup, prepare-opencode, dev-watch-daemon(.fixture) + 12 прежних
- 9× `.npmrc` (root, mcp/neurocenter-asset-sync, frontend, 6 services) — удалить `strict-ssl=false` (и `node-options`-preload в gateway-файле); npm-запуски всегда передают `--strict-ssl=<derived>` CLI-флагом (перекрывает .npmrc); `registry=`-строки не трогать
- Тесты: новый `scripts/test/tls-global-disable.test.mjs`; переписать `scripts/test/gateway-tls.test.mjs`; обновить `scripts/test/docker-build-ca.test.mjs:327-328`, `scripts/test/npm-build-isolation.test.mjs:192-206,320`, `scripts/test/dev-cli.test.mjs:814,843`, `scripts/test/bridge-runtime-sdk.test.mjs:95`, `scripts/catalog-plugins/recipes/tests/recipes.test.mjs:60`, `scripts/test/workspace-check.test.mjs:326`; сверить verifier/fixture: `scripts/test/dev-snapshots-build.test.mjs:557`, `scripts/test/compose-install-integration.test.mjs:209`, `scripts/test/frontend-build-context.test.mjs:56`
- Доки: `docs/docker-build-ca.md:7,34`, `docs/assets.md:108`; `.gitignore` (+`neurocenter.config.local.json`)

## Tasks & Acceptance

**Execution:**
- [ ] `neurocenter.config.json` + `scripts/workspace/project-config.mjs` — флаг, strict-схема, local-override, производные значения; `.gitignore`
- [ ] `scripts/workspace/docker-build-ca.mjs` — сстейджить производные в build-env; `scripts/docker-build.mjs` — дефолтный вывод; `scripts/production/setup.mjs` — форс 0; `scripts/workspace/dev-snapshots.mjs`, dev.mjs (up/build env)
- [ ] 8 Dockerfile'ов — ARG→ENV, убрать inline TLS0/`--strict-ssl=false` из RUN; catalog: строгие apt/curl (CA до первого apt-доступа; проверить `update-ca-certificates` в базовом образе)
- [ ] Compose ×2 — build-args (дефолт 0) + dev-env строка; production-строку 281 удалить
- [ ] Runtime: main.ts, runtime.cjs (исключение), npm-source-transport.ts
- [ ] Host-скрипты (6 файлов) — значения из project-config; 9× .npmrc — чистые
- [ ] Новый `scripts/test/tls-global-disable.test.mjs` + регистрация (check-tooling-tests.json, expectedFiles); обновить 7 старых тестов; доки

**Acceptance Criteria:**
- Given флаг off, when сканирование всех локаций (Dockerfile, compose, .npmrc, host-скрипты, main.ts), then ни одна не содержит независимого отключения — только вывод из флага (статический тест).
- Given флаг on (dev, закоммиченный дефолт), when dev-сборка/инсталл (withNpmBuildEnvironment, docker build, npm ci), then поведение как раньше: TLS-off присутствует в build-окружении, MITM-контур работает (тест).
- Given production-старт, when env/флаг on (`NODE_TLS_REJECT_UNAUTHORIZED=0`), then старт отклонён для любого сервиса, включая api-gateway (тест validateProduction).
- Given production-сборка (setup.mjs build) при флаге on в конфиге, then образ strict: build-arg `NEUROCENTER_TLS_DISABLE=0` (тест).
- Given flag off, when исходящий вызов gateway на сервер с невалидным сертификатом, then reject; с NODE_EXTRA_CA_CERTS с CA сервера, then вызов проходит (тест).

## Implementation Notes

## Plan Change Log

- 2026-11-06 (human-owned директива, приоритетнее AD-деталей): политика TLS — один флаг `tls.disableTlsVerification` в `neurocenter.config.json`, все локации выводятся из него; production fail-closed (3 слоя). Переработаны Intent/Boundaries/Matrix/Code Map/Tasks/AC; AMEND: removed independent hardcoded TLS-off literals, KEEP: CA-механика docker/build-ca, strict-дефолт verifier, Never-правила (1.9, «доверять всем адресам»).
- 2026-11-06 (верификация, status→done): #1 4 тест-файла 36/0/2; #2 grep exit 1 (0 совпадений); #3 config `true`; #4 корневой сьют 43/44 — шаги 1–40 и 42–44 зелёные (shared-шаг: 3701 тест, 3663 pass / 0 fail / 38 gated skips; compose dev+embeddings valid). Шаг 41 (mcp test) красный = environmental: идентичный провал на не-изменённом main-репо (e877f4cd, та же машина, тот же шаг: 18 fail в тех же семействах — agent-method-selected-agent, opencode-provider-*, project-snapshot-http, runtime-configuration); worktree-запуски 22/42/52/15 fail масштабируются с load (Kaspersky ~2 ядра + параллельные сьюты других сессий); standalone-субнаборы 96/96, 9/9, 14/14, 13/13 зелёные при низком load; полный mcp-сьют SEQUENTIAL: 1887/1911 pass, 4 flake (2 файла, все timeout/ENOENT при load 16–20). Регрессии изменений нет.

## Review Triage Log

## Design Notes

Файл: `neurocenter.config.json` (root, git-данные) — не `package.json` (semver/tooling-семантика), не `.env` (флаг — данные политики, а не env-артефакт окружения; dev-матрица AD-OP-5: production `.env` не получает dev-обходы). Дефолт `true` закоммичен: dev/закрытый контур — основной режим проекта (MITM-прокси), ноль изменений UX; production-путь не применяет флаг (setup.mjs форсирует 0; прямой `docker compose build` без обёртки → ARG-дефолт 0 = strict). Local-override `neurocenter.config.local.json` — для dev-машин без MITM (хотят strict). Имя флага осмысленно и в стиле `NEUROCENTER_*`: производные `NEUROCENTER_TLS_DISABLE` (0/1, совпадает с семантикой NODE_TLS_REJECT_UNAUTHORIZED) и `NEUROCENTER_NPM_STRICT_SSL` (!flag, npm-булево) — оба выводятся ридером, не пишутся вручную. Production-запрет enforced слоями: build (форс 0 + ARG-дефолт strict) → runtime (validateProduction, исключение gateway убрано) → drift (production-модель запрещает ключ — стык entry 1.2).

## Verification

**Commands:**
- `~/.nvm/versions/node/v24.22.0/bin/node --test --test-concurrency=1 scripts/test/tls-global-disable.test.mjs scripts/test/gateway-tls.test.mjs scripts/test/docker-build-ca.test.mjs scripts/test/npm-build-isolation.test.mjs` — expected: все зелёные
- `grep -rn 'NODE_TLS_REJECT_UNAUTHORIZED=0\|strict-ssl=false\|rejectUnauthorized: *false' services/*/Dockerfile frontend/Dockerfile compose.production.yml docker-compose.yml .npmrc mcp/neurocenter-asset-sync/.npmrc frontend/.npmrc services/*/.npmrc services/api-gateway/src/main.ts` — expected: нет совпадений (только вывод из флага)
- `jq '.tls.disableTlsVerification' neurocenter.config.json` — expected: `true` (dev-дефолт)
- Корневой сьют (конвенция AD: `node scripts/workspace/check.mjs`) — без деградации против эталона (287 файлов, 3693 pass / 0 fail)
