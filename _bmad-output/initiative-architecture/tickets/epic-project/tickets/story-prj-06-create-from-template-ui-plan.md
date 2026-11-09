---
title: 'FR-102: создание проекта из шаблона (catalog+knowledge+roles) + UI'
type: 'feature'
ticket: '6'
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
  - _bmad-output/initiative-architecture/ux/EXPERIENCE.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Entry 5 даёт lifecycle шаблонов (project_templates, ссылки на каталог/знания/роли). Но проект всё ещё создаётся `POST /api/projects {name, externalResourceId, retention, quotas, fsRootPath}` (catalog.controller.ts:112-131) БЕЗ предзаполнения; UI `CreateProjectModal.tsx` (frontend/src/modules/Projects/components/CreateProjectModal.tsx) — только name/externalResourceId/retention/quotas/fsRoot, выбора шаблона нет. C4 (R4): «Проект создаётся из шаблона: предзаполненный каталог (агенты/скиллы/модели), знания, роли и права». Без создания-из-шаблона C4 не выполнен.

**Approach:** Расширить `POST /api/projects` (catalog.controller.ts:112-131) на опциональный `templateId` (+ `templateVersion`). При создании из шаблона применить предзаполнение в одной транзакции: (1) **Каталог** — assign агентов/скиллов/моделей из шаблона (assign pattern models.repository.ts:334-365, project_assets); (2) **Знания** — перенести knowledge-ссылки шаблона в learning проекта КАК ИСХОДНЫЕ КАНДИДАТЫ (НЕ approved — проходят цикл FR-501 до контекста, FR-502: только approved в контексте); (3) **Роли/права** — назначить role-slots из шаблона (creator→роль, invited→роль). UI: CreateProjectModal получает выбор шаблона + предпросмотр предзаполнения (какие агенты/модели/знания/роли будут). Итог: проект из шаблона предзаполнен, но знания НЕ в контексте до одобрения (FR-502).

## Boundaries & Constraints

**Always:**
- Предзаполнение — в одной транзакции с созданием проекта (атомарность: либо проект+предзаполнение, либо ничего).
- Знания из шаблона = ИСХОДНЫЕ КАНДИДАТЫ в learning (НЕ approved) — в контекст (learning context() — только approved, learning.repository.ts:350-370) попадают ТОЛЬКО после одобрения (FR-502, цикл FR-501 entry 9).
- Каталог — assign существующих каталожных сущностей (models.repository.ts:334-365 pattern), не копии.
- Роли — role-slots из шаблона применены к creator + invited members.
- Провенанс: проект из шаблона несёт source template (templateId+version+SHA) в metadata (R9).
- UI: выбор шаблона + предпросмотр (NFR-1 простота, EXPERIENCE.md).

