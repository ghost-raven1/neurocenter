---
title: 'FR-310: Агент вызывает системного агента + recovery-путь (NFR-3, нет тупиков)'
type: 'feature'
ticket: '5'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '56f8c009cf0c9cb9d18091c5176c36831eb981cd'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-agent-team/epic-agent-team.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md
  - _bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/tickets/tickets.toml
  - _bmad-output/initiative-architecture/tickets/epic-project/tickets/tickets.toml
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-310: **любой** агент проекта может вызвать агента с системной ролью (FR-303/entry 4) в случае проблемы или для уточнения: вызов **явный** (случай: проблема/уточнение), **с записью в аудит**; **ответ системного агента доступен вызвавшему в проектном диалоге**. При отсутствии пути продвижения вызов системного агента — **recovery-путь**: тупиковые сценарии исключены (NFR-3/R8 — каждая ошибка actionable, для каждого failure mode recovery-путь re-pairing/re-fetch/restore). Сейчас `system-role-mcp` (system-role-mcp.controller.ts — execute/close, one-send admission, proof, state succeeded/unknown/failed) существует, но **mcp «недоступен обычным агентам»**: явного вызова системной роли **агентом** (problem/уточнение) с аудитом и возвратом ответа в проектный диалог нет. Entry 4 даёт «координатор показывает владельца»; здесь — **сам явный вызов** + recovery-путь.

**Approach:** (1) **Явный агент→системная-роль вызов**: любой агент проекта вызывает системную роль с явной причиной (problem/уточнение) + **запись в аудит**; ответ системного агента возвращается **вызывающему в проектном диалоге**. (2) **Recovery-путь (NFR-3)**: при отсутствии пути продвижения вызов системного агента = recovery; тупиковые сценарии исключены (каждый failure mode → actionable следующий шаг / recovery-путь). Переиспользуем `system-role-mcp` (execute/close/proof) и `roleCallBudget` (fail-closed), не дублируем роли (entry 4).

## Boundaries & Constraints

**Always:**
- Вызов системной роли агентом — **явный** (случай: проблема/уточнение) + **запись в аудит**.
- Ответ системного агента доступен **вызывающему в проектном диалоге**.
- При отсутствии пути продвижения — вызов системного агента = **recovery-путь** (NFR-3).
- Бюджет вызовов (`roleCallBudget:147`) — fail-closed (NFR-6).
- Каждая ошибка — actionable (следующий шаг указан) (NFR-3).

**Never:**
- Не делать вызов системной роли неявным/автоматическим без явной причины (problem/уточнение).
- Не вызывать без записи в аудит.
- Не терять ответ системного агента (должен дойти до вызывающего в диалоге).
- Не создавать тупиковые сценарии (NFR-3) — каждый failure mode → recovery-путь.
- Не превышать бюджет (fail-closed).
- Не дублировать сами роли/покрытие (entry 4) и «показать владельца» (entry 4).

## I/O & Edge-Case Matrix

| # | Сценарий | Вход / Состояние | Ожидаемый результат | Обработка ошибок |
|---|----------|------------------|---------------------|------------------|
| 1 | Агент вызывает системную роль (проблема) | агент + явная причина (проблема) | Вызов + запись в аудит | нет причины → отказ (явный) |
| 2 | Агент вызывает (уточнение) | агент + явная причина (уточнение) | Вызов + запись в аудит | — |
| 3 | Ответ вызвавшему | системный агент ответил | Ответ доступен вызвавшему в проектном диалоге | потеря ответа → фэйл |
| 4 | Recovery-путь | нет пути продвижения | Вызов системного агента = recovery (NFR-3) | тупик → фэйл (NFR-3) |
| 5 | Каждая ошибка actionable | failure mode | Указан следующий шаг (re-pairing/re-fetch/restore) | без следующего шага → фэйл (NFR-3) |
| 6 | Бюджет исчерпан | > roleCallBudget | Отказ (fail-closed) | NFR-6 |

</frozen-after-approval>

## Code Map

