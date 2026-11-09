---
title: 'Ceiling-version handshake: graceful negotiation contractVersion (AD-13, entry 11)'
type: 'feature'
ticket: '11'
created: '2026-11-09'
status: 'ready-for-dev'
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md'
  - '_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md'
  - '_bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/epic-trust-device-catalog.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Bridge и сервер на разных версиях контракта дают **тихий limit-error**: один ceiling-набор у клиента (old), другой у сервера (new) — клиент молча получает limit-ошибку или, хуже, «сервер разрешил, клиент молча отклоняет» (AD-2 prevents). Сейчас handshake только по `protocolVersion` (=2, `device-compatibility.ts:7`) и capability-флагам (`package-v3/v4/v5` — `assertPackageBridge:22-45`); версия КОНТРАКТА (ceiling-набор, формат дескриптора) нигде не сверяется. Контракт (entry 1) получает `contractVersion` (semver, обязательное) в AssetBase и index-entry — остаётся negociação: capability клиента несёт `maxContractVersion` + `maxPackageFormat`; дескриптор, ticket claim и offline-manifest несут версию контракта; несоответствие → **graceful** actionable «обнови bridge/контракт до X» (не throw, не generic limit-error). Forward-совместимость capability: новые capability-поля факультативны — server игнорирует неизвестные поля device-report (новый bridge + старый сервер работает); client требует только известный минимум (старый bridge + новый сервер → actionable-ошибка обновления, а не reject).

**Approach:** (1) Device-report capability: новые ОПЦИОНАЛЬНЫЕ поля `maxContractVersion` (semver) + `maxPackageFormat` (integer ≥1) — bridge шлёт в heartbeat-report; `workspaceReport()` валидирует типы при наличии (semver-паттерн, safe-integer), отсутствие = старый bridge; неизвестные capability-поля server игнорирует (forward-compat). (2) Server-side handshake: новый `assertContractBridge(report, asset)` (`device-compatibility.ts`) — вызывается в `authorizeHostedMcp` (mcp-host, device.report на руках) + dispatch-пути установки: `asset.contractVersion` > `report.maxContractVersion` (semver-compare) → 409 actionable «Обновите локальный MCP... контракт до X» (паттерн существующих `assert*Bridge`); `maxContractVersion` отсутствует (старый bridge) + пакет с contractVersion → 409 actionable (обновление, не reject); `compatibility.packageFormat`/`bridgeProtocol` вне capability-диапазона клиента → 409 actionable. (3) Версия в данных: ticket claim (`IHostedMcpClaim.contractVersion` — gateway `ticket.ts`) несёт contractVersion издателя; offline-manifest bridge (AD-2) — contractVersion артефакта; verify: claim.contractVersion — valid semver (stateless). (4) packageFormat/bridgeProtocol — диапазоны [min,max] (entry 1 в контракте); client-диапазон = capability.

## Boundaries & Constraints

**Always:**
- Capability-поля `maxContractVersion`/`maxPackageFormat` — ОПЦИОНАЛЬНЫЕ в device-report: server не требует их presence (forward-compat: новый bridge на старом сервере — server просто их не знает; новый сервер их валидирует только при наличии).
- Несоответствие версии → **409 ConflictException с actionable-текстом** («Обновите локальный MCP на странице «Начало работы»: ...контракт до X») — паттерн `assertPackageBridge` (device-compatibility.ts:22-45); НЕ throw 500, НЕ generic limit-error, НЕ reject-без-текста.
- `asset.contractVersion` > `client.maxContractVersion` (semver) ИЛИ `maxContractVersion` отсутствует при наличии contractVersion у пакета ИЛИ packageFormat/bridgeProtocol вне [min,max] capability — каждый кейс = 409 actionable с указанием требуемой версии X.
- Ticket claim несёт `contractVersion` (издательский, semver): `issueHostedMcpTicket`/`verifyHostedMcpTicket` (gateway `ticket.ts`) — claim-поле обязательное (post-bump), verify проверяет valid semver.
- Offline-manifest bridge (AD-2, manifest локального runtime-артефакта) несёт contractVersion артефакта; сверка — при установке (client-сторона).
- Forward-compat-тесты: (а) report с НЕИЗВЕСТНЫМИ capability-полями → server принимает, игнорирует (не reject); (б) старый bridge (без maxContractVersion) + новый сервер + пакет с contractVersion → 409 actionable «обновите» (не 500, не reject-без-текста).

