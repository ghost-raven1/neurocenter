---
title: 'FR-604: in-use guard снятия назначения — живой чат/агент/embedding'
type: 'feature'
ticket: '2'
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

**Problem:** Снятие назначения модели (unassign) блокирует ТОЛЬКО embedding-pin: `unassign` (models.repository.ts:367-397) проверяет только `project_embedding_settings` (:373-380, «Модель используется текущим индексом проекта. Сначала выберите другую модель или отключите эмбеддинги в настройках проекта.»). Живой чат/агент, использующий модель, НЕ проверяется (grep 'in-use' по models/ = 0): проект может снять модель, назначенную в живом проектном диалоге (project_chat_rooms.model_id) или в активной model_chat/агентской сессии — и диалог сломается. FR-604: «Точный project model set с in-use guard (живой чат/агент/embedding) и снятием назначения».

**Approach:** Расширить unassign-guard (models.repository.ts:367-397) на 3 проверки в одной транзакции (после существующей embedding-pin :373-380): (1) embedding-pin (существующий, не менять); (2) живой проектный чат — `SELECT 1 FROM project_chat_rooms WHERE project_id=$1 AND model_id=$2` (room с назначенной моделью); (3) активные model_chat/агентские сессии, где модель = действующая (model_chat_conversations с active model_id, agent-сессии). Guard = fail-closed: ConflictException с actionable-сообщением (следующий шаг: остановить/закрыть диалог или сменить модель в диалоге). Не трогать assign (:334-365) и archive (`requireUnassigned: true`, :330 — отдельный, более строгий guard).

## Boundaries & Constraints

**Always:**
- Все 3 проверки — в одной транзакции unassign (models.repository.ts:368), под advisory lock `asset-management:model:<id>` (:369) — нет race-окна.
- Fail-closed: любая найденная in-use ссылка → ConflictException с actionable-сообщением (NFR-3: указан следующий шаг).
- Сообщение различает причину: embedding-pin (существующий) / проектный чат / активная сессия.
- `requireUnassigned: true` (archive, models.repository.ts:330) — более строгий guard, НЕ трогать (archive и unassign — разные уровни).
- Idempotency: unassign несуществующего назначения → false (существующее поведение :385-387), guard не меняет.

