# Review: rubric-walker (good-spine checklist) — architecture-runtime-trust

- Spine: `architecture-runtime-trust.md` (status: draft, altitude: initiative, 2026-11-05)
- Reviewer: rubric-walker, независимый контекст (BMad-architecture Reviewer Gate)
- База сверки: `_bmad-output/initiative-architecture/architecture-runtime-trust/input-analysis.md`, `.memlog.md`, код brownfield (`def34f9d` + заход 1)
- Дата: 2026-11-05

## Verdict

**Conditional pass.** Spine ратифицирует brownfield честно (все 5 проверяемых утверждений совпали с кодом), AD Rules в основном исполняемы, диаграммы валидны. Но есть 1 high: AD-7 сплит не учитывает жёсткий 170-файловый потолок prepared-source-snapshot — срез, реализующий AD-7, сломает producer-сборку, если не знает об этом. Плюс отсутствует операционное измерение (deployment/environments/operations) — целая размерность altitude=initiative без решения/deferred/вопроса.

---

## Проверка по пунктам checklist

### 1. Spine фиксирует реальные точки расхождения для уровня ниже — PARTIAL

Карта Capability → Architecture покрывает все A1–A5 и C1–C7 из входного анализа (A1→AD-1/2, A2→AD-1/9, A3→AD-2/1, A4→AD-6, A5→AD-4, C1→AD-7, C2→AD-8, C3→AD-7, C4→AD-6, C5→AD-5, C6→AD-10, C7→AD-9). Пропусков по входному анализу нет.

Но обнаружена **точка расхождения, которой нет в spine**:

#### F1 (high) — AD-7 сплит vs 170-файловый потолок prepared-source-snapshot

- **Что:** `scripts/catalog-plugins/prepared-source-snapshot.mjs`: `PREPARED_SOURCE_MAX_FILES = 170` (жёсткий, превышение → `throw 'Prepared source snapshot превышает 170 публичных файлов.'`), текущий `PREPARED_SOURCE_INPUTS` = **168 записей** (проверено runtime-подсчётом). Комментарий файла: *«Adding a producer/helper requires deliberately extending this retained source set»*.
- **Почему это расхождение для среза:** AD-7 вводит 3 новых файла в `services/shared/` (`runtime-paths.cjs`, `runtime-platform.cjs`, `runtime-archive.cjs`); closure уже содержит `services/shared/runtime-artifacts.cjs` + `runtime-artifacts.d.cts` (клиентский bridge исполняет их в рантайме — facade будет реэкспортировать из новых модулей, значит они тоже нужны в closure). Зеркала `.d.cts` (область AD-8) добавят ещё до 3 файлов. Итого 168 + 3…6 = 171–174 > 170 → snapshot бросает исключение → prepared-сборка каталога ломается.
- **Где в spine:** отсутствует. Конвенция «Pinned-артефакты» (Consistency Conventions) покрывает re-pin vendor и `catalog-source/producer.json`, но prepared-source-snapshot — **отдельный механизм** (захват source-байтов prepared-каталога), и он не упомянут ни в AD-7, ни в Deferred, ни в конвенциях. Memlog упоминает producer-closure (166 файлов `producer.json`), но не prepared-snapshot cap.
- **Последствие:** срез AD-7 получит «молчаливое» разрушение pinned-closure, которое не предсказуемо из spine — ровно тот класс дыры, который good-spine обязан закрыть.
- **Исправление:** в AD-7 (или Deferred с revisit) зафиксировать: новые shared-модули добавляются в `PREPARED_SOURCE_INPUTS` осознанно; при достижении потолка — либо расширение cap с тестом, либо пересмотр набора retained-файлов; ре-пин closure (revision-хэш `capturePreparedSource` пересчитается автоматически — это проверить тестом).

Второстепенные точки, не зафиксированные:

#### F5 (low) — Схема route-таблицы AD-6 не покрывает все бюджеты в proxy.service.ts

