---
title: 'FR-501: политика подтверждений — порог 1..N + независимость доказательств'
type: 'feature'
ticket: '9'
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

**Problem:** Цикл FR-501 реализован (learning.service.ts: recordExperience/proposeHypothesis/checkHypothesis/proposeCandidate/candidateAction approve|reject|revoke|activate; LLM-analysis origin 'llm'; learning-schema.ts: experiences/hypotheses/checks/candidates key+version/heads/history/requests, immutable triggers). **Gap:** политика подтверждений ОТСУТСТВУЕТ — grep confirm/threshold/порог/независим по learning/ = 0. FR-501: «Политика подтверждений: порог — число независимых подтверждений (от 1 до N), настраивается админом проекта; повтор одного доказательства и несколько пересказов одной моделью не увеличивают счётчик независимых подтверждений; действующее человеческое одобрение активации сохраняется». Сейчас кандидат активируется без порога независимости — одно подтверждение (даже повторное/пересказ одной моделью) = активация.

**Approach:** (1) **Per-project confirmation policy:** порог независимых подтверждений (1..N), настраивается админом проекта (level>=3), хранится в project settings (learning policy). (2) **Независимость (dedup):** счётчик независимых подтверждений = число DISTINCT (source, origin) пар среди checks кандидата. Повтор одного доказательства (same source/check) НЕ увеличивает; несколько пересказов одной моделью (same origin 'llm' + same model) НЕ увеличивают. (3) **Активация:** кандидат активируется при независимых подтверждений >= порога ИЛИ действующим человеческим одобрением (approve — существующее, сохраняется). Revocation (revoke) — существующее.

## Boundaries & Constraints

**Always:**
- Порог 1..N — per-project, настраивается админом проекта (level>=3).
- Независимость = DISTINCT (source, origin) пар: повтор одного доказательства (same source/check) НЕ увеличивает; пересказ одной моделью (same origin+model) НЕ увеличивает.
- Активация: независимые >= порога ИЛИ действующее человеческое одобрение (approve).
- Действующее человеческое одобрение активации СОХРАНЯЕТСЯ (approve/revoke — learning.service.ts, не менять).
- Провенанс: подтверждение (check) несёт source+origin+model (R9) — база для dedup.
- Policy — fail-closed: нет policy = дефолт (OQ: порог=1 или отказ).

