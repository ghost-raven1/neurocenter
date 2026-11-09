---
title: 'Sweep + C4 e2e-приёмка (проект: шаблон → знания → модели → чат → поиск)'
type: 'feature'
ticket: '16'
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

**Problem:** 15 историй эпика 8 реализуют FR-608/604/601/602/102/103/104/501/504/401/311 (capability, in-use guard, GGUF-архив+E1, cancel, шаблон, lifecycle-UI, restore-снимка, политика подтверждений, перенос, режимы диалога, автономные раунды, знания/опыт-корпуса, единый поиск). Но ни одна не доказала, что **C4 (R4: проект из шаблона) работает СКВОЗЬ** — и не закрыт эпик целиком: нет sweep (мёртвые флаги/артефакты, drift, reindex-guard), нет финальной e2e-приёмки «проект как единица» (шаблон → знания → модели → чат → поиск), и не зафиксировано решение по FR-607 [P2]. C4 — ядро эпика 8 (обязательство); без сквозной e2e «проект как единица» не доказан.

**Approach:** (1) **Sweep:** вычистить мёртвые флаги/временные артефакты предыдущих историй; проверить drift (environment-model.json ↔ compose, pattern 1.12 D2: новый compose-сервис → environment-model + drift-тесты + compose-заголовок); закрыть OQ предыдущих историй; проверить reindex non-empty-index guard (FR-606: смена модели непустого индекса = только явная миграция, project-reindex.service.ts). (2) **C4 e2e-приёмка (R4):** сквозной сценарий: создать проект из шаблона (entry 5/6) → знания из шаблона проходят цикл FR-501 (entry 9: порог/независимость, только approved в контекст FR-502) → модели (capability FR-608 entry 1, in-use guard FR-604 entry 2, GGUF-архив+E1 entry 3) → чат (режимы FR-401 entry 11/12, комнаты/приватность FR-402/403, вложения FR-404) → поиск агента по 4 корпусам (FR-311 entry 13/14) с провенансом + freshness-guard. (3) **Решение по FR-607 [P2]** (Design Notes 1) — defer с обоснованием. HITL: финальная e2e-приёмка.

## Boundaries & Constraints

**Always:**
- Sweep: drift 0 (environment-model ↔ compose, pattern 1.12 D2), мёртвые флаги/артефакты вычищены, reindex non-empty-index guard (FR-606) подтверждён.
- C4 e2e — сквозной (шаблон → знания → модели → чат → поиск), на живых данных, все сегменты зелёные.
- Знания — только approved в контекст (FR-502, цикл FR-501 entry 9) — e2e проверяет.
- Поиск — 4 корпуса с провенансом + freshness-guard (FR-311) — e2e проверяет.
- Чат — режимы (FR-401), комнаты/приватность (FR-402/403), вложения (FR-404) — e2e проверяет.
- UI-канон (DESIGN.md): StatusTag, actionable-ошибки (NFR-3), Операции (rule 7), state в URL (rule 9), dead-ends D1–D16 (EXPERIENCE.md, не создавать новые).
- Node 24 (`~/.nvm/versions/node/v24.22.0/bin/node`) для тестов/сборки.

**Never:**
- Не reimplementировать 15 историй (sweep/e2e — consume их артефакты, не пересобирают).
- Не вводить новые dead-ends (EXPERIENCE.md D1–D16 — не создавать).
- Не менять production-код сервисов вне sweep-фиксов (sweep = чистка + drift + guard, не фичи).
- Не обходить drift-гейт (environment-model ↔ compose, pattern 1.12 D2).
- Не принимать C4 без сквозной e2e (изолированные тесты ≠ C4).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Sweep: drift | environment-model ↔ compose | 0 drift (pattern 1.12 D2) |
| 2 | Sweep: мёртвые флаги | feature flags/артефакты | Вычищены (мёртвые = нет) |
| 3 | Sweep: reindex-guard | смена модели непустого индекса | Только явная миграция (FR-606) |
| 4 | C4: проект из шаблона | POST /projects {templateId} | Проект предзаполнен (каталог+знания+роли) |
| 5 | C4: знания | из шаблона | Только approved в контекст (FR-502, цикл FR-501) |
| 6 | C4: модели | capability/in-use/GGUF-архив | FR-608/604/601 работают |
| 7 | C4: чат | режимы/комнаты/приватность/вложения | FR-401/402/403/404 работают |
| 8 | C4: поиск | агент → 4 корпуса | Провенанс + freshness-guard (FR-311) |
| 9 | C4: e2e-отчёт | сквозной сценарий | e2e-отчёт (C4 принят) |
| 10 | UI-канон | sweep | StatusTag/actionable/Операции/URL-state, нет новых dead-ends |