- **Что:** AD-6: `route → {timeoutMs, maxContentLength, allowed}`. В `proxy.service.ts` встроены и другие бюджеты: pairing-рейт-лимиты per address (`15`/`6000`/`60`, строки ~469–471), embedding-timeout `115000ms` (строка ~570), snapshot-upload `64 MiB` (строка ~313), model-chats `maxContentLength: 64 MiB` (строка ~366).
- **Почему:** Prevents AD-6 — «бюджеты upstream, закодированные в диспетчерской логике прокси». Срез может интерпретировать таблицу как только `timeoutMs/maxContentLength/allowed` и оставить pairing/embedding-бюджеты хардкодом — сохранится ровно тот divergence, против которого AD. Правило должно явно гласить «таблица покрывает ВСЕ per-route бюджеты прокси» или перечислить исключения.

#### F6 (low) — AD-9 «все сервисы» vs Structural Seed с 4 из 6 сервисов

- **Что:** В репо 6 NestJS-сервисов (api-gateway, catalog-service, oauth2-bridge, rag-sync-service, **skills-service**, **feature-flags-service** — все на `@nestjs/core 11.2.7`, читают `NEUROCENTER_*`). Seed показывает 4; skills-service и feature-flags-service отсутствуют, хотя AD-9/C7 их покрывают («все сервисы, читающие NEUROCENTER_*»).
- **Почему:** seed — не исчерпывающий, но для spine, фиксирующего уровень ниже, пропущенные ноды — повод для неверного среза по AD-9. Добавить ноды или пометку «seed не исчерпывающ».

### 2. AD Rules исполняемы — PASS (с оговорками)

Каждый AD проверен на enforceability:

- **AD-1** — исполняем: два уровня (ceiling-константа / policy в runtime-limits), `default ≤ policy ≤ ceiling` проверяемо в `runtimeLimitPolicy`-стиле валидации (существующий паттерн в `runtime-limits.cjs` строки 32–46), env-ограничение «ниже дефолта, только bootstrap» проверяемо config-модулем, default-значения = контрактные (256 MiB/1 GiB/20000/2 GiB) — сверено с `LIMIT_DEFAULTS` в `runtime-artifacts.cjs` и input-analysis «Контрактные ограничения». Конвенция «каждый security-механизм — прямой тест» даёт верификацию.
- **AD-2** — исполняем: одно поле `limits` дескриптора, fail-closed вне `[1..ceiling]`, запрет отдельного endpoint/env — проверяемо (отсутствие + тест).
- **AD-3** — исполняем: verify = HMAC + exp + форма + `claim ≤ ceiling` + связка `claim.artifactSha256` с дескриптором (DB-lookup по `session.assetId/version` — у claim уже есть `session` с `assetId`, `version`, `manifest` — поля присутствуют в `IHostedMcpSession`, lookup выполним). Явное исключение текущей политики — фиксирует поведение.
- **AD-4** — исполняем: live-binding check при соединении, кэш ≤ 60s (ограничение есть даже до deferred точного значения), отзыв = отвязка/деактивация устройства — проверяемо; residual (ротация секрета гасит все билеты) осознанно принят. Минорная неоднозначность: «при соединении» для stateless канала `m/:ticket` (каждый JSON-RPC-запрос — новое соединение) — фактически означает «на каждом запросе, lookup кэширован ≤ 60s»; сформулировано достаточного для среза, но уточнение не помешает.
- **AD-5** — исполняем: обязательный секрет, absence fallback (в коде реально есть `NEUROCENTER_MCP_HOST_SECRET || NEUROCENTER_INTERNAL_TOKEN` — `ticket.ts:52` — AD нацелен верно), fail-fast на старте, независимая генерация в production setup.
- **AD-6** — исполняем (см. оговорку F5 по полноте схемы).
- **AD-7** — исполняем: фасад + фокус-модули, `getHostTarget()` гlibc/musl/throw, whitelist TARGETS (8 платформ — сверено: `darwin-arm64, darwin-x64, linux-arm64-glibc, linux-x64-glibc, linux-arm64-musl, linux-x64-musl, win32-arm64, win32-x64`), отмена fallback `linux-x64-unknown` помечена как осознанное изменение поведения. Не исполняемая часть — только F1 (потолок closure), который не входит в текст AD-7 как таковой.
- **AD-8** — исполняем: drift-тест `.d.cts`↔`.cjs` (наличие имён + базовая форма) — конкретный артефакт теста.
- **AD-9** — исполняем: typed schema + единая валидация + fail-fast агрегированный отчёт — проверяемо per-сервис; конвенция «config naming NEUROCENTER_*».
- **AD-10** — исполняем: freshness-guard (stamps/hash) до прогона тестов на dist/ — конкретный механизм, «stale = явная ошибка».
- **AD-11** — исполняем на уровне правила (presets внутри ceiling, advisory); механизм deferred, но правило standalone проверяемо.