**Never:**
- Не ставить знания из шаблона approved (только кандидаты — FR-502).
- Не копировать данные каталога (assign ссылок, не дублировать).
- Не ломать существующий путь создания БЕЗ templateId (catalog.controller.ts:112-131 — regression).
- Не создавать проект из archived шаблона (entry 5: archive необратимо).
- Не делать предзаполнение fire-and-forget (атомарно с созданием).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Создание из шаблона | POST /projects {name, templateId, templateVersion} | Проект + каталог assigned + знания-кандидаты + роли + source-template metadata |
| 2 | Знания из шаблона в контексте? | после создания, learning context() | Пусто (кандидаты НЕ approved, FR-502) |
| 3 | Каталог из шаблона | после создания | Агенты/скиллы/модели assigned (project_models/project_assets) |
| 4 | Роли из шаблона | creator | creator→роль из шаблона, invited→роль |
| 5 | Создание БЕЗ templateId | POST /projects {name, ...} (существующий) | Как прежде (regression, не сломан) |
| 6 | Archived шаблон | POST {templateId=archived} | 404/Conflict (archived не создаёт) |
| 7 | Невалидный templateVersion | POST {templateId, templateVersion=999} | 404 actionable |
| 8 | Провенанс | metadata созданного проекта | source template (templateId+version+SHA) |
| 9 | UI: выбор шаблона | CreateProjectModal | Выпадающий список шаблонов + предпросмотр предзаполнения |
| 10 | UI: создание без шаблона | CreateProjectModal, без выбора | Существующий путь (не сломан) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/catalog/catalog.controller.ts:112-131` — `POST /api/projects` (create) — точка расширения (templateId+templateVersion); `:112-131` body validation.
- `services/catalog-service/src/catalog/` (catalog service) — create project — применить предзаполнение в транзакции.
- `services/catalog-service/src/models/models.repository.ts:334-365` — `assign` (advisory lock, project FOR KEY SHARE, INSERT project_models) — pattern для каталог-предзаполнения.
- `services/catalog-service/src/learning/learning.repository.ts:371+` — `addExperience`/candidate-создание — pattern для knowledge-кандидатов; `:350-370` `context()` (только approved) — НЕ трогать.
- `services/catalog-service/src/project-template/` (entry 5) — `project-template.service.ts` get (head+версии) — резолвить шаблон.
- `services/catalog-service/src/access/access.model.ts` — projectLevel/roleCan — ролевое назначение.
- `frontend/src/modules/Projects/components/CreateProjectModal.tsx` — текущий create (name/externalResourceId/retention/quotas/fsRoot) — добавить выбор шаблона + предпросмотр.
- `frontend/src/modules/Projects/Projects.tsx` — create-flow (open modal) — стык UI.
- DESIGN.md: rule 5 (lazySection), rule 9 (state в URL), rule 6 (права disabled+причина); EXPERIENCE.md: progressive disclosure, state-matrix canon.

## Tasks & Acceptance

### Execution
- [ ] `catalog.controller.ts:112-131` — `POST /api/projects` принимает опциональный `templateId` + `templateVersion`; валидация (шаблон существует, не archived, версия существует).
- [ ] Create-project service — при templateId: резолвить шаблон (entry 5 get head/версию) → в одной транзакции применить: (a) каталог assign (models.repository.ts:334-365 pattern, project_models + project_assets/agents/skills), (b) knowledge-кандидаты в learning (addExperience/candidate, НЕ approved), (c) role-slots (creator+invited).
- [ ] Провенанс: project metadata `source_template = {templateId, version, sha256}` (R9).
- [ ] Знания — исходные кандидаты: НЕ approved (learning context() остаётся пустым до одобрения, FR-502).
- [ ] UI `CreateProjectModal.tsx`: выпадающий список шаблонов (GET /project-templates) + предпросмотр (какие агенты/модели/знания/роли) + создание; создание без шаблона — существующий путь.
- [ ] Тесты: создание из шаблона (каталог+знания+роли+провенанс), знания НЕ в контексте (FR-502), без templateId (regression), archived (404), невалидная версия (404), UI-выбор+предпросмотр.

### Acceptance
- **Given** POST /projects {templateId} **when** create **then** проект + каталог assigned + знания-кандидаты + роли + source-template metadata (атомарно).
- **Given** проект из шаблона **when** learning context() **then** пусто (знания-кандидаты НЕ approved, FR-502).
- **Given** POST /projects {name, ...} без templateId **when** create **then** как прежде (regression).
- **Given** archived шаблон **when** create **then** 404/Conflict.
- **Given** CreateProjectModal **when** выбрать шаблон **then** предпросмотр предзаполнения + создание.
- Корневой сьют — без деградации.

## Design Notes

- **Атомарность предзаполнения:** создание проекта + предзаполнение — одна транзакция. Частичное предзаполнение (проект создан, каталог не assigned) недопустимо (NFR-2 fail-closed).
- **Знания = кандидаты, не approved:** КЛЮЧЕВОЕ (FR-502): шаблон несёт знания как ССЫЛКИ/исходные кандидаты; в контекст попадают только после одобрения (цикл FR-501, entry 9). Иначе шаблон «проталкивает» неоценённые знания в контекст — нарушение FR-502.
- **Каталог = assign, не copy:** переиспользуем models.repository.ts:334-365 (assign). Каталог-сущности общие (model_catalog/ai_plugins), проект лишь назначает. Не дублируем.
- **Role-slots:** шаблон несёт «creator→admin, invited→developer» (не конкретные users). Creator = создающий. Invited = будущие members (entry назначает при добавлении).
- **UI предпросмотр (NFR-1):** пользователь видит, что будет (агенты/модели/знания/роли), до создания. EXPERIENCE.md: progressive disclosure, нет тупиков (NFR-3) — предпросмотр = «что будет».
- **Стык с entry 5:** entry 5 = lifecycle шаблона; здесь = резолв ссылок при создании. Граница: `project-templates` (entry 5) vs `POST /projects {templateId}` (здесь).
- **Стык с entry 9 (FR-501):** знания-кандидаты из шаблона проходят цикл FR-501 (entry 9: порог/независимость) → одобрение → контекст. Не дублируем цикл.
- **Стык с entry 10 (FR-504):** перенос знаний между проектами (entry 10) — отдельный путь (явный выбор единиц). Шаблон = предзаполнение при создании (не перенос). Разные механизмы.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- catalog project-template learning
node --test scripts/test/create-from-template.test.mjs 2>/dev/null || true
```
Ожидаемо: создание из шаблона (каталог+знания+роли+провенанс) атомарно; знания НЕ в контексте (FR-502); без templateId regression; archived/невалидная версия 404; UI-выбор+предпросмотр; корневой сьют без деградации.

## Open Questions

1. **Каталог-предзаполнение: все 3 типа (agent/skill/model) или подмножество?** Рекомендация: все, что в шаблоне (entry 5 определяет, какие ссылки хранит). Обоснование: FR-102 «предзаполненный каталог (агенты/скиллы/модели)».
2. **Knowledge-кандидаты: перенос (entry 10 pattern) или ссылки?** Рекомендация: перенос как исходные кандидаты (копия записи в learning целевого проекта, НЕ approved). Обоснование: проект должен быть самодостаточен (не зависеть от существования источника).
3. **UI: предпросмотр — модалка или inline?** Рекомендация: inline в CreateProjectModal (выбор шаблона → предпросмотр ниже). Обоснование: NFR-1 (меньше шагов), DESIGN.md rule 9 (state в URL).
4. **Creator-роль: всегда admin или из шаблона?** Рекомендация: creator-роль из шаблона (role-slots), дефолт admin. Обоснование: FR-102 «роли и права» из шаблона.
5. **Нужен ли отдельный endpoint для предпросмотра?** Рекомендация: да, `GET /project-templates/:id/preview` (вернёт, что будет применено). Обоснование: UI-предпросмотр без создания.
