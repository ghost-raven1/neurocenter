# Gap Inventory v2 — полный brownfield-разведка (5 зон, 2026-11-05)

Источники: 5 recon-агентов (mcp-host/секреты/revocation; лимиты во всех слоях; доставка/целостность; shared-слой; proxy/config/ops). Каждая дыра: `[SEV]` — название — суть (файл:строка) — статус относительно spine.

## CRITICAL

### C-1. mcp-host тенится catch-all прокси — мёртвый код в production
- `proxy.module.ts:16`: `controllers: [ProxyController, McpHostController, ResearchMcpController, SystemRoleMcpGatewayController]`.
- `proxy.controller.ts:10,21`: `@Controller('api')` + `@All('{*path}')` — регистрируется ПЕРВЫМ → Express-роут `api/*` перехватывает `POST api/mcp-host/connect` и `ALL api/mcp-host/m/:ticket` до конкретных роутов.
- Живой прогон (dist-контроллеры): оба URL → `{shadowed:true}` от proxy-ветки.
- **Следствие:** вся инфраструктура mcp-host (билеты, live-binding, 16MiB/55s-лимиты, pool) недостижима в production; запросы падают в default axios-forward (30s, ∞ body). Тесты не ловят: каждый контроллер поднимается отдельно.
- **Spine:** НЕ покрыт. **Закрытие:** новый AD — «explicit routes имеют приоритет над catch-all» + shadowing-тест (каждый явный роут сервиса должен быть доступен, не теняясь) + completeness-тест маршрутной таблицы (AD-6).

### C-2. TLS отключён для всех исходящих вызовов gateway
- `main.ts:2`: `NODE_TLS_REJECT_UNAUTHORIZED=0`; `Dockerfile:14`: зашита в образ; `compose.production.yml:358`: `NODE_OPTIONS`; `NPM_CONFIG_STRICT_SSL=false`; `runtime.cjs:203-204` whitelist.
- Внутренний токен (`NEUROCENTER_INTERNAL_TOKEN`) ходит по 12+ internal-каналам **без верификации сертификатов** → MITM на backend-сети = кража internal-токена = фабрикация билетов/доступ во все internal-роуты.
- `NEUROCENTER_TLS_PROXY_ADDRESSES` (runtime.cjs:137-147) существует, но прокси его не использует.
- **Spine:** не покрыт (AD-5 — про separation секретов, не про transport). **Закрытие:** AD: scoped TLS trust (internal CA или scoped-верификация по адресам), глобальное отключение запрещено.

## HIGH

### H-1. Билет пишется в access-log nginx
- `nginx.production.conf.template:2,19`: `access_log` со `$uri` → `/api/mcp-host/m/<30-дневный-ticket>` в json-file логах при каждом запросе.
- **Закрытие:** маскировать `m/:ticket` в log_format (новая location/regex) — расширение конвенции «секреты не печатаются» на proxy-логи.

### H-2. Нет rate-limit на `connect` и `m/:ticket`
- `mcp-host.controller.ts:48,140`: ни throttler, ни бюджета. `connect` = транзакция в catalog на каждый запрос; канал — зальют одним билетом.
- **Spine:** AD-6 completeness (default-deny) покрывает, но explicit строки в таблице политики обязательны.

### H-3. Безлимитный server-side кэш артефактов
- `artifact-cache.ts:14-37`: `LIMITS.cacheBytes` (2 GiB) **нигде не применяется**; ни eviction, ни per-project квота. Каждый одобренный артефакт (до 256 MiB zip + 1 GiB unpacked) живёт навсегда → fill диска gateway.
- **Spine:** AD-1 заявляет квоту+eviction — подтверждено отсутствием в коде; механизм обязателен к реализации (LRU по cacheBytes, per-project квота).

### H-4. Env-переменные без валидации: NaN-дыры
- `runtime-artifacts.cjs:28-34` `limitValue()`: только positive safe-integer, **без ceiling** (env до ≈9e15).
- `snapshot.service.ts:73,94`, `snapshot-repository.ts:400,419`, `snapshot-storage.ts:241`: `Number(env || default)` **без safe-integer** → `SNAPSHOT_MAX_BYTES=abc` → NaN → сравнения ложны → **снятие ограничения**.
- `mcp-host/host.ts:40`: `Math.max(1, Number(env || 4))` → `=abc` → NaN → `>= NaN` всегда false → **неограниченный пул MCP-хостов**.
- **Spine:** AD-1 fail-fast (env > default) частично; нужно расширение AD-9: ВСЕ числовые env — validated safe-integer на старте, invalid = fail-fast.