**Never:**
- Не требовать presence capability-полей (forward-compat сломается); не reject'ить новый bridge на старом сервере (это свойство OLD server'а — тест только NEW server: неизвестные поля игнорируются).
- Не вводить hard-reject (500/throw) при рассогласовании версий — только 409 actionable (AD-13: «не throw»).
- Не менять `protocolVersion` floor (==2, entry вне скоупа) и capability-флаги package-vN (они — packageFormat-диапазон, не контракт).
- Не трогать ceiling-значения (entry 1/2), verify-механику (entry 5) — только contractVersion-составляющую.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| HANDSHAKE_OK | asset.contractVersion 1.3.0 ≤ client.maxContractVersion 1.3.0 | authorize/install проходит | No error |
| CLIENT_OLDER | asset 1.4.0 > client 1.3.0 | 409 actionable «обновите до 1.4.0» | 409 |
| CLIENT_NO_FIELD | старый bridge (нет maxContractVersion), пакет c contractVersion | 409 actionable «обновите локальный MCP» | 409 |
| FORMAT_OUT_OF_RANGE | packageFormat вне capability [min,max] | 409 actionable | 409 |
| FORWARD_UNKNOWN | report с неизвестными capability-полями | server принимает, игнорирует | No error |
| SEMVER_INVALID | maxContractVersion «abc» | 400 (некорректный report) | 400 |
| CLAIM_CV | ticket claim c contractVersion | verify: valid semver (stateless) | invalid → 401 |
| CLAIM_NO_CV | claim без contractVersion (post-bump) | invalid claim | actionable |
| OFFLINE_MANIFEST | offline-manifest bridge: contractVersion артефакта | сверка при установке; mismatch → отказ | actionable |
| GRACEFUL_NO_THROW | любой кейс рассогласования | 409 с текстом (не 500, не throw) | 409 |

</frozen-after-approval>

## Code Map

**Device-report (capability):**
- `services/catalog-service/src/devices/device-report.ts:32-170` — `workspaceReport()`: валидация known-полей (неизвестные top-level ПРОХОДЯТ — forward-compat частично есть); добавить валидацию `maxContractVersion` (semver string) + `maxPackageFormat` (safe-integer ≥1) при наличии
- `device-report.ts:19-30` — `bridgePresence()` (degraded): allowlist keys — добавить новые поля (degraded-присутствие нового bridge не ломается)
- `services/catalog-service/src/devices/device-compatibility.ts:4-19` — `assertManagedBridge` (protocolVersion==2 + capabilities) — ШАБЛОН стиля ошибок
- `device-compatibility.ts:22-45` — `assertPackageBridge` (package-v3/v4/v5 → 409) — ШАБЛОН + точка, где packageFormat-диапазон уже частично сверяется
- Bridge report: `mcp/neurocenter-asset-sync/src/bridge/worker.ts:241-260` (heartbeat → report); поля report собираются в workspace-report-сборщике (найти при реализации: `bridgePresenceReport`/workspace report в `mcp/neurocenter-asset-sync/src/bridge/`)

**mcp-host handshake (server):**
- `services/catalog-service/src/devices/mcp-host-access.ts:156-199` — `authorizeHostedMcp(store, device, value)`: device.report на руках; после `approvedPackage`/`hostArtifact` — `assertContractBridge(device.report, asset)`; contractVersion пакета — из asset-descriptor (OQ1)
- `services/catalog-service/src/devices/mcp-host-access.ts:201-210` — `authorizeHostedMcpSession` (live re-check) — контрактная сверка НЕ заносящаяся повторно (claim уже сверен) — контекст

**Ticket claim (gateway):**
- `services/api-gateway/src/features/mcp-host/ticket.ts:5-23` — `IHostedMcpClaim`: + `contractVersion: string` (semver)
- `ticket.ts:55-77` — `issueHostedMcpTicket`: contractVersion в payload (из ответа catalog `authorize` — `mcp-host.controller.ts:48-135` передаёт)
- `ticket.ts:79-148` — `verifyHostedMcpTicket`: claim.contractVersion — valid semver (stateless; AD-3-совместимо)

**Контракт (entry 1 — контекст, не менять здесь):**
- `vendor/asset-contract/index.d.ts:11-17` — AssetBase (post-bump: +contractVersion); `lib/asset.mjs:81-84` — packageFormat/bridgeProtocol [min,max] (entry 1)

**Offline-manifest (AD-2):**
- Bridge runtime-artifact manifest: `mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts:15-22` (re-export LIMITS) — manifest-схема локального артефакта: +contractVersion (OQ2)

**Тесты (новые):** handshake (client-older/no-field/format-out/forward-unknown/semver-invalid), claim contractVersion (issue/verify), offline-manifest сверка; регистрация.

## Tasks & Acceptance

