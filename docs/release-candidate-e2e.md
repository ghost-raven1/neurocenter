# Приёмка замороженного кандидата (REL-01)

`scripts/test/release-candidate-e2e.test.mjs` — e2e-драйвер приёмки кандидата на релиз по шагам F1–F6. Драйвер не создаёт тег и не публикует supply-артефакты; он только сверяет, собирает, развёртывает в замкнутом контуре и записывает evidence. Операторские шаги H1–H5 ниже; live-запуски F2–F5 выполняет драйвер, человек запускает его один раз и читает отчёт.

Результат — файл `$NEUROCENTER_TEST_EVIDENCE/release-candidate-e2e.json` (0600 в 0700-каталоге, по умолчанию `.run/release-candidate-e2e/`): формат `neurocenter-release-candidate-e2e-v1`, шаги F1–F6, все проверки, load-история, digest'ы и итог `GO`/`NO-GO`. `GO` — кандидат принят и может быть заморожен на релиз; `NO-GO` — причина в последней ошибке и в незавершённом шаге отчёта.

## Требования

- Docker Engine + Compose v2 (profiles, secrets, `up --wait`); на хосте уже есть образы, используемые production-стеком: `pgvector/pgvector:pg16@sha256:ad2e184…`, `ollama/ollama:0.35.1@sha256:292ee7…`, `node:24.22.0-bookworm-slim`. Сборки не выходят в сеть: только локальный registry.
- Node 24 (`export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH`), git, openssl.
- Checkout кандидата (этот worktree) на коммите кандидата, чистое дерево; корневые зависимости установлены (`npm ci --ignore-scripts`).
- Supply-архивы: `npm run bridge:prepare` — в `bridge-dist/runtime` и `bridge-dist/opencode` должны быть `.tgz` (драйвер проверяет и останавливается с указанием этой команды). Архивы не в git: клон-сборки получают их копией из checkout драйвера.
- Load-менеджмент обязателен: каждый тяжёлый шаг (две сборки, подъём стека) стартует только при `load1 < 8`, иначе драйвер ждёт порциями по 15 с; все сэмплы — в `loadHistory` отчёта. Сборки не параллельны (прецедент 2026-11-06). Не запускайте приёмку параллельно с обновлением production-стека на этом хосте.

## H1. Кандидат и тег

Коммит кандидата — HEAD текущего worktree на `main`. Тег создаёт оператор, не драйвер:

```sh
git tag -a <tag> -m 'Кандидат на релиз: <commit-short>'
```

Тег обязан быть annotated: lightweight-тег F1 отклоняет (`git cat-file -t` должен дать `tag`).

## H2. Кандидат-конфиг (fixture-SSO)

Драйвер прогоняет полный SSO-поток и мостовые маршруты через тестовый IdP `blitz-fixture` (Compose-сервис на `node:24.22.0-bookworm-slim`, alias `blitz.test`, порт `127.0.0.1:19444`). Поэтому кандидат-конфиг — фиксированные fixture-значения, которые сверяет `verifyProductionBridge` и `blitz-provider.fixture.cjs`:

| Поле              | Значение             | Причина                                                              |
| ----------------- | -------------------- | -------------------------------------------------------------------- |
| `panelUrl`        | `https://panel.test` | `verifyProductionBridge` и install.sh зашиты на `https://panel.test` |
| `ssoHost`         | `https://blitz.test` | alias blitz-fixture в backend-сети                                   |
| `ssoClientId`     | `fixture-client`     | сверяется blitz-fixture                                              |
| `ssoClientSecret` | `fixture-only`       | Basic-авторизация токенового exchange                                |
| `adminEmail`      | `admin@example.test` | `/blitz/oauth/me` отдаёт именно эту почту                            |
| `release`         | `<tag>`              | метка кандидата                                                      |

