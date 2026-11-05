# Re-Review — Adversary Gate (повторный, после recon v2-обновления spine)

- **Роль:** Adversary Reviewer (повторный прогон после AD-14…AD-19 + обновлённых AD-1/2/3/4/6/7/9/11/13/18)
- **Дата:** 2026-11-05
- **Объект:** `architecture-runtime-trust.md` (status: draft→final, updated 2026-11-05) + `.memlog.md` + код `services/`, `mcp/`, `vendor/asset-contract/`
- **Метод:** для каждой пары AD — две реализации уровня ниже (срез/модуль), каждая формально выполняет букву своих AD, но несовместимы между собой; ищем состояние «оба теста зелёные, runtime сломан/расхождение».
- **Вердикт (1 фраза):** направление новых AD coherent, но в трёх парах есть **контрадикции формулировок внутри самого spine** (AD-3×AD-4, AD-12×AD-1/AD-2, AD-14×AD-6), при которых реализатор обязан молча выбрать security-critical поведение, а completeness-тесты срезов не покрывают dispatch/выполнение — без поправок 2–3 среза «пройдут тесты и сломают runtime».

## Доказательная база из кода (проверено живым чтением)

| Факт | Где | Значение для review |
| --- | --- | --- |
| Catch-all `@Controller('api') @All('{*path}')` регистрируется **первым** (`ProxyModule.controllers[0] = ProxyController`; root-контроллеры — после imported modules) | `services/api-gateway/src/proxy/proxy.module.ts:16`, `proxy.controller.ts:10-24`, `app.module.ts` | /api/mcp-host/\* **и /api/bridge/\*** тенятся (recon подтвердил только mcp-host) |
| Frontend зовёт `/api/bridge/config` | `frontend/src/features/McpBridge/hooks/useBridgeInstaller.ts:20` | bridge-установщик тоже мёртв тем же механизмом — AD-14 scope говорит только про mcp-host |
| `verifyHostedMcpTicket` — чистый HMAC (stateless); TTL = 30d | `services/api-gateway/src/features/mcp-host/ticket.ts:79-148` | AD-3 «verify проверяет retired» буквальнореализуемо только с DB |
| Live re-check **уже существует** на каждую операцию: `handle()` → `authorizeSession()` (adopt + каждый ListTools/CallTool) → POST `/internal/mcp-host/authorize-session` → полная DB-транзакция (device revoked, user enabled, project pin, artifact) | `host.ts:272-340`, `catalog-service/src/devices/mcp-host-access.ts:201-210` | AD-4 residual «mid-session gap» описывает поведение, которого в коде нет |
| Vendor-контракт 1.2.1 читает ceiling **из env при импорте** (`limitEnv('NEUROCENTER_RUNTIME_MAX_*')`) | `vendor/asset-contract/lib/asset.mjs:8-9` | «ceiling-константы в pinned контракте» сейчас — env-значения процесса, а не константы |
| Shared дублирует env-валидацию при импорте (`limitValue`, strict regex, throw) | `services/shared/runtime-artifacts.cjs:28-38` | env-снимок при импорте — нарушение AD-7 «ленивый, без env при импорте»; копия №2 валидации |
| Bridge flat-copy shared-файлов на машину пользователя | `bridge-dist/` (25 файлов, `neurocenter-asset-sync-*.tgz`) | env-валидация shared исполняется **на машине пользователя** |
| `SNAPSHOT_MAX_BYTES=abc` → `Number(...) || default` — NaN-путь; `MCP_HOST_MAX=abc` → `Math.max(1, NaN)` = NaN → пул хостов **неограничен** | `catalog-service/src/snapshots/snapshot.service.ts:73,94`, `api-gateway/src/features/mcp-host/host.ts:43` | живые DoS-кнобы, упомянутые в AD-1/AD-9 — подтверждены |
| Producer-closure **пинит lockfile'ы**: root `package-lock.json`, `services/catalog-service/package-lock.json`, lockfetch-mcp-компонента | `catalog-source/producer.json` (строки 100, 140, 500) | align-срез AD-15 неизбежно меняет байты closure → re-pin обязан |
| Capacity-collector — цикл 15с (не event-driven), snapshot-файл `/capacity/snapshot.json`, `maxAgeMs=90000`, `schemaVersion 1` = disk-only, size cap 32 KiB | `services/shared/capacity-collector.cjs:94-109`, `capacity.cjs:6,59-64` | freshness ≤15с при живом collector'е; bump schema — между двумя сервисами |
| `CAPACITY_REQUIRED` читается ad-hoc из `process.env` в shared и feature-коде | `capacity.cjs:80,163,204`, `gguf-import.capacity.ts:12`, `backup-storage.ts:107` | AD-9 «только через config-модуль» не выполняется today; advisor (AD-11) упрётся в этот же env-gate |
| Proxy pass-through upstream-ответа как есть (`res.status(upstream.status); res.send(body)`) | `proxy.service.ts:385-403` | 404 каталога «Cannot POST /api/mcp-host/connect» доходит до клиента с внутренним маршрутом — AD-19 passthrough |
| Bridge маппит 4xx → «Хост MCP не разрешил подключение этого пакета» | `mcp/neurocenter-asset-sync/src/features/mcp-host/connect.ts:75-83` | shadowing-инцидент выглядит как «не разрешили» — неверная диагностика |
| `NEUROCENTER_MCP_HOST_SECRET \|\| NEUROCENTER_INTERNAL_TOKEN` fallback **активен**, guard.length<16, TTL 30d | `ticket.ts:52-53` | AD-4/AD-5 меняют (24h, ≥32 байта, без fallback) — точка атаки (e) |
| `process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'` в `api-gateway/src/main.ts:2`; shared guard exempt'ит api-gateway | `main.ts:2`, `shared/runtime.cjs:108` | AD-15 знает; в review не атакуем повторно |
| Device-report — **strict key list** (`Object.keys(checked).some(key => ![...,'protocolVersion','runtimeArtifactTarget'].includes(key))`) | `catalog-service/src/devices/device-report.ts:19` | новое capability-поле в report = откат-брек «новый bridge + старый сервер» (AD-13) |
| In-memory `pairLimits` в proxy (rate-limit в памяти) | `proxy.service.ts:463-469` | AD-6 «in-memory per-replica запрещён» — конкретная жертва |