**Execution:**
- [ ] `device-report.ts` — `maxContractVersion`/`maxPackageFormat` (опциональные, валидация типов при наличии); `bridgePresence` allowlist
- [ ] Bridge: report несёт `maxContractVersion` (из версии контракта bridge'а) + `maxPackageFormat` (max schemaVersion = 5)
- [ ] `assertContractBridge(report, asset)` (new, device-compatibility.ts): semver-compare + presence-логика + [min,max] packageFormat/bridgeProtocol; 409 actionable (паттерн assertPackageBridge)
- [ ] `authorizeHostedMcp` — вызов `assertContractBridge` (device.report + asset contractVersion)
- [ ] Ticket claim: `IHostedMcpClaim.contractVersion` (issue/verify; catalog возвращает contractVersion в authorize-ответе)
- [ ] Offline-manifest bridge: contractVersion артефакта + сверка при установке
- [ ] Тесты (матрица) + регистрация

**Acceptance Criteria:**
- Given asset.contractVersion 1.4.0 > client.maxContractVersion 1.3.0, when authorizeHostedMcp, then 409 actionable «обновите до 1.4.0» (не 500, не generic).
- Given старый bridge (нет maxContractVersion) + пакет с contractVersion, when authorize, then 409 actionable «обновите локальный MCP» (не reject-без-текста).
- Given report с неизвестными capability-полями, when workspaceReport, then принят, поля игнорированы (forward-compat).
- Given ticket claim, when issue/verify, then contractVersion (valid semver) в claim; отсутствие (post-bump) → invalid.
- Given offline-manifest mismatch, when установка, then отказ (actionable).
- Корневой сьют — без деградации против baseline.

## Implementation Notes

Semver-compare: без зависимостей (semver-формат `MAJOR.MINOR.PATCH` — строковое сравнение по численным компонентам; pre-release — OQ3). Почему 409, а не 400/428: паттерн существующих `assert*Bridge` = ConflictException «Обновите локальный MCP...» — UI уже обрабатывает этот стиль (кнопка обновления); AD-13 «graceful actionable» = тот же UX-канал. Почему claim.contractVersion в stateless-verify: verify не имеет доступа к asset'у (только claim) — проверяет ФОРМУ (valid semver); семантическая сверка (claim ≤ capability) — при issuance (catalog) и в client (offline-manifest). Capability-диапазон packageFormat: client min = 3 (package-v3 флаг), max = maxPackageFormat (5); bridgeProtocol: [2,2] (единственный протокол) — пока.

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Где contractVersion у mcp-ассета.** Пакет (project_assets pin) — IPackage (schemaVersion/plugin/manifest); asset-descriptor (AssetBase с contractVersion после bump entry 1) — в репозитории ассета (ai_plugins + ai_plugin_versions metadata). Ожидается: descriptor JSON с contractVersion сохраняется при публикации (entry 1 валидирует). Если хранение contractVersion в ai_plugins-descriptor'е требует миграции — OQ1 (колонка/JSONB-поле).
2. **Forward-compat в двух направлениях.** (а) Новый bridge + старый сервер: старый server не знает поля — для full-report `workspaceReport` неизвестные top-level поля уже проходят (не reject); для degraded (`bridgePresence`) — allowlist строже (исправление в новом сервере: добавить поля в allowlist; на старом сервере degraded-присутствие нового bridge может отклоняться — это свойство OLD server'а, AD-13 требует только чтобы NEW server игнорировал). (б) Старый bridge + новый сервер: полей нет → 409 actionable «обновите» (не reject) — потому что пакет с contractVersion требует нового клиента.

## Open Questions (с рекомендациями)

- **OQ1 — Хранение contractVersion в ai_plugins-descriptor'е: нужна миграция?** Рекомендация: если descriptor JSON уже сохраняется целиком (post-bump contractVersion в нём) — миграция не нужна; иначе — JSONB-поле в ai_plugins (catalog migration). Уточнить при реализации.
- **OQ2 — Offline-manifest: где именно schema локального manifest (файл/JSON) и нужно ли отдельное поле или contractVersion уже в descriptor?** Рекомендация: в descriptor-блоке offline-manifest (один источник, entry 1). Подтвердить.
- **OQ3 — Semver pre-release/build-метки в contractVersion?** Рекомендация: только `MAJOR.MINOR.PATCH` (без pre-release) — контрактные версии — стабильные релизы; валидация строго. Подтвердить.

## Verification

**Commands:** (node-тесты — только `$NODE`; CATALOG_TEST_PG_URL-тесты — skip без БД)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `cd services/catalog-service && npm run build` → `$NODE scripts/test/contract-version-handshake.test.mjs` (new) — expected: матрица handshake (client-older/no-field/format-out/forward-unknown/semver-invalid) 0 fail
- `cd services/api-gateway && npm run build` → `$NODE scripts/test/mcp-host-ticket.test.cjs` — expected: без регрессии + claim.contractVersion (issue/verify)
- Bridge-тесты (offline-manifest сверка) — expected: mismatch → отказ
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации
