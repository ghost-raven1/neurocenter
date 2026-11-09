---
title: 'FR-401: автономные раунды — бюджет, пауза/остановка/вмешательство, идемпотентность'
type: 'feature'
ticket: '12'
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
  - _bmad-output/initiative-architecture/ux/EXPERIENCE.md
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Entry 11 даёт `mode` в project_chat_rooms (включая 'autonomous' — заглушка). **Gap FR-401:** автономные раунды — движок. «автономные раунды — запускаются явным сообщением пользователя в чате или запросом агентов (лимит раундов/бюджет, пауза/остановка/вмешательство, **шаг, уже потребивший бюджет, не повторяется после перезапуска**); режим сохраняется в диалоге». Сейчас автономного режима нет: групповая дискуссия (chat-discussion.runner.ts) — ОДНО приватное обсуждение (DISCUSSION_LIMITS calls=5/depth=1/contributions=3/120s), не итеративные автономные раунды. Нет: явного запуска автономных раундов, лимита раундов/бюджета, паузы/остановки/вмешательства, идемпотентности «потребивший бюджет шаг не повторяется».

**Approach:** Движок **автономных раундов** (использует mode='autonomous' из entry 11): (1) **Запуск** — явным сообщением пользователя в чате ИЛИ запросом агентов (явный триггер, не автозапуск). (2) **Лимит раундов/бюджет** — enforced (NFR-6/R11): макс. число раундов, бюджет tokens/вызовов/времени; перерасход невозможен (fail-closed). (3) **Пауза/остановка/вмешательство** — операторские действия: пауза (halt между раундами), остановка (полный stop), вмешательство (вставить сообщение/направление в раунд). (4) **Идемпотентность (КЛЮЧЕВОЕ):** «шаг, уже потребивший бюджет, не повторяется после перезапуска» — checkpoint по request_key/phase (pattern chat-discussion.runner.ts checkpoint :79-87 + model_chat_turns request_id/lease): после перезапуска потребившие бюджет шаги НЕ повторяются (no-op), не-потребившие — продолжаются. Бюджет-учёт через model-token-quotas/model-rate-limits (существующие). Референс-движок — chat-discussion.runner.ts (bounded, checkpoint, phases, deadline, authority/checkpoint pattern).

## Boundaries & Constraints

