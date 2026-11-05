# Recon: data layer (PG, storage, retention, quotas, concurrency) — 2026-11-05

Источник: recon-агент (brownfield), полный ввод в architecture-data spine.

## 1. Факты

### 1.1 PostgreSQL: топология, пулы, ORM

- **Один PG-инстанс** в dev и prod. Dev: `pgvector/pgvector:pg16`, user `rag`, порт `127.0.0.1:5432`, volume `pgvector-data`. Prod: тот же образ (pinned by digest), superuser `nc_owner`, `scram-sha-256`, пароль из docker secret, volume `postgres`.
- **Нет ORM**: везде raw SQL через `pg.Pool` (node-postgres), один Pool на модуль, `application_name` на сервис.
- БД в dev: `rag` + `catalog`. БД в prod: `catalog`, `rag`, `nc_rag_template` (+ создаваемые лениво `nc_rag_<sha256>`). Роли: `nc_catalog/nc_rag/nc_provisioner/nc_backup`. Prod-init под advisory-локом `72465382`.
- **Ghost DB**: `skills` создаётся в dev-init, но ни один сервис к ней не подключается.
- Per-project RAG-базы: LRU-пул кэш **макс 8** соединений, одновременных provisioning **макс 8**; provisioning из `nc_rag_template` через `nc_provisioner`: `CREATE DATABASE ... OWNER nc_rag TEMPLATE nc_rag_template`.

### 1.2 Миграции: три независимые системы

| Система | Лок (advisory xact) | Ledger | Версии |
|---|---|---|---|
| catalog | `hashtextextended('neurocenter:catalog:migrations',0)` | `catalog_schema_migrations (version,name,checksum)` | 0…52 (53 миграции) |
| RAG (шаблон + per-project) | `neurocenter:rag:migrations` + структурные `neurocenter:rag-generation-schema`, `neurocenter:database-lifecycle-schema` | `neurocenter_rag_migrations` (именованные) + **отдельный замороженный** ledger quota-миграции | именованные + `neurocenter_rag_schema_versions` |
| feature-flags | **разделяет лок с catalog**: `neurocenter:catalog:migrations` | `feature_flags_schema_migrations` | v1 |

- Чексумы: sha256 SQL-текста в ledger; откатов нет, только вперёд.
- `security_events` создаётся **двумя** службами с одинаковым DDL (catalog `access-schema.ts` + feature-flags `feature-flags-schema.ts`); целостность индекса проверяется в feature-flags — осознанная связка, общая таблица + общий лок.
- Каждый модуль, трогающий catalog DB, при инициализации вызывает `ensureCatalogSchema` (идемпотентно, под тем же advisory-локом).

### 1.3 Таблицы (~170)

**catalog DB** (catalog-service + feature-flags-service): ledger'ы; проекты/доступ (`projects` с JSONB `quota`, `project_members`, `project_assets`, `project_models`, `platform_users`, `platform_bootstrap`); публикация/каталоги (`ai_plugins`, `ai_plugin_versions`, `model_catalog(+versions)`, `agent_catalog(+versions)`, `catalog_requests(+events+mutations)`, `catalog_reactions`); asset-sources (`asset_management_operations/impacts`, `asset_native_migrations`, `asset_source_blobs/blob_refs/jobs/receipts/refresh/snapshots/versions`, `bridge_source_checks/settings`); bridge/устройства (`bridge_devices` (token_hash, expires_at 30д, report JSONB), `bridge_pairs` (10-мин коды), `bridge_jobs`, `bridge_job_requests` (UNIQUE(email,request_key) + partial unique state='running'), `bridge_runtime_artifacts`, `bridge_instance_events`, `bridge_local_change_plans`, `bridge_hosted_rag_grants` (+8-табличный ревакоу-триггер), `device_install_plans`); retirement/backup/maintenance (`legacy_retirement_*`, `project_retirements`, `retired_rag_previews/purges`, `project_backups`, `backup_state`, `maintenance_runs/settings`); snapshots (`project_snapshots`, `project_snapshot_blobs/blob_refs/blob_writes/commands/cancelled_commands/cancelled_requests/profiles/verifiers`); restore (`web_restore_jobs/runner/cancelled_requests`); chat (~30 таблиц: conversations/turns/objects/agent_responses/attachments/attachment_transfers/compactions/discussions/discussion_steps/research_steps/text_contexts/search_jobs/search_revisions/search_vectors (эмбеддинги `double precision[]`, **не pgvector**)/presence_sessions/system_role_origins/project_chat_*/system_role_*/discussion_*/browser_auth_sessions); модели/usage (~20: model_api_dispatch_slots/rate_limits, model_creation_requests, model_device_connections, model_gguf_runtime_intents/uploads (expires_at/cleaned_at), model_hosting_jobs, model_remote_connections, model_usage_calls, model_user_token_quota_requests/quotas, opencode_managed_models/model_identities/model_snapshots/model_sources/model_sync_settings, remote_provider_user_credentials/requests, project_embedding_settings, project_reindex_plans, project_rag_sync_intents, runtime_limit_requests/settings); агенты/tools (`project_agents`, `project_agent_sets`, `agent_mutation_requests`, `agent_readiness_trials`, `agent_tool_steps`, `tool_build_agent_steps/cancellations/jobs/runtime_checks`, `tool_source_uploads`); learning (~10 `project_learning_*`); прочее (`feature_flags`, `security_events`, `operations`, `operation_action_requests`, `plugin_auto_update_policies`, `skill_audit_receipts`, `skill_dependency_reservations`).

