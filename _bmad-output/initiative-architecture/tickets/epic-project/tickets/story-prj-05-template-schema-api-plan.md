---
title: 'FR-102: шаблон проекта — schema + API (lifecycle, главный админ)'
type: 'feature'
ticket: '5'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-project/epic-project.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/ux/DESIGN.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** ПОНЯТИЯ ШАБЛОНА ПРОЕКТА НЕТ: grep projecttemplate/project_template/templateproject по catalog-service + frontend = 0. Проект создаётся `POST /api/projects {name, externalResourceId, retention, quotas, fsRootPath}` (catalog.controller.ts:112-131) без предзаполнения — каждый проект с нуля. FR-102/C4 (обязательство, R4): «Проект создаётся из шаблона: предзаполненный каталог (агенты/скиллы/модели), знания, роли и права. Lifecycle шаблона (создание, хранение, версионирование, правка) — главный админ.» C4 — ядро эпика 8; без шаблона нет «проект как единица» с воспроизводимым стартом.

**Approach:** Эта история — schema + API шаблона (НЕ создание проекта из него — entry 6). (1) Schema: `project_templates` + версии (key+version/heads/history pattern как learning-schema.ts / snapshot-commands.ts), immutable-версии, head-указатель. Шаблон = ССЫЛКИ (не копии данных): каталог (agent_ids/skill_ids/model_ids), знания (learning candidate ids + key), роли/права (role→level на member-слоты). (2) API: create/save-version/edit/archive — main-admin only (level 4), RBAC через projectLevel/roleCan. (3) Провенанс: SHA + версия + квитанция (R9/NFR-4), security_event на мутации. Idempotency: request_key (AD-D5 pattern). Lifecycle: создание → хранение → версионирование (новая версия) → правка (через новую версию, immutable) → archive (необратимо, pattern AD-16).

## Boundaries & Constraints

**Always:**
- Шаблон = ССЫЛКИ (agent/skill/model ids, learning candidate ids, role-slots) — НЕ копия данных (данные не дублируются в шаблоне).
- Версии immutable: правка = новая версия (key+version, head-указатель), как learning-schema.ts / snapshot-commands.ts (CAS expectedVersion).
- SHA + провенанс на каждую версию (R9); security_event на create/edit/archive (NFR-4).
- Lifecycle — main-admin only (level 4); RBAC через roleCan/projectLevel.
- Idempotency: request_key (повтор = no-op, AD-D5 pattern 4).
- Archive необратимо (pattern AD-16: archived→active запрещено).
- Шаблон не создаёт проект (entry 6) — только lifecycle шаблона.

