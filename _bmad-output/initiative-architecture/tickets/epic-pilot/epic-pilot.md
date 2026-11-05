---
type: epic
title: "Пилот: приёмка и GO"
parent: initiative-architecture
covers: [R1, R2, R5, R6, R12]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [docs/implementation-readiness.md]
after: [epic-identity, epic-dr, epic-res-obs, epic-devices, epic-project, epic-agent-team]
refined: false
risk: high
---

# Пилот: приёмка и GO

## Description

Приёмка пилота: 6 P0-блокеров (P0-S3 ре-верифицирован финальным cross-host restore на полном стеке, включая сервисы эпика 6) + 5 приоритетных сквозных проверок пройдены (NO-GO → GO); baseline Q7 зафиксирован (время onboarding, балл опроса, число шагов ядра, рост к фазе 2); опрос удобства Q3 (5-pt + лог тупиков) проведён на пилотной команде; решение о выходе на фазу 2.

## Outcome

Для команды: статус NO-GO → GO — Neurocenter принят как рабочая проектная среда закрытого контура (сигнал: PRD C1, Success Metrics «Приёмки»).

## Done when

1. 6 P0-блокеров закрыты приёмками; P0-S3 ре-верифицирован финальным cross-host restore на полном стеке.
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
- Waits on epic-identity because: P0-SSO.
- Waits on epic-dr because: P0-S3/MNT/UPD и RPO/RTO.
- Waits on epic-res-obs because: P0-RES.
- Waits on epic-devices because: P0-NAT.
- Waits on epic-project because: проекты из шаблона (C4).
- Waits on epic-agent-team because: реальный проект агент-командой (C5).
