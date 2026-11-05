# Recon: операционный контур (deployment, environments, CI/CD, DR, upgrade, registry) — 2026-11-05

Источник: recon-агент (brownfield), полный ввод в architecture-operational spine.

## 1. Факты

### 1.1 Deployment — compose

**Dev (`docker-compose.yml`):**
- 9 сервисов: model-runtime, frontend, oauth2-bridge, api-gateway, catalog-service, feature-flags-service, skills-service, postgres, rag-sync-service.
- model-runtime: `ollama/ollama:0.35.1@sha256:292ee...` (закреплён), mem 5g, cpus 4, `init`, `no-new-privileges`, healthcheck, volume `./data/embedding`; **pids_limit нет**.
- frontend: build `frontend/Dockerfile`, порт только `127.0.0.1:5173→8080`.
- api-gateway: **`NODE_TLS_REJECT_UNAUTHORIZED=0`**, порт `127.0.0.1:4000`, volume `./bridge-dist:/app/bridge-dist:ro`, `BRIDGE_TEMPLATES_DIR=/app/bridge-dist` (dev — корректно).
- catalog-service: `cap_drop [ALL]` + `no-new-privileges` + seccomp `docker/seccomp/catalog-packager.json`; volumes: projects (bind), runtime-artifacts, help-content bind, backup-data, `./data/embedding→/data/models`; `depends_on postgres: service_healthy`.
- postgres: `pgvector/pgvector:pg16` **без digest**, порт `127.0.0.1:5432`, init-SQL из `services/rag-sync-service/init`.
- Named volumes: `pgvector-data`, `runtime-artifacts`, `backup-data`. **Нигде нет** networks, pids_limit, log-rotation, restart policy (кроме model-runtime/postgres: `unless-stopped`).
- Фактический dev-флоу: `dev.sh` (подбор Node 24) → `dev.mjs`: `docker compose up -d --wait postgres` — остальные 7 сервисов — **node-процессы на хосте** (watch через `dev-watch-guardian.mjs`).
- Overlay'и dev: `compose.embedding.yml`, `compose.chat-storage.ceph.dev.yml`, `compose.chat-storage.dev.yml` (legacy MinIO), `compose.offline-assets.yml`.