---

## (a) AD-14 (shadowing) × AD-6 (route-таблица)

### Что делают юниты
- **Срез A (AD-6):** выносит бюджеты из диспетчерской логики `proxy.service.ts` (hardcoded: model-chats `maxContentLength: 64MB`, tool-builds `85000`, embedding `115000`, device-channel-ветки, in-memory `pairLimits`) в таблицу `route → {timeoutMs, maxBodyBytes, maxResponseBytes, allowed, rateLimit?}` + completeness-тест «любой роут без строки = фэйл».
- **Срез B (AD-14):** чинит порядок регистрации (explicit до catch-all) + shadowing-тест.

### Две реализации (формально по букве AD, несовместимы)
- **X — table-driven dispatch:** прокси переписывается так, что таблица **и есть** dispatch: запрос →匹配 по строкам таблицы (explicit-строки, затем default-строка) → forward с бюджетами строки. «Порядок регистрации не является семантическим» выполняется тривиально (NestJS-порядок не важен). Completeness = «каждый зарегистрированный роут имеет строку + dispatch следует таблице». Shadowing чинится **побочно**.
- **Y — data + NestJS-порядок:** таблица — чистые данные, которые `proxy.forward` читает для уже-свёршенного маршрута; порядок чинится отдельно (реордер `ProxyModule.controllers` + статический тест «в массиве explicit раньше catch-all»).

### Расхождение
1. **Completeness на таблице ≠ shadowing на dispatch.** В Y completeness-тест проверяет покрытие таблицы, а не dispatch: реордер — одноразовая правка массива. Любой будущий явный контроллер в модуле, импортированном после `ProxyModule` (или новый `@Controller('api/...')` в root-модуле — уже сегодня `BridgeController`) → порядок снова сломан, а статический тест «порядок в массиве» либо не обновлён, либо обновлён точечно. Тест X (supertest на собранном app) ловит; тест Y — нет. Оба среза «зелёные», mcp-host мёртв повторно.
2. **Двойное применение бюджетов.** Если Y садится первым (таблица + ветки кода), а потом X (table-driven dispatch), бюджеты применяются дважды из двух источников: таблица говорит 64MB, а уцелевшая ветка в `proxy.service.ts` — своё. Ничто не ассертит «бюджет, реально применённый = строка таблицы» на собранном app — drift бюджета = DoS-поверхность (wrong `maxBodyBytes`/`timeout` на роуте).
3. **Rate-limit counter.** В X `rateLimit?` строки таблицы указывает на PG-счётчик (AD-6); в Y `pairLimits` остаётся in-memory в коде. Два среза, два места, один «счётчик».
4. **Scope-дыра AD-14:** «18 специфичных» роутов — hand-maintained список. Реальность: `/api/bridge/*` (BridgeController, root-модуль, регистрируется **после** catch-all) тенится **уже сейчас** — frontend `useBridgeInstaller.ts:20` зовёт `/api/bridge/config` и получает pass-through 404 каталога. AD-14 называет жертвой только mcp-host → completeness-тест, написанный по списку «18», не увидит bridge-роуты.

### Severity: **HIGH**
(Корректность dispatch + security: wrong body-budget/timeout = DoS; повторная смертность mcp-host/bridge-роутов после «зачёркнутого» среза.)

### Предложение
1. **Ужесточить AD-6:** таблица — единый источник и бюджетов, и dispatch: один dispatch-пункт прокси по строкам таблицы; invariant-тест «в `proxy.service.ts` нет литеральных бюджетов (timeout/maxContentLength)» + «реально применённый бюджет = строка таблицы» (supertest на собранном app с замером). In-memory счётчики — только как ключ к PG-счётчику из строки `rateLimit?`.
2. **Ужесточить AD-14:** shadowing-тест обязан быть **dispatch-уровнем на собранном app** для **каждого** явного роута (перечень роутов — извлечён из собранного app, не hand-list): mcp-host `connect`, `m/:ticket`, **и `/api/bridge/*`**; «порядок в массиве модуля» запрещён как единственный гейт. Добавить в scope AD-14: `/api/bridge/config` и т.п. (уже тенятся — рекон должен дообследовать).
3. Связка: completeness (A) и shadowing (B) — один и тот же fixture собранного app; срез A не считается выполненным, пока его completeness-тест не включает dispatch-ассерт.

---

## (b) AD-15 (локальные registry) × AD-12 (ceiling из pinned контракта)

### Что делают юниты
- **Срез A (AD-15):** «lockfile аллайнится с версиями, существующими локально (берём локальную версию)» — 249 пакетов downgrade либо provisioning registry (Deferred: «registry-side provisioning vs downgrade lockfile — решение на реализации»).
- **Связка с AD-12:** ceiling живут в pinned контракте; «любое изменение ceiling = новый релиз контракта + re-pin + bump-тест».

### Две реализации (формально по букве AD, несовместимы)
- **X — downgrade lockfile:** 249 версий → локальные (старые). Корневой `package-lock.json` **и** `services/catalog-service/package-lock.json` входят в producer-closure (`catalog-source/producer.json` строки 140, 500) → байты closure изменились → **re-pin catalog-source-pin обязан** (иначе `BUNDLED_CATALOG_INVALID` — но это детектируемый жёсткий фэйл, не тихий drift). Если downgraded-зависимости влияют на build-выход компонентов каталога → новый publish каталога → `manifest.json` (current-вошли) изменился → re-pin `bundled-catalog.lock.json` → **project-пины устройств изменились → массовая «пакет изменился, повторите установку»** у всех устройств.
- **Y — provisioning:** недостающие/нужные версии добавляются в Artifactory/Nexus → lockfile не тронут → closure не тронут → никаких re-pin'ов, никаких mass-reinstall.

Обе формально compliant: текст AD-15 mandates X («берём локальную версию»), Deferred явно оставляет выбор. Последствия (каскад re-pin → mass-reinstall) задокументированы **только для X**.

### Есть ли AD, связывающий смену версий зависимостей с re-pin producer-closure?
**Нет, только общая конвенция** «Пinned-артефакты … любая правка → пересчёт пина официальным тулингом». Конкретной связи «lockfile (в составе closure) → re-pin closure → re-pin manifest → device-pins» в AD нет. Каскад длинный (4 звена), и ни один AD не говорит, что срез AD-15 обязан содержать все re-pin'ы в том же срезе.

### Угол AD-12 (ceiling) — вторая вилка
Срез «align lockfile» **не трогает** `vendor/asset-contract` (это `file:`-зависимость, закреплённая SHA256SUMS+SOURCE.json+gitBlobSha1, а не lockfile) — re-pin ceiling от align-среза не запускается. Но сам bump-контракта (AD-2/13/16 → 1.3.0) даёт вторую пару реализаций:
- **X — истинные константы:** в 1.3.0 ceiling — константы компиляции, `limitEnv` в `vendor/asset-contract/lib/asset.mjs:8-9` **удалён** (сегодня контракт читает `NEUROCENTER_RUNTIME_MAX_*` из env при импорте!).
- **Y — контракт всё ещё читает env** (совместимость): формально «ceiling существуют ровно в одном месте — в pinned контракте» соблюдено (контракт — единственное место, читающее env), identity-тест «один модуль, один набор байтов» проходит (байты одинаковые) — но **два деплоя с разным env получают разный ceiling из одних и тех же пин-байтов**. AD-12 «одна идентичность» ломается по смыслу, хотя тест «один модуль» зелёный.

### Расхождение
- X/Y по lockfile: разные user-visible последствия (mass-reinstall vs ничего) при одном и том же «lockfile алайд с локальными версиями» — Deferred-вилка не закреплена критерием выбора.
- X/Y по ceiling: Y нарушает AD-1 двухуровневую модель (ceiling, зависящий от env, = policy-knob, замаскированный под константу), но AD-12-тест (модульная идентичность) его не ловит.

### Severity: **MEDIUM** (процессная дыра; жёсткие пины ловят поломку, но каскад из 4 звеньев и массовый re-install не задокументированы; Y-вариант ceiling — **HIGH**, если не запретить).

### Предложение
1. **Ужесточить AD-15 (кросс-ссылка):** «Срез, меняющий lockfile, который входит в producer-closure (root + catalog-service `package-lock.json`), обязан в том же срезе: re-pin `catalog-source/producer.json`; если меняется publish каталога — re-pin `bundled-catalog.lock.json` + bump-тест; downgrade-вариант документирует mass-reinstall устройств как осознанное следствие».
2. **Ужесточить AD-12:** «В контракте 1.3.0 ceiling — константы компиляции; чтение env для ceiling запрещено (vendor `limitEnv` убирается в bump). Identity-тест сравнивает **значения** (bridge-видимый ceiling == server-verify ceiling), а не только идентичность модуля».
3. К Deferred-вилке (downgrade vs provisioning) добавить критерий выбора: «выбирается вариант без mass-reinstall устройств, если provisioning покрывает >50% пакетов» (или зафиксировать решение на срезе AD-15 в memlog до реализации).

---

## (c) AD-16 (retirement) × AD-3 (verify)

### Что делают юниты
- **AD-3:** `verifyHostedMcpTicket` = HMAC + exp + форма + `claim ≤ ceiling` + связка claim↔descriptor + **«версия артефакта не retired в текущем каталоге»**.
- **AD-4:** билет остаётся stateless (HMAC + exp); live-binding lookup при соединении (кэш ≤60s, fail-closed); residual «mid-session gap — уже подключённое устройство остаётся в сессии до reconnect».
- **Код today:** verify — чистый HMAC (`ticket.ts:79`); **live re-check уже существует на каждую операцию**: `host.handle()` → `authorizeSession()` (до adopt + каждый ListTools + каждый CallTool) → `/internal/mcp-host/authorize-session` → полная DB-транзакция: device не revoked + user enabled + project membership + approvedPackage + hostArtifact (`mcp-host-access.ts:201-210`).

### Две реализации (формально по букве AD, несовместимы)
- **X — verify чистый (stateless по AD-4):** retired-гейты живут в (1) connect-time live-binding (AD-4), (2) per-op `authorize-session` (существующий путь), (3) `artifact open()` в каталоге. AD-3 выполняется «в духе» (pipeline билета в целом), сама verify — только HMAC.
- **Y — verify ходит в каталог:** `verifyHostedMcpTicket` делает lookup status версии. Формально выполняет букву AD-3 («verify = … + версия не retired») — но ломает AD-4 «билет остаётся stateless»: outage каталога/БД = 503 на **каждом** канале, включая валидные билеты (blast-radius: сейчас catalog-down роняет только per-op re-check, а с Y — ещё и stateless-часть, которую весь смысл AD-4 в том, чтобы держать автономной).

