---
title: 'FR-504: точечный перенос опыта/знания между проектами (с провенансом)'
type: 'feature'
ticket: '10'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-project/epic-project.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Переноса опыта/знания между проектами НЕТ (grep transfer/перенос по learning/ = 0). Знания/опыт изолированы в проекте: learning-цикл (learning.service.ts) работает внутри одного project_id; контекст (learning.repository.ts:350-370) читает только approved heads СВОЕГО проекта. FR-504 [пользователь, 2026-11-05]: «Точечный перенос опыта между проектами: явный выбор отдельных единиц опыта/знания (не bulk-копия всей базы) переносится между проектами с провенансом (источник — исходный проект); в целевом проекте единица проходит цикл FR-501 — до одобрения админом целевого проекта не попадает в контекст».

**Approach:** API/действие **точечного переноса** отдельных единиц (experience/knowledge candidate id) из проекта A (источник) в проект B (цель) с провенансом: `source_project_id` + `source_version` + SHA (R9/NFR-4). В проекте B единица = **исходный кандидат** (НЕ approved) → проходит цикл FR-501 (entry 9: порог/независимость) → в контекст (learning context(), только approved, learning.repository.ts:350-370) попадает ТОЛЬКО после одобрения админом B. Точечный (по выбранным id), НЕ bulk-копия. Копия версии (snapshot на момент переноса) — последующие правки A не влияют на копию в B.

## Boundaries & Constraints

**Always:**
- Точечный: явный выбор отдельных единиц (experience/knowledge candidate ids), НЕ bulk-копия всей базы.
- Провенанс: source_project_id + source_version + SHA (R9/NFR-4) — запись в B ссылается на источник.
- В B единица = кандидат (НЕ approved) → цикл FR-501 (entry 9) → контекст только после одобрения админом B (FR-502).
- Копия версии (snapshot на момент переноса): последующие правки A НЕ влияют на копию в B.
- RBAC: перенос — main-admin (источник: право читать; цель: право писать) — OQ точный уровень.
- Idempotency: request_key (повтор = no-op, AD-D5).

