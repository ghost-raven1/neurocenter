---
title: 'FR-401: режимы диалога — сохранение в диалоге + UI-переключатель'
type: 'feature'
ticket: '11'
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
  - _bmad-output/initiative-architecture/ux/DESIGN.md
  - _bmad-output/initiative-architecture/ux/EXPERIENCE.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Режимов диалога НЕТ: `project_chat_rooms` (project-chat.schema.ts:2-10) не имеет поля mode. Существующее: групповая дискуссия (люди+агенты) в model-chat/chat-discussion.runner.ts (DISCUSSION_LIMITS calls=5/depth=1/contributions=3/120s, фазы, флаги group_chat/group_discussions); исследование — явный запуск (chat.controller.ts:32-67); @агенты — chat-group.*. Но «режим» не сохранён в диалоге и не переключается. FR-401: «Режимы диалога: обычный @; совместная дискуссия людей+агентов; автономные раунды — запускаются явным сообщением пользователя в чате или запросом агентов (лимит раундов/бюджет, пауза/остановка/вмешательство, шаг, уже потребивший бюджет, не повторяется после перезапуска); **режим сохраняется в диалоге**».

**Approach:** Эта история (часть 1) — **персистентность режима + UI-переключатель** (НЕ автономный движок — entry 12). (1) Schema: добавить `mode` в `project_chat_rooms` (CHECK mode IN ('mention','discussion','autonomous'), дефолт 'mention'). (2) API: PATCH mode (смена режима в диалоге). (3) Персистентность: режим сохраняется в диалоге (между сессиями/перезапусками). (4) UI: переключатель режима в проектном диалоге (mention/discussion/autonomous). Режим 'discussion' запускает существующую групповую дискуссию (chat-discussion.runner.ts) без деградации. Режим 'autonomous' — заглушка до entry 12 (явно «в разработке»/disabled+причина, NFR-3 — не тупик).

## Boundaries & Constraints

**Always:**
- `mode` в project_chat_rooms: CHECK ('mention','discussion','autonomous'), дефолт 'mention' (существующее поведение = mention).
- Режим сохраняется в диалоге (персистентность между сессиями/перезапусками).
- PATCH mode — RBAC (участник room'а, assertProjectChatRoomAccess).
- UI-переключатель: 3 режима, текущий подсвечен; autonomous до entry 12 — disabled+причина (NFR-3, DESIGN.md rule 6).
- Режим 'discussion' → существующая групповая дискуссия (chat-discussion.runner.ts) без деградации.
- StatusTag/UX-канон (DESIGN.md) для переключателя.

**Never:**
- Не реализовывать автономный движок (entry 12) — здесь только персистентность+UI.
- Не ломать @агенты (mention-режим, существующий) — regression.
- Не ломать групповую дискуссию (discussion-режим, chat-discussion.runner.ts) — regression.
- Не делать autonomous тупиком (disabled+причина, NFR-3 — не молчаливое отключение).
- Не менять schema-иммутабилити сообщений (project-chat.schema.ts:38-47 trigger) — mode на room, не на message.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Дефолтный режим | новый room | mode='mention' (существующее @-поведение) |
| 2 | Смена на discussion | PATCH mode='discussion' | Режим сохранён, групповая дискуссия (chat-discussion.runner.ts) |
| 3 | Смена на autonomous (до entry 12) | PATCH mode='autonomous' | Сохранён, UI disabled+причина (NFR-3) |
| 4 | Персистентность | перезапуск/новая сессия | Режим сохранён (не сбросился в mention) |
| 5 | @агенты (mention) | существующий | Не деградирует (regression) |
| 6 | Групповая дискуссия (discussion) | существующая | Не деградирует (regression) |
| 7 | RBAC: смена режима чужим | не участник room | 403 (assertProjectChatRoomAccess) |
| 8 | UI-переключатель | project chat | 3 режима, текущий подсвечен, autonomous disabled+причина |
| 9 | Невалидный mode | PATCH mode='xyz' | 400 (CHECK) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/project-chat/project-chat.schema.ts:2-10` — `project_chat_rooms` (project_id PK, agent_ids, model_id, model_pin) — добавить `mode` (CHECK, дефолт 'mention'); `:38-47` immutable trigger (не трогать — mode на room).
- `services/catalog-service/src/project-chat/project-chat-room-access.ts` — assertProjectChatRoomAccess — RBAC для PATCH mode.
- `services/catalog-service/src/project-chat/` (controller) — добавить PATCH mode.
- `services/catalog-service/src/model-chat/chat-discussion.runner.ts` — групповая дискуссия (режим discussion) — НЕ трогать (regression).
- `services/catalog-service/src/model-chat/chat-discussion.constants.ts` — DISCUSSION_LIMITS (calls=5/depth=1/contributions=3/120s) — REFERENCE.
- `services/catalog-service/src/model-chat/chat.controller.ts:32-67` — явный запуск исследования — REFERENCE (не режим).
- `frontend/src/modules/.../ProjectChat` (UI проект-чата) — переключатель режима (точный файл — dev-уточнение).
- DESIGN.md: rule 6 (disabled+причина), rule 9 (state в URL); EXPERIENCE.md: state-matrix canon.

## Tasks & Acceptance

### Execution
- [ ] Migration 53+: `project_chat_rooms` — добавить `mode text NOT NULL DEFAULT 'mention' CHECK(mode IN ('mention','discussion','autonomous'))`.
- [ ] PATCH mode endpoint (project-chat controller) — смена режима, RBAC (assertProjectChatRoomAccess).
- [ ] Персистентность: режим в БД (не in-memory) — переживает сессии/перезапуски.
- [ ] Режим 'discussion' → запуск существующей групповой дискуссии (chat-discussion.runner.ts) без деградации.
- [ ] Режим 'autonomous' — заглушка: UI disabled+причина «Автономные раунды — в разработке» (NFR-3, не тупик); backend принимает mode='autonomous' (для entry 12).
- [ ] UI: переключатель режима (mention/discussion/autonomous) в проектном диалоге, текущий подсвечен (DESIGN.md/EXPERIENCE.md канон).
- [ ] Тесты: дефолт mention, PATCH discussion (персистентность), autonomous (заглушка), персистентность (перезапуск), @агенты regression, групповая дискуссия regression, RBAC, невалидный mode (400).

### Acceptance
- **Given** новый room **when** create **then** mode='mention' (существующее @-поведение).
- **Given** PATCH mode='discussion' **when** смена **then** режим сохранён, групповая дискуссия (chat-discussion.runner.ts).
- **Given** перезапуск/новая сессия **when** открыть диалог **then** режим сохранён (персистентность).
- **Given** @агенты (mention) **when** run **then** не деградирует (regression).
- **Given** групповая дискуссия (discussion) **when** run **then** не деградирует (regression).
- **Given** autonomous (до entry 12) **when** UI **then** disabled+причина (NFR-3, не тупик).
- Корневой сьют — без деградации.

## Design Notes

- **Почему mode на room, не на message:** «режим сохраняется в диалоге» (FR-401) — режим свойство ДИАЛОГА (room), не сообщения. room = project_chat_rooms (per-project shared dialog). Mode-колонка на room.
- **3 режима (FR-401):** (1) mention = обычный @ (существующий, дефолт); (2) discussion = совместная дискуссия людей+агентов (существующая, chat-discussion.runner.ts); (3) autonomous = автономные раунды (entry 12).
- **Autonomous-заглушка (NFR-3):** до entry 12 autonomous = disabled+причина (не тупик, DESIGN.md rule 6). Backend принимает mode='autonomous' (schema готово к entry 12), но не запускает движок.
- **Почему не на model_chat_conversations:** personal dialogs (model_chat) — отдельные; FR-401 режимы — для ПРОЕКТНЫХ диалогов (rooms). Personal dialog mode — OQ (вне этой истории).
- **Персистентность:** mode в БД (project_chat_rooms) — переживает перезапуски/сессии. Не in-memory.
- **Стык с entry 12 (autonomous engine):** entry 12 реализует движок автономных раундов (использует mode='autonomous' из этой истории). Граница: персистентность+UI (здесь) vs движок (entry 12).
- **Regression-чувствительность:** mention (@-агенты) и discussion (групповая дискуссия) — существующие пути, НЕ ломать. Mode-колонка дефолт 'mention' = текущее поведение.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- project-chat chat-discussion
```
Ожидаемо: дефолт mention, PATCH discussion (персистентность), autonomous-заглушка, персистентность (перезапуск), @агенты/групповая дискуссия regression, RBAC, невалидный mode — зелёные; корневой сьют без деградации.

## Open Questions

1. **Personal dialogs (model_chat) — нужны ли режимы?** Рекомендация: **нет для этой истории** (FR-401 режимы = проектные диалоги/rooms). Personal dialog mode — OQ (отдельно). Обоснование: scope.
2. **Autonomous-заглушка: disabled или «запустится после entry 12»?** Рекоменdация: disabled+причина «в разработке» (NFR-3). Обоснование: не тупик, не ложное ожидание.
3. **PATCH mode — только участник или admin room'а?** Рекоменdация: участник room'а (assertProjectChatRoomAccess). Обоснование: режим = свойство диалога, участники управляют.
4. **UI-переключатель: segment-control или dropdown?** Рекоменdация: segment-control (3 варианта, компактно). Обоснование: UX-канон (DESIGN.md).
5. **Смена режима с активным обсуждением?** Рекоменdация: завершить/подтвердить текущее обсуждение перед сменой (actionable). Обоснование: не сломать in-flight.