### H-5. Нет криптографической подписи producer-closure (authenticity gap)
- vendor: только sha256 content-addressing + Git-lock (`bundled-catalog.cjs`, `producer.json`→`manifest.json`→`lock`). Подписей 0.
- Скомпрометированный CI/мэйнтейнер **легитимно** пересобирает все пины — все проверки проходят (они сверяют согласованность, не подлинность). Отравленный каталог неотличим от честного.
- **Spine:** не покрыт. **Закрытие:** решение (подпись ключом мэйнтейнера + публичный ключ вне дерева) или осознанный threat-model residual.

### H-6. Невозможно отозвать отдельную версию артефакта
- `assertIndexEvolution` (repository.mjs:30-34) **запрещает** удаление опубликованной версии; `archived_at` — asset целиком; `legacy-retirement` — fixed-scope демо.
- Баг/RCE в версии N → **не отозвать**: билеты/пины на N остаются валидными, blob по sha256 отдаётся вечно.
- **Spine:** AD-3 ссылается на «не retired в каталоге», но **механизма retirement нет** — AD-3 опирается на несуществующее. **Закрытие:** `status: active|retired` в контракте (index-entry/версия) + server-side гейт в open()/mcp-host.

### H-7. Два расходящихся ceiling'а: issuance 2 GiB vs verify 256 MiB (подтверждено)
- `mcp-host.controller.ts:116` (issuance ≤2 GiB) vs `ticket.ts:126` (verify ≤256 MiB env) vs `runtime-artifact-stream.ts:35` (**hardcoded 256 MiB**, не читает shared LIMITS).
- Билет с compressedBytes в (256 MiB; 2 GiB] проходит issue, падает в verify.
- **Spine:** AD-12 закрывает — подтверждено как реальный дрейф в коде.

### H-8. Platform-детекция: 15+ локаций, 3 поведения, 4 пространства имён
- Строгие (throw/`-unknown`): `host-target.ts:11`, `runtime-host-target.ts:2`, `model.ts:26`, `verify-runtime.mjs:76`.
- **Слабые (тихо `-musl`)**: `dev-bridge-runtime.ts:29`, `python-runtime.mjs:32`, `bridge-runtime-probe.mjs:17` (без try/catch — падение), `workspace/dev-bridge-runtime.mjs:12`, `prepare-bridge-runtimes.mjs:29`, `package-bridge-runtime.mjs:29` + 11 test-фиксатур. На Linux с неизвестной libc (bionic) → **установка чужого (musl) артефакта**.
- 4 пространства имён: runtime `win32-*+glibc`, bridge `windows-*`, upstream `windows-*+baseline`, opencode-cli `linux` без libc.
- **Внутри shared свой TARGETS**: `opencode-cli-install.cjs:5` — 6 целей, расходится с каноном.
- **Spine:** AD-7 канон покрывает 4 строгих call-site; **не покрывает слабые B1-B8 и win32/windows-несогласованность**. **Закрытие:** AD-7 расширить: канон заменяет ВСЕ 15+ локаций (включая bridge-скрипты), единое пространство имён + явные маппинги.

### H-9. Fat-proxy: dispatch + безопасность + 6 спец-стрим-веток в одной функции
- `proxy.service.ts:95-420`: upstream-выбор, 3 no-store regex, 2 device-403, job-authorize, internal-access, feature-flag, 6 ручных стрим-пайплайнов.
- **Spine:** AD-6 покрывает (таблица данных), но конкретика: 18 строк таблицы (см. ниже), regex → data, dispatch-порядок под test.

### H-10. Default axios: 30s + maxContentLength -1 (∞)
- `proxy.service.ts:85`: default-ветка буферизует **весь ответ в памяти без потолка**; 30s на всё.
- Маршруты в дефолте: `internal/events`, `opencode-cli-supply`, `research-mcp`, `system-role-mcp`, `/api/bridge/*` GET, и всё `/api/catalog|rag-sync|skills|auth|users|agent|models/*` (кроме спец-веток).
- **Закрытие:** AD-6: default-роут = explicit бюджет (не ∞); default-deny.

### H-11. Dangling deadline-лестницы: nginx рвёт раньше gateway
- model-chats: gateway 910s → **nginx `/api/` 600s** (template:49) → nginx рвёт первым. Локация `turns` (915s) не покрывает все model-chat-маршруты.
- Остальной model-inference: gateway **610s hardcoded** (`model-inference-forward.ts:38`) — не из JSON, не из лестницы, тоже > 600s nginx.
- embedding: gateway 115s == catalog 115s — **ноль запаса** (race).
- Body-бюджеты: nginx 50m = gateway 50m > **catalog 35mb** → запрос 40MB проходит наружу и падает внутри. Правильное направление: бюджеты не растут к центру (outermost = strictest).
- **Spine:** AD-6 invariant-тест покрывает лестницу tool-import; нужно расширение: **все** лестницы (включая nginx) + body-бюджет-инвариант.

