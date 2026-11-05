---
type: epic
title: "Матрица установщиков (P0-NAT)"
parent: initiative-architecture
covers: [R1, R2, R12]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md, docs/implementation-readiness.md]
after: [epic-release-baseline, epic-trust-device-catalog]
refined: false
risk: high
---

# Матрица установщиков (P0-NAT)

## Description

P0-NAT закрыт: установщики всех 8 клиентских целей (7 оставшихся) и полный чеклист для всех 8 (папки/настройки/восстановление/дочерние); устройство — личный opencode-агент пользователя, «одетый» проектом (FR-701), каждая установка — с квитанцией (FR-702); устройство работает offline (кэш) и переподключается без потери данных (FR-704); комплект декларирует поддерживаемые версии opencode, несовместимость — явная ошибка + следующий шаг (FR-706). UJ-3 работает как записан.

## Outcome

Для пользователя: новое устройство подключается к проекту за минуты без оператора (сигнал: PRD C1 P0-NAT, C2, UJ-3).

## Done when

1. Установщики всех 8 клиентских целей (7 оставшихся).
2. Полный чеклист для всех 8: папки/настройки/восстановление/дочерние.
3. Каждая установка — с квитанцией (FR-702); повтор idempotent.
4. Устройство работает offline (кэш) и переподключается без потери данных (FR-704).
5. Несовместимая версия opencode — явная ошибка + следующий шаг (FR-706).
6. Полезный MCP-вызов с нового устройства (UJ-3).

## Boundaries

- mcp-host/билеты — эпик epic-trust-device-catalog (этот эпик потребляет).
- Device-агенты и агент-команда — эпик epic-agent-team.
- «Тонкое устройство» (без локального opencode-агента) — out of scope инициативы.

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R1, R2, R12)
- prd — _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md (FR-701..FR-706, C2, UJ-3)
- architecture — _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md (AD-3/AD-4/AD-14)
- readiness — docs/implementation-readiness.md (P0-NAT)

## Notes

- Waits on epic-release-baseline because: кандидат релиза (установщики строятся из кандидата).
- Waits on epic-trust-device-catalog because: живой mcp-host и верифицированные билеты (AD-3/AD-14).