**Never:**
- Не копировать данные проекта в шаблон (только ссылки/конфиг).
- Не менять existing-версию шаблона (immutable — только новая версия).
- Не давать lifecycle не main-admin (level<4 → 403).
- Не обходить CAS (expectedVersion) при смене head — race-окно.
- Не дублировать project-создание (entry 6) — здесь только шаблон.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Create шаблон (main-admin) | POST /project-templates {key, catalog, knowledge, roles} | Шаблон v1 + head + SHA + security_event |
| 2 | Save-version (правка) | POST save-version {expectedVersion, ...} | Новая версия, head сдвинут (CAS), SHA |
| 3 | CAS-конфликт (устаревший expectedVersion) | save-version с чужим expectedVersion | ConflictException (CAS) |
| 4 | Edit не main-admin | level<4, POST create/edit | 403 Forbidden |
| 5 | Archive шаблона | archive (main-admin) | archived, необратимо (archived→active запрещено) |
| 6 | Повторный create (idempotency) | тот же request_key | no-op (AD-D5) |
| 7 | Шаблон со ссылками на удалённые агенты/модели | create с невалидными ids | Валидация: ссылки существуют (404/actionable) |
| 8 | Head-указатель | get template | head = последняя версия, версия immutable |
| 9 | Шаблон без знаний/ролей | create {catalog only} | Допустимо (поля опциональны), SHA |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/catalog/catalog.controller.ts:112-131` — `POST /api/projects` (create project) — REFERENCE для RBAC/transaction-паттернов; `:133-148` PATCH, `:151-168` DELETE (не трогать).
- `services/catalog-service/src/learning/learning-schema.ts` — key+version/heads/history/requests, immutable triggers — REFERENCE для template-версионирования (переиспользовать паттерн).
- `services/catalog-service/src/snapshots/snapshot-commands.ts:46-79` — SnapshotCommands.move activate|rollback (CAS expectedHeadId/expectedHeadRevision) — REFERENCE для CAS-смены head.
- `services/catalog-service/src/learning/learning.repository.ts` — revision/head/heads pattern (:330-370) — REFERENCE.
- `services/catalog-service/src/access/access.model.ts` — projectLevel, roleCan — RBAC (level 4 = main-admin).
- `services/catalog-service/src/catalog/dto.ts` — projects.state/quotas/retention DTO-паттерн — REFERENCE.
- `services/catalog-service/src/models/models.repository.ts:334-365` — assign (advisory lock, project FOR KEY SHARE) — REFERENCE для ссылочных назначений.
- New: `project_templates` table (migration 53+), `project-template.*` (controller/service/repository/schema) — новый модуль (lazySection-паттерн не нужен — backend; UI — entry 6).

## Tasks & Acceptance

### Execution
- [ ] Migration 53+: `project_templates` (id, key UNIQUE, head_version, archived_at, created_by, created_at) + `project_template_versions` (template_id, version, catalog jsonb [agent_ids/skill_ids/model_ids], knowledge jsonb [candidate_ids/keys], roles jsonb [role-slots], sha256, request_key, created_by, created_at) + immutable triggers (pattern learning-schema.ts).
- [ ] `project-template.service.ts` — create (v1 + head + SHA), save-version (CAS expectedVersion → новая версия + head), archive (необратимо), get (head + версии).
- [ ] `project-template.controller.ts` — `POST /project-templates` (create), `POST /project-templates/:id/versions` (save-version, CAS), `POST /project-templates/:id/archive`, `GET /project-templates[/:id]` — main-admin only (roleCan level 4).
- [ ] SHA + провенанс: sha256 от canonical-JSON версии (R9); security_event (create/version/archive) — pattern :316-322 (models.repository.ts).
- [ ] Idempotency: request_key (create/save-version), повтор = no-op (AD-D5).
- [ ] Валидация ссылок: agent/skill/model ids существуют (404 actionable); learning candidate ids существуют в источнике.
- [ ] Тесты: create (main-admin), save-version CAS (успех/конфликт), archive необратимо, RBAC (level<4 → 403), idempotency, невалидные ссылки (404), SHA.

### Acceptance
- **Given** main-admin **when** POST /project-templates **then** шаблон v1 + head + SHA + security_event.
- **Given** save-version с корректным expectedVersion **when** POST **then** новая версия, head сдвинут (CAS), SHA.
- **Given** save-version с устаревшим expectedVersion **when** POST **then** ConflictException (CAS).
- **Given** level<4 **when** create/edit **then** 403.
- **Given** archive **when** POST **then** archived, archived→active запрещено (AD-16).
- **Given** повторный create (тот же request_key) **when** POST **then** no-op.
- **Given** шаблон с невалидными agent/model ids **when** create **then** 404 actionable.
- Корневой сьют — без деградации.

## Design Notes

- **Почему ссылки, не копии:** шаблон = конфигурация старта (какие агенты/скиллы/модели/знания/роли), не снапшот данных. Копирование данных = дублирование + рассинхрон (источник меняется, шаблон устаревает). Entry 6 (создание из шаблона) резолвит ссылки в назначение/перенос на момент создания.
- **key+version/heads pattern:** переиспользуем learning-schema.ts (key+version, immutable, head) — единый идиом версионирования в кодеbase. CAS (expectedVersion) — как snapshot-commands.ts:46-79.
- **SHA от canonical-JSON:** детерминированный SHA версии (R9 провенанс). Canonical-JSON (sorted keys) — детерминизм.
- **Archive необратимо (AD-16):** как retire-версии каталога (epic-trust-device-catalog entry 7). Archived шаблон не создаёт проекты (entry 6 проверит).
- **Roles/права в шаблоне:** role-slots = «какая роль на каком member-слоте» (например, creator→admin, invited→developer). Entry 6 применит к создаваемому проекту. Не конкретные users (шаблон не знает пользователей) — роли/слоты.
- **Почему main-admin (level 4):** FR-102: «lifecycle шаблона — главный админ». Шаблоны = организация-уровень (всё пространство), не проект-уровень.
- **Стык с entry 6:** entry 6 = создание проекта из шаблона (резолвит ссылки). Здесь — только lifecycle шаблона. Граница: `project-templates` API (здесь) vs `POST /api/projects {templateId}` (entry 6).
- **OQ-зависимость:** точные колонки agent/skill/model-ссылок (agent_ids из project_chat_rooms? skill-каталог? model project_models?) — dev-уточнить по existing assign-таблицам.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- project-template
```
Ожидаемо: create/save-version(CAS)/archive/RBAC/idempotency/валидация-ссылок/SHA — зелёные; корневой сьют без деградации.

## Open Questions

1. **Каталог-ссылки: agent_ids из какой таблицы?** Рекомендация: agent/skill/model — существующие каталожные id (ai_plugins/ai_skills/model_catalog). Dev-уточнить точные таблицы (project_assets / project_models / agent-каталог). Обоснование: шаблон ссылается на каталожные сущности.
2. **Knowledge-ссылки: candidate_ids или key?** Рекомендация: key+version (как learning) — детерминированно. Обоснование: candidate_id может измениться, key+version стабилен.
3. **Roles: role-slots или конкретные roles?** Рекомендация: role-slots (creator→admin, invited→developer) — шаблон не знает users. Обоснование: FR-102 «роли и права» = конфигурация, не конкретные люди.
4. **SHA — canonical-JSON или hash полей?** Рекомендация: canonical-JSON (sorted keys) всей версии. Обоснование: детерминизм + простота.
5. **Нужен ли отдельный service, или расширить catalog?** Рекомендация: отдельный модуль `project-template.*` (как learning/snapshots). Обоснование: чистая ответственность, не перегружать catalog.controller.