### H-12. Drift .d.cts реален + 6 .cjs без деклараций
- `capacity.cjs`: 4 value-экспорта без деклараций (реально используются); `github-release-source.cjs`: `resolveGithubRelease`.
- Без деклараций: `runtime.cjs` (15 потребителей!), `bridge-update-lock.cjs`, `capacity-collector.cjs`, `chat-document-worker.cjs`, `package-build-loader.cjs`, `archive-source.cjs`.
- **Spine:** AD-8 покрывает; guard-дизайн уточнён recon'ом (allowlist'ы: worker-скрипт, declaration-only gguf-import.d.ts, дубль skill-source.d.cts/d.mts).

### H-13. Mutable env-state в shared
- `runtime.cjs:191,193`: **запись в process.env при импорте** (12 секретов из `*_FILE`) + `validateProduction` при импорте с угадыванием сервиса из `argv[1]` — side effect на 15 импортеров, порядок загрузки модулей становится семантически значим.
- `runtime-artifacts.cjs:37`: `LIMITS` = снимок env при импорте, экспорт **без Object.freeze**.
- `release-inspection/skill-repository/upload-inspection`: `TOOL_BUILD_SCRIPT` снимается на уровне модуля (3 копии).
- **Spine:** не покрыт. **Закрытие:** AD-7/AD-9: shared не пишет в process.env и не валидирует при импорте; ленивое чтение лимитов; загрузка секретов — в config-модуль сервиса.

### H-14. Prepared-source cap 168/170 подтверждён (headroom 2)
- +3 файла → throw → все prepared-сборки падают. Сплит в **подпапку** `services/shared/runtime/` (фасад остаётся на плоском пути) — но новые файлы попадают в allowlist (43 shared-файла уже в списке) → cap-бамп обязателен.
- `BRIDGE_SHARED_RUNTIME_FILES` флэт-копирует 25 .cjs в standalone-архив bridge — сплит не должен ломать копирование (подпапка = отдельное решение).
- **Spine:** AD-7 уже фиксирует cap-бамп; уточнение: сплит → подпапка, фасад → плоский путь.

### H-15. Offline-пакет без top-level манифеста
- Офлайн = каталог blobs+metadata, per-blob sha256; частичный/смешанный кэш (революция A + революция B) проходит per-blob-проверки; `completeGraph` вызывается только при `--offline-ready`, не при offline-запуске.
- **Закрытие:** подписанный `offline-manifest.json` (index.sha256 + набор blobs + generatedAt) + валидация при offline-старте.

### H-16. Internal-токен сравнивается `!==` в 3 middlewares
- catalog/skills/rag `main.ts`: простое сравнение вместо timing-safe `assertInternal` (gateway — timing-safe).
- **Spine:** AD-5/AD-9: единый timing-safe assert для internal-токена везде.

### H-17. Pairing rate-limit in-memory, не выживает multi-replica
- `proxy.service.ts:66,461-490`: счётчики per-process; при 2+ репликах brute-force pairing-кода не ограничен (pairing = единственный механизм аутентификации devices).
- **Закрытие:** AD-6: rate-limit-счётчики — в shared storage (PG).

### H-18. error.message уходит клиенту в ~16 местах
- `proxy.service.ts:414`: axios error = **внутренний hostname+порт** (`GET https://internal-host:port/...`). Фильтр только в 1 месте (`source-upload.service.ts:250`).
- **Spine:** не покрыт. **Закрытие:** конвенция/AD: external error body = фиксированные сообщения; `error.message` не транслируется (кроме validated domain-ошибок).

## MEDIUM (выборка, полная таблица в отчётах реконов)