**Never:**
- Не блокировать unassign из-за ЗАВЕРШЁННЫХ/удалённых диалогов (только ЖИВЫЕ: room с model_id не NULL, active conversation/агент).
- Не трогать assign (:334-365) и archive (requireUnassigned :330).
- Не вводить мягкую блокировку/warning — только hard fail-closed (ConflictException).
- Не менять project_embedding_settings-логику (entry epic-data 7/8 retention — отдельная территория).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Модель в живом проектном чате | unassign, project_chat_rooms.model_id=модель | ConflictException «модель используется в проектном диалоге» + следующий шаг |
| 2 | Модель в активной model_chat-сессии | unassign, active conversation с model | ConflictException «модель используется в активном диалоге» |
| 3 | Модель в embedding-pin | unassign, project_embedding_settings | ConflictException (существующий guard :373-380, не деградирует) |
| 4 | Модель свободна | unassign, нет ссылок | Успех, security_event project.model.remove (:388-394) |
| 5 | Назначение уже снято | unassign повторно | false (no-op, :385-387), guard не сломан |
| 6 | Завершённый/удалённый диалог использовал модель | unassign | Успех (завершённые НЕ блокируют) |
| 7 | Race: room назначил модель во время unassign | concurrent | advisory lock (:369) → одна транзакция, guard видит актуальное состояние |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/models/models.repository.ts:367-397` — `unassign` (advisory lock :369, project FOR UPDATE :372, embedding-pin guard :373-380, DELETE :381-384, security_event :388-394) — точка расширения.
- `services/catalog-service/src/models/models.repository.ts:334-365` — `assign` (advisory lock :336, project FOR KEY SHARE :339, INSERT :350-354) — НЕ трогать.
- `services/catalog-service/src/models/models.repository.ts:327-332` — `remove`/archive с `requireUnassigned: true` (:330) — более строгий guard, НЕ трогать.
- `services/catalog-service/src/project-chat/project-chat.schema.ts:2-10` — `project_chat_rooms` (model_id :7, `CHECK((model_id IS NULL)=(model_pin IS NULL))` :9) — источник in-use-ссылки «проектный чат».
- `services/catalog-service/src/model-chat/` — model_chat_conversations (owner_email, model_id, agent_ids) — источник in-use-ссылки «активная сессия» (точная колонка/статус active — dev-уточнение).
- `services/catalog-service/src/agent-tools/agent-tools.service.ts:197-199` — infer с `getUsable`+`projectEmbeddingPin` сверкой — пример активной агентской сессии (агент-модель).
- `services/catalog-service/src/models/project-embedding.validation.ts` — project_embedding_settings (embedding-pin) — существующий guard, не менять.

## Tasks & Acceptance

### Execution
- [ ] `models.repository.ts:367-397` `unassign` — после embedding-pin guard (:373-380) добавить 2 проверки в той же транзакции: (a) `SELECT 1 FROM project_chat_rooms WHERE project_id=$1 AND model_id=$2` → ConflictException «Модель используется в проектном диалоге. Сначала закройте диалог или смените в нём модель.»; (b) активные model_chat/агентские сессии с model_id=модель → ConflictException «Модель используется в активном диалоге. Сначала завершите диалог.»
- [ ] Actionable-сообщения: различают причину + следующий шаг (NFR-3); формат — как существующий embedding-pin (:378-380).
- [ ] Завершённые/удалённые диалоги НЕ блокируют (WHERE status active / removed_at IS NULL — dev-уточнить по model_chat-схеме).
- [ ] Тесты: unassign в живом проектном чате → Conflict; unassign в активной сессии → Conflict; unassign embedding-pin (не деградирует); unassign свободной → успех; повторный unassign → false; завершённый диалог не блокирует.
- [ ] Regression: assign (:334-365) и archive (requireUnassigned :330) — без изменений.

### Acceptance
- **Given** модель назначена в живом проектном чате (project_chat_rooms.model_id) **when** unassign **then** ConflictException с actionable-сообщением (следующий шаг).
- **Given** модель в активной model_chat/агентской сессии **when** unassign **then** ConflictException.
- **Given** модель в embedding-pin **when** unassign **then** ConflictException (существующий guard :373-380, без деградации).
- **Given** модель свободна **when** unassign **then** успех + security_event.
- **Given** завершённый/удалённый диалог использовал модель **when** unassign **then** успех (не блокирует).
- Корневой сьют — без деградации.

## Design Notes

- **Почему 3 проверки в одной транзакции:** in-use guard должен быть атомарным — между проверкой и DELETE нет окна, где модель «занялась» (advisory lock :369 + project FOR UPDATE :372 уже дают это для embedding-pin; расширяем тем же).
- **Живой vs завершённый:** блокируем только ЖИВЫЕ ссылки. Завершённый диалог, который когда-то использовал модель, не должен вечно блокировать unassign (иначе модель невозможно снять после завершения всех диалогов). «Живой» = room с model_id (room не удаляется) / active conversation (dev-уточнить статус).
- **Точность in-use-ссылки проектного чата:** project_chat_rooms.model_id — room-level назначение. Если room переключает модель — модель «освобождается» (model_id меняется). Guard читает актуальное model_id room'а.
- **Агент-сессии:** агент-модель (agent-tools infer :197) — активная, пока идёт turn. После завершения turn модель свободна. Dev-уточнить, как определить «активный» agent/model_chat (lease/turn-status).
- **Не дублируем requireUnassigned (archive):** archive (:330) — более строгий (нельзя заархивировать назначенную модель вообще). unassign — мягче (нельзя снять занятую). Разные уровни, оба сохраняются.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- models.repository unassign project-chat
```
Ожидаемо: unassign-тесты зелёные (проектный чат/активная сессия/embedding-pin → Conflict; свободная → успех; завершённый не блокирует); assign/archive без деградации; корневой сьют без деградации.

## Open Questions

1. **Как определить «активную» model_chat/агентскую сессию?** Рекомендация: active = есть незавершённый turn/lease (model_chat_turns status pending/running) ИЛИ room с model_id. Dev-уточнить по model_chat-схеме (статусы/lease_until). Обоснование: завершённая сессия не должна блокировать.
2. **project_chat_rooms.model_id — room-level; а если в room несколько моделей (агенты)?** Рекомендация: guard на room.model_id (основная модель room'а). Агент-модели — отдельная in-use-ссылка (agent-сессии). Dev-уточнить, хранятся ли агент-модели отдельно от room.model_id.
3. **Сообщение: единое или per-причина?** Рекомендация: per-причина (embedding-pin/проектный чат/активная сессия) — actionable (NFR-3), как существующий embedding-pin.
