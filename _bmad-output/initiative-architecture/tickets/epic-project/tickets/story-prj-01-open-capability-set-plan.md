---
title: 'FR-608: открытое множество capability модели + содержательная проба'
type: 'feature'
ticket: '1'
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
  - _bmad-output/initiative-architecture/ux/DESIGN.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Capability модели — ЗАКРЫТОЕ множество: `TModelCapability = 'embedding' | 'vision' | 'chat'` (model.interfaces.ts:1); валидация отклоняет любое другое значение (model-validation.ts:55-56, ошибка «Выберите назначение модели: embedding, vision или chat.»); GGUF-приёмка принимает только chat/embedding (gguf-import.model.ts:79 `['chat','embedding'].includes(...)`); agent-tools фильтрует `card.capability !== 'embedding'` (agent-tools.service.ts:141). FR-608 [пользователь, 2026-11-05] требует ОТКРЫТОГО множества (chat/text, vision, multimodal, embedding, rerank и прочие разновидности): capability — часть карточки и точного указания модели; закрытый список capability платформой НЕ заводится; «проверить модель» выполняет содержательную пробу заявленной capability (карточка ≠ работающая обработка). Сейчас «проверить» = частичная проба (ollama-client.ts:149-153), не содержательная по заявленному назначению.

**Approach:** (1) Сменить `TModelCapability` с закрытого union на открытый slug-тип (валидация формата: `[a-z][a-z0-9-]{0,31}`), сохранив задокументированный набор известных capability (chat, embedding, vision, multimodal, rerank) как СПРАВОЧНЫЙ (не блокирующий). (2) Переписать валидацию model-validation.ts:55-56 — принимать произвольный корректный slug, отклонять мусор. (3) Расширить GGUF-приёмку (gguf-import.model.ts:79) и agent-tools-фильтр (agent-tools.service.ts:141) под открытый набор (embedding-фильтр оставить для publicChats, но как сравнение со slug 'embedding', не как закрытый union). (4) Содержательная проба capability: «проверить модель» (model card action) выполняет пробу именно заявленного назначения (chat → реальный chat-turn, embedding → embed-вызов с проверкой dimension, rerank → rerank-вызов, vision → image-input-вызов), а не общий ping. (5) UI: capability-чипы карточки без закрытого списка (произвольный slug рендерится).

## Boundaries & Constraints

**Always:**
- Задокументированный набор известных capability (chat, embedding, vision, multimodal, rerank) остаётся справочным (для UI-подсказок), но НЕ блокирует новый slug.
- Capability — часть карточки и точного указания модели: change capability = новый revision карточки (model_catalog.revision, pattern models.repository.ts nextModelRevision :309).
- Содержательная проба = реальный вызов по назначению, не ping: проба должна отличить «карточка говорит rerank» от «модель реально реранжит».
- Slug-формат строго валидируется (lowercase, hyphen, ≤32, начинается с буквы) — не произвольная строка.
- Провенанс: capability в descriptor + version (R9); изменение capability = security_event (pattern :316-322).

