# Neurocenter — архитектурные проблемы (вход для bmad-architecture spine)

Объём: A1–A5 (архитектурные) + C1–C7 (связность). База: `def34f9d` + заход 1 (аудит-фиксы).

## Trust model (исходная карта)

- **Доверенный сервер**: api-gateway, catalog-service, oauth2-bridge, rag-sync-service, production-скрипты (compose/setup/recovery).
- **Недоверенная машина пользователя**: `mcp/neurocenter-asset-sync` (bridge: runtime-artifact-download, cache, bridge CLI), `bridge-dist/install.sh`.
- **Общий код через границу**: `services/shared/runtime-artifacts.cjs` выполняется и на сервере (verify билет), и на клиенте (bridge re-экспортирует через `mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts`).
- **Pinned vendor**: `vendor/asset-contract` (SHA256SUMS + SOURCE.json, byte-exact) исполняется на обеих сторонах.
- **Политики в DB**: `services/shared/runtime-limits.cjs` — DEFAULT_RUNTIME_LIMIT_POLICY + RUNTIME_LIMIT_CEILINGS, хранение в DB, HTTP `/internal/runtime-limits`, UI, аудит.

## A-проблемы (архитектура)

### A1. Общий код на обеих сторонах trust-границы с client-controlled конфигурацией
- `services/shared/runtime-artifacts.cjs` → `LIMITS` читает `process.env` (NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES/_MAX_UNPACKED_BYTES/_MAX_FILES/_CACHE_BYTES) при module load.
- Клиентский контур: `mcp/neurocenter-asset-sync/src/bridge/runtime-artifact-download.ts:29` (`artifact.compressedBytes > LIMITS.compressedBytes`), `cache.ts:80` (`limitBytes = LIMITS.cacheBytes`).
- Следствие: сила клиентской анти-zip-bomb/кэш-защиты зависит от env на машине пользователя. Установив завышенный env, пользователь ослабляет client-side guard.
- Требование: server-лимиты и client-лимиты — **разные источники доверия**; клиентские лимиты — константа контракта (не env), серверные — настраиваемые с потолком.

### A2. Фрагментация архитектуры лимитов/политик
- «Правильная» система: `services/shared/runtime-limits.cjs` (дефолт + потолок + DB + аудит + UI + `/internal/runtime-limits`).
- Параллельно: env-лимиты runtime-artifacts (введённые заходом 1), константы (`TOOL_SOURCE_MAX_BYTES`, `QUIRKS_LIMITS`, gguf `RUNTIME_LIMIT_CEILINGS`, text-knowledge), отдельные policies (`gguf-import-policy.cjs`, `project-text-knowledge.cjs`).
- Каждый новый лимит добавляется ad-hoc с разной моделью настраиваемости → governance расползается.
- Требование: единая модель: класс лимита (contract-константа / policy с потолком / infrastructure env) + единое место регистрации + единая валидация.

### A3. Pinned-контракт vs runtime-конфигурация
- `vendor/asset-contract/lib/asset.mjs` — byte-pinned (SHA256SUMS/SOURCE.json), но читает env в рантайме (заход 1: limitEnv).
- «Контракт» с зафиксированными байтами и поведением, зависящим от окружения — неконсистентно.
- Требование: конфигурируемость — на границе приложения, а не внутри pinned-артефакта; pinned-контракт = константы контракта.

### A4. Fat-proxy / leaky abstraction в gateway
- `services/api-gateway/src/proxy/proxy.service.ts`: allowlist device-channel, per-route таймауты (60000/85000/120000), maxContentLength-override, спецкейс TOOL_IMPORT_ROUTE.
- Знание про роуты/бюджеты каталога дублируется на границе прокси: каталог меняет таймаут → gateway синхронно правит хардкод.
- Требование: политика роутов — декларативный конфиг (единый источник), прокси — механизм.