Ни один AD не «декларирует намерение» вместо предотвращения: у каждого есть проверяемый артефакт (константа/таблица/тест/отсутствие fallback).

### 3. Deferred не создаёт дыр — PARTIAL

Каждый deferred имеет revisit-условие (проверено по списку из 9 пунктов). Анализ дыр:

#### F3 (medium) — Deferred «Конкретные значения ceiling» создаёт дыру согласованности клиент↔сервер

- **Что:** ceiling — одновременно (а) константа контракта в vendor (клиент применяет `min(политика, ceiling)`, AD-2 fail-closed вне `[1..ceiling]`), (б) потолок политики в runtime-limits (AD-1), (в) верификационный порог `claim ≤ ceiling` (AD-3). Значения — deferred: «подтвердить при реализации (определяется максимально допустимым артефактом)».
- **Дыра:** до подтверждения два юнита (bridge с vendor-константами и gateway) могут зафиксировать **разные interim-ceiling** — spine не предписывает обязательный interim. Revisit-условие «при реализации» совпадает по времени с самим срезом, который от ceiling зависит (т.е. defer на решение, необходимое для исполнения AD-1/2/3 в том же срезе).
- **Исправление:** в Deferred (или AD-1) зафиксировать: «до подтверждения оба конца используют рекомендацию 2 GiB / 8 GiB / 200000 / 16 GiB как единую vendor-константу; изменение = re-pin vendor».

Остальные deferred без дыр:
- **TS-миграция** — до этого AD-8 drift-guard держит границу; расхождения двух юнитов нет.
- **Миграция тестов на src** — до этого AD-10 freshness-guard; дыры нет.
- **Per-ticket denylist** — AD-4 явно фиксирует granularity по device; residual принят.
- **Механизм capability-advisor** — AD-11 standalone исполням (presets внутри ceiling, advisory); deferred влияет только на UX-детали.
- **Кэш live-binding 30–60s** — AD-4 уже содержит связку «≤ 60s», interim исполняем.
- **Динамическая route-политика из каталога** — interim = статическая таблица в gateway (единственный источник); расхождения нет.
- **Хрупкость process.report** — риск-нота с revisit; канон AD-7 уже использует `glibcVersionRuntime`/`sharedObjects` (проверено: логика детекции в трёх call-site, `runtime-artifacts.cjs` её не содержит — канон действительно создаётся, а не переносится).
- **Лимиты вне runtime-поставки** (F7, low): `TOOL_SOURCE_MAX_BYTES`, `QUIRKS_LIMITS` остаются ad-hoc — до консолидации сосуществуют два реестра лимитов. Это сознательное ограничение scope с revisit; governance-расхождение, которое A2 называет проблемой, будет жить дальше — допустимо, зафиксировать в spine как «осознанно частичное покрытие A2».

### 4. Технологии/версии актуальны — PASS

Сверено с `package.json` репо:

| Утверждение spine | Реальность | Статус |
| --- | --- | --- |
| Node.js 24 (vendor-контракт `>=24`) | `vendor/asset-contract/package.json`: `"node": ">=24"`; `mcp/neurocenter-asset-sync/package.json`: `"node": ">=24.0.0"` | ✅ |
| NestJS 11.2.7 | `@nestjs/core: 11.2.7` во всех 6 сервисах (api-gateway, catalog-service, oauth2-bridge, rag-sync-service, skills-service, feature-flags-service) | ✅ |
| @neurocenter/asset-contract 1.2.1 (byte-pinned) | `vendor/asset-contract/package.json`: `"version": "1.2.1"` | ✅ (но см. F4) |
| PostgreSQL | `docker-compose.yml`: `pgvector/pgvector:pg16`, сервис `postgres`, `CATALOG_PG_URL`/`RAG_PG_URL` | ✅ |

#### F4 (low) — Stack-таблица противоречит траектории AD-2

