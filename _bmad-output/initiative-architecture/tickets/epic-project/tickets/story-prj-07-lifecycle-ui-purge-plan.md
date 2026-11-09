---
title: 'FR-103: жизненный цикл проекта в UI (archive/lock) + верификация защищённого RAG-purge'
type: 'feature'
ticket: '7'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-project/epic-project.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/ux/DESIGN.md
  - _bmad-output/initiative-architecture/ux/EXPERIENCE.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Server-side FR-103 реализован: `projects.state = ACTIVE|ARCHIVED|LOCKED` (catalog/dto.ts:22, project-validation.ts:52), PATCH state (catalog.controller.ts:133-148), DELETE (catalog.controller.ts:151-168), ручной retire RAG (retired-rag.service.ts 489 строк: freeze+DROP, request_key idempotency, preview→purge→receipt, `automaticPurge:false` :113; retired-rag.controller.ts:14-57). **Gap = UI:** `ProjectDetail.tsx` НЕ имеет переходов состояния (grep ARCHIVED/LOCKED/PATCH по ProjectDetail.tsx = 0) и не показывает state — пользователь не может архивировать/локнуть проект из UI и не видит текущее состояние. FR-103: «Жизненный цикл проекта (создание → активен → архив) и удаление с полным каскадом… Ручной retire RAG-БД (вне удаления проекта) — защищённый явный purge (retention/hold/preview/подтверждение); автоматический purge — только триггер удаления проекта».

**Approach:** (1) **UI жизненного цикла:** показать state проекта (StatusTag: ACTIVE/ARCHIVED/LOCKED — из common StatusTag/constants.ts, DESIGN.md rule 1) + действия archive/lock/unlock (main-admin/project-admin, level>=3) через PATCH state (catalog.controller.ts:133-148) с actionable-ошибками (NFR-3). (2) **Верификация защищённого RAG-purge:** подтвердить, что ручной purge (retired-rag preview→подтверждение→receipt) доступен и защищён (retention/hold/preview/подтверждение), а автоматический purge НЕ активируется вне удаления проекта (триггер удаления = epic-data entry 11). Не reimplementировать cascade (epic-data entry 11) и не менять retired-rag (automaticPurge:false — ратификация).

## Boundaries & Constraints

**Always:**
- State показывается через StatusTag (ACTIVE/ARCHIVED/LOCKED) — единственный способ (DESIGN.md rule 1, StatusTag/constants.ts).
- Действия archive/lock/unlock — через PATCH state (catalog.controller.ts:133-148), RBAC level>=3 (project-admin)/4 (main-admin).
- Actionable-ошибки (NFR-3): сообщение + причина + следующий шаг (DESIGN.md rule 3).
- Ручной RAG-purge (retired-rag) — защищён (retention/hold/preview/подтверждение), НЕ менять (automaticPurge:false — ратификация).
- Долгие операции (lock/unlock с freeze) — через «Операции» (DESIGN.md rule 7).

