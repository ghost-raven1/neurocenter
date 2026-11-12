# Ротация production-секретов и edge-сертификата

FR-1004: «Секреты ротируемы с задокументированными последствиями»; AD-OP-4 (rotation — DR-компонент), AD-OP-7(3) (edge-сертификат: runbook + алерт days-to-expiry), AD-OP-8 (правило cert-expiry в матрице алертов), AD-5 (mcp-host — отдельный trust-domain).

Ротация — **операторское действие по этому runbook**. Автоматической ротации нет (production-update.md) — ратификация, не дыра. В документе **нет значений секретов** — только имена, пути и процедуры. Все файлы живут в закрытом production-config-каталоге (`0700`, файлы `0600`, симлинки отклоняются — production-setup.md).

**Рекомендуемый период (рекомендация, не политика):** 90 дней для сервисных секретов; edge-сертификат — по дате истечения, алерт при ≤ 30 дней. Свежесть = mtime файла в `secrets/` + период; политику периодов оператор задаёт отдельно (policy в `maintenance_settings`, не здесь).

## Инвентарь

| Секрет | Файл | Consumers (compose) | Период |
|---|---|---|---|
| `internal_token` | `secrets/internal_token` | catalog-service, feature-flags-service, skills-service, rag-sync-service, oauth2-bridge, api-gateway | 90 дней |
| `metrics_token` | `secrets/metrics_token` | все app-сервисы (scrape) + prometheus | 90 дней |
| `sso_client_secret` | `secrets/sso_client_secret` | oauth2-bridge (token-exchange с Blitz) | 90 дней / политика IdP |
| `model_credential_key` (+`.id`) | `secrets/model_credential_key` | только catalog-service | 90 дней, с ограничением |
| `postgres_password` | `secrets/postgres_password` | postgres + 4 файла `*_url` | 90 дней |
| `mcp_host_secret` | `secrets/mcp_host_secret` | api-gateway (билеты MCP-хоста, AD-5) | 90 дней |
| `restore_runner_token` | `secrets/restore_runner_token` | web-restore-runner (compose.web-restore.yml, 127.0.0.1:44101) | 90 дней |
| `chat_s3_access_key` | `secrets/chat_s3_access_key` | catalog-service (chat S3, compose.chat-storage.yml) | 90 дней |
| `chat_s3_secret_key` | `secrets/chat_s3_secret_key` | catalog-service (chat S3, compose.chat-storage.yml) | 90 дней |
| `tls_cert` / `tls_key` | `TLS_CERT_FILE` / `TLS_KEY_FILE` | frontend (nginx edge) | по истечению; алерт ≤ 30 дней |

Файлы `catalog_url`, `rag_url`, `rag_provision_url`, `backup_url` — **не отдельные секции**: каждый несёт пароль своей PG-роли и ротируется как часть процедуры `postgres_password`.

Общие правила всех процедур: (1) перед ротацией — копия старого значения в тот же закрытый каталог (`<имя>.<дата>.bak`, `0600`), до успешной проверки ротации бэкап не уничтожается; (2) новое значение генерируется `openssl rand -hex 32` (кроме sso_client_secret — из IdP, и edge-сертификата — из CA/ACME); (3) запись — новый файл `0600`, один `newline`, симлинки запрещены; (4) после ротации — проверить `/ready` затронутых сервисов и запись последствий ниже; (5) dev-обходы (`SSO_DISABLE` и пр.) в production не применяются (AD-OP-5).

## internal_token

**Что это:** общий секрет межсервисной аутентификации и подписи билетов устройств (AD-4 runtime-trust). Генерация — `configuration.mjs` (`secret('internal_token', …)`), повторный `configure` сохраняет существующее значение.

### Процедура ротации
1. Выбрать окно: ротация гасит все билеты устройств (см. запись последствий) — окно = плановое обслуживание.
2. Сгенерировать новое значение; сохранить копию старого файла.
3. Записать новый `secrets/internal_token` (`0600`).
4. Перезапустить всех consumers: `docker compose -f compose.production.yml restart catalog-service feature-flags-service skills-service rag-sync-service oauth2-bridge api-gateway`.
5. Проверить: `/ready` всех шести сервисов; устройства переподключаются (re-issue — ep2 entry 6); в логах нет 401/403 межсервисных.
6. Успешная проверка → по retention-политике уничтожить бэкап старого значения.

### Последствия
Все билеты устройств гаснутся (AD-4): устройства теряют доступ до re-issue-цикла переподключения. Если не перезапущен хотя бы один consumer — он работает со старым значением: межсервисные вызовы с него дают 401 у перезапущенных соседей; следующий шаг — перезапустить оставшиеся сервисы. Двойное окно (старое и новое значение валидны одновременно) не создаётся: consumers читают файл при старте.

### Проверка истечения
mtime `secrets/internal_token` + период 90 дней; свежесть: межузловая аутентификация без 401/403, билеты устройств валидны, `/ready` consumers.

## metrics_token

**Что это:** токен auth для Prometheus-scrape метрик (64 hex, `0600`). Генерация — `ensureMetricsToken` (configuration.mjs): «автоматическая замена запрещена». Consumers: все app-сервисы (метрики) + prometheus (scrape-конфигурация в config-каталоге).

### Процедура ротации
1. Сгенерировать новое значение (64 hex); сохранить копию старого файла.
2. Записать новый `secrets/metrics_token` (`0600`).
3. В config-каталоге обновить scrape-авторизацию prometheus на новое значение (тот же файл).
4. Перезапустить prometheus (compose) — приложениям перезапуск не нужен (токен валиден при scrape, не при старте).
5. Проверить: `up{job="neurocenter"} = 1` по всем сервисам; alerting работает.
6. Успешная проверка → уничтожить бэкап.

### Последствия
Если scrape-конфигурация prometheus не обновлена синхронно — весь scrape падает (401) до догнания: метрики и алертинг слепы в этом окне, алерты в окне ротации ожидаемы. Частичная ротация (файл обновлён, prometheus нет) не ломает приложения — только мониторинг.

### Проверка истечения
mtime `secrets/metrics_token` + период 90 дней; свежесть: `up{job="neurocenter"}` равен 1 для всех сервисов, scrape-окон без 401.

## sso_client_secret

**Что это:** Client Secret IdP (Blitz) для token-exchange. Consumer: oauth2-bridge (`SSO_CLIENT_SECRET_FILE=/run/secrets/sso_client_secret`). Генерация/замена — только явный новый ввод в `configure` (production-setup.md).

### Процедура ротации
Порядок «сначала IdP — потом server-файл» (без окна отказа входа):
1. В Blitz: сгенерировать **новый** client secret; старый остаётся валидным (переходное окно IdP).
2. Записать новое значение в `secrets/sso_client_secret` (`0600`), сохранив копию старого.
3. `docker compose -f compose.production.yml restart oauth2-bridge`.
4. Проверить: **новый** вход через Blitz проходит (token-exchange 200); существующие сессии живут до TTL.
5. В Blitz: деактивировать старый secret (окно закрыто).
6. Успешная проверка → уничтожить бэкап.

### Последствия
Несовпадение секрета (файл раньше IdP или после деактивации) = token-exchange 401: **новые входы не создаются**, старые сессии живут до TTL. Если порядок нарушен (сначала файл, IdP ещё не знает новое значение) — вход сломан до синхронизации; следующий шаг — завершить шаги 1/5 в Blitz. Если старый secret не деактивирован — оба значения работают: окно раскрытия зафиксировать и закрыть.

### Проверка истечения
Дата выдачи secret в Blitz (источник) + mtime файла; период 90 дней или политика IdP, что раньше; свежесть: новый вход через Blitz проходит, token-exchange без 401.

## model_credential_key

**Что это:** мастер-ключ AES-256 для сохранённых (зашифрованных) API-ключей удалённых моделей + несекретная identity в `model_credential_key.id`. Consumer: **только** catalog-service (`NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE`). Генерация — `ensureModelCredentialKey` (configuration.mjs): «Восстановите сохранённый model_credential_key; автоматическая замена запрещена».

**Ограничение (обязательно к прочтению):** новые ключи **не откроют** старые сохранённые credentials (production-update.md, production-setup.md:29). Ротация допустима **только при отсутствии сохранённых credentials** либо с re-encrypt-миграцией (механизм в main не существует — отдельная работа, Deferred).

### Процедура ротации
1. Проверить, есть ли в каталоге сохранённые подключения моделей (зашифрованные credentials). Если есть — ротация запрещена без re-encrypt-миграции (Deferred); остановить процедуру.
2. Сгенерировать новый ключ и новую identity (`.id`) тем же механизмом, что первичное создание; сохранить копии обоих старых файлов.
3. Записать новые `secrets/model_credential_key` и `secrets/model_credential_key.id` (`0600`).
4. `docker compose -f compose.production.yml restart catalog-service`.
5. Проверить: `seed`/`up` сверяют keyId сохранённым подключениям (production-setup.md:29) — квитанция без несовпадения; новое подключение модели создаётся.
6. Если на шаге 5 выяснилось, что credentials всё-таки были и стали недоступны — **инцидент**: восстановить старые два файла из независимой копии (production-recovery.md) до запуска приложений; бэкап не уничтожать.

### Последствия
Несовпадение ключа/credentials = «тихая поломка»: сохранённые подключения моделей не открываются, приложение при этом healthy — без записи последствий это незаметно до первого inference. Утерянный мастер-ключ из SQL-дампа не восстановить; `seed`/`up` не запускают приложения при несовпадении keyId (квитанция не выдаётся).

### Проверка истечения
Ключ не имеет срока истечения: mtime + период 90 дней; свежесть: `up`/`seed`-гейт keyId проходит, inference по сохранённым подключениям работает.

## postgres_password

**Что это:** пароль PG-роли `postgres` (`POSTGRES_PASSWORD_FILE`). Файлы `catalog_url`, `rag_url`, `rag_provision_url`, `backup_url` несут пароли ролей `nc_catalog`, `nc_rag`, `nc_provisioner`, `nc_backup` (соответственно БД catalog/rag/postgres/rag) и ротируются **вместе** с `postgres_password` как один набор PG-креденшелов. Consumers: postgres, database-init, bootstrap-admin, catalog-service, rag-sync-service (через `*_url`); `backup_url` — backup-задачи.

### Процедура ротации
Атомарное окно (пароль роли и URL-файл должны смениться как одно действие):
1. Сгенерировать 5 новых значений: `postgres_password` + 4 пароля ролей (`openssl rand -hex 32`).
2. Сохранить копии всех 5 старых файлов.
3. Остановить потребителей БД: `docker compose -f compose.production.yml stop catalog-service feature-flags-service skills-service rag-sync-service oauth2-bridge api-gateway` (postgres работает).
4. В postgres смен пароли ролей (под старой `postgres_password`): `ALTER ROLE nc_catalog / nc_rag / nc_provisioner / nc_backup / postgres PASSWORD '<новое>';`.
5. Записать новые 5 файлов: `secrets/postgres_password` и 4 `*_url` в той же форме `postgresql://<роль>:<новый пароль>@postgres:5432/<БД>` (роли и БД — как в текущих файлах).
6. Перезапустить postgres, затем consumers: `docker compose -f compose.production.yml start postgres` → `start catalog-service feature-flags-service skills-service rag-sync-service oauth2-bridge api-gateway`.
7. Проверить: `/ready` всех сервисов; `backup_url` работает (тестовая копия или dry-run backup); scrape без 28P01.
8. Успешная проверка → уничтожить бэкапы.