- **Что:** Stack фиксирует `asset-contract 1.2.1` в настоящем времени, но AD-2 требует **расширить** контракт (поле `limits` в дескрипторе + ceiling-константы), а AD-1 фактически убирает env-зависимость из pinned-байтов (сейчас `lib/asset.mjs:9-10` читает `NEUROCENTER_RUNTIME_MAX_*` через `limitEnv` — проверено). Это изменение byte-pinned vendor → новый re-pinned релиз (1.3.x), 1.2.1 — состояние «до», а не «к».
- **Почему:** срез, читающий Stack как целевое состояние, может не сделать bump/re-pin. Конвенция «любая правка → пересчёт пина» частично покрывает, но Stack-таблица должна пометить 1.2.1 как interim.

### 5. Brownfield-ратификация — PASS (5/5 утверждений)

| Утверждение spine | Сверка с кодом | Статус |
| --- | --- | --- |
| mcp-host ticket flow: stateless HMAC + exp + TTL 30d; verify = HMAC/exp/форма/лимиты; fallback-цепочка секрета; канал `m/:ticket` без re-check привязки | `ticket.ts`: `HOSTED_MCP_TTL_MS = 30*86400*1000` (стр. 53), `secret() = NEUROCENTER_MCP_HOST_SECRET \|\| NEUROCENTER_INTERNAL_TOKEN` (стр. 52), verify без DB-lookup (стр. 79–148); `mcp-host.controller.ts` `@All('m/:ticket')` → только `verifyHostedMcpTicket` | ✅ AD-3/4/5 нацелены точно |
| runtime-limits.cjs: policy-система только user-квоты (textKnowledge, ggufImport); runtime-artifact-лимитов нет | `RUNTIME_LIMIT_CEILINGS`/`DEFAULT_RUNTIME_LIMIT_POLICY` содержат ровно `textKnowledge` + `ggufImport`; `exact(value, ['textKnowledge','ggufImport'])` — расширение на `runtimeArtifacts` действительно вводится AD-1 | ✅ |
| proxy.service.ts: allowlist device-channel, per-route таймауты, maxContentLength-override, спецкейс TOOL_IMPORT_ROUTE | Строки ~367 (`timeout: 60000`), ~370 (`timeout: 85000`), ~366 (`maxContentLength: 64 MiB`), ~380–381 (`supplyPath === TOOL_IMPORT_ROUTE` → `forwardToolImport`), device-channel allowlist-регулярки (строки ~423–447) | ✅ AD-6 нацелен точно |
| tool-import-deadline.cjs: лестница 480/540/550 | `480000` + `60000` margin = `540000` + `10000` = `550000`; порядок client > gateway > catalog держится константами | ✅ AD-6 «base + margins» — точное обобщение |
| prepared-source-snapshot.mjs: prepared-source closure с retained-файлами и лимитами | `PREPARED_SOURCE_INPUTS` (168), cap 170, per-file ≤ 1 MiB, total ≤ 5 MiB, revision-хэш | ✅ по существу; **но** потолок 170 не учтён AD-7 → F1 |

Дополнительно проверено: TARGETS = 8 платформ, «неизвестная libc не подменяется» (input-analysis «Контрактные ограничения») согласовано с AD-7 throw-поведением; env-driven `LIMITS` в `runtime-artifacts.cjs` (строки 29–38, `LIMIT_ENV` на module load) — дефект A1 реально существует, AD-1/2 его устраняют.

### 6. Полнота altitude=initiative — FAIL (одно целое измерение)

#### F2 (medium) — Операционное/средовое измерение отсутствует

- **Что:** В spine нет ни решения, ни deferred, ни открытого вопроса по: **deployment & environments** (какие среды: dev/stage/prod; как развёртываются сервисы — memlog упоминает «Docker/OpenShift», spine — ни слова), **infra/provider strategy**, **operations** (наблюдаемость, бэкапы, incident-процесс, provisioning секретов за исключением одного предложения AD-5 «production setup генерирует оба секрета»).
- **Почему это дыра altitude:** AD-11 (capability-advisor) ссылается на «фактические ресурсы хоста (disk/RAM/CPU)» — **какого хоста**? Серверный deployment-host не определён, т.е. целевая машина advisor'а не зафиксирована; AD-4 (активность устройства, lookup device↔project) предполагает хранилище привязок — где/как оно операционно живёт, не сказано; AD-5 production-setup — единственная операционная точка.
- **Классификация по checklist:** «целое измерение без слов — finding». Частично компенсируется brownfield-реальностью (docker-compose + compose.production.yml существуют), но spine должен ратифицировать среду, а не молчать о ней.
- **Исправление:** минимально — раздел «Operational envelope» с 3–4 строками: среды и их назначение, способ деплоя (compose/OpenShift — как есть), где живут привязки/политики (Postgres в стеке), provisioning секретов (setup.mjs + secret-менеджер платформы); либо явный Deferred с revisit.