### Расхождение и окна
1. **Контрадикция формулировок AD-3 × AD-4:** AD-3 вкладывает catalog-проверку в stateless verify; AD-4 запрещает non-stateless verify. Реализатор **обязан** молча выбрать точку применения — а это security-critical (где рвётся retired-версия: в connect, в per-op, в open). Тест приёма AD-3 «verify(ticket retired-версии) → reject» проходит только у Y; тест AD-4 «verify не ходит в DB» — только у X. **Один и тот же spine даёт два взаимоисключающих acceptance-теста.**
2. **Окно retired между issue и verify:** в X — первое ListTools (per-op re-check) отклоняет, окно < 1 операции; в Y — в самом verify. Окно между issue и **первой** операцией ничем не закрыто в обоих — приемлемо, но AD это не говорит.
3. **Mid-session:** в X retired/revoked устройство умирает на **следующей операции** (per-op re-check существует today). Residual AD-4 «остаётся в сессии до reconnect после отзыва» **фактически неверен** против кода. Если срез AD-4, чтобы снять «нагрузочный DoS» (каждая операция = полная DB-транзакция), введёт общий кэш ≤60s **и на connect lookup, и на authorize-session** — gap станет реальным (≤60s) — и residual станет правдой, но без явного допущения «окно отзыва ≤60с» в residual. Кэш и freshness для connect-lookup и per-op-lookup в AD не разведены.
4. **Offline-клиент без каталога:** mcp-host — серверная услуга, offline-режима нет (offline = `ASSET_SOURCE_MODE` для доставки артефактов). Catalog down: X — verify проходит (stateless), каждая операция 503 (fail-closed по AD-4, корректно); Y — даже verify 503. Оба fail-closed; Y строго хуже. Фраза AD-3 «verify против текущего каталога» для offline-сценария бессмысленна — нужно переформулировать.

### Severity: **HIGH**
(Контрадикция формулировок в сердце revoke-механизма + устаревший residual, который может завести срез AD-4 на кэш, расширяющий окно отзыва без документирования.)

### Предложение
1. **Переформулировать AD-3:** «verify = HMAC + exp + форма + `claim ≤ ceiling` + связка claim↔descriptor — **stateless, каталог в verify не участвует**». Retired-гейты явно перечислить в AD-16: (1) connect/authorize (AD-4 live-binding), (2) per-op `authorize-session`, (3) `artifact open()`, (4) delivery/описание (retired версия не предлагается новой установке). Фразу «не проходит ticket-verify (AD-3)» из AD-16 — убрать или пометить «через гейт (2)».
2. **Уточнить AD-4:** residual «mid-session gap» — переписать: per-op `authorize-session` уже закрывает gap; кэш ≤60s действует **только** на connect-lookup (либо явный residual «окно отзыва ≤60с» с числом, если кэш общий).
3. **AD-16:** добавить гейт (4) delivery — retired версия не возвращается в списке для новой установки (иначе новая установка на retired-версию пройдёт connect, а умрёт в per-op — UX-лом).

---

## (d) AD-13 (contractVersion handshake) × AD-15/AD-2 (registry/offline-пакет)

### Что делают юниты
- **Bump-срез (AD-2/13/16):** контракт 1.2.1→1.3.0: `limits` + `contractVersion` + `status`; re-pin всех артефактов; device-handshake (`protocolVersion` + `runtimeArtifactTarget`) получает `maxContractVersion` + `maxPackageFormat`; graceful actionable-ошибка при `asset.contractVersion > client.maxContractVersion`.
- **Offline-срез (AD-2):** offline-пакет = RUNTIME_ARTIFACT_DIR (content-addressed `sha256.tar.gz`) + bundled catalog (git-pinned) + новый `offline-manifest.json` (index.sha256 + blobs + generatedAt), валидируется при offline-старте.

### Сценарий «offline-пакет на старом контракте + новый сервер»
Blobs content-addressed: bump контракта **не меняет** байты blobs (если не меняется упаковка). Метаданные/дескрипторы re-pin'ятся в git-аппе. Итог: новый app-образ (новый bundled catalog + новый контракт) + старый offline-каталог blobs.
- Если bump не менял упаковку/метаданные → старые blobs валидны → **offline-пакет тихо работает после bump** (OK, но не проверено тестом).
- Если bump изменил метаданные (новые обязательные поля в дескрипторах) → старые blobs не совпадают с новыми sha256 в метаданных → ошибка sync «бинарные файлы выбранных ассетов отсутствуют в SHA-кэше» — сформулирована как «пропавшие файлы», а не как «offline-пакет старше контракта сервера».

### Две реализации (формально по букве AD, несовместимы)
- **X — offline-manifest без contractVersion** (буква AD-2: index.sha256 + blobs + generatedAt): после bump ошибка «missing blobs» (или тихая валидность) — оператор не понимает, что нужно перегенерировать offline-пакет.
- **Y — offline-manifest с contractVersion** (расширение AD-2): сервер при offline-старте сверяет `manifest.contractVersion` с контрактом app → mismatch = явный fail-closed «offline-пакет собран на контракте 1.2.1 < сервер 1.3.0 — перегенерируйте `assets:sync --offline-ready`».

Обе compliant сегодняшней букве AD-2 (contractVersion в манифесте не требуется). Divergence: после **обязательного** bump (AD-2/13/16 его требуют) каждый offline-сайт получает либо confusing-ошибку (X), либо actionable (Y).

### Вторая вилка AD-13 — device-report strict key list
`device-report.ts:19` — валидатор отклоняет **неизвестные ключи** report'а (`Object.keys(checked).some(key => !allowed.includes(key))`). Реализация «maxContractVersion — новое top-level поле report'а»:
- **X — top-level поле:** новый bridge (шлёт maxContractVersion) + **старый** каталог (rollout-окно) → handshake устройства **ломается** (400/403 на report) — AD-13 graceful-ошибка «обнови bridge» не достигается, вместо неё «устройство не принимается».
- **Y — вложенный объект** (расширение существующего `runtimeArtifactTarget`-объекта или нового `contract`-подобъекта в уже разрешённом ключе): strict key list не тронут → rollout-safe в обе стороны.

Обе формально «device-handshake несёт maxContractVersion»; только Y rollout-safe.

### Severity: **MEDIUM-HIGH**
(Offline-деплой — флагманский сценарий продукта; первый обязательный bump оставляет каждый offline-сайт с непонятным фэйлом. Rollout-брек device-report — MEDIUM, но детерминированный.)