**RAG DB** (`rag` / `nc_rag_template` / `nc_rag_<sha256>`): `rag_chunks`, `rag_generations`, `rag_index_state`, `rag_write_receipts`; quota: `rag_storage_settings`, `rag_storage_budget`, `rag_quota_events`; lifecycle: `neurocenter_database_identity`, `neurocenter_project_databases`, `neurocenter_database_purge_receipts`, `neurocenter_rag_schema_versions`, `neurocenter_rag_migrations`; text/platform-схемы.

### 1.4 Диск: volumes и содержимое

| Volume | Кто пишет (mode) | Содержимое |
|---|---|---|
| `postgres` | PG rw | данные 3 БД + per-project `nc_rag_*` |
| `runtime-artifacts` → `/app/runtime-artifacts` | catalog rw | `<sha256>.tar.gz` (content-addressed, immutable), `.`-partial (tmp+rename), `.gguf-imports`, `.source-uploads` (tmp 256MiB), `.project-snapshots` (dev FS-fallback) |
| `backups` → `/app/backups` | catalog + maintenance | dump `projects/<sha32>/<label-...-uuid>.dump` (pg_dump custom, per DB), **keep 5** на location, бюджет 64GiB |
| `projects` / `/data/projects` | **catalog rw + rag-sync rw** | локальные файлы проектов (двойной доступ) |
| `model-weights` | **двойной писатель**: model-runtime (ollama `/root/.ollama`) rw + catalog rw (хидратация) | GGUF-веса |
| `skills` | skills-service rw | `.md` + `.neurocenter-skill-versions/<hash>/<hash>/<v>.snapshot` (immutable, **без prune**) |
| `capacity` | capacity-collector rw | `/capacity/snapshot.json` ≤ 32KiB; ресурсы: postgres, wal, skills, projects, backups, runtime-artifacts (**model-weights не мониторится**) |
| gateway artifact cache | tmpdir контейнера (volume отсутствует) | `NEUROCENTER_MCP_HOST_DIR || tmpdir/neurocenter-mcp-host`; **квоты и eviction нет** |
| chat-вложения | Ceph/S3 | S3-объекты + PG transfer-queue |
| snapshots (prod) | catalog → S3/MinIO (обязателен) | key `projects/<sha256(project)>/blobs/<sha256>`; chunk 64MiB |

### 1.5 Retention / purge

| Механизм | Что чистит | Автоматичность |
|---|---|---|
| source-uploads sweep | tmp-загрузки 256MiB, `expires_at` | timer |
| GGUF drafts | `model_gguf_uploads` с `expires_at` (ACCEPTED хранится) | timer |
| project dump prune | keep **5** per location | backup-tick |
| snapshot GC | 2-фазный `DELETING`, refcount | **только по HTTP от внешнего verifier**, cron отсутствует |
| RAG-DB retirement purge | **ручной** (`automaticPurge: false`), 3 стадии preview→purge→receipt, freeze+DROP | ручной |
| full-backup retention | `policy.localCopies` | systemd timer → maintenance.mjs tick |
| bridge_pairs | просроченные коды | при операциях |
| **Отсутствует purge** | `security_events`, `operations`/`operation_action_requests`, `bridge_jobs`, `bridge_runtime_artifacts`+tar.gz, `ai_plugin_versions`, `model_usage_calls`, skill-versions, `rag_quota_events`, chat-таблицы, `maintenance_runs`, `retired_rag_previews` (expires_at есть, чистильщика нет), `bridge_local_change_plans` | — |

