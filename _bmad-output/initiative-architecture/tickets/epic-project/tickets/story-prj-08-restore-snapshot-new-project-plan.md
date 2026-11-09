---
title: 'FR-104: restore снимка в новый проект (с верификацией)'
type: 'feature'
ticket: '8'
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

**Problem:** Snapshot-восстановление сейчас = activate/rollback head ВНУТРИ проекта (snapshot-commands.ts:46-79, CAS expectedHeadId/expectedHeadRevision) + release-profile capsule+signature (:174-317) + device upload lancedb-snapshot/v1 + verifier (snapshot.service.ts). Каталог `restore/` = host-level web-restore (P0-UPD, другой хост) — НЕ snapshot→новый-проект. **Gap FR-104:** «два пути восстановления: **restore в новый проект (с верификацией)** и activate/rollback снимка (смена head внутри проекта, CAS-проверка перед сменой)». Путь «restore в новый проект» ОТСУТСТВУЕТ (grep createProject/fromSnapshot по snapshots/ = 0). Снимок можно активировать/откатить только ВНУТРИ исходного проекта, но не восстановить как НОВЫЙ проект.

**Approach:** Добавить действие **«создать проект из снимка»** (snapshot.controller.ts — новый endpoint): верифицированный снимок (signature/capsule, snapshot-verifier.ts) → создать НОВЫЙ проект с данными снимка (БД/файлы/знания/чат — data-level FR-801) + квитанцией (receipt, NFR-4/R9). CAS-проверка перед активацией (существующая expectedHeadId/expectedHeadRevision). Новый проект = отдельный entity (не мутация исходного). Не менять activate/rollback внутри проекта (snapshot-commands.ts:46-79).

## Boundaries & Constraints

**Always:**
- Верификация снимка ОБЯЗАТЕЛЬНА до создания (signature/capsule, snapshot-verifier.ts): невалидный/чужой снимок → отклонён.
- Новый проект = отдельный entity (свой project_id), не мутация исходного.
- Квитанция (receipt, R9/NFR-4): source snapshot (id+SHA+version) + новый project_id.
- CAS-проверка (expectedHeadId/expectedHeadRevision) — переиспользовать (snapshot-commands.ts:46-79).
- Данные снимка (БД/файлы/знания/чат, FR-801) — перенесены в новый проект.
- RBAC: создание из снимка — main-admin/project-admin (level>=3).