**Production (`compose.production.yml`):**
- Якорь `x-service`: `restart unless-stopped`, `init`, `stop_grace_period 45s`, `no-new-privileges`, json-file 10m×3, `networks [backend]`. **pids_limit в якоре нет.**
- 12 сервисов: model-runtime, postgres, capacity-collector, database-init, bootstrap-admin, catalog-service, feature-flags-service, skills-service, rag-sync-service, oauth2-bridge, api-gateway, frontend.
- Образы: `neurocenter/<svc>:$NEUROCENTER_RELEASE:?` (метка обязательна, `latest` запрещён скриптами); ollama и pgvector — с digest.
- 11 file-secrets из `$NEUROCENTER_CONFIG_DIR/secrets` + `tls_cert`/`tls_key` из `$TLS_CERT_FILE`/`$TLS_KEY_FILE`.
- Сети: `backend` + `edge`; только frontend в обеих; публикуемые порты: **`80:8080`, `443:8443`** (все интерфейсы).
- capacity-collector: `network_mode: none`, `read_only`, `cap_drop ALL + DAC_OVERRIDE`, 128m/0.25cpu/**pids 32**.
- database-init / bootstrap-admin: `profiles [setup]`, `restart: 'no'`, CLI-команды.
- catalog: `cap_drop ALL` + seccomp; RAG-роль читает через `backup_url` (nc_backup).
- postgres: `POSTGRES_PASSWORD_FILE` (secret), `--auth-host=scram-sha-256`, пользователь `nc_owner`.
- api-gateway: **`NODE_TLS_REJECT_UNAUTHORIZED: '0'`** (`:281`), `BRIDGE_DIST: /app/bridge-dist` (`:286` — **мёртвая переменная**, нигде не читается).
- frontend: nginx `envsubst` template, `ssl_certificate /run/secrets/tls_cert` (TLSv1.2/1.3, HSTS, 308→https, `limit_req 10r/m` на `/auth/login`, JSON access log без query/cookies).
- Volumes: `model-weights`, `capacity`, `postgres`, `skills`, `projects`, `help-content`, `runtime-artifacts`, `backups`.

**Dev↔prod отличия:** env-файлы vs 0700-конфиг-каталог; пароли в env vs secrets; `rag:rag` на loopback-5432 vs scram+role-модель; build-on-fly vs метка-релиза; TLS off в dev-фронтенде vs nginx-TLS; seccomp/cap_drop только у catalog в обоих; `NODE_TLS_REJECT_UNAUTHORIZED=0` у gateway в обоих.

### 1.2 Dockerfiles (7)

- Базы: все `node:24.22.0-bookworm-slim@sha256:a5f4366e...` (ARG); frontend — 2 стадии (build + `nginx:1.30.6-alpine@sha256:...`), остальные single-stage.
- **`USER` отсутствует во всех 7** — все контейнеры root (кроме nginx-worker'ов).
- TLS-off зашит в **все 7**: каждый `npm ci` с `NODE_TLS_REJECT_UNAUTHORIZED=0` + `--strict-ssl=false` + `ENV NPM_CONFIG_STRICT_SSL=false`; api-gateway дополнительно `ENV NODE_TLS_REJECT_UNAUTHORIZED=0` — персистентно в рантайме; catalog: `apt-get -o Acquire::https::Verify-Peer=false` + `curl --insecure` для PGDG-ключа.
- npm: `NPM_CONFIG_REGISTRY=https://registry.npmjs.org/`, `USERCONFIG=/dev/null`, `GLOBALCONFIG=<пустой файл>` — machine-`.npmrc`/креды никогда не участвуют.
- CA: `ARG NEUROCENTER_BUILD_CA_SHA256/NAME` → `COPY docker/build-ca/<name>` → `extra.pem` с `sha256sum --check` + `chmod 0444` → `NODE_EXTRA_CA_CERTS` (всех 7); catalog дополнительно вшивает в системные CA для apt.
- catalog: `postgresql-client-16` (PGDG), `bubblewrap`, дерево `/tools` для in-image нативных сборок.
- rag-sync: MCP-мост `mcp/neurocenter-asset-sync` собирается в образе, lancedb-биндинги `--include=optional`.
- EXPOSE: 4000/4100/4400/4200/4300/22222/8080; CMD `node dist/main.js` (frontend — nginx).
- Куда пушатся образы: **никуда** — локальные теги `neurocenter/*`; registry-публичений нет.

### 1.3 CI/CD

- **Отсутствует**: нет `.github/workflows` и каких-либо CI-конфигов; remote — `github.com/ghost-raven1/neurocenter.git`.
- Сборка/деплой — вручную на машине оператора: `dev.sh`, `scripts/docker-build.mjs compose build` (обёртка `withDockerBuildCa`), `setup.mjs build` (проверка ≥6 GiB свободного места). Публикация в docker/npm-registry не выполняется; `update.mjs` использует `--pull never`.

### 1.4 Setup/seed

- `setup.mjs configure|check|build|seed|up|status --directory <priv>`.
- `configure`: wizard или `--json-stdin` → каталог 0700, `.env` 0600 (не symlink), `secrets/`: `postgres_password`, `internal_token`, `metrics_token` (64 hex), `model_credential_key(+.id)`, `catalog_url/rag_url/rag_provision_url/backup_url` (PG-URLs ролей `nc_catalog/nc_rag/nc_provisioner/nc_backup` с сгенерированными паролями), `sso_client_secret`. Валидация: `panelUrl/ssoHost` только https+DNS, `release ≠ latest`.
- `up`: ensure metrics/model-ключ → проверка TLS-файлов → `maintenanceLock` → `up --wait postgres` → `--profile setup run database-init` (роли NOSUPERUSER/NOREPLICATION, `GRANT pg_read_all_data TO nc_backup`, `nc_rag_template`) → schema `check`+`migrate` → квитанция `schema-initialization.json` (только первая установка) → assert model-ключ через psql.
- `seed`: `--profile setup run bootstrap-admin` (`BOOTSTRAP_ADMIN_EMAIL`).
- Идемпотентность: существующие секреты не перегенерируются; повтор `seed/up` возможен только с теми же образами/конфигурацией/кластером; update-квитанция `wx`-single-writer.
- Dev: seed отсутствует; `SSO_DISABLE=true` (mock-юзер), `RAG_AUTH_DISABLED=true` (обход role-gate).

### 1.5 Backup/DR

- Полная **offline quiesced** копия — `scripts/production/recovery.mjs` (`backupOperation`): `maintenanceLock` + `databaseLifecycleLock`; стоп приложений (`stop --timeout 45`); контроль: нет других PG-клиентов, нет незавершённых `bridge_jobs`; `pg_dump --format=custom` **каждой** БД (catalog, rag, все `nc_rag_<hash>`); 4 тома (`skills, projects, backups, runtime-artifacts`) копирует read-only `network: none` helper-контейнер (DAC_OVERRIDE/FOWNER, sha256 на файл, ≤200000 файлов); экспорт точных версий snapshot-объектов (S3) и chat-оригиналов (два приватных S3-бакета, включая null-version); манифест `neurocenter-recovery-v4` + SHA256 + `verifyBackup`; переименование из `.partial`; бюджет паузы `pauseBudget(maxPauseMs)`.
- Что НЕ копируется: `model-weights` (осознанно — «веса воспроизводятся из релиза»), `capacity` (производный), production-конфиг/секреты (документировано: хранить отдельно).
- Внешний транспорт — `external-backup.mjs`: только HTTPS-DNS S3 endpoint (SSRF-гарды, запрет IP/localhost/redirect), SigV4, блоки 32 MiB, `If-None-Match: *`, **GET+SHA readback каждого PUT**, manifest последним; `INDEPENDENT=true` — операторское заявление.
- Расписание: политика в БД (`maintenance_settings`/`maintenance_runs`, PATCH `/api/maintenance/policy`): дни/окна/IANA-tz/`maxPauseMinutes`/`localCopies`/RPO/RTO; runner — `maintenance.mjs tick` (атомарный claim, retry ≥5 мин, гейт флагом `project_backups`); systemd: `deploy/maintenance/neurocenter-maintenance.{service,timer}` (каждую минуту, `Persistent`, `User=neurocenter-operator`, `backup-root /srv/neurocenter-backups`, `TimeoutStartSec 6h`).
- Мониторинг: `deploy/production/monitoring/prometheus.yml` (Bearer `metrics_token`, 5 целей в backend-сети) + `neurocenter-alerts.yml` (9 алертов).
- Восстановление: `previewRestoreProduction` (полная верификация **до** создания PG; **те же образы**, что при копировании; только новый Compose-проект — `assertNewTarget`) → `restoreProduction`; web-restore из UI: подтверждение `RESTORE <target>` → отдельный host-runner (`web-restore-runner.mjs`, control-токен, `127.0.0.1:44101`).
- Приёмки: «Приёмка на независимом S3 и восстановление на другом физическом хосте ещё не выполнены» — `docs/external-backups.md`; RTO — «цель до измеренной репетиции».
- Replica/hot-бэкап (WAL, streaming): **отсутствуют** — только полные офлайн-копии.

### 1.6 Upgrade-путь

- Сервер: `setup.mjs build` (сборка на хосте из git-checkout, корп. CA через `withDockerBuildCa`) → `update.mjs preflight|apply`.
- План `neurocenter-update-v1`: `sourceRelease/targetRelease` (не `latest`), **pinned sha256 digest всех 7 app-образов + `postgresImage`**, `catalogMigrations` (опись из точного нового образа), `migrationCompatibility: backward-compatible|restore-required`, `rollback: 'restore-new-project'` (обязательно), `rehearsalSha256` (квитанция репетиции на копии данных: passed/copyOfData/settingsPreserved/repeatSafe/restoreVerified), `maxPauseMs` 60 с…24 ч.
- Preflight: топология не меняется (secrets/тома/env — отказ), совпадение локальных image ID, **история миграций = точный префикс** (`assertMigrationPrefix`), model-ключ, `NEUROCENTER_RELEASE` в `.env` = sourceRelease.
- Apply: preflight-копия до паузы → `withQuiescedProductionBackup` (полный offline backup в `--backup-destination`) → `migrate` (с бюджетом) → `up -d --no-build --pull never --wait` → `assertLive` → **атомарная замена `NEUROCENTER_RELEASE` в `.env`** → квитанция `planned→backed-up→applying→completed/failed` (сбой → стоп целевых + запись).
- Миграции: `schemaServices = [catalog-service, feature-flags-service, rag-sync-service]` — `dist/database/migrate.cli.js manifest|check|migrate` из **pinned-образа**; журнал `catalog_schema_migrations` (version/name/checksum); история неизменяема; rag-миграции scoped (scope+version).
- Rollback: **только** restore-new-project из pre-update копии; «старые комплекты восстанавливаются прежним инструментом и его точными образами».
- Откуда образы нового релиза: «Образы нового и прежнего выпусков должны уже находиться на хосте»; реестра нет.
- Bridge-клиент: `/api/bridge/{install.sh,install_opencode.sh,install.ps1,connect.sh,connect.ps1,install_workspace.*}` из `bridge-dist` (git-tracked шаблоны; `context.cjs`/`connect.cjs` встраиваются через `__BRIDGE_*__` токены); в prod bridge-dist **запечён в образ gateway** (`COPY bridge-dist/`), в dev — bind-том. SHA-256 проверяется; скачивание — с отключённой TLS-проверкой (`curl --insecure` / `-SkipCertificateCheck`). Update-флоу моста: блокировка параллельной установки, сохранение прежней версии, откат на совместимую при отказе регистрации; cleanup-политика (2 последние проверенные копии, 7–90 дней).
- Артефакты моста/OpenCode (~750 MB: `bridge-dist/runtime`, `bridge-dist/opencode`) сталятся на build-машине (`assets:sync`/`bridge:prepare`) и попадают в образ — `.dockerignore` их **не исключает**.

### 1.7 Environments

- **dev**: `docker-compose.yml` (+overlay'и) + node-сервисы на хосте (dev.mjs), `.env`/`.env.local`, `SSO_DISABLE=true`, `RAG_AUTH_DISABLED=true`.
- **production**: `compose.production.yml` + приватный конфиг-каталог + опциональные overlay (`chat-storage.yml`, `snapshots.yml`, `web-restore.yml`, `packager-apparmor.yml`) + systemd maintenance + prometheus-конфиг.
- **staging: отсутствует** (`scripts/snapshots/staging.mjs` — staging файлов снимков проекта, не environment).

### 1.8 CA/сертификаты

- **Внутренний CA: отсутствует.** Инструментов генерации/ротации в репозитории нет.
- TLS-кромка = nginx (frontend): сертификат+ключ **поставляет оператор** (`TLS_CERT_FILE`/`TLS_KEY_FILE` → compose secrets → `/run/secrets`); self-signed — только «в автоматическом изолированном тесте».
- Rotation: замена файлов + пересоздание контейнера frontend; механизма reload/алерта на срок действия **нет**.
- Межсервисный трафик (backend-сеть) — plain HTTP.
- Build-time CA: `docker/build-ca/` — **13 публичных корпоративных CA закоммичены** (+`extra.pem`); на каждую сборку файл стейтится с sha256-pinning.

### 1.9 Registry-provisioning

- Docker: удалённого registry в контуре нет; `ollama`/`pgvector` — официальные с digest; `neurocenter/*` — только локальные сборки.
- npm: Docker-сборки и host-сборки — **`registry.npmjs.org`** с пустыми user/global npmrc (machine-конфиг изолирован); корпоративный Artifactory для neurocenter **не используется**.
- Аудит (dep-registry-audit.md, 2026-11-05): 987 unique → 694 доступны, 249 с несоответствием версий, **44 не найдены** (24 npm + 17 нативных биндингов + `@neurocenter/ollama-runtime` + 2 `file:`-зависимости).
- Private-пакеты резолвятся через `file:`-зависимости: `@neurocenter/ollama-runtime` = `file:vendor/ollama-runtime`, `@neurocenter/asset-contract` = `file:vendor/asset-contract`.
- Тулинга/процесса добавления 44 пакетов в Artifactory **нет**.

### 1.10 Resource limits (production)

- `mem_limit`+`cpus` — у **всех 12** сервисов: model 5g/4, postgres 1g/2, capacity 128m/0.25, catalog 512m/1, ff 256m/0.5, skills 512m/1, rag 2g/2, oauth 256m/1, gateway 512m/1, frontend 128m/1.
- `pids_limit` — только model-runtime **512**, capacity-collector **32**, feature-flags **128**. **Нет** у: postgres, catalog, skills, rag, oauth, gateway, frontend, database-init, bootstrap-admin.
- `read_only` — только capacity-collector; `cap_drop ALL` — catalog (dev+prod), model-runtime (prod), capacity (prod); seccomp — catalog; apparmor — опциональный overlay.
- Dev: pids_limit **ни у кого**, log-rotation — только в embedding-overlay, restart policy — только у model-runtime/postgres.

## 2. Дыры

**`[SEV: high]` H1 — Нет CI/CD, нет image registry, нет подписи/провенанса.** Релиз = ручная `docker build` из локального checkout на машине оператора; «pinned digest» вычисляется из той же локальной сборки. Сценарий: дрейф/компрометация build-машины → произвольный код в production под видом проверенного digest; независимая воспроизводимость сборки невозможна.
**`[SEV: high]` H2 — `NODE_TLS_REJECT_UNAUTHORIZED=0` в production api-gateway** (compose.production.yml:281 + ENV в Dockerfile) — весь outbound HTTPS gateway'а без верификации в production. Стык с AD-15.
**`[SEV: high]` H3 — Все 7 сервис-контейнеров работают root (нет `USER`).** RCE/уязвимость в любом node-сервисе = root в контейнере. Стык с AD-4.
**`[SEV: high]` H4 — Нет `pids_limit` у 9 из 12 production-сервисов.** Fork-бomba в gateway/catalog → исчерпание pids/OOM хоста. Стык с AD-4.
**`[SEV: high]` H5 — Production bridge-endpoints разбиты: `BRIDGE_TEMPLATES_DIR` не задан, `BRIDGE_DIST` — мёртвая переменная.** Fallback `bridge.controller.ts:18` = `/bridge-dist` (не существует; реально `/app/bridge-dist`). В production `/api/bridge/install.sh|connect.sh|...` → 404. Фактический дефект, не дизайн-решение.
**`[SEV: high]` H6 — DR не верифицирован, и образы не входят в DR.** Restore требует **теже** image digest; registry отсутствует (H1); production-секреты вне бандла без механизма их независимого хранения. Гибель хоста (включая docker-объекты) → S3-бандл недостаточен.
**`[SEV: med]` M1 — Bootstrap-установщики моста скачивают с отключённой TLS-проверкой** (`curl --insecure`, `-SkipCertificateCheck`); SHA-256 выдаёт тот же Gateway — MITM подменяет архив и `.sha256` одновременно. Стык с AD-15.
**`[SEV: med]` M2 — Нет механизма ротации и контроля срока действия TLS-сертификата** (file secrets, создаются один раз; нет reload, нет алерта на expiry).
**`[SEV: med]` M3 — Отсутствует staging.** Репетиция update — на том же хосте, на копии данных.
**`[SEV: med]` M4 — Production-хост = build-хост; supply моста берётся из ФС build-машины** (~750 MB `bridge-dist/runtime|opencode`, stale-риски, `.dockerignore` не исключает).
**`[SEV: med]` M5 — Postgres production: mem 1g на все проектные БД, без pids_limit, квоты логические.**
**`[SEV: med]` M6 — `strict-ssl=false` закоммичен в `.npmrc` и зашит во все Dockerfile/host-сборки.** Фактическая защита — только lockfile integrity (sha512). Стык с AD-15.
**`[SEV: med]` M7 — Нет хостового супервизора production-стека** (после ребута — только `restart: unless-stopped`; кто контролирует, что стек и мониторинг живы — не определено).
**`[SEV: med]` M8 — Нет процедуры ротации внутренних секретов** (one-shot генерация; runbook'ов нет).
**`[SEV: low]` L1 — Dev compose без лимитов и изоляции.**
**`[SEV: low]` L2 — 13 корпоративных публичных CA закоммичены в `docker/build-ca/`.**
**`[SEV: low]` L3 — `database-init`/`bootstrap-admin` без mem/pids-лимитов.**
**`[SEV: low]` L4 — Dev-дефолты обходов в `.env.example` (`SSO_DISABLE=true`, `RAG_AUTH_DISABLED=true`).**
**`[SEV: low]` L5 — Local backup-root проверен только «вне docker-томов», а не «на отдельном физическом диске».**

## 3. Кандидаты AD для architecture-operational spine

1. **AD-OP-1 — Deployment как данные.** Единственная машино-читаемая модель окружения (сервисы, образы+digest, сети, лимиты mem/cpus/pids, read_only/cap/seccomp, секреты, порты), от которой compose-файлы (dev/prod/overlay'и) сверяются drift-тестом; мёртвые env-переменные (типа `BRIDGE_DIST`) и расхождения dev↔prod — фэйл. Закрывает: L1, L3, часть H4, H5.
2. **AD-OP-2 — Модель поставки релиза и образов.** Build → publish в internal registry → signed manifest (digest 7+1 образов + supply-манифест bridge-dist + описи миграций); production тянет только из registry; разделение build-хоста и production-хоста. Закрывает: H1, M4, половину H6.
3. **AD-OP-3 — Upgrade-модель (ратификация + допущения).** План `neurocenter-update-v1` принять как эталон; явно описать: supply целевых образов до update, отсутствие in-place rollback, maxPauseMs как SLO-параметр. Закрывает: ядро M3, часть H6.
4. **AD-OP-4 — DR-модель.** Scope бандла vs вне; RPO/RTO как измеримые цели; критерии готовности: приёмка на независимом S3 + cross-host restore + supply образов; ротация секретов как DR-компонент. Закрывает: H6, M2, M8, L5.
5. **AD-OP-5 — Environments и config-матрица.** Матрица dev/(staging?)/production: что может отличаться, что запрещено; запрет dev-дефолтов в production-конфиге. Закрывает: M3, L4.
6. **AD-OP-6 — Production resource limits как контракт.** Таблица mem/cpus/pids/read_only/cap/seccomp на сервис (включая postgres-tuning, database-init/bootstrap-admin); pids для child-MCP — стык с AD-4. Закрывает: H3 (с non-root), H4, L3, M5.
7. **AD-OP-7 — TLS/CA lifecycle (операционная часть).** Политика TLS-off per окружение/этап с целевым состоянием (стык AD-15); ротация edge-сертификата, алерт на expiry; межсервисный HTTP как residual или TLS внутри. Закрывает: H2, M1, M2, M6.
8. **AD-OP-8 — Supervision & monitoring.** Что живёт на хосте (systemd stack-watchdog, prometheus, node_exporter — отсутствуют); матрица алертов (9 + expiry-cert + stack-down). Закрывает: M7.
9. **AD-OP-9 — Registry-provisioning (npm) — только ссылка на AD-15** + interim: `strict-ssl=false` в build-этапах с переходным планом (M6); запрет наследования machine-`.npmrc` (ратификация).

Отдельно (не AD, а дефекты): H5 (битый production-резолв bridge-шаблонов — fix) и H6-приёмки (критерии готовности production-допуска).
