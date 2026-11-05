---
type: epic
title: "Вход: настоящий Blitz IdP (P0-SSO)"
parent: initiative-architecture
covers: [R1, R2, R12]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [docs/implementation-readiness.md]
after: [epic-release-baseline]
refined: false
risk: high
---

# Вход: настоящий Blitz IdP (P0-SSO)

## Description

P0-SSO закрыт: вход/отказы/истечение/выход на настоящем Blitz (единственный IdP контракта), первый админ, отзыв прав без re-login, отказ production-старта при dev-auth; неверный state/отказ IdP не создают сессию (fail-closed, FR-901); человек добавляется главным админом по почте (FR-902) — человеческая часть R2 (onboarding без оператора). UJ-1 работает как записан.

## Outcome

Для пользователя: вход в Neurocenter — через Blitz за минуты, без оператора (сигнал: PRD C1 P0-SSO, C2, UJ-1).

## Done when

1. Вход/отказы/истечение/выход на настоящем Blitz (FR-901; единственный IdP контракта).
2. Первый админ создаётся по runbook.
3. Отзыв прав без re-login.
4. Production-старт при dev-auth — отказ.
5. Неверный state/отказ IdP не создают сессию (fail-closed).
6. Человек добавляется главным админом по почте (FR-902).
7. UJ-1 работает как записан.

## Boundaries

- Каталог/билеты/устройственный канал — эпик epic-trust-device-catalog.
- Устройства и установщики — эпик epic-devices.

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R1, R2, R12)
- prd — _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md (FR-901, FR-902, C1, UJ-1)
- readiness — docs/implementation-readiness.md (P0-SSO)

## Notes

- Waits on epic-release-baseline because: кандидат REL-01 (замороженный релиз) — предмет приёмки P0-SSO.
