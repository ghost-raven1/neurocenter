# Подготовка production с Blitz

Подготовлен отдельный стек для одного хоста. Реальные адреса и реквизиты по просьбе владельца оставлены пустыми. Этот порядок подготавливает конфигурацию, БД и первого администратора; полный промышленный допуск зависит от оставшихся [критериев](production-readiness-2026-10-17.md).

## Требования

- Docker Engine и Docker Compose v2 с поддержкой profiles, secrets и `up --wait`.
- Поддерживаемый Node.js для операторского скрипта; рекомендован Node 24 LTS.
- DNS-имя площадки, доверенный сертификат с цепочкой и закрытый ключ. Самоподписанный сертификат используется только в автоматическом изолированном тесте.
- Зарегистрированное веб-приложение Blitz: client ID, client secret, разрешения `openid profile email`, callback `https://<площадка>/auth/callback` и logout return `https://<площадка>/`.
- Blitz должен передавать устойчивый `sub`/`uid`, корпоративную почту и доверенные сведения профиля. Почта первого администратора должна совпадать с этой учётной записью.

Плагин Compose можно подготовить командой `npm run compose:install` из корня checkout. Она сохраняет подходящий установленный Compose v2 или новее; Docker Engine устанавливается отдельно. [Платформы и проверка загрузки](compose-install.md).

