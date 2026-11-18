# Приёмка устройственного канала и каталога (TRUST-01)

`scripts/test/trust-device-e2e.mjs` — e2e-драйвер TRUST-01 (эпик 2, тикет 14). Принимает связку «устройство → gateway → catalog → контракт» на **production-стеке** (12 сервисов, production-nginx с маскированием билетов и лестницами, `--pull never`, `validateProduction`) — то, чего не доказывали изолированные сьюты 2.1–2.13. Аналог REL-01 для эпика 2. Драйвер не создаёт кандидата, не мержит и не решает «принят/отклонён»: он сверяет, разворачивает в замкнутом контуре и записывает evidence. Операторские шаги — H1, H2, H4, H5 ниже; live-фазы выполняет драйвер, человек запускает его один раз и читает отчёт.

Результат — файл `$NEUROCENTER_TEST_EVIDENCE/trust-device-e2e.json` (0600, по умолчанию `.run/trust-device-e2e/`): кандидат (commit SHA + сверенный `candidateHead`), режим (`static-only`/`live`), compose-проект, `checkedAt`, `liveRun` (`setup-ok`/`setup-failed`/`not-run` + `reason`), `phases` — статус каждой проверки (`pass`/`fail`/`skip`). Решение «эпик принят» принимает оператор (H5) после отчёта и H4.

## Режимы

- `node --test scripts/test/trust-device-e2e.mjs --static-only` (и просто `node --test scripts/test/trust-device-e2e.mjs` без `--candidate`) — **БЕЗ docker**: T5-static (gateway-политики на коде кандидата: completeness, лестницы, nginx-body-инварианты, error-body, ceiling-identity; при stale-сборке драйвер сначала собирает `api-gateway` и `neurocenter-asset-sync`). Safe-дефолт для tooling-гейта и локального запуска; live-фазы помечены `skip: live mode только с --candidate <commit>`.
- `node scripts/test/trust-device-e2e.mjs --candidate <sha>` — **полный live**: сверка HEAD == кандидат → build + up production-стека → T1–T7 → teardown. Жёсткий docker.

Гейт режима — наличие `--candidate`: под `node --test` дополнительные флаги не доходят до argv процесса, поэтому live — только прямым запуском (не через `node --test`).

## Требования

- Docker Engine + Compose v2 (profiles, secrets, `up --wait`); на хосте уже есть образы production-стека (pgvector, ollama, `node:24.22.0-bookworm-slim`). Сборки не выходят в сеть.
- Node 24 (`export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH`), git, openssl.
- Checkout кандидата (этот worktree) на коммите кандидата, чистое дерево; корневые зависимости установлены (`npm ci --ignore-scripts`).
- Load-менеджмент: порог этого хоста — `load1 < 6` (проверить `uptime` перед стартом). Сборка и подъём стека у драйвера последовательные; параллельно с приёмкой на этом хосте ничего тяжёлого не запускайте. Два driver-стека одновременно на одном хосте невозможны (общие порты 18080/18443/18444, см. «Отклонения»).

## H1. Кандидат

Кандидат — commit SHA, по умолчанию **HEAD `main`** после мержа 2.1–2.13 (OQ3: тег — процесс REL-01/релиза, приёмку эпика с релизом не смешиваем). Драйвер **сверяет** `git rev-parse HEAD` == значение `--candidate` до сборки; расхождение — остановка до стека (`candidateHead` в отчёте).

```sh
git rev-parse HEAD   # это значение и передаём в --candidate
```

Checkout на этом коммите; чистоту дерева оператор гарантирует сам (драйвер проверяет только HEAD).

## H2. Запуск драйвера

Из корня checkout кандидата:

```sh
uptime
node scripts/test/trust-device-e2e.mjs --candidate <sha>
```

Что делает драйвер (последовательно):

