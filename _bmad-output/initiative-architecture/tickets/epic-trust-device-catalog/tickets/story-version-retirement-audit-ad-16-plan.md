---
title: 'Retire версии: необратимый отзыв + запись в аудит + server-гейты (AD-16, FR-204, entry 7)'
type: 'feature'
ticket: '7'
created: '2026-11-09'
status: 'ready-for-dev'
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'high'
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

**Problem:** Невозможно отозвать багованную/RCE-версию каталога (AD-16): контракт запрещает удаление опубликованных версий, `archived_at` — asset целиком (не версию, `plugin-repository.ts:486`), legacy-retirement — fixed-scope демо. Version-level retire ОТСУТСТВУЕТ (`ai_plugin_versions` без status). Нужен необратимый отзыв конкретной версии с записью в аудит (FR-204): новые назначения не разрешаются, запуск в mcp-host и проверка билета не проходят, уже запущенные сессии гаснут при следующей проверке (окно ≤ TTL кэша, entry 6), версия остаётся в каталоге (провенанс сохраняется).

**Approach:** Контракт (entry 1) несёт `status: 'active'|'retired'` (retired необратим). Catalog: version-level `status` в `ai_plugin_versions` + admin-эндпоинт retire (необратимый) + запись в `security_events`. Server-гейты: retired версия не разрешается для новых назначений (project_assets), не стартует в mcp-host (`artifact open()` + `authorize-session`), не проходит ticket-verify (через live re-check, AD-3). Уже запущенные сессии гаснут при следующем re-check (entry 6, ≤60s).

## Boundaries & Constraints

**Always:**
- Version-level `status: 'active'|'retired'` в `ai_plugin_versions` (новая колонка, default `active`, CHECK constraint); retired необратим.
- Admin-эндпоинт retire (main-admin): `POST ai-plugins/:id/versions/:v/retire` — ставит `retired`, запись в `security_events` (`securityEvent`, `security-events.ts:12`).
- Гейты (retired версия):
  - Новые назначения (project_assets, `POST projects/:id/assets` → `ProjectAssetRepository`) — НЕ разрешаются.
  - mcp-host: `approvedPackage`/`hostArtifact` (`mcp-host-access.ts`) — отклоняют retired (и при новом `authorizeHostedMcp`, и в `authorizeHostedMcpSession`); `artifact open()` — gated authorize-session.
  - ticket-verify — не проходит для retired (механизм — live re-check `authorize-session`, AD-3/AD-4, entry 6 кэш).
- Уже запущенные сессии гаснут при следующем re-check (окно ≤ TTL кэша 60s, entry 6).
- Версия остаётся в каталоге (провенанс сохраняется — FR-204): строка `ai_plugin_versions` + байты артефакта не удаляются.
- `assertIndexEvolution` (контракт, entry 1): `retired→active` запрещено.
- Скоуп: mcp/plugin (`ai_plugins`/`ai_plugin_versions`) — FR-204.