### Предложение
1. **Ужесточить AD-2:** `offline-manifest.json` обязан нести `contractVersion`; сервер при offline-старте: `manifest.contractVersion < contract(app)` → явный fail-closed с обеими версиями и командой перегенерации.
2. **Ужесточить AD-13:** механизм расширения device-report — явный (новые capability-поля — только в вложенный объект; top-level strict key list не расширяется ретроспективно) + rollout-тест в обе стороны (новый bridge + старый сервер; старый bridge + новый сервер).
3. **Deferred:** оффлайн-сценарий для handshake — bridge-апдейт доставляется с сервера (`/bridge/*` supply) и работает offline — зафиксировать в AD-13, чтобы срез не «изобрёл» внешний канал апдейта.

---

## (e) AD-4 (TTL 24h + ре-выдача) × AD-3 (verify)

### Что делают юниты
- **AD-4:** TTL 24h (было 30d, `ticket.ts:53`); bridge ре-выпускает билет при reconnect; live-binding lookup при соединении (кэш ≤60s, fail-closed); pool-квоты, pids_limit.
- **Re-issue = connect:** `POST /api/mcp-host/connect` (Bearer device-токен) → `authGuard.authenticate` → каталог `/internal/device-channel/identity` → `authorize` → новый билет.

### Две реализации «bridge ре-выпускает билет при reconnect»
- **X — пассивная:** ре-выдача только при повторной установке (install-repair flow). Старый билет жив до exp; на 24h канал → 401 «Соединение MCP истекло. Повторите установку.» → пользователь переустанавливает → новый URL в конфиг OpenCode.
- **Y — активная rolling-renewal:** bridge при каждом reconnect к хабу проактивно ре-выпускает и **переписывает URL в конфиге OpenCode** до exp → сессия не рвётся.

Обе формально «ре-выпускает билет при reconnect (connect — лёгкий)». **Несовместимы по клиентскому контракту:**
- Y требует от bridge: детект hosted-MCP-записи в конфиге OpenCode, атомарная перепись, и — критично — **OpenCode должен перечитать URL в сессии**. OpenCode кэширует конфиг; перепись без рестарта OpenCode не применится → Y «полу-сломан»: билет перевыдан, а сессия всё равно умрёт на 24h. AD не говорит, кто переключает OpenCode.
- X требует UX-копира + install-repair путь; операционная цена: **каждые 24h каждый hosted MCP каждого пользователя рвётся и требует ручного действия** (для always-on сервера — операционная катастрофа).

Дивергенция операционная, не security: оба acceptance-теста «ре-выдача при reconnect» зелёные (оба зовут connect), поведение в проде — противоположное.

### «Устройство отозвано между issue и reconnect»
Обе реализации: connect → каталог 401 → gateway мапит `UnauthorizedException('MCP не подключён или доступ отозван.')` — **корректно и actionable** (mcp-host.controller.ts:81-82). Окна нет: re-issue отозванного устройства отклоняется.

### «Окно между TTL-expiry и reconnect (тупик?)»
Bridge offline >24h: билет expired, MCP-канал 401 «истекло», bridge без сети не может re-issue → тупик до восстановления сети. AD-4 **явно** принимает: «offline-запуск в пределах 24h работает, дальше — reconnect». Ошибки различимы: exp → «Соединение MCP истекло. Повторите установку.», отзыв → «МCP не подключён или доступ отозван.» / «Доступ к MCP отозван или временно недоступен.» — диагностика ОК. Residual: зафиксировать тексты.

### Второстепенно: AD-4 residual #1 (ротация секрета)
С 24h TTL ротация `NEUROCENTER_MCP_HOST_SECRET` гасит билеты максимум на 24h (было 30d) — улучшение, но residual-текст не отражает взаимодействия с TTL.

### Severity: **MEDIUM**
(Не security; операционная/UX-дыра: AD не специфицирует, кто переключает OpenCode-конфиг после re-issue → две несовместимые клиентские модели поведения; 24h-цикл ручного переустановления либо полу-сломанный rolling-renewal.)

### Предложение
1. **Ужесточить AD-4 — renewal-контракт:** (a) connect возвращает `exp` билета bridge'у (bridge знает, когда renew); (b) bridge ре-выпускает **до** exp (например, на 50% TTL) и переписывает конфиг OpenCode; (c) поведение OpenCode при смене URL (перечит в сессии либо задокументированный «повторите установку» на exp) — явно, с owner'ом; (d) 24h offline-окно — residual с точными текстами ошибок (exp vs отзыв).
2. **Уточнить residual «mid-session gap»** — см. (c): per-op `authorize-session` уже закрывает gap по отзыву; TTL-expiry mid-session = жёсткий 401 (не gap, а expected).
3. AD-4 residual #1 дополнить: «влияние ротации секрета ограничено TTL (≤24h после введения 24h TTL)».

---

## (f) AD-1 (safe-integer env fail-fast) × AD-9 (config-модуль)

### Что делают юниты
- **AD-1:** «все числовые env — validated positive safe-integer: NaN/invalid = fail-fast, а не снятие ограничения» (примеры: `SNAPSHOT_MAX_BYTES=abc` → NaN → лимит снят; `MCP_HOST_MAX=abc` → неограниченный пул — **оба подтверждены в коде**: `snapshot.service.ts:73`, `host.ts:43` `Math.max(1, NaN)` = NaN → пул неограничен).
- **AD-9:** каждый сервис читает env **только** через свой config-модуль (typed schema, единая валидация, fail-fast с агрегированным отчётом на старте во всех режимах); shared не валидирует при импорте.
- **Код today:** ТРИ копии env-валидации лимитов: (1) `shared/runtime-artifacts.cjs:28-38` `limitValue` при импорте (strict regex, throw «Лимит X должен быть положительным целым числом.») — env-снимок при импорте, прямое нарушение AD-7 «ленивый, без env при импорте»; (2) `vendor/asset-contract/lib/asset.mjs:8-9` `limitEnv` при импорте («Invalid limit X»); (3) будущий config-модуль сервиса. Плюс bridge flat-copy shared-файлов → env-валидация исполняется **на машине пользователя**.

### Две реализации срезов (формально по букве AD, несовместимы)
- **X — shared владетель валидации:** `runtime/limits.cjs` ленивый `getLimits()` читает+валидирует env при первом вызове; config-модуль сервиса знает только про «свои» env, а NEUROCENTER_RUNTIME_MAX_* — «в shared».
- **Y — config-модуль владетель:** config-модуль сервиса валидирует NEUROCENTER_RUNTIME_MAX_* (typed schema, агрегированный отчёт на старте) и **инжектит значения** в shared-модуль (параметр); shared никогда не трогает process.env.

### Расхождение
1. **Двойная валидация с разными ошибками и разным временем fail-fast.** Если X садится первым (AD-1 срез: «safe-integer env в shared»), а Y потом (AD-9 срез: «все числовые env через config-модуль»), одна переменная валидируется дважды: ошибка shared «Лимит NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES должен быть положительным целым числом.» (на первом `getLimits()`, т.е. **в runtime**, не на старте) vs агрегированный отчёт config-модуля (на старте). Из-за import-порядка (shared импортируется в модулях на top-level) первый `getLimits()` может сработать **до** инициализации config-модуля → агрегированный отчёт никогда не сформируется → AD-9 acceptance «агрегированный отчёт на старте» локально сломан, а тест AD-9 (на уровне сервиса, с config-модулем) — зелёный.
2. **Клиентский env-путь (нарушение AD-2, незаметное AD-1-среза).** Bridge (машина пользователя) импортирует shared-модуль. В X: `getLimits()` читает env **пользователя** → stray env на машине пользователя = краш bridge с серверным текстом ошибки; env отсутствует = дефолты — но AD-2 запрещает **любой** env-путь клиента («env-лимиты клиента полностью удаляются», клиент применяет `min(descriptor.limits, ceiling)`). X формально compliant AD-1 («все числовые env валидированы»), но **реинтродусирует клиентский env-путь** — AD-2-нарушение, которое AD-1-тесты (серверные) не увидят. В Y: shared — чистая функция инъектированных значений → bridge получает значения из дескриптора → AD-2-compliant.
3. **Третья копия (vendor `limitEnv`) не упомянута ни в AD-1, ни в AD-9, ни в AD-7.** Если bump-срез (AD-2/13/16) оставит её «для совместимости» — на сервере три источника «максимального размера артефакта» (env→shared, env→vendor, policy→DB) с тихим drift'ом. AD-7 «ленивый getLimits, без env при импорте» тоже не говорит «shared никогда не читает process.env» — только «не при импорте», т.е. ленивый env-снимок (X) формально проходит AD-7.
4. **Живой DoS-кноб today:** `NEUROCENTER_MCP_HOST_MAX=abc` → `Math.max(1, NaN)` = NaN → `hosts.size + starting.size >= NaN` всегда false → **неограниченный пул MCP-хостов** (fork-бомба в одобренном артефакте роняет gateway — ровно то, что AD-4 «pids_limit» пытается закрыть, но кноб открывается до форка).

### Severity: **HIGH**
(Живой DoS-кноб + вилка X/Y создаёт клиентский env-путь, нарушающий AD-2, при «зелёных» тестах обоих срезов.)

### Предложение
1. **Ужесточить AD-9:** явно перечислить runtime-limit env (NEUROCENTER_RUNTIME_MAX_*, NEUROCENTER_RUNTIME_CACHE_BYTES, NEUROCENTER_MCP_HOST_MAX, SNAPSHOT_MAX_BYTES, CAPACITY_REQUIRED, …) как config-module-owned; тест: «в feature-коде и shared нет прямых `process.env`-чтений NEUROCENTER_*» (расширение dead-env-теста с имён на чтения).
2. **Ужесточить AD-7:** shared-модули **никогда** не читают process.env (не при импорте и не лениво) — значения только параметрами/инжектом; flat-copy bridge не содержит env-чтений (тест на скопированные файлы).
3. **Уточнить AD-1:** safe-integer-правило формулируется для **схемы config-модуля** (единая точка валидации), не для shared; включить `MCP_HOST_MAX=abc→NaN→unbounded pool` в примеры с прямым тестом (`Number.isSafeInteger` перед `Math.max`).
4. **AD-2 (bump):** vendor `limitEnv` убирается в 1.3.0 — ceiling становятся константами компиляции (см. (b)); третья копия умирает в том же bump-срезе.

---

## (g) AD-18 (RAM/CPU в snapshot) × AD-11 (advisor)

### Факты кода
Collector — **цикл 15с** (`capacity-collector.cjs:94-109`), не event-driven: snapshot свеж ≤15с при живом collector'е; `maxAgeMs=90000` — порог не «свежести сбора», а «допустимого возраста для принятия». Schema bump = между **двумя сервисами** (collector-контейнер пишет файл; catalog-сервисы читают), size cap 32 KiB, `CAPACITY_REQUIRED`-gate читается ad-hoc из env в shared (`capacity.cjs:80,163`) и feature-коде (`gguf-import.capacity.ts:12`, `backup-storage.ts:107`).