Базовые пути и `client_secret_basic`/PKCE сверены с [официальным руководством Blitz](https://docs.identityblitz.com/latest/integration-guide/oidc-web.html). Приёмку конкретной версии корпоративного IdP всё равно нужно выполнить на настоящем входе.

## Локальный IdP-режим (пилот, interim)

Production-конфиг поддерживает два auth-режима (модель `ssoModes`): **`local-idp`** — локальный Blitz-совместимый IdP в закрытом контуре площадки, и **`corporate`** — центральный корпоративный Blitz. До развёртывания центрального IdP (эпик identity) пилот работает в режиме `local-idp`; это supported-конфигурация, а не dev-обход: тот же полный OAuth2/PKCE-поток против того же контракта Blitz (`/blitz/oauth/ae`, `/te`, `/me`, `/logout`), `SSO_DISABLE=false` в обоих режимах.

- Когда: пилот и любой развёртываемый контур без центрального IdP. Переход на `corporate` — после пилота, без переделки режима.
- Предпосылки: Blitz-совместимый IdP в контуре (self-hosted Blitz — рекомендуемый вариант, чтобы переход был перенастройкой, а не миграцией; в изолированном e2e стека — fixture-эмулятор `scripts/test/blitz-provider.fixture.cjs`). IdP обязан быть доступен по HTTPS, говорить контрактом Blitz и передавать устойчивый `sub`/`uid`, почту и `email_verified`. Сертификат IdP, которому доверяет стек, передаётся в `NODE_EXTRA_CA_CERTS` у `oauth2-bridge` (механизм AD-OP-7).
- Конфигурация: тот же мастер `configure` / `configure --json-stdin`, значения режима — `ssoHost` = адрес локального IdP (HTTPS), `ssoClientId`/`ssoClientSecret` = реквизиты локального веб-приложения, callback `https://<площадка>/auth/callback`. Отдельного переключателя режима нет: режим определяется тем, какой IdP назван в `SSO_HOST`.
- Первый администратор: тот же one-shot `bootstrap-admin`; `BOOTSTRAP_ADMIN_EMAIL` обязан совпадать с почтой учётной записи в IdP (создаётся без dev-входа, повторный запуск `created:false`).
- Ограничения: fail-closed — неверный `state`, отказ IdP или неподтверждённый профиль сессию не создают; dev-обход (`SSO_DISABLE=true`, mock-пользователь) в production запрещён всеми слоями и в обоих режимах (AD-OP-5): production-старт с `SSO_DISABLE`/`RAG_AUTH_DISABLED` ≠ `false` отклонён.
- Переход: после пилота — смена `SSO_HOST`, `SSO_CLIENT_ID` и `sso_client_secret` на реквизиты центрального Blitz (повторный `configure`); код, модель и стек не меняются, приёмка центрального IdP — по чеклисту P0-SSO.

## Настройка без секретов в репозитории

Из корня checkout:

```sh
node scripts/production/setup.mjs configure --directory /srv/neurocenter/config
```

Мастер запросит URL площадки и Blitz, Client ID, почту/имя первого администратора, постоянную метку релиза и пути к TLS-файлам. Client secret вводится без эха. Ввод паролей через аргументы командной строки не используется.

Получается приватный каталог с `.env` и `secrets/`. Права каталога — 0700, `.env` — 0600, секрет-файлов — 0444: Compose v2 реализует file secrets как bind-mount host-файла с сохранением его прав, поэтому non-root (USER node) и cap-drop сервисы читают секрет только в world-readable режиме; конфиденциальность на хосте сохраняет 0700 каталог (файл недоступен без прохождения пути владельцем). Пароли БД и внутренний ключ генерируются криптографически. Повторная настройка сохраняет существующие пароли БД и ключ; смена Client secret производится только при его явном новом вводе. Симлинки вместо секретов отклоняются.

`secrets/model_credential_key` — постоянный ключ AES-256 для сохранённых API-ключей удалённых моделей; рядом хранится его несекретная identity в `model_credential_key.id`. Оба файла резервируются отдельно вместе с закрытой конфигурацией. Потерянный ключ с сохранившимся marker не генерируется заново; после восстановления `catalog` нужен исходный ключ, а не новый из свежей настройки. `seed` и `up` проверяют соответствие keyId сохранённым подключениям до запуска приложений. Ключ монтируется только в `catalog-service`; в Git, карточки, мост и дамп конфигурации он не включается. Ротация каждого секрета и edge-сертификата — по [runbook](secret-rotation.md).

Для закрытой автоматизации доступен `configure --json-stdin`: JSON с полями `panelUrl`, `ssoHost`, `ssoClientId`, `ssoClientSecret`, `adminEmail`, `adminName`, `release`, `tlsCertFile`, `tlsKeyFile` поступает через stdin. Не сохраняйте такой JSON в репозитории и не включайте вывод shell trace.

Необязательные числовые поля `ragDefaultQuotaBytes` и `ragMaxQuotaBytes` задают логическую квоту новых баз знаний и максимум для нового значения лимита. Без них мастер использует 1 ГиБ и 16 ГиБ. В `.env` получаются `RAG_DEFAULT_QUOTA_BYTES` / `RAG_MAX_QUOTA_BYTES`; ноль, дробные/небезопасные целые и default выше maximum запрещены. При повторном `configure` нестандартные значения нужно передать снова. Переменные dev shell не перекрывают выбранный файл. Существующие пользовательские бюджеты не сбрасываются при перезапуске или изменении значения по умолчанию. Квота не учитывает физический диск/WAL, файлы и копии; достаточный запас диска и его контроль всё ещё обязательны.

Поля `backupMaxTotalBytes`, `backupMaxFileBytes`, `backupMinFreeBytes` задают общий объём HTTP-копий, размер одного дампа и резерв свободного диска. Значения по умолчанию — **64 ГиБ / 16 ГиБ / 1 ГиБ**; в `.env` это `BACKUP_MAX_TOTAL_BYTES`, `BACKUP_MAX_FILE_BYTES`, `BACKUP_MIN_FREE_BYTES`. Нужны положительные безопасные целые байты, файл не больше общего лимита; ноль не отключает защиту. При повторном `configure` нестандартные значения также передаются снова. В подсчёт входят старые/неучтённые файлы: для следующей копии нужно место сверх сохранённых пяти. Старые данные ради нового лимита не удаляются. Эти настройки не ограничивают PG/WAL, скиллы, проектные файлы или внешний полный DR-комплект; подбор ёмкости требует измерений.

`deploy/production/.env.example` — справочный шаблон с пустыми реквизитами и значениями квот по умолчанию. Его нельзя запускать без заполнения. Не используйте `.env` локального стенда и не объединяйте production Compose с `docker-compose.yml`.

## Non-root-запуск и томы (AD-OP-6)

Все 7 app-образов (catalog, gateway, skills, rag-sync, feature-flags, oauth2-bridge, frontend) работают от выделенного non-root-пользователя `node` с **единым uid 1000** во всех образах: общие named volumes (projects, skills, backups, model-weights) монтируются в несколько сервисов, и разные uid дали бы постоянные конфликты владельцев. Единый uid между доверенными сервисами закрытой backend-сети — осознанное решение (residual — AD-OP-7(5)). Внешние образы **вне non-root-скоупа** намеренно: `ollama/ollama` (работает root'ом — выбор образа) и `pgvector/pgvector` (внутренний пользователь `postgres`) — это не app-образы.

Writable-пути образов, включая точки монтирования named volumes, принадлежат uid 1000 в самом образе: первый mount пустого тома наследует владельца из образа. **Старый root-owned том** (созданный до non-root-миграции) не chown'ится автоматически: сервис отказывается стартовать с явной ошибкой (fail-closed, только production) вместо молчаливой read-only-работы. Действие: согласованный backup, затем пересоздание тома в новом пустом стеке и restore (либо одноразовый chown uid=1000 через привилегированный контейнер по явному решению). `docker compose down -v` без подтверждённого бэкапа уничтожает данные.

Профили `database-init`/`bootstrap-admin` (catalog-образ) работают тем же non-root: file secrets читаются в world-readable режиме (0444), app-томы они не пишут. `capacity-collector` (тот же образ, read-only-файловая система) пишет только снимок в том `capacity`; единственный `cap_add` стека — его `DAC_OVERRIDE` под read-only `statfs` — не меняется.

nginx (frontend) — non-root master: контейнер слушает 8080/8443 (>1024), привилегированных портов нет, pid-файл — вне tmpfs. Если будущий edge потребует 80/443, revert-путь — `cap_add: [NET_BIND_SERVICE]` у frontend (зафиксированный residual).

## Проверка, сборка и первый seed

Сборка сервера не загружает ассеты и не заполняет общий каталог. На сборочной машине с Node.js 24 установите корневые зависимости; зеркальные пакеты OpenCode подготавливаются отдельно, если нужны для первичной установки клиента.

```sh
npm ci --ignore-scripts
node scripts/production/setup.mjs check --directory /srv/neurocenter/config
node scripts/production/setup.mjs build --directory /srv/neurocenter/config
node scripts/production/setup.mjs up --directory /srv/neurocenter/config
```

`build` — production-сборка всех application-образов и release-манифеста. Режим fail-closed: checkout обязан быть чистым git-деревом без незакоммиченных изменений, SHA HEAD и timestamp commit входят в манифест; production-`.env` — обычный файл, а не symlink, с ровно одной `NEUROCENTER_RELEASE` — меткой релиза. Проверка TLS форсируется strict независимо от флага проекта. Перед `docker compose build` функция `normalizeBuildContext` приводит mtime файлов build-контекста к timestamp commit (`SOURCE_DATE_EPOCH`); набор исключений тот же, что в `.dockerignore`. Слои образов зависят только от исходников и закреплённых базовых образов, сборка перестает зависеть от времени checkout. Результат — манифест формата `neurocenter-release-v1`: 7 image ID application-сервисов и image ID postgres, опись миграций каталога, флагов и базовой RAG-БД, взятая из закреплённых образов, и опись supply — runtime/OpenCode-архивы `bridge-dist` (SHA-256 пересчитывается, `.sha256`-сайдкары сверяются с пересчётом), 8 installer-шаблонов и vendor-контракт `@neurocenter/asset-contract` (SOURCE.json, SHA256SUMS пересчитаны по файлам). Манифест атомарно (tmp + rename + fsync каталога) с правами 0600 записывается в `<каталог-конфига>/releases/<метка>/release-manifest.json` в закрытые 0700 каталоги. Перед успешным завершением фактическое состояние собирается повторно и сверяется с манифестом; любое рассогласование образов, supply или описей миграций останавливает сборку.

`up` подготавливает БД, проверяет место и запускает рабочие сервисы с ожиданием readiness. Пустой runtime моделей допустим. Веса не загружаются до выбора модели. При первом развёртывании выполните `seed` для bootstrap-администратора; эта команда не создаёт карточки ассетов.

До seed и приложений последовательно выполняются миграции каталога, флагов и базовой RAG-БД из CLI соответствующих образов. `check` схемы не изменяет БД, а `migrate` требует подтверждённого ready-состояния. Проектные RAG-БД обрабатываются перед доступом; существующим БД не присваивается identity автоматически.

Пустая первая установка сохраняет приватную `schema-initialization.json` до первого DDL. Если один из трёх этапов отказал, повтор того же `seed`/`up` может продолжить попытку только с теми же образами, конфигурацией, PostgreSQL-кластером и БД, при отсутствии контейнеров приложений. CLI выполняются по закреплённым image ID; перед каждым этапом и закрытием квитанции эти условия проверяются повторно. После готовности схем квитанция закрывается до запуска seed и приложений. Квитанцию нельзя удалять или подменять ради обхода проверки. Неприменённые миграции существующего стека, включая остановленный, требуют [update с резервной копией](production-update.md).

## Автономный пакет фонового агента (операторское провижининг)

Сервис `background-agent` не несёт runtime (OpenCode) в образе: закреплённый автономный пакет оператор размещает в named volume `background-agent-runtime` **до `up`** — без пакета сервис не проходит healthcheck (fail-fast по дизайну: run на unpinned-runtime невозможен, FR-305), и `up --wait` не становится зелёным.

Лэйаут тома (монтируется в `/app/background-agent-runtime`, `BACKGROUND_AGENT_RUNTIME_ROOT`; сервис читает его read-only):

```
runtime.json          {"probeEngine":{"file":"bin/opencode-probe","version":"<пин>","sha256":"<sha256 бинаря>"}}
bin/opencode-probe    бинарь закреплённой версии OpenCode (исполняемый)
```

Пин и целостность: версия обязана совпасть с пином сборки (текущий — OpenCode 1.14.48), sha256 сверяется с фактическим файлом бинаря — любое расхождение = явная ошибка старта (не «fallback»). Источник бинаря — supply-опись релиза (`release-manifest.json`: runtime/OpenCode-архивы с SHA-256). Лэйаут идентичен тому, что использует e2e `background-agent-server` (там — fake-бинарь; для стенда без реального движка допустим stand-in с честным sha256 — см. RES-01-protocol.md).

## Выборочный импорт ассетов

Главный администратор открывает **Ассеты**, обновляет описания и выбирает, что добавить в общий каталог. Текущая опись и закреплённые рецепты поставляются вместе с приложением в `catalog-source/`; content SHA, source revision и прежние Git provenance сохраняются отдельно. MCP/плагины подготавливаются явным действием через упаковщик; внешнее хранилище ассетов и GitHub Releases для запуска не нужны. Зависимости включаются в план импорта явно. Конфликт с локально изменённой карточкой требует выбора; чужие изменения не перезаписываются молча.

Перед подключением компьютеров импортируйте мост нужного выпуска. API Gateway выдаёт только зарегистрированные и проверенные файлы этого выпуска. Локальный `bridge-dist/runtime` не является запасным источником. Установка инструмента на компьютер проходит через мост и Gateway.

Обновление Git/сервера не импортирует новые карточки и не переключает закреплённые версии проектов. Для изолированной площадки сохраняйте проверенный blob-кэш, descriptor и сведения о соответствующем commit источника. [Формат, кэш и границы](assets.md).

## Обновления и восстановление

Используйте новую метку `NEUROCENTER_RELEASE` для каждой сборки и храните проверенные образы/digest предыдущего выпуска. Подготовленные базовые образы закреплены digest; полноценного CI в checkout пока нет. [Оператор обновления](production-update.md) требует репетицию точных образов на копии данных и создаёт проверенный согласованный комплект перед изменением; несовместимый возврат выполняется восстановлением в новый стек. Не запускайте непроверенное обновление поверх единственных рабочих данных.

Перед первым запуском версии с лимитом RAG выполните согласованный backup. Новая миграция квоты выполняется транзакционно под блокировкой, записывает версию/контрольную сумму и сохраняет старые данные. Применённый SQL нельзя править на месте: следующее изменение требует новой миграции. Контрольная сумма не заменяет проверку обновления всего приложения на копии данных.

Docker volumes production-стека: PostgreSQL, Markdown-скиллы, серверные рабочие папки, копии и неизменяемые runtime-артефакты. Остановка/перезапуск не удаляет их. `docker compose down -v` уничтожает данные; не используйте эту команду для рабочего стека.

Кнопка backup в панели копирует каталог. Для согласованной копии всех БД и серверных томов используйте [операторский backup/restore](production-recovery.md). Он проверяет контрольные суммы и точные образы и восстанавливает только в новый пустой Compose-проект. Параметр `--project-name` поддерживается и в `setup.mjs`; повторный seed при восстановлении не нужен. Запуск и seed разделяют maintenance-блокировку с копированием.

[Расписание и контроль свежести](maintenance-schedule.md), [S3-доставка](external-backups.md) и [физический admission](capacity-admission.md) реализованы. До допуска нужно подключить независимое внешнее хранилище и системный таймер, обеспечить внешний retention и подтвердить согласованные RPO/RTO репетицией на целевом объёме. Конфигурация/секреты и TLS требуют отдельного закрытого хранения. Локальные папки сотрудников и их LanceDB резервируются отдельно.

## Канал алертов (AD-O6, ep6 entry 13)

Алерты Prometheus доставляются оператору через **file-sink** (HITL-решение оператора): alertmanager (compose, backend-сеть) → webhook → **host-receiver** (systemd-сервис на хосте) → запись в `/var/log/neurocenter/alerts.jsonl` + journald.

**«Доставлено» = запись в файл/journal с меткой времени** (readiness-критерий, `docs/implementation-readiness.md` P0-RES). alertmanager UI — диагностика, НЕ канал; **файл правил без работающего канала = не доставлено**. Resolve-события (снятие алерта) доставляются так же — строка с `"status":"resolved"`.

Механика:

- `deploy/production/monitoring/alertmanager.yml` — route (`group_by [alertname, severity]`, `group_wait 30s`, `group_interval 5m`, `repeat_interval 4h`) + receiver `neurocenter-file-sink` (webhook `http://host.docker.internal:9111/alerts`).
- `scripts/production/alert-receiver.mjs` — HTTP-сервер без зависимостей: `POST /alerts` (JSONL 0600, каталог 0700, fail-fast на старте если каталог не writable), `GET /metrics` (`neurocenter_alert_receiver_up`, `neurocenter_alerts_received_total{status}`, `neurocenter_edge_cert_days_to_expiry` — AD-OP-7, gauge пересчитывается из `CERT_PATH` при каждом scrape, нет файла → `NaN`), `GET /ready`.
- `deploy/production/alert-receiver.service` — systemd: `User=neurocenter-operator` (тот же, что у stack-watchdog), `Restart=always`, `UMask=0077`.
- Адрес хоста: у compose-паттерна нет host networking — `extra_hosts: host.docker.internal:host-gateway` добавлен сервисам alertmanager и prometheus (резолвится в IP шлюза backend-моста). Порт 9111 согласован в трёх местах: `ALERT_RECEIVER_PORT` (юнит), `webhook_url` (alertmanager.yml), job `alert-receiver` (prometheus.yml).
- Новые правила (ep6 entry 13) в `neurocenter-alerts.yml`: `NeurocenterStackDown` (ни один сервис не жив, 2m, critical), `NeurocenterErrorCritical` (critical-события error-store за 5m, warning), `NeurocenterCertExpiry` (<14d, warning) / `NeurocenterCertExpiryCritical` (<7d, critical), `NeurocenterAlertReceiverDown` (канал down, 2m, critical).
- Детект «канал down» — по `up{job="alert-receiver"} == 0` (scrape-уровень): с гибелью процесса gauge `neurocenter_alert_receiver_up` из Prometheus исчезает, и «gauge == 0» не сработал бы никогда.
- Retention `alerts.jsonl` — 30 дней (алерты редкие; logrotate на хосте):

  ```
  /var/log/neurocenter/alerts.jsonl {
      rotate 30
      daily
      compress
      missingok
      notifempty
      copytruncate
  }
  ```

Установка на хосте (один раз): скопировать юнит в `/etc/systemd/system/`, в `CERT_PATH` подставить актуальное значение `TLS_CERT_FILE` из production `.env` (edge-сертификат frontend), затем `systemctl daemon-reload && systemctl enable --now neurocenter-alert-receiver`. Проверка: `curl -s localhost:9111/ready` → `ready`, `journalctl -u neurocenter-alert-receiver`.

Как проверить доставку: `tail /var/log/neurocenter/alerts.jsonl` (строка = `{ts, source:"alertmanager", status, alertname, severity, labels, annotations, …}`) и/или `journalctl -u neurocenter-alert-receiver` (строка `[alert-receiver] firing <AlertName> severity=… service=…`). Grep по имени алерта: `grep NeurocenterDiskSpaceLow /var/log/neurocenter/alerts.jsonl`. Снятие: после восстановления условия alertmanager шлёт resolve-событие — в файле появляется строка с тем же alertname и `"status":"resolved"` (через ~5m, resolve-timeout alertmanager v0.30+ фиксирован).

Как расширить канал (email/telegram/webhook-2 — OQ-2, не P0): новый named receiver в `receivers` + ветка в `route` (matcher по severity/alertname) — см. комментарий-секцию «РАСШИРЕНИЕ» в `alertmanager.yml`; file-sink остаётся базовым каналом, новые дублируют доставку.

Валидность конфигов (локальные образы, egress не нужен):

```sh
# alertmanager.yml (amtool из образа; флага --check в alertmanager нет):
docker run --rm --entrypoint /bin/amtool -v $PWD/deploy/production/monitoring:/etc/alertmanager \
  prom/alertmanager:v0.32.1 check-config /etc/alertmanager/alertmanager.yml
# правила + fixture (promtool из образа; test-файл один, rule_files внутри):
docker run --rm --entrypoint /bin/promtool \
  -v $PWD/deploy/production/monitoring:/etc/prometheus -v $PWD/scripts/test:/fixtures \
  prom/prometheus@sha256:3b9b2a15d376334da8c286d995777d3b9315aa666d2311170ada6059a517b74f \
  test rules /fixtures/alert-rules.fixture.yaml
```

### HITL-приёмка 6.15: «вызвать → доставлено → снято»

Пошаговая приёмка на живом production-стеке (оператор). Критерий: условие вызвано → в `alerts.jsonl`/journal есть строка с временем → условие снято → есть resolve-строка.

1. **Disk low** (`NeurocenterDiskSpaceLow`, critical): найти физический том, на котором живут данные стека (`df -h /var/lib/docker` на хосте); заполнить резерв: `dd if=/dev/zero of=/var/lib/docker/filler-nc bs=1M count=<N>` до free < 1GiB (том capacity-collector). Проверка: `grep NeurocenterDiskSpaceLow alerts.jsonl` (строка firing, ≤ 1m + group_wait 30s). Снятие: `rm filler-nc` → resolve-строка.
2. **Service down** (`NeurocenterServiceUnavailable`, critical, 1m): `docker compose -f compose.production.yml -p neurocenter-production stop <сервис>` (например, skills-service). Проверка: grep по имени (строка с `service`/`instance` labels). Снятие: `… start <сервис>` → resolve.
3. **Stack down** (`NeurocenterStackDown`, critical, 2m): остановить все 6 app-сервисов job="neurocenter" (`docker compose … stop` по каждому; мониторинг не трогаем — иначе некому доставлять). Проверка: grep `NeurocenterStackDown` (один алерт — group_by). Снятие: `… start` всех → resolve.
4. **Канал down** (`NeurocenterAlertReceiverDown`, critical, 2m): `systemctl stop neurocenter-alert-receiver`. Проверка: grep (2m). Снятие: `systemctl start neurocenter-alert-receiver` → resolve.
5. **Queue** (`NeurocenterRagQueueGrowing`, warning) и **error critical** (`NeurocenterErrorCritical`, warning): на живом стеке безопасного вызова нет (queue — штатная нагрузка; critical-ошибка — штатный сбой) — принимаются fixture'ом: `promtool test rules` (сценарии 3/5 в `alert-rules.fixture.yaml`) + строчка в доке.
6. **Cert expiry** (`NeurocenterCertExpiry`/`Critical`): live-проверка текущего срока — `curl -s localhost:9111/metrics | grep days_to_expiry` и `openssl x509 -in <TLS_CERT_FILE> -noout -checkend 2592000` (30 дней, см. `secret-rotation.md`); пороговые значения (14d/7d) принимаются fixture'ом (сценарий 4/5). Ротация при истечении — по runbook `secret-rotation.md` (frontend пересоздаётся, gauge обновляется при следующем scrape без перезапуска receiver).
7. **Grouping** (ожидаемо): при п.3 в файле одна строка `NeurocenterStackDown` (не 6) + 6 строк `NeurocenterServiceUnavailable` — оператор видит масштаб по labels.

## Доказательства и границы

Автотест `node scripts/test/production-stack.mjs --build` сам создаёт тестовый TLS через OpenSSL, приватную конфигурацию и уникальный Compose-проект. Используются отдельные volumes, loopback-порты и тестовый Blitz. После прогона удаляются только собственные контейнеры и volumes; логи по умолчанию сохраняются в `.run/production-stage-1`. Тест не использует production-реквизиты и не изменяет рабочие данные локального стенда. Метку образов задаёт `NEUROCENTER_TEST_RELEASE`, каталог свидетельств — `NEUROCENTER_TEST_EVIDENCE`; для уже собранных образов флаг `--build` не нужен. В сетях, где build-контейнер не резолвит внешние имена (закрытый наружный DNS, недоступный из контейнера локальный stub-resolver), фиксация хостов: `NEUROCENTER_BUILD_HOSTS=host:ip,host:ip` — переменная добавляет `extra_hosts` каждому build-сервису в генерируемый Compose-override (apt-зеркала, PGDG, npm-реестры); без переменной override не меняется. Авторизация доверенного реестра (`NPM_REGISTRY_AUTH_B64`) и корпоративный CA (`NEUROCENTER_BUILD_CA_SHA256`/`NEUROCENTER_BUILD_CA_NAME`, [механизм](docker-build-ca.md)) — стандартные build-арги образов, в доверенной сети обязательны. Текущий код и приёмка разделены в [описании реализации](current-implementation.md) и [реестре готовности](implementation-readiness.md). [Этап 0.9.0](reliable-installation-0.9-2026-10-18.md) содержит исторические результаты для своих образов; [четвёртый этап](production-stage-4-2026-10-17.md) сохранён как история; [первый этап](production-stage-1-2026-10-17.md) сохранён как история.

Базовые версии сверены с [Node.js releases](https://nodejs.org/en/about/previous-releases) и [nginx security advisories](https://nginx.org/en/security_advisories.html). Файловые Compose secrets не являются внешним менеджером секретов: [ограничения Docker](https://docs.docker.com/compose/how-tos/use-secrets/).
