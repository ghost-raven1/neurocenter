---
type: epic
title: "DR: cross-host restore (P0-S3/MNT/UPD, C3)"
parent: initiative-architecture
covers: [R1, R3, R10, R12]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md, docs/implementation-readiness.md]
after: [epic-release-baseline]
refined: false
risk: high
---

# DR: cross-host restore (P0-S3/MNT/UPD, C3)

## Description

P0-S3/P0-MNT/P0-UPD закрыты: quiesced backup по расписанию на независимый S3 с readback-верификацией; maintenance-таймер реален (успешный слот + отказ + повтор, измеренные пауза/RPO/RTO); модуль обслуживания: feature flags, журнал операций, capacity, статус бэкапов (FR-1001); репетиция обновления на копии рабочего объёма с точными актуальными образами; полный cross-host restore без исходных дисков (репетиция на стеке, каком он существует на момент эпика); RPO/RTO измерены и задокументированы (UJ-5). DR-бандл (AD-OP-4) собирается из текущего compose; новые compose-сервисы (prometheus/alertmanager — эпик 6) подхватываются на повторном финальном restore при приёмке пилота (эпик 10).

## Outcome

Для команды: состояние проекта восстанавливается на другом хосте с измеренными RPO/RTO (сигнал: PRD C3, UJ-5).

## Done when

1. Quiesced backup по расписанию на независимый S3 с readback-верификацией.
2. Maintenance-таймер: успешный слот + отказ + повтор, измеренные пауза/RPO/RTO; модуль обслуживания (FR-1001): feature flags, журнал операций, capacity, статус бэкапов.
3. Репетиция обновления (P0-UPD) на копии рабочего объёма с точными актуальными образами.
4. Полный cross-host restore (P0-S3) без исходных дисков, на стеке момента эпика.
5. RPO/RTO измерены репетицией и задокументированы.
6. UJ-5 работает как записан.

## Boundaries

- Data-модель (что восстанавливать: volumes, RAG-БД) — эпик epic-data; этот эпик восстанавливает то, что есть.
- Новые compose-сервисы (эпик 6) подхватываются в DR-бандл на финальном restore (эпик 10).
- Runbook оператора — touch point инициативы (вне UI продукта).

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R1, R3, R10, R12)
- architecture — _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md (AD-OP-2, AD-OP-3, AD-OP-4)
- readiness — docs/implementation-readiness.md (P0-S3, P0-MNT, P0-UPD)
- prd — _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md (FR-1001, C3, UJ-5)

## Notes

- Unknown: L-8 — число томов в AD-OP-4: 4 → 5 (artifact-cache); ждёт решение пользователя на точечный фикс spine; gate для DR-бандла.
- Waits on epic-release-baseline because: supply-манифест (AD-OP-2) и compose-as-data (AD-OP-1) — предмет restore и репетиции обновления.