**Never:**
- Не менять activate/rollback внутри проекта (snapshot-commands.ts:46-79) — отдельный путь.
- Не создавать проект из НЕВЕРИФИЦИРОВАННОГО снимка (signature/capsule обязательны).
- Не мутировать исходный проект при restore в новый (read-only источник).
- Не дублировать host-level web-restore (restore/ каталог, P0-UPD) — это другой путь (другой хост).
- Не обходить CAS — race-окно.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Restore в новый проект | POST /snapshots/:id/restore-as-project (верифицированный снимок) | Новый проект с данными снимка + квитанция |
| 2 | Провенанс нового проекта | metadata | source snapshot (id+SHA+version) + new project_id |
| 3 | Невалидный снимок | signature не совпадает | Отклонён (верификация, 4xx actionable) |
| 4 | Чужой снимок (другой проект/хост) | restore снимка без прав | 403/404 actionable |
| 5 | CAS-конфликт | expectedHeadId устарел | ConflictException (CAS) |
| 6 | Activate/rollback (внутри) | существующий путь | Не изменён (snapshot-commands.ts:46-79) |
| 7 | Данные снимка | новый проект | БД/файлы/знания/чат перенесены (FR-801) |
| 8 | RBAC | level<3, restore | 403 actionable |
| 9 | Повторный restore (idempotency) | тот же request_key | no-op (или новый проект — OQ) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/snapshots/snapshot-commands.ts:46-79` — SnapshotCommands.move activate|rollback (CAS expectedHeadId/expectedHeadRevision) — REFERENCE для CAS; `:174-317` release-profile capsule+signature.
- `services/catalog-service/src/snapshots/snapshot.service.ts` — device upload lancedb-snapshot/v1 + verifier — REFERENCE для верификации/данных.
- `services/catalog-service/src/snapshots/snapshot-verifier.ts` — верификация снимка (signature/capsule) — переиспользовать.
- `services/catalog-service/src/snapshots/snapshot-signature.ts` — подпись снимка.
- `services/catalog-service/src/snapshots/snapshot-storage.ts` — storage (blob, recoverWrite :418).
- `services/catalog-service/src/snapshots/snapshot-gc.ts` — 2-фазный GC (не трогать).
- `services/catalog-service/src/snapshots/snapshot.controller.ts` — текущие endpoints (activate/rollback) — добавить restore-as-project.
- `services/catalog-service/src/catalog/catalog.controller.ts:112-131` — POST /api/projects (create) — REFERENCE для создания нового проекта (entry 6 — стык).
- `services/catalog-service/src/restore/` — host-level web-restore (P0-UPD) — НЕ путать (другой путь, другой хост).
- `services/catalog-service/src/learning/` — знания снимка → новый проект (FR-801 data-level).

## Tasks & Acceptance

### Execution
- [ ] `snapshot.controller.ts` — новый endpoint `POST /snapshots/:id/restore-as-project` (или аналог): принять verifiy + request.
- [ ] Service: верифицировать снимок (snapshot-verifier.ts signature/capsule) → создать НОВЫЙ проект (catalog create pattern) → перенести данные снимка (БД/файлы/знания/чат, FR-801) → квитанция (source snapshot id+SHA+version + new project_id).
- [ ] CAS: expectedHeadId/expectedHeadRevision (snapshot-commands.ts:46-79 pattern) перед активацией.
- [ ] RBAC: level>=3 (main-admin/project-admin).
- [ ] Idempotency: request_key (OQ: повтор = no-op или новый проект).
- [ ] Тесты: restore верифицированного (новый проект+данные+квитанция), невалидный (отклонён), чужой (403/404), CAS-конфликт, activate/rollback не изменён, RBAC, данные (БД/файлы/знания/чат).

### Acceptance
- **Given** верифицированный снимок **when** restore-as-project **then** новый проект с данными снимка + квитанция (source snapshot id+SHA+version).
- **Given** невалидный/чужой снимок **when** restore **then** отклонён (верификация, 4xx actionable).
- **Given** CAS-конфликт (устаревший expectedHeadId) **when** restore **then** ConflictException.
- **Given** activate/rollback (внутри проекта) **when** run **then** не изменён (snapshot-commands.ts:46-79).
- **Given** level<3 **when** restore **then** 403 actionable.
- Корневой сьют — без деградации.

## Design Notes

- **Два пути восстановления (FR-104):** (1) restore в НОВЫЙ проект (здесь) — snapshot → новый project; (2) activate/rollback ВНУТРИ проекта (snapshot-commands.ts:46-79, существующий) — смена head. Разные пути, не смешивать.
- **Не путать с host-level web-restore (restore/):** restore/ каталог = P0-UPD (восстановление на ДРУГОМ хосте, whole-stack). Здесь = snapshot → новый проект (в пределах стека, data-level). Разные масштабы.
- **Верификация обязательна:** snapshot-verifier.ts (signature/capsule) — до создания. Невалидный снимок не создаёт проект (fail-closed, NFR-2).
- **CAS:** переиспользуем snapshot-commands.ts:46-79 (expectedHeadId/expectedHeadRevision) — race-защита.
- **Данные (FR-801):** БД/файлы/знания/чат — data-level. Перенос = restore data-доменов в новый проект. OQ: точный механизм (snapshot-blob → новый project-namespace).
- **Стык с entry 6 (create-from-template):** создание проекта (catalog) — общий pattern; здесь источник = снимок (не шаблон). Не конфликт.
- **Стык с epic-data entry 11 (deletion cascade):** новый проект из снимка — полноценный проект (подлежит cascade-удалению entry 11). Не дублируем.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- snapshots
node --test scripts/test/snapshot-restore-as-project.test.mjs 2>/dev/null || true
```
Ожидаемо: restore верифицированного (новый проект+данные+квитанция), невалидный/чужой отклонён, CAS-конфликт, activate/rollback не изменён, RBAC, данные (БД/файлы/знания/чат) — зелёные; корневой сьют без деградации.

## Open Questions

1. **Механизм переноса данных снимка → новый проект?** Рекомендация: snapshot-blob (S3) → restore в new project-namespace (БД/файлы/знания/чат). Dev-уточнить по snapshot-storage.ts (blob layout) + FR-801 data-level. Обоснование: снимок уже хранит data-level (FR-801).
2. **Idempotency: повторный restore = no-op или новый проект?** Рекомендация: request_key → no-op (повтор = та же квитанция/проект). Обоснование: AD-D5 pattern (повтор idempotent).
3. **Новый проект наследует имя исходного?** Рекомендация: имя = исходное + суффикс «(восстановлен)» (actionable, NFR-3). Обоснование: отличить от исходного.
4. **Restore — в «Операции» (долгая)?** Рекомендация: да (DESIGN.md rule 7) — перенос данных долгий. Обоснование: прогресс+retry.
5. **RBAC: main-admin (4) или project-admin (3)?** Рекомендация: level>=3 (project-admin может восстанавливать снимок СВОЕГО проекта). Обоснование: снимок привязан к проекту.