**Never:**
- Не bulk-копировать всю базу (только выбранные единицы).
- Не ставить перенесённое approved в B (только кандидат — FR-502).
- Не ломать исходник A (read-only источник, snapshot версии).
- Не обходить цикл FR-501 в B (перенесённое проходит порог/независимость/одобрение).
- Не терять провенанс (source_project_id+version+SHA обязательны, R9).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Точечный перенос | transfer {from A, to B, [candidate_ids]} | В B кандидаты + провенанс (source A+version+SHA) |
| 2 | Провенанс | запись в B | source_project_id + source_version + SHA |
| 3 | В B — approved? | после переноса, context() B | Пусто (кандидаты НЕ approved, FR-502) |
| 4 | Цикл FR-501 в B | перенесённое | Проходит порог/независимость (entry 9) → одобрение → контекст |
| 5 | Bulk-копия | transfer (вся база) | НЕ поддерживается (только выбранные id) |
| 6 | ПРАВКИ A после переноса | A меняется | Копия в B НЕ меняется (snapshot версии) |
| 7 | RBAC | без прав на A/B | 403 actionable |
| 8 | Idempotency | повторный transfer (request_key) | no-op |
| 9 | Невалидный candidate_id | transfer с чужим id | 404 actionable |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/learning/learning.service.ts` — recordExperience/proposeCandidate/candidateAction — REFERENCE для создания кандидата в B; точка расширения (transfer).
- `services/catalog-service/src/learning/learning.repository.ts:371+` — `addExperience`/candidate-создание — pattern для переноса (копия в B); `:350-370` `context()` (только approved) — НЕ трогать.
- `services/catalog-service/src/learning/learning-schema.ts` — experiences/hypotheses/checks/candidates key+version/heads/history — snapshot версии (source_version).
- `services/catalog-service/src/learning/learning-access.ts` — RBAC learning — права на A (читать) + B (писать).
- `services/catalog-service/src/learning/learning-validation.ts` — валидация — transfer (ids, from, to).
- New: `learning-transfer.*` (controller/service) — точечный перенос (transfer endpoint).
- Frontend: ProjectLearning — UI переноса (выбор единиц + цель + предпросмотр).

## Tasks & Acceptance

### Execution
- [ ] `learning-transfer.service.ts` — точечный перенос: принять {fromProject, toProject, candidate_ids, request_key} → прочитать единицы из A (snapshot версии) → создать в B как кандидаты (НЕ approved) + провенанс (source_project_id+source_version+SHA).
- [ ] Провенанс: запись в B несёт source_project_id + source_version + SHA (R9/NFR-4) — новая колонка/jsonb (migration 53+).
- [ ] Копия версии (snapshot): последующие правки A не влияют на B (копия на момент переноса).
- [ ] B: перенесённое = кандидат → цикл FR-501 (entry 9) → контекст только после одобрения (FR-502, context() не трогать).
- [ ] RBAC: права на A (читать) + B (писать) (OQ уровень).
- [ ] Idempotency: request_key (повтор = no-op).
- [ ] UI ProjectLearning: выбор единиц + цель + предпросмотр + перенос.
- [ ] Тесты: точечный перенос (кандидаты+провенанс), bulk НЕ поддерживается, правки A не влияют на B, FR-502 (НЕ approved), цикл FR-501 в B, RBAC, idempotency, невалидный id (404).

### Acceptance
- **Given** точечный перенос [candidate_ids] A→B **when** transfer **then** в B кандидаты + провенанс (source A+version+SHA).
- **Given** перенесённое в B **when** context() B **then** пусто (НЕ approved, FR-502).
- **Given** перенесённое в B **when** цикл FR-501 (entry 9) **then** порог/независимость → одобрение → контекст.
- **Given** bulk-копия (вся база) **when** transfer **then** НЕ поддерживается (только выбранные id).
- **Given** правки A после переноса **when** A меняется **then** копия в B НЕ меняется (snapshot версии).
- **Given** повторный transfer (request_key) **when** run **then** no-op.
- Корневой сьют — без деградации.

## Design Notes

- **Точечный, не bulk:** FR-504 явно «явный выбор отдельных единиц (не bulk-копия всей базы)». Bulk = риск переноса мусора/конфиденциального. Точечный = контроль.
- **Провенанс (R9):** source_project_id + source_version + SHA — обязательны. Без провенанса = дефект (NFR-4). Это отличает перенос от «просто создать заново».
- **Кандидат, не approved (FR-502):** перенесённое в B НЕ в контексте до одобрения админом B. Иначе источник «проталкивает» неоценённое в контекст B. Проходит цикл FR-501 (entry 9).
- **Snapshot версии:** копия на момент переноса. Последующие правки A не влияют на B (B самодостаточен). Это НЕ живая ссылка (иначе правки A «пробрасываются» в B — опасно).
- **Стык с entry 9 (FR-501):** перенесённое проходит политику подтверждений (entry 9) в B. Не дублируем цикл.
- **Стык с entry 6 (create-from-template):** создание из шаблона (entry 6) — предзаполнение при создании (знания-кандидаты из шаблона). Здесь (entry 10) — перенос между СУЩЕСТВУЮЩИМИ проектами (после создания). Разные механизмы, общая идея «кандидаты, не approved».
- **Стык с entry 13 (FR-311):** перенесённое (approved в B) индексируется (entry 13). Не дублируем.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- learning learning-transfer
node --test scripts/test/learning-transfer.test.mjs 2>/dev/null || true
```
Ожидаемо: точечный перенос (кандидаты+провенанс), bulk НЕ, правки A не влияют, FR-502 (НЕ approved), цикл FR-501 в B, RBAC, idempotency, невалидный id — зелёные; корневой сьют без деградации.

## Open Questions

1. **RBAC: кто может переносить?** Рекомендация: main-admin (level 4) — читает A + пишет B. Project-admin (3) — OQ (может ли per-project?). Обоснование: перенос = кросс-проектное действие, main-admin.
2. **Провенанс: колонка или jsonb?** Рекомендация: jsonb `transfer_provenance = {source_project_id, source_version, sha256, transferred_at, actor}`. Обоснование: гибкость (несколько полей).
3. **Снапшот версии: полный кандидат или с проверками?** Рекомендация: полный кандидат + связанные checks (провенанс доказательств). Обоснование: FR-501 цикл в B Needs checks (независимость).
4. **UI: перенос — из ProjectLearning A или B?** Рекомендация: из A (источник: «перенести в…»), цель B. Обоснование: выбор единиц в контексте источника.
5. **Перенос experience И knowledge (candidates)?** Рекоменdация: оба (FR-504 «опыта/знания»). Обоснование: experience → candidate → knowledge цикл.