**Never:**
- Не вводить закрытый whitelist capability в валидацию (FR-608: «закрытый список capability платформой не заводится»).
- Не ломать embedding-pin логику (project-embedding.validation.ts) — embedding остаётся capability='embedding', pin-проверки не трогать.
- Не изменять runtime-поведение моделей (inference) — capability = декларация + проба, не новый inference-путь.
- Не обходить dimension-проверку для embedding (assertProjectEmbeddingModel, project-embedding.validation.ts).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Новый capability slug | capability='rerank' | Принят (валидация :55-56 переписана), карточка создана |
| 2 | Экзотический slug | capability='audio-transcribe' | Принят (открытое множество), рендерится чип |
| 3 | Мусорный slug | capability='Embedding!' / '123' | Отклонён (BadRequest, slug-формат) |
| 4 | Содержательная проба chat | «проверить» модель capability=chat | Реальный chat-turn выполнен, результат записан |
| 5 | Содержательная проба embedding | «проверить» capability=embedding | embed-вызов + проверка dimension (assertProjectEmbeddingModel) |
| 6 | Карточка ≠ работающая | capability=rerank, модель не реранжит | Содержательная проба ПРОВАЛЕНА (карточка ≠ работающая обработка — дефект) |
| 7 | GGUF-импорт с rerank | ggufAcceptance capability='rerank' | Принят (gguf-import.model.ts:79 расширен) |
| 8 | agent-tools publicChats | capability='embedding' | Фильтр (agent-tools.service.ts:141) работает как прежде (сравнение со slug) |
| 9 | Смена capability | capability chat→rerank | Новый revision карточки + security_event (R9) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/models/model.interfaces.ts:1` — `TModelCapability = 'embedding' | 'vision' | 'chat'` (закрытый union) — точка изменения; `:9` capability в IModel; `:44` capability в descriptor.
- `services/catalog-service/src/models/model-validation.ts:55-56` — `if (!capabilities.includes(body.capability as TModelCapability))` + ошибка «Выберите назначение модели…» — переписать на slug-валидацию; `:50` fields; `:103` capability в результат.
- `services/catalog-service/src/models/gguf-import/gguf-import.model.ts:73-82` — `ggufAcceptance`, `:79` `['chat','embedding'].includes(String(input.capability))` — расширить под открытый slug; `:45-72` ggufIntent (не трогать).
- `services/catalog-service/src/agent-tools/agent-tools.service.ts:141` — `card.capability !== 'embedding'` (publicChats-фильтр) — сравнение со slug 'embedding'; `:99` assertProjectEmbeddingModel (не трогать).
- `services/catalog-service/src/models/ollama-client.ts:149-153` — текущая (частичная) проба capability — расширить до содержательной по назначению.
- `services/catalog-service/src/models/models.repository.ts:309-323` — nextModelRevision + security_event('model.pin') — паттерн для capability-change revision; `:24` assignment.
- `services/catalog-service/src/models/project-embedding.validation.ts` — assertProjectEmbeddingModel / projectEmbeddingPin — НЕ трогать (embedding-pin логика).
- Frontend: карточка модели (Catalog/Store) — capability-чипы; точный файл — dev-уточнение (Store.tsx / каталог моделей), рендер произвольного slug.

## Tasks & Acceptance

### Execution
- [ ] `model.interfaces.ts:1` — `TModelCapability` → открытый slug-тип (например `export type TModelCapability = string & { __capability?: never }` + валидатор `isCapabilitySlug`); задокументировать известные (chat/embedding/vision/multimodal/rerank) константой `KNOWN_CAPABILITIES` (справочная, не блокирующая).
- [ ] `model-validation.ts:55-56` — заменить union-check на `isCapabilitySlug(body.capability)`; ошибка → «Укажите назначение модели (capability) — slug из строчных букв/цифр/дефиса.»; сохранить fields (:50).
- [ ] `gguf-import.model.ts:79` — заменить `['chat','embedding'].includes(...)` на `isCapabilitySlug(...)` (GGUF-импорт принимает любой корректный slug); сохранить `validateModelCreate` (:82).
- [ ] `agent-tools.service.ts:141` — `card.capability !== 'embedding'` → сравнение со slug 'embedding' (поведение publicChats не меняется).
- [ ] Содержательная проба capability (ollama-client.ts:149-153 + inference.controller): «проверить модель» = реальный вызов по назначению (chat→turn, embedding→embed+dimension, rerank→rerank-вызов, vision→image-input); результат пробы (success/failed + причина) в карточку/receipt.
- [ ] UI: capability-чипы карточки — рендер произвольного slug (без закрытого списка); KNOWN_CAPABILITIES — только подсказка.
- [ ] Migration 53+: capability уже text-колонка (model_catalog.descriptor jsonb) — проверить, что slug не сломает существующие CHECK-констрейнты; при наличии CHECK на capability — расширить (dev-уточнение).
- [ ] Тесты: slug-валидация (принять/отклонить), содержательная проба (chat/embedding/rerank), GGUF-приёмка rerank, agent-tools-фильтр, capability-change revision+event.

### Acceptance
- **Given** capability='rerank' **when** создать модель **then** карточка создана (open set), slug принят.
- **Given** capability='123' / 'Embedding!' **when** создать **then** BadRequest (slug-формат).
- **Given** модель capability=chat **when** «проверить модель» **then** реальный chat-turn выполнен, результат пробы записан.
- **Given** модель capability=rerank, но модель не реранжит **when** содержательная проба **then** проба ПРОВАЛЕНА (карточка ≠ работающая обработка).
- **Given** GGUF-импорт capability='rerank' **when** ggufAcceptance **then** принят (gguf-import.model.ts:79 расширен).
- **Given** смена capability chat→rerank **when** update **then** новый revision + security_event (R9).
- Корневой сьют — без деградации.

## Design Notes

- **Почему slug-тип, а не string-без-типа:** TypeScript-уровень остаётся type-safe (branded type), но runtime принимает произвольный корректный slug. Баланс: нет закрытого union, но нет и произвольного мусора.
- **KNOWN_CAPABILITIES = справочная, не блокирующая:** UI использует для подсказок/иконки; валидация НЕ проверяет вхождение в KNOWN (FR-608: закрытый список не заводится).
- **Содержательная проба — ключевое отличие:** текущая проба (ollama-client.ts:149-153) — общий ping. FR-608: «проверить» = доказательство именно заявленной capability. Для rerank/vision — новые вызовы (rerank endpoint, image-input). Для embedding — существующий embed + dimension-check.
- **Сык с entry 3 (FR-601 GGUF-архив):** ggufAcceptance расширяется в entry 1 (capability), entry 3 добавляет архив — не конфликт (разные функции ggufIntent/ggufAcceptance).
- **FR-607 [P2] — defer (решение задокументировано в entry 16 sweep):** контекст-окно (num_ctx, compaction, chat-context.ts) уже есть; история/сравнение/откат системного промпта + разделение серверного/внешнего потребления — [P2], приоритет открытый (agent-capability-audit), C4 не зависит. Вне этого эпика.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- model-validation gguf-import agent-tools ollama
node --test scripts/test/model-capability.test.mjs 2>/dev/null || true
```
Ожидаемо: slug-валидация (принять/отклонить), содержательная проба (chat/embedding/rerank), GGUF-приёмка rerank, agent-tools-фильтр, capability-change revision+event — зелёные; корневой сьют без деградации.

## Open Questions

1. **Branded type vs plain string для TModelCapability?** Рекомендация: **branded slug-тип + `isCapabilitySlug` валидатор** (type-safe + open set). Обоснование: чистый `string` теряет type-safety; closed union нарушает FR-608.
2. **Содержательная проба rerank/vision — какие endpoint'ы?** Рекомендация: dev-уточнение (Ollama rerank endpoint, vision = image в chat). Если endpoint отсутствует у runtime — проба = «capability не подтверждена» (не провал модели).
3. **UI: capability-чипы — иконки для KNOWN, slug для прочих?** Рекомендация: KNOWN → иконка+label, прочие → slug-тег (StatusTag-совместимо, DESIGN.md rule 1).
4. **Нужен ли CHECK-констрейнт на capability в БД?** Рекомендация: **нет** (open set); валидация только на уровне сервиса (model-validation). При наличии существующего CHECK — dev-уточнить и снять.