### Две реализации (формально по букве AD, несовместимы в roll-out)
- **X — один файл, schemaVersion 2, backward-incompatible:** collector пишет `schemaVersion: 2` + `host: {ram, cpu}`; `validateSnapshot` требует ровно свою версию. Rollout: новый collector + старый reader (catalog не обновили) → `schemaVersion !== 1` → reject → `CAPACITY_UNAVAILABLE` → **`reserveCapacity` fail-closed на ВСЕХ операциях** (503) — не на advisor'е, а на всей capacity-защите (uploads, backups, GGUF, RAG). И наоборот: новый reader + старый collector → тот же результат. Бамп schema файла между двумя сервисами — **неатомичен**, и жертва — не новый advisor, а существующий production-путь.
- **Y — compatibility window:** reader принимает `schemaVersion ∈ {1, 2}` в переходном окне (host-секция optional для новых reader'ов; advisor работает только при наличии host-секции). AD-18 «schema bump» не запрещает, но и не требует window — реализатор X проходит букву AD-18 («snapshot расширяется, лимит 32 KiB сохраняется») и роняет production на время rollout'а.

### Вилки внутри (g)
1. **Источник RAM:** контейнеризированный collector видит и `/proc/meminfo` (host total/free), и cgroup v2 `memory.max/current` (лимит контейнера). «RAM хоста» → две реализации: (a) /proc/meminfo (host: 256 GiB), (b) cgroup (8 GiB) → пресеты advisor'а различаются в **32 раза**. AD-18 «RAM хоста (total/free), CPU (count, load average)» не фиксирует источник.
2. **Advisor на stale/absent snapshot:** `getCapacityStatus` → `CAPACITY_UNAVAILABLE` (collector down или `CAPACITY_REQUIRED` unset) → поведение advisor'a **не специфицировано**: (a) скрыть пресеты + «сведения о ёмкости недоступны», (b) fallback на disk-only пресеты (v1-совместимый partial view). Оба формально compliant AD-11 («пресеты из фактических ресурсов хоста» — без RAM RAM-пресеты не вычисляются, disk-only — тоже «из фактических ресурсов»). UI-вилка. Плюс `CAPACITY_REQUIRED` env-gate: advisor в dev (env unset) молчит — AD-9 dead-env/schema вопрос (env должен быть в config-схеме; shared читает ad-hoc — инжекты-вилка как в (f)).
3. **Freshness пресетов (вопрос промпа «90-секундная RAM-картинка»):** сбор — 15с, не event; maxAge 90с — порок принятия. Пресеты по instantaneous `free` (15с) — advisory-шум: пресет должен быть функцией **total** (стабильных: RAM total, disk total, CPU count), а не текущего load; load/free — только для «машина сейчас насыщена» warning. AD-11 «машина-осведомлённые пресеты из фактических ресурсов» не фиксирует, от чего зависит пресет.

### Severity: **MEDIUM**
(Rollout-порядок X: production capacity-guard 503'ит всё на время окна — это реальная availability-дыра; advisor-вилки — косметика. Источник RAM — MEDIUM, т.к. пресеты advisory, но 32×-расхождение запутает админа.)

### Предложение
1. **Ужесточить AD-18:** (a) зафиксировать источник: `/proc/meminfo` (host total/available), `/proc/loadavg`, count из `/proc/cpuinfo` — **не** cgroup-вид; (b) compatibility window: reader принимает {1,2} в течение одного миграционного релиза (host-секция optional), либо явное требование «collector и все reader'ы деплоятся одним релизом» + тест на переход; (c) 32 KiB cap сохраняется для host-секции (ram/cpu ~100 байт — ок).
2. **Ужесточить AD-11:** поведение advisor'а при stale/absent snapshot — явное (пресеты скрыты + заметка «сведения о ёмкости недоступны»; disk-only пресеты — только с явным флагом и пометкой); пресеты — функция total-ресурсов (а не instantaneous free/load); load/free — только warning.
3. **AD-9-связка:** `CAPACITY_REQUIRED` → config-схема сервиса (dead-env-тест), `capacity.cjs` получает флаг параметром (AD-7-паттерн «shared не читает env»).

---

## (h) AD-19 (error-body) × AD-14 (shadowing)

### Факты кода (today, до фиксов)
Shadowed `/api/mcp-host/connect` → catch-all proxy → каталог → NestJS 404 `{"statusCode":404,"message":"Cannot POST /api/mcp-host/connect","error":"Not Found"}` → proxy **pass-through** как есть (`proxy.service.ts:385-403`) → клиент получает **внутренний маршрут upstream** в body (AD-19 passthrough-нарушение сегодня). Bridge мапит: 5xx → «Сервис хоста MCP недоступен. Повторите установку позже.», 4xx → **«Хост MCP не разрешил подключение этого пакета»** (`connect.ts:75-83`) — shadowing-инцидент выглядит как **отказ в доступе**. Диагностика: админ видит «пользователям не разрешён пакет», а причина — роутинг площадки.

### Две реализации (формально по букве AD, несовместимы в порядке)
- **X (AD-19 срез первым):** proxy нормализует upstream-ошибки: non-2xx → фиксированный body по классу статуса; upstream-404 → `UPSTREAM_NOT_FOUND` «Маршрут не найден на площадке. Обновите версию Нейроцентра.»; 5xx → `upstream-unavailable`. Shadowing-инцидент: пользователь видит «обновите версию» — лучше, но не точечно; легитимный 404 (пользователь задал несуществующий endpoint) получает **то же** сообщение — неверно для легитимного случая.
- **Y (AD-14 срез первым):** shadowing починен → bridge получает **настоящий** ответ mcp-host (401 «MCP не подключён или доступ отозван.», 403, 502 с jsonrpc-body). Shadowing-error-body становится историей.

### Расхождение
1. **Порядок срезов меняет наблюдаемое поведение:** X без Y — фиксированный «обновите версию» на **каждом** upstream-404 (включая легитимные); Y без X — pass-through 404 продолжает вытекать на другие тенящиеся/неизвестные роуты (новый явный роут в будущем модуле = та же бомба с новой жертвой; см. (a): `/api/bridge/*` уже тенится сегодня — и получает pass-through 404 каталога **прямо сейчас**).
2. **Маппинг bridge 4xx→«не разрешил»** не привязан ни к AD-19, ни к AD-14: ни один AD не говорит, что proxy `UPSTREAM_NOT_FOUND` (502-класс) bridge обязан мапить как «площадка», а не «право». Связка отсутствует.
3. AD-19 «исключение: validated domain-ошибки с явным allowlist» — 404 каталога «Cannot POST /…» **не** domain-ошибка → pass-through = нарушение; AD-19-срез обязан это закрыть (тест: body на любой upstream-404/500 не содержит upstream-текст).

### Severity: **MEDIUM**
(Диагностический gap + текущая утечка маршрутов в body; security-вклад низкий, цена — incident response: shadowing-баг прячется за «не разрешили».)

### Предложение
1. **Ужесточить AD-19:** pass-through upstream-ошибок proxy запрещён для error-статусов — фиксированные body по классу, отдельный код `UPSTREAM_NOT_FOUND` для upstream-404 с сообщением,导向 «обновите версию площадки»; bridge мапит его как «площадка», не «право». Тест: «body proxy на upstream-404/500 не содержит upstream-текст/маршрут».
2. **Ужесточить AD-14:** shadowing-тест ассертит **body** явного роута: mcp-host connect с битым device возвращает 401-body **mcp-host**, а не pass-through catch-all — связывает acceptance двух AD.
3. (AD-5 маскирование nginx-логи — отдельный канал; body-канала сегодня нет — закрывается п.1.)

---

## Сводка

| # | Пара | Severity | Суть дыры | Действие |
| --- | --- | --- | --- | --- |
| 1 | (c) AD-16×AD-3 | **HIGH** | Контрадикция формулировок: «verify проверяет retired» vs «verify stateless» → два взаимоисключающих acceptance-теста; residual «mid-session gap» неверен против кода (per-op re-check существует) | Переформулировать AD-3 (verify — stateless), гейты AD-16 явно в 4 точках, residual AD-4 переписать |
| 2 | (a) AD-14×AD-6 | **HIGH** | Completeness на таблице ≠ shadowing на dispatch; реордер — одноразовая правка, регрессия не ловится; `/api/bridge/*` уже тенится (frontend-установщик мёртв) — scope AD-14 не видит | Dispatch-тест на собранном app для всех явных роутов; таблица = источник dispatch; scope AD-14 расширить на /api/bridge/* |
| 3 | (f) AD-1×AD-9 | **HIGH** | Три копии env-валидации (shared при импорте, vendor limitEnv, будущий config-модуль); вилка X/Y → клиентский env-путь (AD-2-нарушение, незаметное AD-1-тестам); живой DoS-кноб `MCP_HOST_MAX=abc` → неограниченный пул | Shared без process.env (параметры), env-владение в config-модуле, vendor limitEnv умирает в bump, NaN-кноб — прямой тест |
| 4 | (g) AD-18×AD-11 | MEDIUM (rollout — HIGH для availability) | Schema bump файла между двумя сервисами неатомичен → `reserveCapacity` fail-closes **все** операции на время окна; источник RAM (host vs cgroup) не зафиксирован → 32×-расхождение пресетов | Compatibility window {1,2} или один релиз; источник = /proc (не cgroup); advisor на absent snapshot — явный |
| 5 | (b) AD-15×AD-12 | MEDIUM | Lockfile входит в producer-closure → align-срез обязан re-pin (каскад из 4 звеньев + mass-reinstall), покрывает только общая конвенция; Deferred-вилка downgrade/provisioning без критерия выбора; vendor env-ceiling (Y-вариант AD-12) — HIGH, если не запретить | Кросс-ссылка AD-15→closure-re-pin; AD-12: ceiling = константы компиляции, env-чтение запрещено, identity-тест по значениям |
| 6 | (d) AD-13×AD-2/15 | MEDIUM-HIGH | offline-manifest без contractVersion → после обязательного bump каждый offline-сайт с confusing-ошибкой; device-report strict key list → новое capability-поле = rollout-брек «новый bridge + старый сервер» | contractVersion в offline-manifest + явный error; extension mechanism device-report + rollout-тест в обе стороны |
| 7 | (e) AD-4×AD-3 | MEDIUM | Renewal-контракт не специфицирован: кто переключает OpenCode-конфиг после re-issue; 24h-цикл ручного переустановления vs полу-сломанный rolling-renewal | AD-4: exp в ответе connect, proactive renewal на 50% TTL, owner по OpenCode-side, тексты residual |
| 8 | (h) AD-19×AD-14 | MEDIUM | Shadowing-инцидент = misleading «не разрешил» + утечка маршрутов в body (pass-through today); порядок срезов меняет наблюдаемое поведение | AD-19: no upstream error pass-through, UPSTREAM_NOT_FOUND код; AD-14: shadowing-тест ассертит body |
| 9 | (c) AD-4-кэш | MEDIUM | Кэш ≤60s не разведён между connect-lookup и per-op authorize-session → окно отзыва может расшириться до 60s без документирования | AD-4: кэш только на connect-lookup, либо явный residual «окно отзыва ≤60с» |
| 10 | (e) AD-4 residual #1 | LOW | Ротация секрета × 24h TTL не отражена в residual-тексте | Дополнить residual |

## Вердикт
**CONDITIONAL PASS** — направление рекон-AD (AD-14…AD-19) и обновлений корректно, но 3 HIGH (контрадикции формулировок AD-3×AD-4, AD-12×AD-1/2, AD-14×AD-6) требуют **поправок в spine до запуска срезов**: без них реализаторы срезов получат взаимоисключающие acceptance-тесты и «пройдут тесты, сломав runtime» в dispatch (a), в точке применения retired-гейта (c) и в env-владении лимитов (f). МEDIUM-позиции (b, d, e, g, h) — ужесточения AD (кросс-ссылки, поля манифестов, источники метрик), не блокирующие дизайн. Residual без изменений: AD-17 (authenticity), AD-4 ротация секрета, 24h offline-окно.

*— adversary re-review, 2026-11-05*