**Never:**
- Не увеличивать счётчик повтором одного доказательства (same source/check).
- Не увеличивать счётчик пересказами одной моделью (same origin 'llm' + same model).
- Не ломать approve/revoke/activate (learning.service.ts) — действующее человеческое одобрение сохраняется.
- Не вводить глобальный порог (per-project).
- Не обходить immutable triggers (learning-schema.ts) — policy = настройка, не мутация истории.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Порог по умолчанию | проект без policy | Дефолт (OQ: порог=1) |
| 2 | Настройка порога | админ проекта (level>=3), порог=3 | Policy сохранена (per-project) |
| 3 | Независимые подтверждения >= порога | 3 разных (source,origin) | Кандидат активируем |
| 4 | Повтор одного доказательства | same source/check повторно | Счётчик НЕ увеличен |
| 5 | Пересказ одной моделью | same origin 'llm' + same model ×3 | Счётчик = 1 (не 3) |
| 6 | Чув. одобрение (approve) | approve (человек) | Активация (независимо от порога) |
| 7 | Revoke | revoke | Отзыв (существующее) |
| 8 | Независимые < порога | 1 из 3 | НЕ активирован (ждёт) |
| 9 | Разные модели, один origin | llm model-A + llm model-B | OQ (независимы? — recommendation: да, разные модели) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/learning/learning.service.ts` — recordExperience/proposeHypothesis/checkHypothesis/proposeCandidate/candidateAction (approve|reject|revoke|activate) — точка расширения (политика + dedup); LLM-analysis origin 'llm'.
- `services/catalog-service/src/learning/learning-schema.ts` — experiences/hypotheses/checks/candidates key+version/heads/history/requests, immutable triggers — checks (source/origin/model) — база dedup; НЕ трогать immutable.
- `services/catalog-service/src/learning/learning.repository.ts:306-367` — candidateRows/activeCandidates/context (approved heads) — активация-логика; `:371+` addExperience.
- `services/catalog-service/src/learning/learning-validation.ts` — валидация learning-входов — расширить (policy).
- `services/catalog-service/src/learning/learning-access.ts` — RBAC learning — настройка policy (level>=3).
- Project settings (learning policy) — per-project порог (новая колонка/таблица, OQ).
- Frontend: ProjectLearning (frontend/src/modules/.../ProjectLearning) — UI политики (порог) + статус независимых подтверждений.

## Tasks & Acceptance

### Execution
- [ ] Per-project confirmation policy: порог 1..N (learning policy, per-project), настройка админом проекта (level>=3) — API + валидация.
- [ ] Dedup независимости: счётчик = DISTINCT (source, origin) пар среди checks кандидата (learning-schema.ts checks). Повтор same source/check НЕ увеличивает; same origin+model НЕ увеличивает.
- [ ] Активация: независимые >= порога ИЛИ действующее человеческое одобрение (approve). Интеграция с candidateAction (learning.service.ts).
- [ ] Провенанс: check несёт source+origin+model (R9) — убедиться, что хранится (для dedup).
- [ ] UI ProjectLearning: настройка порога + статус «независимых подтверждений: X из N».
- [ ] Тесты: порог (настройка), независимые >= порога (активация), повтор (не увеличивает), пересказ одной моделью (не увеличивает), approve (активация вне порога), revoke, < порога (не активирован).

### Acceptance
- **Given** админ проекта (level>=3) **when** настроить порог=3 **then** policy сохранена (per-project).
- **Given** 3 независимых подтверждения (разные source,origin) **when** порог=3 **then** кандидат активируем.
- **Given** повтор одного доказательства (same source/check) **when** подсчёт **then** счётчик НЕ увеличен.
- **Given** пересказ одной моделью (same origin+model ×3) **when** подсчёт **then** счётчик=1 (не 3).
- **Given** действующее человеческое одобрение (approve) **when** активация **then** активирован (вне порога).
- **Given** независимые < порога **when** активация **then** НЕ активирован (ждёт).
- Корневой сьют — без деградации.

## Design Notes

- **Независимость = DISTINCT (source, origin):** ключевое определение. «Источник» (source) = где наблюдение (user/device/check-id); «origin» = кто сгенерировал (user/llm/model). Повтор одного доказательства = same source (same check) → не независим. Пересказ одной моделью = same origin+model → не независим. Разные (source, origin) = независимы.
- **Почему (source, origin), не только origin:** один и тот же источник (same check), пересказанный, — не независим даже если «разные». А разные источники, даже одного origin (llm), — потенциально независимы (OQ-3: разные модели одного origin).
- **Чув. одобрение вне порога:** FR-501 «действующее человеческое одобрение активации сохраняется» — approve (человек) активирует независимо от порога. Порог = для АВТОМАТИЧЕСКОЙ активации (без человека).
- **Fail-closed policy:** нет policy = дефолт (OQ-1: порог=1 = текущее поведение, backward-compat). Не отказ (иначе сломает существующие проекты).
- **Immutable triggers (learning-schema.ts):** policy = настройка (не мутация history). Checks immutable (доказательства не меняются) — dedup читает, не пишет.
- **Стык с entry 10 (FR-504 transfer):** перенос единиц (entry 10) — в целевом проекте проходят цикл FR-501 (эту политику). Не дублируем.
- **Стык с entry 13 (FR-311):** индексация знаний/опыта (entry 13) — только approved (FR-502). Политика влияет на то, что approved.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- learning
```
Ожидаемо: порог (настройка), независимые >= порога (активация), повтор (не увеличивает), пересказ одной моделью (не увеличивает), approve (вне порога), revoke, < порога (не активирован) — зелёные; корневой сьют без деградации.

## Open Questions

1. **Дефолтный порог при отсутствии policy?** Рекомендация: **порог=1** (текущее поведение, backward-compat). Обоснование: fail-closed, но не ломает существующие проекты (1 подтверждение = активация, как сейчас).
2. **Источник (source) для dedup — check-id или origin+context?** Рекомендация: (source_id, origin, model) — тройка. Повтор = same source_id. Обоснование: точная идентификация доказательства.
3. **Разные модели одного origin (llm) — независимы?** Рекомендация: **да, независимы** (разные модели = разные «наблюдатели»). Обоснование: FR-501 «несколько пересказов одной моделью» — акцент на ОДНОЙ модели; разные модели = разные.
4. **Порог — число или policy-объект (веса)?** Рекомендация: число (1..N) — просто. Обоснование: FR-501 «порог — число независимых подтверждений (от 1 до N)».
5. **UI: настройка порога — в ProjectLearning или Settings?** Рекоменdация: ProjectLearning (там цикл FR-501). Обоснование: контекст.