</frozen-after-approval>

## Code Map

- `deploy/production/environment-model.json` — compose-модель (сервисы/env) — drift-проверка (pattern 1.12 D2); новый compose-сервис (colibri, если spike GO) → environment-model + drift-тесты + compose-заголовок.
- `scripts/test/compose-drift.test.mjs` — drift-тест (both directions, 1.2/1.3) — sweep-проверка.
- `services/catalog-service/src/models/project-reindex.service.ts` — reindex non-empty-index guard (FR-606: «Нужно перестроить N фрагментов. Действующий индекс будет работать до переключения» :293-296, needs_input/building) — sweep-проверка.
- `services/catalog-service/src/catalog/catalog.controller.ts:112-131` — POST /api/projects (entry 6: templateId) — C4-сегмент.
- `services/catalog-service/src/project-template/` (entry 5) — шаблоны — C4-сегмент.
- `services/catalog-service/src/learning/` (entry 9/10/13) — знания/опыт/политика — C4-сегмент.
- `services/catalog-service/src/models/` (entry 1/2/3/4) — capability/in-use/GGUF/cancel — C4-сегмент.
- `services/catalog-service/src/project-chat/` (entry 11/12) — режимы/автономные раунды — C4-сегмент.
- `services/catalog-service/src/agent-tools/` (entry 14) — единый поиск — C4-сегмент.
- `frontend/nginx.production.conf.template:46-56` — E1-фикс (entry 3) — sweep-проверка.
- DESIGN.md: rule 1/3/6/7/9 (StatusTag/actionable/права/Операции/URL-state); EXPERIENCE.md: D1–D16 dead-ends (не создавать новые), state-matrix canon.
- `scripts/test/` — e2e-harness (production-stack.mjs pattern) — C4 e2e.

## Tasks & Acceptance

### Execution
- [ ] Sweep: вычистить мёртвые флаги/временные артефакты 15 историй (feature flags без читателя, temp-коды).
- [ ] Sweep: drift 0 (environment-model ↔ compose, pattern 1.12 D2); новый compose-сервис (colibri, если spike GO) → environment-model + drift-тесты + compose-заголовок.
- [ ] Sweep: reindex non-empty-index guard (FR-606) — проверить (project-reindex.service.ts: смена модели непустого индекса = только явная миграция, no auto-conversion).
- [ ] Sweep: закрыть OQ предыдущих историй (зафиксировать решения).
- [ ] Sweep: UI-канон (DESIGN.md): StatusTag (rule 1), actionable-ошибки (rule 3/NFR-3), права (rule 6), Операции (rule 7), state в URL (rule 9); нет новых dead-ends (EXPERIENCE.md D1–D16).
- [ ] C4 e2e (R4): сквозной — проект из шаблона (entry 5/6) → знания (цикл FR-501, только approved FR-502) → модели (capability/in-use/GGUF-архив) → чат (режимы/комнаты/приватность/вложения) → поиск агента по 4 корпусам (провенанс+freshness-guard).
- [ ] C4 e2e-отчёт: `c4-acceptance.json` (шаблон, знания, модели, чат, поиск — все сегменты).
- [ ] Решение по FR-607 [P2] — defer (Design Notes 1), задокументировано.
- [ ] Регистрация: `scripts/workspace/check-tooling-tests.json` + expectedFiles (union+sort при мерже — конфликтная зона).

### Acceptance
- **Given** sweep **when** drift **then** 0 drift (environment-model ↔ compose, pattern 1.12 D2).
- **Given** sweep **when** мёртвые флаги/артефакты **then** вычищены.
- **Given** смена модели непустого индекса **when** reindex **then** только явная миграция (FR-606, no auto-conversion).
- **Given** C4 e2e **when** сквозной сценарий **then** проект из шаблона → знания (approved only) → модели → чат → поиск (4 корпуса, провенанс+freshness) — все сегменты зелёные.
- **Given** e2e-отчёт **when** F6 **then** `c4-acceptance.json` (все сегменты, C4 принят).
- **Given** FR-607 [P2] **when** решение **then** defer (задокументировано с обоснованием).
- `check --tooling` зелёный; корневой сьют — без деградации.

## Design Notes