**Never:**
- Удаление published version (immutable — FR-202/AD-16): retire = статус, не удаление.
- `retired→active` (необратимо): повторный retire/restore → ошибка.
- Retire без записи в аудит (security_events).
- Retire для kinds вне скоупа (skill/model/agent/bridge) без OQ-решения (OQ3).
- Тихое гашение уже запущенных сессий вне окна re-check (окно ≤60s, entry 6).
- Территория кэша/re-check (entry 6), UJ-2 провенанс-карточка (entry 12) — не сюда.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| RETIRE | main-admin, `POST .../versions/:v/retire` | `status='retired'` + запись в security_events | No error |
| RETIRE_IRREVERSIBLE | повторный retire / restore → active | ошибка «retired необратим» | actionable |
| ASSIGN_RETIRED | новое назначение retired версии (project_assets) | отказ | actionable |
| MCPHOST_RETIRED | mcp-host authorize/authorize-session для retired | отклонён | actionable |
| ARTIFACT_OPEN_RETIRED | `artifact open()` для retired (gated) | отклонён (authorize-session) | actionable |
| TICKET_RETIRED | билет retired версии, live re-check | не проходит (403/отзыв) | actionable |
| LIVE_SESSION | уже запущенная сессия, retire | гаснет при следующем re-check (≤60s) | No error |
| PROVENANCE | retired версия | остаётся в каталоге (строка + байты + провенанс) | No error |
| AUDIT | retire | запись в security_events (actor/action/before/after) | No error |
| NON_MAIN_ADMIN | retire не main-admin | 403 | 403 |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/database/schema-contract/part-01.ts:5-22` — колонки `ai_plugin_versions` — + `status` (text, default 'active', CHECK in ('active','retired'))
- `services/catalog-service/src/publication/publication-schema.ts` — additive migration (DDL `status`); schema-contract части (part-01/04/05/06) — обновить контракт
- `services/catalog-service/src/publication/plugin-repository.ts:530` — insert version (status default 'active'); `:486` — asset-level archive (контекст, не version)
- `services/catalog-service/src/catalog/catalog.controller.ts:686,715` — `versions` list + `activate`; + `@Post('ai-plugins/:id/versions/:v/retire')` (main-admin)
- `services/catalog-service/src/catalog/catalog.service.ts` — retire-метод (необратимый + securityEvent)
- `services/catalog-service/src/access/security-events.ts:12` — `securityEvent` (аудит retire)
- `services/catalog-service/src/catalog/project-asset-repository.ts:65` — INSERT project_assets — гейт: retired версия не назначается
- `services/catalog-service/src/devices/mcp-host-access.ts:91-140` — `approvedPackage`/`hostArtifact` — гейт: retired отклоняет (authorize + authorize-session)
- `services/catalog-service/src/devices/mcp-host-access.ts:201-210` — `authorizeHostedMcpSession` (live re-check) — retired отклоняет
- `services/catalog-service/src/runtime-artifacts/runtime-artifacts.ts:159` — `open()` (gated authorize-session; контекст)
- `services/catalog-service/src/catalog/catalog.controller.ts:404` — `POST projects/:id/assets` (назначение — гейт retired)
- Тесты: retire (необратимый + аудит), гейты (assign/mcp-host/ticket), live-session-окно, провенанс-сохранение; регистрация

## Tasks & Acceptance

**Execution:**
- [ ] DDL: `ai_plugin_versions.status` (additive migration + schema-contract); default 'active', CHECK
- [ ] `catalog.service.ts` + `catalog.controller.ts` — `POST ai-plugins/:id/versions/:v/retire` (main-admin, необратимый, securityEvent)
- [ ] Гейт назначения: `project-asset-repository.ts` / `POST projects/:id/assets` — retired не назначается
- [ ] Гейт mcp-host: `mcp-host-access.ts` `approvedPackage`/`hostArtifact`/`authorizeHostedMcpSession` — retired отклоняет
- [ ] Тесты: retire (необратимый + аудит + 403 non-admin), гейты (assign/mcp-host/artifact-open/ticket), live-session-окно ≤60s, провенанс-сохранение; регистрация

**Acceptance Criteria:**
- Given main-admin retire версии, when `POST .../retire`, then `status='retired'` + запись в security_events; повторный retire/restore → ошибка «необратим».
- Given retired версия, when новое назначение (project_assets), then отказ (actionable).
- Given retired версия, when mcp-host authorize/authorize-session, then отклонён; `artifact open()` gated (отклонён).
- Given билет retired версии, when live re-check, then не проходит (403/отзыв); уже запущенная сессия гаснет при следующем re-check (≤60s, entry 6).
- Given retired версия, when каталог, then строка + байты + провенанс сохраняются (не удалены).
- Retire не main-admin → 403. Корневой сьют — без деградации.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Почему status, а не удаление: AD-16 — «контракт запрещает удаление опубликованных версий»; FR-202 immutable. Retire = статус `retired` (необратимый), байты и провенанс сохраняются (FR-204). Гейты: (1) назначение — в `ProjectAssetRepository`/`POST projects/:id/assets` (новые назначения не разрешаются); (2) mcp-host — в `approvedPackage`/`hostArtifact`/`authorizeHostedMcpSession` (и при новом authorize, и в live re-check); (3) artifact open() — gated authorize-session (open() keyed by sha, version-гейт на уровне authorize-session); (4) ticket-verify — через live re-check (AD-3: retired НЕ в stateless HMAC verify, а в live re-check). Уже запущенные сессии: гаснут при следующем re-check (entry 6 кэш, окно ≤60s) — «окно ≤ TTL кэша». Аудит: `securityEvent` (transactional, security_events) — R9 «100% admin-мутаций в транзакционном аудите». Скоуп mcp/plugin (ai_plugins) по FR-204; расширение на skill/model/agent/bridge — OQ3 (каждая kind-таблица своя).

## Open Questions

- **OQ3 (скоуп):** retire — только mcp/plugin (ai_plugins) или все kinds (skill/model/agent/bridge)? FR-204/AD-16 говорят о «версии каталога» (общее). Рекомендация: начать с mcp/plugin (ai_plugin_versions), расширение на другие kinds — отдельная итерация (свои таблицы). Owner: human.
- **OQ:** колонка `status` vs `retired_at` (timestamp). Рекомендация: `status` (согласованно с контрактом) + `retired_at` для аудита-времени (опционально). Подтвердить.
- **OQ:** retire — main-admin только (как activate) или project-admin? Рекомендация: main-admin (глобальный отзыв версии каталога). Подтвердить.

## Verification

**Commands:** (node-тесты — только `$NODE`)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `cd services/catalog-service && npm run build` → retire/гейт-тесты — expected: 0 fail
- Проверка аудит: retire → строка в security_events (тест)
- Проверка необратимости: restore retired→active → ошибка (тест)
- Проверка провенанса: retired версия остаётся в каталоге (строка + байты, тест)
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации
