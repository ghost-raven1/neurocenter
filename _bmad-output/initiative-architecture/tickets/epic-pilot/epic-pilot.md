---
type: epic
title: "Пилот: приёмка и GO"
parent: initiative-architecture
covers: [R1, R2, R5, R6, R12]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [docs/implementation-readiness.md]
after: [epic-dr, epic-res-obs, epic-devices, epic-project, epic-agent-team]
refined: false
risk: high
---

# Пилот: приёмка и GO

## Description

Приёмка пилота на ЛОКАЛЬНОЙ версии (решение пользователя 2026-11-06: Blitz IdP — после пилота, эпик 3 в конце очереди; вход — локальный auth-режим как interim): 5 P0-блокеров (P0-S3/MNT/UPD, P0-RES, P0-NAT; P0-S3 ре-верифицирован финальным cross-host restore на полном стеке, включая сервисы эпика 6; P0-SSO — после пилота, эпик 3) + 5 приоритетных сквозных проверок пройдены (NO-GO → GO); baseline Q7 зафиксирован (время onboarding, балл опроса, число шагов ядра, рост к фазе 2); опрос удобства Q3 (5-pt + лог тупиков) проведён на пилотной команде; решение о выходе на фазу 2 (включая переход на Blitz IdP — эпик 3).

## Outcome

Для команды: статус NO-GO → GO — Neurocenter принят как рабочая проектная среда закрытого контура (сигнал: PRD C1, Success Metrics «Приёмки»).

## Done when

1. 5 P0-блокеров закрыты приёмками (P0-S3/MNT/UPD, P0-RES, P0-NAT); P0-S3 ре-верифицирован финальным cross-host restore на полном стеке; P0-SSO — после пилота (эпик 3), вход пилота — локальный auth-режим (interim, не dev-обход по AD-OP-5).
2. 5 приоритетных сквозных проверок пройдены (NO-GO → GO).
3. Baseline Q7 зафиксирован: время onboarding, балл опроса, число шагов ядра, рост к фазе 2.
4. Опрос Q3 (5-pt + лог тупиков) проведён на пилотной команде; балл ≥ целевого.
5. Onboarding участника/устройства — за целевое время, без оператора.
6. Тупики, найденные в пилоте: 0 незакрытых.
7. Принято решение о выходе на фазу 2.

## Boundaries

- Исполнение P0 — соответствующие эпики; этот эпик — приёмка и ре-верификация на полном стеке.
- Состав пилота (проекты/команда/данные) — Q1, определяется пользователем до старта.

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R1, R2, R5, R6, R12)
- readiness — docs/implementation-readiness.md (P0-матрица, 5 приоритетных сквозных проверок)
- prd — _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md (Success Metrics, C1)

## Notes

- Open question: Q1 — состав пилота (какие проекты/команда, реальные данные, сколько людей и агентов); owner: пользователь; gate до старта пилота.
- Open question: Q3 — инструмент измерения удобства: 5-pt опрос + лог тупиков. [ASSUMPTION]
- Open question: Q7 — baseline-цифры Success Metrics фиксируются при старте пилота. [ASSUMPTION]
- Decision (Sofia/PO, 2026-11-09): UI-polish + UX-спека — ПЕРВЫЙ entry epic-pilot (до приёмки, при breakdown волны 2). Обоснование: приёмочные метрики пилота = UX-метрики (PRD NFR-1 «Простота»: completion-rate, число шагов ядра; NFR-3 «Нет тупиковых сценариев»: тупики = 0 незакрытых) — GO с неполированным UI по контракту невозможен. В entry: UX-спека (DESIGN.md + EXPERIENCE.md, bmad-ux), аудит user paths (error/empty-states), Playwright-e2e критических путей, фикс-лист из walkthrough'а dev-стека (факты собираются с 2026-11-09, dev-стек эпика 1 гейт (б)). Gap-фикс: в 9 эпиках не было явной записи про UI-polish.
- Decision (пользователь, 2026-11-06): epic-identity (Blitz IdP) перенесён в конец очереди сборки (после пилота) — пилот идёт на локальной версии. Открытый вопрос: локальный auth-режим пилота — поддержанная конфигурация, не dev-обход (AD-OP-5, entry 1.4); если требует отдельной работы до пилота — выносится в микро-эпик (решение с пользователем).
- Waits on epic-dr because: P0-S3/MNT/UPD и RPO/RTO.
- Waits on epic-res-obs because: P0-RES.
- Waits on epic-devices because: P0-NAT.
- Waits on epic-project because: проекты из шаблона (C4).
- Waits on epic-agent-team because: реальный проект агент-командой (C5).