### 1.6 Quotas

**Принудительно (DB/код):** RAG per-project byte budget: default **1GiB**, max **16GiB** — enforcement **deferred constraint triggers**; write-lock-триггер. Snapshots: per-project **64GiB**, всего **256GiB** + free-space check; chunk 64MiB. Backup-бюджет 64GiB; capacity reservations через `reserveCapacity`. GGUF: лимиты в `model_gguf_uploads.limits` + pending-сумма. Chat: вложения 10MiB; text 128KiB; token-квоты; rate limits; build-slots.

**Только объявлены (enforcement отсутствует):** `projects.quota` JSONB (`currentBytesLimit`/`retentionBytesLimit`/`stagingBytesLimit`, default 0) — **ноль кода, читающего/принуждающего**. AD-1/AD-4 «quota + eviction artifact cache» — в коде **отсутствуют** (cache gateway не ограничен).

### 1.7 Каталог (asset-contract index)

- `index.json`: `schemaVersion 1`, ≤1000 assets, `assets/<id>/<version>/asset.json`.
- Эволюция: `assertIndexEvolution` — опубликованные версии immutable, head-смена никогда не переписывает версию.
- Источники: pinned GitHub raw index.json / загруженные архивы; доставка — immutable GitHub Releases.
- Конкурентный publish: `ai_plugins.publication_key` unique + fingerprint `publication_hash`.

### 1.8 Snapshots

- Полный образ (LanceDB+файлы), chunked upload 64MiB, manifest+signature; статусы `UPLOADING→…→DELETED`; head-указатель `projects.head_snapshot_id`.
- Внешний verifier: leases claim/renew/complete/reject; GC только по его запросу.
- **Restore не in-place**: `web_restore_jobs` (kind=preview|restore), target — новый проект `neurocenter-restore-*`, SHA-верификация чекпоинта до первой записи, journal `job.id.json`, резервирование источника, токен `RESTORE_RUNNER_TOKEN(_FILE)`.

### 1.9 Конкурентность

- Advisory locks: `neurocenter:catalog:migrations` (catalog **и** feature-flags), `neurocenter:rag:migrations` + 2 структурных (RAG), `project-lifecycle:<id>`, `snapshot-storage`, `72465385` statement-level RAG-write, `72465382` prod-init, `72465401/402` uploads, `53709168` maintenance.
- Row locks: `FOR UPDATE`/`FOR SHARE` на bridge-записях, lease-токены jobs.
- Double-booking: `UNIQUE(email,request_key)` + partial `UNIQUE (true) WHERE state='running'`.
- Crash-consistency: tmp+rename+fsync (runtime artifacts), 2-фазные blob-write + recover, upload-leases с recheck 500ms; **backup lock file освобождается вручную после краха**.

### 1.10 Device bindings

- `bridge_devices` (token_hash, expires_at 30д, `report` JSONB — client-reported, в т.ч. `->>'bindings'`), `bridge_pairs` (10-мин коды, sweep), `bridge_hosted_rag_grants` (ревакоу-триггер по 8 таблицам), `device_install_plans` (pending/approved/revoked).
- Lifecycle: pairing → device poll → job lease → install plan → approval → job; unbind = `revoked=true`; deactivation по `expires_at`.
- Орфаны: `bridge_local_change_plans` (`expires_at` есть, cleanup отсутствует).

### 1.11 Data flow: установка артефакта

publish → `ai_plugin_versions` + index (immutable) → device install plan (approval) → enqueue `bridge_jobs` → device poll через gateway → job-lease-gated стрим из `RUNTIME_ARTIFACT_DIR` (content-addressed tar.gz, лимит 256MiB) **или** GitHub release → опциональный materialized cache в gateway (без квоты) → success triggers.

## 2. Дыры