### A5. Revocation билетов: декларация, не механизм (подтверждено по коду)
- `services/api-gateway/src/features/mcp-host/ticket.ts`: stateless HMAC-билет, TTL 30 дней (HOSTED_MCP_TTL_MS).
- Канал `m/:ticket` (`mcp-host.controller.ts:140-150`): только `verifyHostedMcpTicket(ticket)` = HMAC + exp + форма + лимиты. **Нет** ре-check привязки device↔project, нет проверки статуса устройства на каждом вызове.
- Per-ticket отзыв невозможен; ротация секрета убивает все билеты.
- Дизайн-вопрос: revocation-check на verify (легкий DB/redis-lookup по device, negative cache) или явная модель «билет действует до отзыва привязки + rotation».

## C-проблемы (связность)

### C1. God-модуль `services/shared/runtime-artifacts.cjs`
- Fan-in ~40: 4 NestJS-сервиса + catalog-plugins + production + test + клиентский bridge.
- Низкая сплочённость: 4 конгломерата — path-validation, TARGETS, LIMITS, archive-inspection (zip/tar). Разная частота изменений, разный trust-контекст.
- Плюс (заход 1) глобальное мутабельное состояние: env-LIMITS на module load.
- Направление: расщепить по ответственностям (paths / targets+platform / limits / archive) с единым индексом.

### C2. Ручные `.d.cts`-зеркала `.cjs`
- `runtime-artifacts.cjs` + `runtime-artifacts.d.cts` правятся вручную; drift = молчаливая потеря типобезопасности на границе CJS/TS.
- Направление: генерация деклараций из CJS (типогенератор/ast-grep) или миграция hot-модулей в TS.

### C3. Тройная репликация platform-детекции
- glibc/musl через `process.report.getReport()` написан 3 раза: `catalog-service/src/devices/runtime-host-target.ts`, `api-gateway/src/features/mcp-host/host-target.ts`, `scripts/catalog-plugins/verify-runtime.mjs` (заход 1 привёл к одной канон-логике, но три копии).
- Хрупкость: `process.report` — не стабильный публичный API.
- Направление: одна `getHostTarget()` в shared; остальные — обёртки.

### C4. Лестница дедлайнов 480/540/550
- `services/shared/tool-import-deadline.cjs`: CATALOG=480s, GATEWAY=+60, CLIENT=540+10. Инварианта client > gateway > catalog держится вручную.
- Направление: один источник + invariant-тест (порядок и минимальный margin).

### C5. Fallback-цепочка секретов схлопывает trust-domain
- `api-gateway/src/features/mcp-host/ticket.ts`: `NEUROCENTER_MCP_HOST_SECRET || NEUROCENTER_INTERNAL_TOKEN`.
- Утечка internal-токена → подделка host-билетов.
- Направление: независимые креды; fallback убрать (или только dev-профиль с явным флагом).

### C6. Тесты связаны с `dist/`, а не с `src/`
- `scripts/test/blitz-flow.test.mjs` и др. грузят `services/*/dist/...` через createRequire.
- Обязательный rebuild перед прогоном; риск «проходит у меня, падает в CI».
- Направление: тестировать src (ts-node/tsx или vitest) либо явный build-шаг в test-плане + проверка freshness dist (git hash в dist).

### C7. Config sprawl — нет центральной схемы
- `NEUROCENTER_MCP_HOST_SECRET`, `NEUROCENTER_INTERNAL_TOKEN`, `SESSION_TTL_SECONDS`, `CATALOG_SERVICE_URL`, 4 runtime-лимита — ad-hoc чтение, ad-hoc валидация.
- Направление: единый config-модуль (схема + валидация + документация) на сервис.

## Контрактные ограничения (не ломать)
- Дефолты лимитов: 256 MiB / 1 GiB / 20000 / cache 2 GiB.
- Vendor byte-pinning: любой правок vendor → пересчёт SHA256SUMS + SOURCE.json + total в `scripts/test/asset-contract-vendor.test.mjs`.
- `dist/` читается тестами (пока C6 не решён) — rebuild обязательный шаг.
- Каталог целей TARGETS: 8 платформ; неизвестная libc не подменяется (throw).
- Корневой сьют: 287 файлов, эталон 3693 pass / 0 fail / 38 skipped.