- **30-дневный ticket TTL** (`ticket.ts:53`) — чрезмерно; укоротить + ре-выдача при reconnect.
- **Global pool 4 MCP-хоста = кросс-юзер DoS** (`host.ts:40,87`) — per-project/per-device квота под глобальным потолком.
- **Per-ticket connection cap отсутствует** (`mcp-session.ts`) — cap активных каналов на hostKey (`listeners` уже есть).
- **Body 50MB на `m/:ticket`** (`main.ts:41` global express.json) — per-route бюджет.
- **Gateway без pids_limit, child-MCP работает root** (`compose.production.yml:273-298`, Dockerfile без USER) — форк-бомба в «одобренном» артефакте.
- **Live-check = полная DB-транзакция на каждую операцию, без кэша** (`host.ts:342-364`) — нагрузка-DoS на catalog; кэш ≤60s обязателен (AD-4), а не опционален.
- **Секрет <16 байт, проверка deferred** (`ticket.ts:57,81`) — ≥32 байт + fail-fast на старте.
- **Дубли констант лимитов**: 256 MiB source-upload (2 места), 64 MiB chunk (hardcoded в proxy, не импорт shared), 4 GiB tool-supply (4 места), 64 MiB model-chats (2 места).
- **Frontend дрейфы**: `ASSET_IMPORT_MAX_ITEMS` 50 vs server 20; model dimension 16384 vs rag 16000; `CATALOG_STORAGE_LIMIT` display-only (ложный контроль).
- **GGUF ceiling 8/32 TiB** — на 2 порядка выше defaults (ceiling без смысла); `textKnowledge.fileBytes` ceiling = default (вырождено).
- **AD-1 scope уже ~15% реальных лимитов**: двухуровневая модель уже существует для textKnowledge (7 полей) + ggufImport (15 полей) — AD-1 должен быть «моделью для всех секций runtime-limits», а не только артефактов.
- **runtime-cache limitBytes (per-machine)** — вне модели: устройство получает её device-job'ом (не дескриптором), v2-max ≈9 EiB (фактически без потолка).
- **Client-only лимиты** (installation-limits: ledger 4 MiB, journal 64 MiB, recovery 1 GiB) — сервер о них не знает; модель должна явно покрыть или исключить.
- **Self-referential descriptor pin**: live API `getAiPluginPackage` → клиент верит `manifest.sha256` из самого пакета; нужен server-issued `descriptorSha256` в билете.
- **Race head-version**: установка `version=undefined` (head) может получить 404 после смещения head.
- **Мёртвые env**: `NEUROCENTER_AUTH_GUARD_ENABLED` (4 конфига, ноль чтений в коде); `NEUROCENTER_BRIDGE_DIST` vs `NEUROCENTER_BRIDGE_TEMPLATES_DIR`.
- **~257 прямых process.env** в 6 сервисах без валидации (AD-9); **валидация только в prod** (`runtime.cjs:182`), dev — ноль.
- **Dist staleness**: `check --step test` без build, 10+ тестов импортируют dist (AD-10 подтверждён: hash-guard на старте).
- **oauth2-bridge: ноль rate-limit** на token-exchange.
- **Nginx login rate-limit только на кромке** (edge = ок, но gateway-level pairing — redundant/inconsistent).
- **SDK error message раскрывает внутренние пути** (`host.ts:224-226`).

## Чего не хватает спайну (сводка)

| AD | Статус |
|---|---|
| AD-1 | Scope расширить: модель для всех секций runtime-limits; interim ceiling подтверждён отсутствием в коде; server-cache квота = обязательный механизм |
| AD-2 | Подтверждено: limits в дескрипторе нет (env); нужен `limits:{compressed,unpacked,files,cacheBytes}` + `descriptorSha256` |
| AD-3 | Опора «не retired» не существует → нужен H-6 (retirement) |
| AD-4 | Кэш lookup обязателен (сейчас транзакция на операцию); live-check уже сильнее заявленного (fail-closed 503 есть) |
| AD-5 | Подтверждено: fallback активен в prod; ≥32 байт + fail-fast; маскирование в nginx access-log (H-1) |
| AD-6 | Таблица = 18 строк (recon E §1.4); default-deny (H-10); nginx в лестнице (H-11); PG rate-limits (H-17); shadowing (C-1) |
| AD-7 | Сплит → подпапка `runtime/` (H-14); слабые детекции B1-B8 (H-8); свой TARGETS в shared (H-8); mutable env (H-13) |
| AD-8 | Guard-дизайн уточнён: allowlist'ы (worker, declaration-only, дубль) |
| AD-9 | ВСЕ числовые env = safe-integer fail-fast (H-4); dead-env тест (H-17/мертвые); timing-safe везде (H-16); error-message конвенция (H-18); shared без env-writes (H-13) |
| AD-10 | Подтверждён: hash dist↔src на старте check |
| AD-11 | Входы: capacity snapshot = только disk (statfs); **RAM/CPU не собираются** — без расширения collector'а advisor не реализуем |
| AD-12 | Подтверждено (H-7): единый источник = контракт; identity-тест обязателен |
| AD-13 | Опровергнут в текущем виде: нужен `contractVersion` (semver) в AssetBase + index + `maxContractVersion` в capability клиента (канал: device-handshake `protocolVersion`) |

## Новые AD (кандидаты из recon)

- **AD-14** — Explicit routes не тенятся catch-all + shadowing/completeness-тест (C-1).
- **AD-15** — Scoped TLS trust: глобальное отключение верификации запрещено; internal-каналы — CA/scoped (C-2).
- **AD-16** — Retirement версий: `status: active|retired` в контракте + server-гейт (H-6).
- **AD-17** — Authenticity producer-closure: подпись или осознанный residual (H-5).
- **AD-18** — Machine-metrics для advisor: расширение capacity snapshot на RAM/CPU (AD-11 вход).
- **AD-19** (кандидат) — Error-body policy: фиксированные сообщения, no error.message passthrough (H-18).
