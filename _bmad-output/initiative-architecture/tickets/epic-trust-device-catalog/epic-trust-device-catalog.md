---
type: epic
title: "Устройственный канал и версии каталога"
parent: initiative-architecture
covers: [R9, R12]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md]
after: [epic-release-baseline]
refined: false
risk: high
---

# Устройственный канал и версии каталога

## Description

Когда эпик закрыт, mcp-host жив в production (route shadowing закрыт, AD-14); билет верифицируется (HMAC + claims + ceiling, AD-3) и отзывается в окне TTL кэша (AD-4); retire версии необратим с записью в аудит (AD-16); у gateway — таблица роут-политики и error-body-политика (AD-6/AD-19); контрактная версия и ceiling — единый источник (AD-2/AD-12/AD-13). Публикация каталога (UJ-2): упаковка из доверенных источников с SHA-описью (FR-201), провенанс артефакта — версия/SHA/источник/время/издатель, проверяется из карточки (FR-203), immutable-версии и назначение только одобренного комплекта (FR-202). Артефакты — живой mcp-host, верифицированные билеты, версии каталога: базис для установщиков устройств (эпик 7) и агент-команды (эпик 9).

## Outcome

Для команды и агентов: устройство и агент подключаются к проекту через доверенный канал с проверяемыми билетами; артефакты каталога несут полный провенанс (сигнал: PRD NFR-4, UJ-2).

## Done when

1. mcp-host жив в production: route shadowing (AD-14) закрыт, маскирование m/:ticket в nginx-логах (AD-5).
2. Билет верифицируется: HMAC + exp + claim ≤ ceiling + связка claim↔descriptor (AD-3).
3. Отзыв билета работает в окне TTL кэша (60s), live-binding device↔project (AD-4).
4. Retire версии необратим: новые назначения не разрешаются, запись в аудит (FR-204/AD-16).
5. Gateway: таблица роут-политики (timeout/maxBody/rateLimit) + error-body-политика, completeness-тест (AD-6/AD-19).
6. Контрактная версия и ceiling — единый источник (AD-2/AD-12/AD-13).
7. UJ-2 работает как записан: карточка + immutable-версия + SHA + одобрение комплекта.

## Boundaries

- Установщики, pairing, offline-работа устройства — эпик epic-devices.
- Вход/Blitz/пользователи — эпик epic-identity.
- Проекты/чаты/агенты — эпик epic-project и epic-agent-team.
- Лимиты-политики (ceiling в policy) и их enforcement — эпик epic-res-obs; этот эпик даёт единый источник ceiling.

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R9, R12)
- architecture — _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md (AD-2..AD-6, AD-12..AD-14, AD-16, AD-19)

## Notes

- Waits on epic-release-baseline because: сплит shared-слоя (AD-7) и release pipeline — базис для production-деплоя mcp-host.