- `services/catalog-service/src/system-role-mcp/system-role-mcp.controller.ts` — execute/close, one-send admission, proof, state succeeded/unknown/failed (45s) — **точка** явного вызова (сейчас mcp недоступен обычным агентам).
- `services/catalog-service/src/system-roles/system-role.definitions.ts` — `roleCallBudget:147`, `ROLE_BUDGET:134` (coordinatorCalls=5 `:136`) — бюджет вызовов.
- `services/catalog-service/src/system-roles/system-role.service.ts` + `system-role.runner.ts` — исполнение вызова, ответ.
- `services/catalog-service/src/system-roles/system-role.failure.ts` — обработка отказа (recovery-путь, actionable).
- `services/catalog-service/src/system-roles/system-role.guidance.ts` + `system-role.dialog-context.ts` — ответ в проектном диалоге (вызывающему).
- `services/catalog-service/src/agents/agent-audit.ts` — запись вызова в аудит (NFR-4).
- Аудит-стор: `security_events`/`operations` (эпик 6 entry 14) — единая история.
- NFR-3/R8 — recovery-путь (re-pairing/re-fetch/restore), тупики = 0.

## Tasks & Acceptance

### Execution
- [ ] Явный агент→системная-роль вызов: любой агент проекта вызывает системную роль с **явной** причиной (проблема/уточнение).
- [ ] **Запись в аудит** вызова (who/what/почему/когда).
- [ ] Ответ системного агента — **вызывающему в проектном диалоге** (не теряется).
- [ ] **Recovery-путь (NFR-3)**: при отсутствии пути продвижения вызов системного агента = recovery; тупиковые сценарии исключены.
- [ ] Каждая ошибка — actionable (следующий шаг: re-pairing/re-fetch/restore).
- [ ] Бюджет (`roleCallBudget:147`) — fail-closed.
- [ ] Тесты: вызов (проблема/уточнение)+аудит, ответ вызвавшему, recovery-путь, actionable, бюджет.

### Acceptance
- **Given** любой агент проекта **when** явный вызов системной роли (проблема/уточнение) **then** вызов + запись в аудит.
- **Given** системный агент ответил **when** вызов **then** ответ доступен вызвавшему в проектном диалоге.
- **Given** нет пути продвижения **when** вызов системного агента **then** recovery-путь, тупик исключён (NFR-3).
- **Given** failure mode **when** ошибка **then** actionable (указан следующий шаг: re-pairing/re-fetch/restore).
- **Given** > roleCallBudget **when** вызов **then** отказ (fail-closed, NFR-6).
- Корневой сьют — без деградации.

## Design Notes

- **Почему mcp «недоступен обычным агентам» — это gap:** сейчас `system-role-mcp` есть как механизм (execute/close/proof), но нет явного пути «агент вызывает системную роль с причиной + аудит + ответ в диалоге». Здесь открываем именно этот путь.
- **Граница с entry 4:** entry 4 — координатор **показывает владельца** следующего действия + coverage; entry 5 — **явный вызов** системной роли агентом (problem/уточнение) + recovery. Комплиментарно, не дублирует.
- **Recovery-путь = NFR-3:** «при отсутствии пути продвижения вызов системного агента — recovery-путь; тупиковые сценарии исключены». Это R8/NFR-3: каждая ошибка actionable, каждый failure mode → recovery (re-pairing/re-fetch/restore).
- **Аудит обязателен (NFR-4/R9):** «вызов — с записью в аудит» — прямое требование FR-310.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- system-roles system-role-mcp agents
node --test scripts/test/agent-invokes-system-role.test.mjs 2>/dev/null || true
```
Ожидаемо: явный вызов (проблема/уточнение)+аудит, ответ вызвавшему в диалоге, recovery-путь (NFR-3, тупик исключён), actionable (следующий шаг), бюджет fail-closed; корневой сьют без деградации.

## Open Questions

1. **Какие системные роли может вызвать обычный агент?** Рекомендация: все 5 (через roleCallBudget), кроме ограничений политики роли. Обоснование: FR-310 «агента с системной ролью (FR-303)» — любая.
2. **Recovery-путь — отдельное состояние или guidance?** Рекомендация: recovery = явный вызов с причиной «нет пути продвижения» + guidance-ответ (следующий шаг). Обоснование: не новая сущность, а сценарий вызова.
3. **Ответ в «проектном диалоге» — в общей комнате или 1:1?** Рекомендация: в диалог, где был вызов (проектный), с учётом доступов (FR-403). Обоснование: FR-310 «доступен вызвавшему в проектном диалоге».