- `[SEV: high]` **Кэш артефактов gateway не ограничен** (artifact-cache.ts:15) — в prod контейнеру нет volume: кэш в tmpdir, растёт без квоты/eviction; при рестарте теряется. Стык с AD-1/AD-4.
- `[SEV: high]` **Volume `model-weights` с двойным писателем и без мониторинга** — ollama и catalog-service пишут в один volume без общей блокировки; capacity-снапшот не включает `model-weights` — переполнение не видно.
- `[SEV: med]` **Нечитаемые (unbounded) таблицы и файлы** — security_events, operations, bridge_jobs, bridge_runtime_artifacts+tar.gz, ai_plugin_versions, model_usage_calls, skill-versions, rag_quota_events, chat-таблицы, maintenance_runs, retired_rag_previews, bridge_local_change_plans — нет retention/vacuum: рост линейный с трафиком.
- `[SEV: med]` **Удаление проекта не удаляет данные** (project-deletion.ts:32, FK-cascade по БД только) — локальная папка, snapshot-blobs в S3, dump, per-project RAG-БД — ничему каскадом не удаляется. **Важно**: durable ручной механизм RAG-DB retirement/purge **существует** (retired-rag.service.ts, `automaticPurge:false`, 3 стадии, freeze+DROP) — в runtime-trust spine AD-16 «механизма нет» верно только для версий asset'ов; для RAG-БД это референс-паттерн.
- `[SEV: med]` **`projects.quota` JSONB декларативен** — ноль кода принуждения; пользователь видит лимит, который не работает.
- `[SEV: med]` **Ghost DB `skills` в dev** (создаётся, не используется).
- `[SEV: med]` **Backup lock file освобождается вручную после краха** — при падении tick'а сервисы могут остаться остановленными.
- `[SEV: med]` **`security_events` — двойное владение и общий миграционный лок** — две службы создают одну таблицу и конкурируют за лок; целостность — только ручная идентичность DDL.
- `[SEV: med]` **`bridge_devices.report->'bindings'` — client-reported JSONB** — устройство само сообщает bindings; при компрометации токена может заявить чужие.
- `[SEV: low]` **`forwardRuntimeArtifact` в gateway не ре-хэширует** — стрим по длине (256MiB check) без SHA-верификации у получателя.
- `[SEV: low]` **Snapshot GC — только по вызову verifier'а** — если verifier не здоров, `DELETING`-blobs накапливаются в S3 вечно.
- `[SEV: low]` **Dev PG порт на `127.0.0.1:5432`** без пароля-разграничения.

## 3. Кандидаты AD для architecture-data spine

1. **AD: versioning схемы (data-plane migrations)** — три независимых миграционных режима как осознанное решение: единый протокол ledger (version, name, checksum, monotonic, no-rollback) + правило «кто какой лок берёт»; решение о `security_events` как shared-table (owner = один сервис, другой — read-only).
2. **AD: layout хранилища (storage invariants)** — каноническая карта volume→service→mode (включая двойных писателей: `model-weights`, `/data/projects`) + правило «один owner записи на volume» + content-addressing как инвариант. Именно этот AD размещает gateway artifact cache на персистентном volume с eviction (стык AD-1/AD-4).
3. **AD: retention-политика (purge/GC)** — единая декларация: что имеет TTL, что — rolling window, что — ручной; автоматизация (unbounded-таблицы, S3 snapshot-blobs in-process GC-fallback, backup lock TTL); RAG-DB retirement (ручной) — референс-паттерн, расширять на snapshots/backups/local files.
4. **AD: quota enforcement** — разделить «enforced» и «declared» (`projects.quota` — убрать или реализовать); правило: любое quota-поле в API обязано иметь enforcement-точку с указанием файла.
5. **AD: crash-consistency (durable writes)** — канонические паттерны: tmp+rename+fsync, 2-фазные writes + recover-таблица, lease-токены с recheck, idempotency unique indexes; новый durable-store обязан выбрать зафиксированный паттерн; backup lock file → TTL-паттерн. Включить `model-weights` в capacity-ресурсы (стык AD-18).

Дополнительно: asset-contract index (`schemaVersion 1`, immutable versions, ≤1000) — референс «evolution rules for data artifacts» (ссылка из AD-2 runtime-trust).
