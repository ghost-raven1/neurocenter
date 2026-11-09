# PRD Addendum — П0-сплит: GO пилота = 5 P0, P0-SSO (корпоративный Blitz) — после пилота

- **Дата решения:** 2026-11-06 (решение пользователя)
- **Зафиксировано:** 2026-11-09 (PO; coverage-аудит G-12)
- **Статус:** в силе; PRD 2026-11-05 — НЕ ИЗМЕНЯЕТСЯ, настоящий Addendum — авторитетная интерпретация пилотного гейта
- **Связанные:** `.memlog.md:50` (решение + обновлённые файлы), `tickets/epic-pilot/epic-pilot.md` (Description, Done when #1, Notes), `tickets/epic-identity/epic-identity.md` (after, Notes), микро-эпик `tickets/epic-local-auth/` (локальный auth как supported-конфигурация, AD-OP-5)

## Контекст

PRD и инициатива сформулировали пилотный гейт как «6 P0 = GO»:

- PRD `prd-neurocenter.md:28` (C1): «**Закрытый пилот = GO**: 6 P0-блокеров закрыты приёмками: P0-SSO (IdP), P0-NAT (матрица установщиков), P0-S3 (cross-host DR), P0-UPD (обновление/восстановление), P0-RES (ресурсы/наблюдаемость), P0-MNT (maintenance); предпосылка — замороженный кандидат релиза (REL-01)».
- PRD `prd-neurocenter.md:187` (Success Metrics «Приёмки»): «6 P0 + 5 приоритетных сквозных проверок = пройдены (NO-GO → GO)».
- Инициатива `initiative-architecture.md:30` (R1): «R1 (prd C1). Закрытый пилот = GO: 6 P0-блокеров закрыты приёмками — P0-SSO (IdP = Blitz), P0-NAT (матрица установщиков), P0-S3 (cross-host DR), P0-UPD (обновление/восстановление), P0-RES (ресурсы/наблюдаемость), P0-MNT (maintenance); предпосылка — замороженный кандидат релиза (REL-01)».

Решение пользователя 2026-11-06 (`.memlog.md:50`): «E3 (epic-identity, Blitz IdP P0-SSO) перенесён в конец очереди сборки — **после пилота** … «пока отрабатываем локальную версию»». Обновлены в тот же день: `tickets/tickets.toml` (E3 после E10, after=[E1,E10]; E10 — пилот на локальной версии, 5 P0), `epic-pilot.md` (after, Description, Done when #1, Notes), `epic-identity.md` (after, Notes).

## Решение

**Пилотный гейт GO = 5 P0** (P0-NAT, P0-S3, P0-UPD, P0-RES, P0-MNT) **закрыты приёмками + 5 приоритетных сквозных проверок пройдены**. P0-SSO (корпоративный Blitz IdP) — **отдельный гейт после пилота**: приёмка epic-identity (эпик 3) после эпика 10 (пилота); переход local-idp → corporate без переделки конфигурации (контракт зафиксирован в epic-identity, OQ RESOLVED).

**Вход пилота — локальная версия = supported production-конфигурация, не dev-обход** (AD-OP-5): production-стек `SSO_DISABLE=false` + локальный Blitz-совместимый IdP в контуре (OAuth2 PKCE S256, контракт Blitz) — микро-эпик `epic-local-auth` (entry 11.1, блокирует пилот). Dev-обход (`SSO_DISABLE=true`, mockUser) в production-слоях запрещён.

Текст PRD/инициативы «6 P0 = GO» **не изменяется** (PRD — final от 2026-11-05); настоящий Addendum — авторитетная интерпретация: «6 P0» = 5 P0 в пилотном гейте + P0-SSO в пост-пилотном гейте epic-identity.

## Влияние

1. **Сквозная проверка #5** (`docs/user-scenario-regression-2026-10-24.md:319`): «Первый вход через настоящий IdP → installer каждой обещанной ОС → pairing → physical root binding → offline asset install → полезный MCP вызов» — **адаптируется**: на пилоте «настоящий IdP» = self-hosted локальный Blitz-совместимый IdP (OAuth2 PKCE S256, контракт Blitz); корпоративная Blitz-часть (настоящий корпоративный IdP, UJ-1 «неверный state/отказ IdP не создают сессию» на корпоративном контуре) — выполняется на приёмке epic-identity **после GO**. Адаптация фиксируется при breakdown пилота (эпик 10).
2. **`epic-pilot.md`** — уже отражает решение (Description: «5 P0-блокеров … P0-SSO — после пилота, эпик 3»; Done when #1: «5 P0-блокеров закрыты приёмками … P0-SSO — после пилота (эпик 3), вход пилота — локальный auth-режим (interim, не dev-обход по AD-OP-5)»).
3. **`epic-identity.md`** — after = [epic-pilot]; OQ RESOLVED (контракт перехода local-idp → corporate).
4. **P0-матрица** (`docs/implementation-readiness.md`): P0-SSO остаётся в матрице как отдельный блокер фазы 2-гейта («выход на команды организации»), а не пилотного.
5. **UJ-1** (вход через Blitz): на пилоте выполняется по локальной версии (локальный Blitz-совместимый IdP); полный UJ-1 с корпоративным IdP — приёмка epic-identity после пилота.

## Открытые вопросы

- **OQ (перенесён, не закрыт этим Addendum):** локальный auth-режим пилота — поддержанная конфигурация, не dev-обход (AD-OP-5); реализована микро-эпиком `epic-local-auth` (entry 11.1); OQ2 — какой локальный IdP-инстанс на пилоте (рекомендация: self-hosted Blitz; owner: пользователь до пилота).