Сертификат — самоподписанный, обязателен SAN `DNS:panel.test,DNS:blitz.test,IP:127.0.0.1` (драйвер проверяет openssl'ем):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 1 \
  -subj '/CN=panel.test' -addext 'subjectAltName=DNS:panel.test,DNS:blitz.test,IP:127.0.0.1'
```

Конфиг и сборка кандидата — штатный production-путь из корня checkout:

```sh
node scripts/production/setup.mjs configure --json-stdin --directory <config> <<'JSON'
{"panelUrl":"https://panel.test","ssoHost":"https://blitz.test","ssoClientId":"fixture-client","ssoClientSecret":"fixture-only","adminEmail":"admin@example.test","adminName":"Приёмочный администратор","release":"<tag>","tlsCertFile":"<path>/tls.crt","tlsKeyFile":"<path>/tls.key"}
JSON
node scripts/production/setup.mjs build --directory <config>
```

`build` даёт манифест `<config>/releases/<tag>/release-manifest.json` — его и передаёт драйвер. Реальный корпоративный Blitz (epic-identity) приёмкой не покрывается: это отдельная интеграция.

## H3. Запуск драйвера

Из корня checkout кандидата:

```sh
export NEUROCENTER_CONFIG_DIR=<config>
node scripts/test/release-candidate-e2e.test.mjs \
  --candidate "$(git rev-parse <tag>)" \
  --tag <tag> \
  --manifest <config>/releases/<tag>/release-manifest.json \
  --host-variant B
```

- `NEUROCENTER_CONFIG_DIR` — единственный способ драйверу узнать конфиг кандидата; без него — явная ошибка с указателем на этот ранбук.
- `--host-variant B` — эта машина: драйвер встраивает в build-контейнеры `NODE_OPTIONS=--dns-result-order=ipv4first` (ipv4first-Dockerfile'ы в `bridge-dist/ipv4first/` клона, overlay только `dockerfile`, context/args не меняются). Вариант `A` — хост без IPv6-first-проблемы DNS: overlay не встраивается; такой хост на этой машине не проверялся, в отчёте variant A остаётся HITL-разметкой.
- `NEUROCENTER_TEST_EVIDENCE` — необязательный каталог evidence (по умолчанию `.run/release-candidate-e2e`, gitignored).

Драйвер работает только с чистого checkout (F1) и не трогает main-worktree. Конфиг-каталоги для F2 (×2) и F4 — свои копии оператора (`cp`, 0700) с переписанной `NEUROCENTER_CONFIG_DIR`; повторный запуск не ломается stale `schema-initialization.json`.

## H4. Что делает драйвер

1. **F1.** Тег annotated; `manifest.release` == тег; `manifest.commit` == `git rev-list -n1 <tag>`; HEAD == кандидат; кандидат == замороженный коммит манифеста; дерево чистое.
2. **F2.** Два последовательных чистых клона одного commit (`git clone --no-checkout` + `checkout --detach`, не worktree). Каждый: `assertCleanCheckout` → `withDockerBuildCa` со strict-TLS (как `setup.mjs build`) → `normalizeBuildContext` (SOURCE_DATE_EPOCH = timestamp commit) → `docker compose build` в своём Compose-проекте с `--project-directory` = клон (production `composeClient` хардкодит корень репозитория, поэтому драйвер держит тонкий clone-клиент) → capture фактов сразу после сборки (тег `neurocenter/<svc>:<tag>` общий, вторая сборка перезапишет его) → `buildReleaseManifest` → запись в `releases/<tag>/release-manifest.json` копии конфига → `verifyReleaseManifest` повторным capture.
3. **F3.** `compareManifestDigests`: 7 image ID + postgres по serviceName и `canonicalSha256` по каноническому JSON. Любое расхождение — NO-GO по имени сервиса. Дополнительно сверяется, что чистые сборки воспроизводят операторский кандидат-манифест.
4. **F4.** Pinned-деплой в замкнутом контуре: уникальный проект `nc-rel01-<uuid>`, overlay JSON ровно по паттерну `update.mjs` (7 app → свои digest'ы, `database-init`/`bootstrap-admin`/`capacity-collector` → digest `catalog-service`; postgres не пинится — base compose закреплён по digest'у и сверяется через `container.Image == manifest.postgresImage`), test-override: порты `127.0.0.1:19080:8080` / `127.0.0.1:19443:8443` (`!override`, иначе склейка с 80/443 встанет в production-стек) и blitz-fixture. Все `up`/`run` — `--no-build --pull never`. Последовательность под `maintenanceLock`: postgres → `database-init` → `runSchemaCommands check` → `prepareSchemaInitialization` → `migrate` → закрытие квитанции → `bootstrap-admin` → `assertProductionModelKey` → `capacity-collector` → `up --wait` всего. Assert: 7 app + postgres `running`/`healthy`, образы == digest'ы из манифеста.
5. **F5.** Статика: `staticDriftReport` модели окружения на base + overlays модели + live-оверлеях (0/0/0: structural, dead-env, required-env; pinned-сервисы и frontend-порты тенью, blitz-fixture исключён из compose-стороны). Live: (а) absence TLS-отключений — ни в `compose.production.yml`, ни в `Config.Env` 7 кандидат-образов; (б) живые 7 контейнеров: `NEUROCENTER_TLS_DISABLE=0` присутствует, `NODE_TLS_REJECT_UNAUTHORIZED=0` отсутствует; (в) исходящий вызов `api-gateway → https://blitz.test:443` на self-signed отклонён (`SELF_SIGNED`/`CERT_*`), негативный контроль с `NODE_TLS_REJECT_UNAUTHORIZED=0` дошёл до HTTP; (г) `validateProduction` негатив: `compose run … -e SSO_DISABLE=true --entrypoint node catalog-service -e 'require("/shared/runtime.cjs")'` падает с `SSO_DISABLE=false обязателен в production`, позитив — поднятый production-стек (F4); (д) ghost-БД: `pg_database` только `catalog`, `nc_rag_<hash>`, системные — `skills` нет; DDL `security_events` — ровно 7 колонок контракта, `PRIMARY KEY (event_id)`, индекс `security_events_created … USING btree (created_at DESC)`; (е) lock-независимость для обоих ключей (`neurocenter:feature-flags:migrations`, `neurocenter:catalog:migrations`): racing `migrate.cli.js check` другого сервиса проходит под чужим advisory-локом, а прямой `pg_advisory_xact_lock` с `lock_timeout=2s` падает с `lock timeout`/`55P03`.
6. **H5 (в рамках F5).** Полный PKCE-поток Blitz: `/auth/login` → authorize у blitz-fixture → callback → `bridge_session`, возврат в исходный раздел, `/auth/me` — `Главный админ`; затем `verifyProductionBridge` (автономный архив MCP, pairing, heartbeat/pause/resume, choose-root job с арендой, продление истёкшего подключения) через настоящий HTTPS gateway на `127.0.0.1:19443` (servername `panel.test`, CA = сертификат кандидата).
7. **F6.** Evidence-запись (0600 в 0700), затем teardown `down --remove-orphans --timeout 60`. Volumes намеренно сохраняются; удаление — явно:

```sh
docker volume ls -q --filter name=nc-rel01- | xargs -r docker volume rm
rm -rf .run/release-candidate-e2e   # только после сохранения отчёта
```

## Отклонения от штатного production

Порты 19080/19443/19444 (не пересекаются с production-стеком 18080/18443/18444), blitz-fixture вместо реального Blitz, самоподписанный сертификат, fixture-реквизиты SSO, собственный Compose-проект и копии конфига. Production-код, compose-схемы, `validateProduction` и артефакты supply драйвер не модифицирует — только потребляет.

## Оффлайн-режим

Без аргументов и вне `node --test` файл печатает usage. Под `node --test` исполняется offline-блок (F1/F3/F5-static/F6, `validateProduction` на env-фикстурах) и live-фазы помечены `skip: HITL` — это штатное поведение tooling-гейта, а не отказ.