**Rollback при частичной ротации** (файлы записаны, а роли не сменены, или наоборот): восстановить бэкапы 5 файлов (либо `ALTER ROLE` обратно на старые пароли), перезапустить postgres + consumers; бэкапы не удалять до успешного завершения.

### Последствия
Все PG-соединения площадки падают (catalog, rag, feature-flags, skills, oauth2-bridge, bootstrap, backup): в окне остановки — сервисы недоступны; при несовпадении «роль-пароль ≠ URL-файл» — 28P01/401 у приложений до завершения шага 5/4 или rollback. Частичная ротация `backup_url` ломает следующее плановое копирование (maintenance) до исправления.

### Проверка истечения
mtime 5 файлов (postgres_password + 4 `*_url`) + период 90 дней; свежесть: соединения без 28P01, backup-задачи успешны.

## mcp_host_secret

**Что это:** секрет отдельного trust-domain MCP-хоста (AD-5): подписывает билеты hosted-MCP (TTL 24h) в api-gateway (`NEUROCENTER_MCP_HOST_SECRET`, `features/mcp-host/ticket.ts`). Fallback на `internal_token` **запрещён** — без значения сервис отказывает в выпуске билетов. Генерация — `configuration.mjs` (независимо от `internal_token`).

### Процедура ротации
1. Сгенерировать новое значение; сохранить копию старого файла.
2. Записать новый `secrets/mcp_host_secret` (`0600`).
3. `docker compose -f compose.production.yml restart api-gateway`.
4. Проверить: `/ready` api-gateway; выпуск билета MCP-хоста для действующего устройства проходит (новый билет валиден, TTL 24h); старые билеты живут до TTL.
5. Успешная проверка → уничтожить бэкап.

### Последствия
Билеты, выпущенные старым значением, не проверяются новым: MCP-хосты переподключаются с re-issue (как AD-4 re-issue-цикл). Если значение не задано/слишком короткое — api-gateway отказывает в выпуске новых билетов (hard fail, не silent). Двойное значение не создаётся (единый файл, чтение при старте).

### Проверка истечения
mtime `secrets/mcp_host_secret` + период 90 дней; свежесть: билеты выпускаются и принимаются, в логах нет отказов «Секрет хоста MCP не задан».

## restore_runner_token

**Что это:** токен управления web-restore-runner (HTTP-контроль восстановления, compose.web-restore.yml: порт 4100 публикуется только на 127.0.0.1:44101, Docker socket в сервис не монтируется). Reader: `web-restore-runner.mjs` (`RESTORE_RUNNER_TOKEN_FILE`; `RESTORE_RUNNER_TOKEN` и `_FILE` одновременно запрещены).

### Процедура ротации
1. Сгенерировать новое значение; сохранить копию старого файла.
2. Записать новый `secrets/restore_runner_token` (`0600`).
3. Перезапустить web-restore-runner (compose с файлом compose.web-restore.yml).
4. Проверить: runner отвечает на `127.0.0.1:44101` с новым токеном; запрос без токена/со старым — 401/403.
5. Успешная проверка → уничтожить бэкап; обновить у оператора (единственный holder) способ авторизации.

### Последствия
В окне перезапуска web-restore недоступен (кнопки восстановления в панели — 503); активные restore-сессии, запущенные до ротации, завершаются по своему ходу (токен не переподписывается на лету). Если токен у оператора устарел — restore из панели невозможен до обновления: фикс = шаги 3–4 с текущим файлом.

### Проверка истечения
mtime `secrets/restore_runner_token` + период 90 дней; свежесть: runner на 127.0.0.1:44101 отвечает авторизованно.

## chat_s3_access_key

**Что это:** access key пользователя RGW для оригиналов файлов чата (production chat S3, compose.chat-storage.yml; consumer — catalog-service, `CHAT_S3_ACCESS_KEY_FILE`). Пара с `chat_s3_secret_key`: ротируются как пара (RGW поддерживает два ключа на пользователя — переходное окно).