1. Fixture-конфиг через `configureProduction` (fixture-SSO значения как в `production-stack.mjs`: `https://panel.test` / `https://blitz.test`, `fixture-client`/`fixture-only`, `admin@example.test`) + самоподписанный сертификат (SAN `panel.test`/`blitz.test`/`127.0.0.1`) + собственный compose-проект `nc-trust-device-<uuid>` и override (порты 18080/18443/18444, blitz-fixture).
2. Читает `config/secrets/mcp_host_secret` (fixture-секрет хоста mcp-host) — **только** для подделки валидно-подписанных негативных билетов (T2_CEILING/T2_HMAC, изоляция конкретных веток verify); секрет в отчёт и логи не попадает.
3. `HEAD == кандидат` → `docker compose build` (12 сервисов, ~30 мин; `build.log` в evidence) → `up --wait postgres blitz-fixture` → `database-init` → `bootstrap-admin` (первый админ) → `up --wait` всего → `/ready` (poll до 120 s) → admin-логин (Blitz PKCE, cookie `bridge_session`).
4. T1–T7 (ниже), затем teardown: `services.log` (снимок логов стека **до** down) → `down --volumes --remove-orphans` → удаление fixture-каталога (конфиг с секретами, сертификат, device-fixture); `services.log`, `build.log` и отчёт остаются в evidence.

Время: в прогоне есть ~60 s wall-clock ожидания (T3_CACHE — окно отзыва кэша) и 40MB-загрузка (T5_BODY_40MB); доминирует сборка.

Статика без docker:

```sh
node --test scripts/test/trust-device-e2e.mjs --static-only
```

## T1–T7: что проверяет драйвер

- **T1 — mcp-host жив.** Scripted device → `POST /api/mcp-host/connect` (Bearer-токен устройства) → билет → канал `m/:ticket` отвечает 200/jsonrpc (контроллер, не прокси — shadowing закрыт); `descriptorSha256` = sha256 канонического descriptor-текста одобренного пакета (AD-3). После запроса `m/:ticket` в nginx access-log (frontend) — `/api/mcp-host/m/[REDACTED]` и **нет** сырого билета (билет в логе = CRIT).
- **T2 — билет верифицируется.** Валидный билет работает; валидно-подписанный билет с `compressedBytes = ceiling + 1` → 401 (HMAC-ветка проходит, отказ — именно ceiling-проверка verify); битая подпись → 401 (HMAC-ветка); connect отозванной (retired) версии → 403 (retire-gate AD-16).
- **T3 — отзыв.** Claim `exp` = issuance + 24h (TTL билета); после отзыва устройства в БД (`revoked=true`) запрос в свежем окне кэша проходит (кэш фиксированного TTL не обновляется хитом), затем poll каждые 3 s до 403 — elapsed ≤ 65 s (кэш 60 s, AUTHZ_TTL в compose не задан); `docker inspect api-gateway`: `pids_limit` (128) + non-root user. **T3_POOL** (квота MAX_HOSTS, N+1 хостов) — skip в базовом гейте, усиленный прогон.
- **T4 — retire необратим.** Назначение до отзыва 200/201 → retire версии 1 → 201 → повторный retire 409, новое назначение retired 409, connect retired-пакета 403; аудит — ровно одна запись `security_events` `action='plugin.version.retire'` на `cardId:1`; провенанс сохранён (статус `retired` виден в `/versions`, `package?version=1` отдаёт байты).
- **T5 — gateway-политики.** Static: route-policy completeness, deadline-лестницы, nginx body-инварианты, error-body policy, ceiling-identity (свежая сборка gateway + asset-sync). Live: 40MB upload реальной content-маршрута проходит без 413 (nginx server-level `client_max_body_size 50m`; 8g — только `/api/asset-sources/archive`). **T5_ERROR_BODY** (live-инжект транспортного 5xx) — skip в базовом гейте: транспортный 5xx покрывает static error-body policy.
- **T6 — identity ceiling (OQ4: из развёрнутых образов).** `docker exec` (SERVICE names): gateway `require('/repo/services/shared/runtime-artifacts.cjs').CEILING` и клиентский facade `dist/shared/runtime-artifacts.cjs` в образе `rag-sync-service`. Ожидается, что клиентский require падает с `MODULE_NOT_FOUND` (documented gap **3629dc7e**: `@neurocenter/asset-contract` вне production-closure моста) — тогда драйвер проходит **fallback**: byte-identity facade+limits-файлов клиента и gateway + ceiling gateway, и фиксирует residual в отчёте (`clientRead: 'fallback-byte-identity'`). Ловит stale-build.
- **T7 — UJ-2.** Пять полей провенанса на API-уровне (версия + `manifest.sha256` + `metadata.origin` + `createdAt` + `author`); immutable-версии — `activate v1` создаёт **новую** версию 2 (INSERT-only, строка v1 не меняется); pin-only — connect с `version=999` (не pin проекта) → 403/409. **T7_UI** — skip, HITL H4.

Scripted device-клиент (OQ1): драйвер собирает stdio MCP-server через `packRuntime`, импортирует архив в каталог операторским CLI (`compose cp` + `exec import.cli.js`, код архива не исполняется), создаёт проект → члена-разработчика (`dev-trust-qa@example.test`, auto-provisioning `platform_users`) → hosted-mcp карточку → назначение (pin версии 1) → device-строку (в БД только `sha256(token)`, NFR-2; хеш считается на стороне JS). Реальное устройство для гейта не требуется.

## H4. UI-проверка провенанс-карточки

Драйвер рвёт свой стек после прогона (режима «оставить стек» нет), поэтому UI-проверка выполняется на вручную поднятом стеке (тот же fixture-паттерн, H2) или при следующем production-подъёме: проект → карточка hosted-mcp (у драйвера — «TRUST-01 Hosted QA») → провенанс-секция. Пять полей (версия, SHA, источник, время, издатель) должны совпасть с `phases.T7_CARD` отчёта — API-уровень автоматически зафиксирован T7_CARD, H4 подтверждает только отображение.

## H5. Интерпретация отчёта

Файл `.run/trust-device-e2e/trust-device-e2e.json` (0600). Оператор (owner) принимает решение «эпик принят» после проверки:

1. `liveRun.status == 'setup-ok'` и `candidateHead == candidate` (HEAD действительно был кандидатом).
2. Все pass-проверки T1–T7 — `pass`: `T1_MCPHOST_LIVE`, `T1_LOG_MASKED`, `T2_VERIFY_OK`, `T2_CEILING`, `T2_HMAC`, `T2_RETIRED`, `T3_TTL`, `T3_CACHE` (`wallMs <= 65000`), `T3_PIDS_NROOT`, `T4_IRREVERSIBLE`, `T4_RETIRE`, `T5_BODY_40MB`, `T6_IDENTITY`, `T7_CARD`, `T7_IMMUTABLE`, `T7_KIT`.
3. Skips — ожидаемы в базовом гейте: `T3_POOL` (квота MAX_HOSTS — усиленный прогон, N+1 хостов), `T5_ERROR_BODY` (транспортный 5xx — static error-body policy; live-инжект — усиленный прогон), `T7_UI` (это H4).
4. `T6_IDENTITY`: `clientRead == 'direct'` — ceiling идентичен у обоих развёрнутых образов (deepEqual); `clientRead == 'fallback-byte-identity'` — residual 3629dc7e (asset-contract вне closure моста, клиентский require не резольвится в рантайме): byte-identity facade+limits + ceiling gateway — принимаемый прокси, residual зафиксирован в отчёте и не скрывается.
5. `liveRun.status == 'setup-failed'` — причина в `liveRun.reason`; `services.log`/`build.log` в evidence-каталоге сохранены (fixture-каталог с секретами удалён).

CRIT-признаки (эскалация, не «поправить и повторить»): сырой билет в nginx access-log (`T1_LOG_MASKED`), расхождение ceiling между развёрнутыми образами (`T6_IDENTITY`), аудит retire ≠ ровно одной записи (`T4_RETIRE`).

Почему driver-подделки: host-секрет используется только для валидно-подписанных **негативных** билетов (T2_CEILING/T2_HMAC) — это единственный способ изолировать конкретные ветки verify (ceiling/HMAC) от подписи; секреты в отчёт не попадают. `tool_installation` — `defaultEnabled: true`, `dependsOn: computer_connections`: на свежем стеке оба флага включены по умолчанию, фичафлаги драйвер не переключает.

## Отклонения от штатного production

Fixture-SSO (blitz-fixture вместо реального Blitz), самоподписанный сертификат, собственный compose-проект и конфиг, порты 127.0.0.1:18080/18443/18444 (базовый production-стек — 80/443, REL-01 — 19xxx: пересечений нет; пересечение только между двумя driver-стеками на одном хосте). Production-код, compose-схемы, `validateProduction` и артефакты драйвер потребляет, не модифицирует.