**Always:**
- Запуск — явный (сообщение пользователя ИЛИ запрос агентов), не автозапуск.
- Лимит раундов/бюджет enforced (NFR-6): перерасход → остановка (fail-closed), не «тихий перерасход».
- Бюджет-учёт через model-token-quotas/model-rate-limits (существующие) — не новый отдельный бюджет.
- Пауза/остановка/вмешательство — операторские действия (RBAC участник room'а).
- Идемпотентность: шаг, уже потребивший бюджет, НЕ повторяется после перезапуска (checkpoint request_key/phase).
- Чекпоинт каждого раунда/шага (durable, request_key) — как chat-discussion.runner.ts checkpoint :79-87.
- Mode='autonomous' (entry 11) — precondition (режим сохранён в диалоге).

**Never:**
- Не автозапускать автономные раунды (явный триггер только).
- Не перерасходовать бюджет (enforced, fail-closed).
- Не повторять шаг, уже потребивший бюджет, после перезапуска (идемпотентность — ключевое FR-401).
- Не ломать mention/discussion режимы (entry 11 regression).
- Не обходить checkpoint (durable) — in-memory «я запомнил» недопустимо (перезапуск).
- Не дублировать бюджет (model-token-quotas/model-rate-limits — существующие).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Запуск (пользователь) | явное сообщение в autonomous-диалоге | Автономные раунды запущены |
| 2 | Запуск (агент) | запрос агентов | Автономные раунды запущены |
| 3 | Лимит раундов достигнут | раунд N = макс | Остановка (бюджет/лимит), receipt |
| 4 | Бюджет исчерпан | tokens/вызовы = бюджет | Остановка (fail-closed, NFR-6) |
| 5 | Пауза | оператор pause | Halt между раундами (не в середине шага) |
| 6 | Остановка | оператор stop | Полный stop, receipt |
| 7 | Вмешательство | оператор вставляет сообщение | Вмешательство учтено в следующем раунде |
| 8 | ПЕРЕЗАПУСК: шаг потребил бюджет | рестарт, шаг уже потребил | Шаг НЕ повторяется (no-op, идемпотентность) |
| 9 | ПЕРЕЗАПУСК: шаг не потребил | рестарт, шаг не завершён | Шаг продолжается (не потерян) |
| 10 | Перерасход | попытка выйти за бюджет | Отказ (fail-closed) |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/project-chat/project-chat.schema.ts:2-10` — `project_chat_rooms.mode` (entry 11, 'autonomous') — precondition.
- `services/catalog-service/src/model-chat/chat-discussion.runner.ts` — референс-движок: `bounded` :35-45, `authority` :58-78, `checkpoint` :79-87 (request_id/lease), `call` :88+ (phases, deadline) — переиспользовать паттерны.
- `services/catalog-service/src/model-chat/chat-discussion.constants.ts` — DISCUSSION_LIMITS (calls/depth/contributions/deadlineMs/stepMs) — REFERENCE для лимитов раундов/бюджета.
- `services/catalog-service/src/model-chat/chat-discussion.repository.ts` — durable steps (checkpoint) — REFERENCE.
- `services/catalog-service/src/model-chat/chat-round.ts` — IChatRoundScope — REFERENCE для round-scope.
- `services/catalog-service/src/model-token-quotas/` + `model-rate-limits/` — бюджет-учёт (существующие) — переиспользовать.
- `services/catalog-service/src/model-chat/chat-context.ts` — контекст-окно/num_ctx (FR-607 adjacent) — не трогать.
- New: `project-chat-autonomous.*` (runner/repository/constants) — движок автономных раундов.
- Frontend: ProjectChat — UI пауза/остановка/вмешательство + прогресс раундов (DESIGN.md rule 7 — «Операции»).

## Tasks & Acceptance

### Execution
- [ ] `project-chat-autonomous.runner.ts` — движок: loop раундов (явный запуск), каждый раунд = checkpoint (request_key/phase, pattern chat-discussion.runner.ts :79-87).
- [ ] Лимит раундов/бюджет: max_rounds + бюджет (tokens/вызовы/время), enforced (fail-closed); бюджет-учёт через model-token-quotas/model-rate-limits.
- [ ] Пауза/остановка/вмешательство: операторские действия (RBAC), пауза = halt между раундами, остановка = stop, вмешательство = вставить сообщение/направление.
- [ ] Идемпотентность: после перезапуска — потребившие бюджет шаги no-op (checkpoint), не-потребившие продолжаются (durable, не in-memory).
- [ ] Запуск: явное сообщение пользователя ИЛИ запрос агентов (явный триггер, не автозапуск).
- [ ] UI: прогресс раундов + пауза/остановка/вмешательство (DESIGN.md rule 7 — «Операции»).
- [ ] Тесты: запуск (пользователь/агент), лимит раундов (остановка), бюджет (fail-closed), пауза/остановка/вмешательство, идемпотентность (потребивший не повторяется после рестарта), не-потребивший продолжается, перерасход (отказ).

### Acceptance
- **Given** явное сообщение/запрос агентов **when** autonomous-режим **then** раунды запущены (явный триггер).
- **Given** лимит раундов/бюджет **when** достигнут **then** остановка (fail-closed, NFR-6), receipt.
- **Given** пауза/остановка/вмешательство **when** оператор **then** halt/stop/вмешательство учтено.
- **Given** шаг потребил бюджет + перезапуск **when** рестарт **then** шаг НЕ повторяется (no-op, идемпотентность).
- **Given** шаг не потребил + перезапуск **when** рестарт **then** шаг продолжается (не потерян).
- **Given** перерасход **when** попытка **then** отказ (fail-closed).
- Корневой сьют — без деградации.

## Design Notes

- **Идемпотентность = ключевое FR-401:** «шаг, уже потребивший бюджет, не повторяется после перезапуска». Реализация = durable checkpoint (request_key/phase) на каждый шаг, как chat-discussion.runner.ts :79-87 (model_chat_turns request_id/lease). После рестарта: шаг с потреблённым бюджетом (checkpoint exists) = no-op; без checkpoint = продолжить. НЕ in-memory (перезапуск теряет память).
- **Референс — chat-discussion.runner.ts:** bounded (per-call deadline), authority/checkpoint (request_id/lease), phases, deadline. Автономные раунды = итеративная версия (несколько раундов, не одно обсуждение). Переиспользуем паттерны, не изобретаем.
- **Бюджет через существующие:** model-token-quotas/model-rate-limits (существующие, FR-605). Не новый отдельный бюджет-механизм. Автономные раунды = consumer существующего бюджета.
- **Явный триггер (не автозапуск):** FR-401 «запускаются явным сообщением пользователя ИЛИ запросом агентов». Автозапуск (без триггера) = риск неконтролируемого бюджета. Только явный.
- **Пауза между раундами, не в середине:** пауза = halt после завершённого шага/раунда (checkpoint), не в середине inference (нельзя «заморозить» модель в полуслове). Оператор паузит между раундами.
- **Вмешательство:** оператор вставляет сообщение/направление — учитывается в следующем раунде (не прерывает текущий inference).
- **Стык с entry 11 (mode):** mode='autonomous' — precondition (entry 11). Движок (здесь) использует сохранённый режим.
- **FR-607 [P2] — defer:** контекст-окно (chat-context.ts num_ctx/compaction) используется движком, но история/откат системного промпта + server/OpenCode-расщепление — [P2], вне (задокументировано в entry 16).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- project-chat-autonomous chat-discussion model-token-quotas
node --test scripts/test/autonomous-rounds-idempotency.test.mjs 2>/dev/null || true
```
Ожидаемо: запуск (явный), лимит/бюджет (fail-closed), пауза/остановка/вмешательство, идемпотентность (потребивший не повторяется после рестарта, не-потребивший продолжается), перерасход (отказ) — зелёные; корневой сьют без деградации.

## Open Questions

1. **Бюджет: tokens, вызовы или время (или всё)?** Рекоменdация: всё (tokens via model-token-quotas, вызовы via max_rounds, время via deadline). Обоснование: NFR-6 «у каждого лимита enforcement-точка».
2. **Пауза — только между раундами или и в середине?** Рекоменdация: между раундами (checkpoint). Обоснование: нельзя заморозить inference в полуслове; checkpoint = атомарная точка.
3. **Вмешательство прерывает текущий раунд?** Рекоменdация: нет — учитывается в следующем (не прерывает inference). Обоснование: атомарность раунда.
4. **Автономные раунды видны в «Операции»?** Рекоменdация: да (DESIGN.md rule 7 — долгая операция, прогресс+pause/stop). Обоснование: единый паттерн.
5. **Лимит раундов — global или per-dialog?** Рекоменdация: per-dialog (настройка room'а) + global cap. Обоснование: контроль на уровне диалога.