**Never:**
- Не reimplementировать deletion cascade (epic-data entry 11 — отдельная территория).
- Не менять `automaticPurge:false` (retired-rag.service.ts:113) — ратификация.
- Не активировать автоматический purge вне триггера удаления проекта.
- Не показывать state через прямой Tag color=... (DESIGN.md rule 1 — только StatusTag).
- Не создавать тупиковые состояния (NFR-3): locked проект должен иметь recovery (unlock).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Показ state | ProjectDetail, проект ACTIVE | StatusTag ACTIVE |
| 2 | Archive проекта | action archive (level>=3) | PATCH state=ARCHIVED, StatusTag ARCHIVED |
| 3 | Lock проекта | action lock (level>=3) | PATCH state=LOCKED, StatusTag LOCKED |
| 4 | Unlock проекта | action unlock (level>=3) | PATCH state=ACTIVE (recovery) |
| 5 | Действие без прав | level<3, archive | 403 actionable (NFR-3: какое право нужно) |
| 6 | Ручной RAG-purge | retired-rag preview→подтверждение | защищённый purge (retention/hold), receipt |
| 7 | Автоматический purge | без удаления проекта | НЕ активируется (automaticPurge:false) |
| 8 | Locked проект — recovery | unlock | Возврат в ACTIVE (не тупик, NFR-3) |
| 9 | Долгая операция (lock с freeze) | lock | В «Операции» (прогресс, DESIGN.md rule 7) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/catalog/catalog.controller.ts:133-148` — `PATCH /projects/:id` (state/retention/quota) — endpoint для archive/lock/unlock; `:151-168` DELETE (не трогать).
- `services/catalog-service/src/catalog/dto.ts:22` — `projects.state = ACTIVE|ARCHIVED|LOCKED`; project-validation.ts:52 — state-валидация.
- `services/catalog-service/src/retired-rag/retired-rag.service.ts` — ручной purge (489 строк, freeze+DROP, `automaticPurge:false` :113, preview→purge→receipt) — НЕ менять, только верифицировать.
- `services/catalog-service/src/retired-rag/retired-rag.controller.ts:14-57` — purge routes (list/preview/purge/retry/authorize) — верифицировать доступность.
- `frontend/src/modules/Projects/ProjectDetail.tsx` — gap: нет state-показа/переходов (grep ARCHIVED/LOCKED/PATCH = 0) — точка UI-расширения.
- `frontend/src/modules/Projects/Projects.tsx` — list, state-показ (StatusTag).
- `frontend/src/common/components/StatusTag/constants.ts` — карта статусов (ACTIVE/ARCHIVED/LOCKED) — переиспользовать (DESIGN.md rule 1).
- `frontend/src/modules/.../RetiredRagDatabases` (UI purge) — существующий purge-UI (DESIGN.md §2.3: RetiredRagDatabases.less) — верифицировать.
- DESIGN.md: rule 1 (StatusTag), rule 3 (actionable-ошибки), rule 6 (права disabled+причина), rule 7 (Операции); EXPERIENCE.md: state-matrix canon, D1–D16 (не создавать новые тупики).

## Tasks & Acceptance

### Execution
- [ ] `ProjectDetail.tsx` — показать state проекта (StatusTag ACTIVE/ARCHIVED/LOCKED из common StatusTag/constants.ts).
- [ ] `ProjectDetail.tsx` — действия archive/lock/unlock (main-admin/project-admin, level>=3) через PATCH state (catalog.controller.ts:133-148); RBAC через Permission/roleCan (DESIGN.md rule 6: disabled+причина, не скрытие).
- [ ] Actionable-ошибки (NFR-3): 403 → «Попросите у администратора проекта право…», state-конфликт → причина+следующий шаг (DESIGN.md rule 3).
- [ ] Долгие операции (lock с freeze) — в «Операции» (DESIGN.md rule 7).
- [ ] Верификация RAG-purge: ручной purge (retired-rag preview→подтверждение→receipt) доступен и защищён (retention/hold); автоматический purge НЕ вне удаления (automaticPurge:false :113).
- [ ] `Projects.tsx` — state в списке (StatusTag).
- [ ] Тесты: state-показ (StatusTag), archive/lock/unlock (PATCH, RBAC), actionable-403, ручной purge (preview→подтверждение), автоматический purge не активируется, recovery (unlock не тупик).

### Acceptance
- **Given** проект **when** открыть ProjectDetail **then** state показан через StatusTag (ACTIVE/ARCHIVED/LOCKED).
- **Given** level>=3 **when** archive/lock/unlock **then** PATCH state применён, StatusTag обновлён.
- **Given** level<3 **when** archive **then** 403 actionable (NFR-3: какое право нужно).
- **Given** ручной RAG-purge **when** preview→подтверждение **then** защищённый purge (retention/hold), receipt.
- **Given** без удаления проекта **when** автоматический purge **then** НЕ активируется (automaticPurge:false).
- **Given** locked проект **when** unlock **then** возврат в ACTIVE (recovery, не тупик NFR-3).
- Корневой сьют — без деградации.

## Design Notes

- **UI- gap, не server:** server-side (PATCH state, DELETE, retired-rag) уже реализован — здесь только UI-показ/переходы + верификация purge. Не дублируем backend.
- **StatusTag — единственный способ (DESIGN.md rule 1):** ACTIVE/ARCHIVED/LOCKED уже в StatusTag/constants.ts. Не использовать прямой Tag color=... (antipattern DESIGN.md §3.3).
- **Recovery locked (NFR-3):** locked ≠ тупик. Unlock — recovery-путь. Locked проект показывает, ЧТО заблокировано + как разблокировать (actionable).
- **Ручной vs автоматический purge:** ручной (retired-rag, operator-triggered) — сохраняется (automaticPurge:false ратификация). Автоматический — только триггер удаления проекта (epic-data entry 11). Здесь верифицируем, не меняем.
- **Стык с epic-data entry 11 (deletion cascade):** полный каскад удаления (БД+файлы+S3+RAG) — epic-data entry 11. Здесь: lifecycle UI (archive/lock) + верификация ручного purge. Не дублируем cascade.
- **Права (DESIGN.md rule 6):** archive/lock — disabled+причина (не скрытие) для level<3. Main-admin (level 4) всегда; project-admin (level 3) — по RBAC.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- catalog retired-rag
# UI: e2e-чек state-показа/переходов (существующий harness)
```
Ожидаемо: state-показ (StatusTag), archive/lock/unlock (PATCH+RBAC), actionable-403, ручной purge (preview→подтверждение→receipt), автоматический purge не активируется, recovery (unlock) — зелёные; корневой сьют без деградации.

## Open Questions

1. **Lock vs archive — семантика в UI?** Рекомендация: archive = «неактивен, доступен для просмотра/восстановления»; lock = «запись заблокирована (freeze)». Разные подписи в UI (actionable). Обоснование: LOCKED (freeze) ≠ ARCHIVED (неактивен).
2. **Кто может unlock — только main-admin?** Рекомендация: тот, кто lockнул (level>=3) + main-admin (level 4). Обоснование: симметрия lock/unlock.
3. **Ручной purge — в ProjectDetail или отдельный раздел?** Рекомендация: отдельный раздел (RetiredRagDatabases — существующий), из ProjectDetail — ссылка. Обоснование: purge = операционное действие, не project-lifecycle.
4. **Нужен ли confirmation-диалог на archive/lock?** Рекомендация: да (Modal.confirm, DESIGN.md §2.5 — критичные действия). Обоснование: необратимые/влияющие действия.