1. **Решение по FR-607 [P2] — DEFER (обоснование):** FR-607 «Контекст-окно каждой локальной модели; история/сравнение/откат системного промпта; разделение серверного и внешнего (OpenCode) потребления. Приоритет — открытый (agent-capability-audit)». **Решение: defer (вне эпика 8).** Обоснование: (a) контекст-окно механизм УЖЕ есть (`chat-context.ts` allocation/contextWindowTokens, num_ctx, chat-compaction) — «контекст-окно каждой локальной модели» закрыто; (b) GAP = история/сравнение/откат системного промпта + server-vs-OpenCode consumption split — это [P2] с ОТКРЫТЫМ приоритетом (agent-capability-audit), не закреплённым за C4; (c) C4 (обязательство эпика 8) НЕ зависит от FR-607 (шаблон/знания/модели/чат/ поиск работают без истории системного промпта); (d) включение добавит 3-day UI+API surface (system-prompt versioning + comparison + rollback + consumption split), блокирующее C4-приёмку. **Рекомендация:** FR-607 → отдельный P2-эпик (или epic-9 agent-team, где системный промпт агентов актуален). Контекст-окно (закрытая часть) — в entry 12 (autonomous rounds использует chat-context.ts).
2. **Sweep ≠ фичи:** sweep = чистка (мёртвые флаги/артефакты) + drift + guard + OQ, не новые фичи. Не reimplementировать 15 историй (consume их артефакты).
3. **C4 e2e = сквозной, не сумма изолированных:** каждая история проверена изолированно (unit/свой e2e-сегмент), но C4 = «проект как единица» (шаблон→знания→модели→чат→поиск) — только сквозной e2e доказывает связку. Как REL-01 (epic-release-baseline): изолированные части ≠ промышленный цикл.
4. **Drift (pattern 1.12 D2):** если spike (entry 15) вердикт GO/PARALLEL → colibri compose-сервис → environment-model.json + drift-тесты + compose-заголовок (pattern 1.12 D2: новый сервис = модель+drift+заголовок). Sweep проверяет.
5. **Reindex non-empty-index guard (FR-606):** «смена модели непустого индекса — только явная миграция или новый проект (автоматической конвертации векторов нет)». project-reindex.service.ts уже делает явную миграцию (needs_input/building, «Действующий индекс будет работать до переключения»). Sweep = ПРОВЕРИТЬ guard (не реализовывать).
6. **HITL: финальная e2e-приёмка:** запуск C4 e2e на живых данных + интерпретация отчёта + решение «C4 принят». HITL-точки: (H1) запуск e2e (resource-heavy), (H2) интерпретация отчёта + GO/NO-GO по C4.
7. **Dead-ends (EXPERIENCE.md D1–D16):** sweep проверяет, что 15 историй НЕ создали новых тупиков (NFR-3). Каждая ошибка actionable (следующий шаг). Не создавать новые D17+.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
# Sweep: drift + guard
node --test scripts/test/compose-drift.test.mjs -- expected: 0 drift (both directions)
node --test scripts/test/project-reindex-guard.test.mjs 2>/dev/null || true  # FR-606 non-empty-index
node scripts/workspace/check.mjs --tooling -- expected: sweep-артефакты в tooling-списке
# C4 e2e (HITL, resource-heavy):
node scripts/test/c4-acceptance-e2e.mjs -- expected: все сегменты зелёные, c4-acceptance.json
# Корневой сьют:
npm test -- expected: без деградации против baseline
```
Ожидаемо: drift 0, reindex-guard подтверждён, мёртвые флаги вычищены, OQ закрыты, UI-канон (нет новых dead-ends); C4 e2e: проект из шаблона → знания (approved only) → модели → чат → поиск (4 корпуса, провенанс+freshness) — все сегменты зелёные, `c4-acceptance.json`; FR-607 defer задокументирован; корневой сьют без деградации.

## Open Questions

1. **C4 e2e — на чистом хосте или dev-стеке?** Рекоменdация: dev-стек (production-stack.mjs pattern, unique project, fresh volumes) для повторяемого гейта; чистый хост — отдельный HITL (как REL-01 вариант A/B). Обоснование: повторяемость + детерминизм.
2. **Sweep: какие мёртвые флаги/артефакты?** Рекоменdация: аудит feature flags (без читателя) + temp-кодов 15 историй при запуске sweep. Обоснование: точный список — dev-аудит.
3. **FR-607 — defer в какой эпик?** Рекоменdация: epic-9 (agent-team) — системный промпт агентов актуален; или отдельный P2. Обоснование: FR-607 = системный промпт + consumption split, связано с агентами.
4. **Colibri compose-сервис в sweep?** Рекоменdация: только если spike (entry 15) GO/PARALLEL → environment-model + drift + заголовок (pattern 1.12 D2). Обоснование: зависит от вердикта.
5. **C4 e2e-отчёт — какой формат?** Рекоменdация: `c4-acceptance.json` (шаблон, знания, модели, чат, поиск — per-сегмент статус+данные). Обоснование: аудирует C4 (R4).