### Процедура ротации
1. На стороне S3 (RGW): сгенерировать **вторую** пару ключей пользователя (старая пара остаётся валидна — переходное окно).
2. Записать новые `secrets/chat_s3_access_key` и `secrets/chat_s3_secret_key` (`0600`), сохранив копии старых.
3. Перезапустить catalog-service (consumer читает значения при старте).
4. Проверить: чтение и запись оригиналов чата в приложении (новый upload + чтение существующего файла).
5. На стороне S3: деактивировать старую пару ключей.
6. Успешная проверка → уничтожить бэкапы.

### Последствия
Если старую пару деактивировать до обновления файлов — catalog-service теряет доступ к оригиналам чата (чтение/запись 403) до шага 3: файлы чата недоступны, приложения при этом healthy. Переходное окно (оба ключа валидны) исключает отказ: порядок «S3 сначала (добавить), затем файлы, затем S3 (убрать)».

### Проверка истечения
mtime пары файлов + период 90 дней; свежесть: оригиналы чата читаются/записываются, в логах RGW нет 403 от catalog-service.

## chat_s3_secret_key

**Что это:** secret key пары с `chat_s3_access_key` (см. ту же секцию: consumer — catalog-service, compose.chat-storage.yml).

### Процедура ротации
Ротируется **только вместе** с `chat_s3_access_key` по процедуре из соседней секции (шаги 1–6): отдельно пары не меняются, RGW валидирует ключи как пару.

### Последствия
Те же, что у `chat_s3_access_key` (см. соседнюю секцию): доступ к оригиналам чата, 403-окно при нарушенном порядке, healthy-приложение при сломанном хранилище.

### Проверка истечения
mtime пары файлов + период 90 дней; свежесть: те же, что у `chat_s3_access_key`.

## edge-сертификат

**Что это:** TLS-сертификат внешнего edge (frontend nginx: `ssl_certificate /run/secrets/tls_cert`, `ssl_certificate_key /run/secrets/tls_key`; файлы задаются `TLS_CERT_FILE`/`TLS_KEY_FILE`, presence проверяет `setup.mjs` перед `up`). Операторские файлы — не производные repo.

### Процедура ротации
1. Выпустить новый сертификат+ключ (корпоративный CA или ACME) для `NEUROCENTER_HOST`.
2. Сохранить копии старых файлов сертификата и ключа.
3. Заменить файлы `TLS_CERT_FILE` и `TLS_KEY_FILE` (пара — вместе; `0600`).
4. **Пересоздать** frontend (не restart — nginx не перечитывает сертификаты на лету): `docker compose -f compose.production.yml up -d --force-recreate frontend` (AD-OP-7(3): «замена + пересоздание frontend»).
5. Проверить: `openssl s_client -connect <NEUROCENTER_HOST>:443 </dev/null | openssl x509 -noout -dates` показывает новую дату; `https://<host>/ready` — 200.
6. Успешная проверка → по retention уничтожить бэкапы (ключ — обязательно).

### Последствия
Сертификат без пересоздания контейнера = nginx продолжает отдавать **старый** сертификат: замена «не видна» до пересоздания — зафиксировано как шаг 4, не как опция. Истёкший edge-сертификат (M2) = HTTPS edge-фронта невалиден для всех TLS-клиентов (браузеры, установщики) при живом стеке: детект — `openssl x509 -checkend`. **Алерт days-to-expiry** — правило cert-expiry в матрице AD-OP-8 (alerting, ep6 entry 13; канал доставки — AD-O6, здесь не дублируется): срабатывает при ≤ 30 днях до истечения.

### Проверка истечения
`openssl x509 -in <TLS_CERT_FILE> -noout -dates` (источник) и `openssl x509 -in <TLS_CERT_FILE> -noout -checkend 2592000` (30 дней, для cron/скрипта оператора); алерт — ep6 entry 13.