Остальные измерения altitude покрыты: trust (AD-1/2/4/5), данные/хранилище (runtime-limits DB, pinned-closures — конвенции), inter-service контракт (internal HTTP, AD-6), безопасность (AD-5, конвенции тестов безопасности), наблюдаемость конфигурации (AD-9 fail-fast), качество/тесты (AD-8/10, регрессионный эталон).

### 7. Диаграммы — PASS

- **Диаграмма 1 (Design Paradigm):** `flowchart LR`, два subgraph (`CLIENT`, `SERVER`) с подписями в кавычках, 7 нод (включая cylinder `RL[("...")]`), 5 рёбер с подписями через `-->|"..."|`. Синтаксис валиден, структура несёт смысл: две trust-зоны + поток «дескриптор с limits» и «политика ≤ ceiling».
- **Диаграмма 2 (Structural Seed):** `flowchart TD`, subgraph CLIENT (1 нода) и SERVER (4 ноды), внешние ноды `SH`, `VL`, `DB[("...")]`, 8 рёбер включая dotted `SH -.->|"re-export"| VL`. Синтаксис валиден; структура совпадает с AD-7 (фасад + vendor-канон + DB). Единственная неточность — F6 (в SERVER нет skills-service / feature-flags-service).

---

## Сводка findings

| # | Severity | Finding | Пункт checklist |
| --- | --- | --- | --- |
| F1 | **high** | AD-7 сплит vs 170-файловый потолок `PREPARED_SOURCE_INPUTS` (сейчас 168/170): 3–6 новых shared-файлов превысят cap → throw в prepared-source-snapshot → сломается prepared-сборка. Spine не фиксирует механизм | 1, 5 |
| F2 | **medium** | Операционное измерение (deployment & environments, infra/provider, operations) отсутствует целиком; AD-11 «хост» не определён | 6 |
| F3 | **medium** | Deferred «значения ceiling» без обязательного interim: bridge и gateway могут зафиксировать разные interim-ceiling; defer совпадает по времени с срезом, от которого зависит | 3 |
| F4 | low | Stack-таблица: asset-contract 1.2.1 — interim, а не целевое состояние (AD-2 расширяет pinned-контракт → bump + re-pin) | 4 |
| F5 | low | Схема route-таблицы AD-6 `{timeoutMs, maxContentLength, allowed}` не покрывает pairing-рейт-лимиты, embedding-timeout 115s, 64 MiB snapshot/model-chats — риск неполного среза | 1, 2 |
| F6 | low | AD-9 «все сервисы» vs seed без skills-service и feature-flags-service | 1 |
| F7 | low | A2 осознанно частичное: ad-hoc лимиты (`TOOL_SOURCE_MAX_BYTES`, `QUIRKS_LIMITS`) живут во втором реестре до консолидации — зафиксировать в spine как принятый residual | 3 |

## Что spine делает хорошо

- Brownfield-ратификация точная: 5/5 проверяемых утверждений подтверждены кодом; дефекты (fallback-цепочка `ticket.ts:52`, env-LIMITS на module load, 3 копии platform-детекции, лестница 480/540/550) описаны так, как они есть.
- Все 11 AD имеют проверяемый артефакт; конвенция «каждый security-механизм — прямой тест» + регрессионный эталон (3693/0/38) дают измеримый критерий для среза.
- Все deferred снабжены revisit-условиями (кроме интерпретационного вопроса F3).
- Residual-риски принимаются явно (ротация секрета гасит билеты, отмена catalog-fallback — осознанное изменение поведения).

## Рекомендация

Вернуть автору с F1 (обязательно), F2, F3 (обязательно или явный waiver). F4–F7 — по желанию, не блокируют.
