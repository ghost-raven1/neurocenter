---
type: epic
title: "Локальный auth как supported-конфигурация (AD-OP-5)"
parent: initiative-architecture
covers: [R1, R2, R12]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md, docs/implementation-readiness.md]
after: [epic-release-baseline]
refined: false
risk: medium
---

# Локальный auth как supported-конфигурация (AD-OP-5)

## Description

Пилот идёт на production-стеке с локальным auth (решение пользователя 2026-11-06: Blitz IdP — после пилота, эпик 3 в конце очереди; вход — существующий локальный auth-режим как interim-конфигурация). Но ep1 entry 4 (AD-OP-5) запрещает dev-обходы в production-конфиге, а текущий локальный auth выглядит как dev-обход. Решение пользователя 2026-11-09 (coverage-аудит G-6): **локальный auth = first-class supported-конфигурация** production-конфига — режим, задокументированный для оператора, покрытый e2e на production-стеке, — а не обход. Локальный auth ≠ dev-обход: он работает при `SSO_DISABLE=false` через полный OAuth2/PKCE-поток против локального Blitz-совместимого IdP в закрытом контуре (тот же контракт Blitz: /blitz/oauth/ae, /te, /me, /logout); dev-обход — это `SSO_DISABLE=true` с mock-пользователем, запрещённый в production всеми слоями (validateProduction, модель, drift-тест). Механизм локального режима уже доказан e2e (production-stack.mjs + blitz-fixture) — эпик делает его декларированным, задокументированным и проверяемым: режимы в production-модели, операторские доки, e2e-признак «0 dev-флагов» в evidence.

## Outcome

Для пилотной команды: вход в пилоте — на supported-конфигурации, которую оператор может развернуть по докам, а приёмка может проверить e2e; переход на центральный Blitz после GO (эпик 3) — смена параметров конфига, не переделка.

## Done when

1. Локальный auth-режим явно декларирован в production-модели (environment-model.json) как supported-конфигурация: поддерживаемые режимы (local-idp — локальный Blitz-совместимый IdP в контуре; corporate — центральный Blitz) + drift-тест-проверка (наличие поля, допустимые значения; SSO_DISABLE=false обязателен в обоих режимах — productionEnvConstraints не меняется).
2. Операторские доки: секция «Локальный IdP-режим (пилот, interim)» в docs/production-setup.md (когда, предпосылки, конфигурация через configure, первый админ bootstrap-admin, ограничения fail-closed/0 dev-флагов, переход на центральный Blitz после пилота — эпик 3) + P0-SSO-строка docs/implementation-readiness.md отражает interim-путь пилота (локальный auth как supported-конфиг, центральный Blitz — после GO).
3. e2e на production-стеке в local-auth-режиме зелёный (scripts/test/production-stack.mjs): логин (PKCE, state fail-closed)/сессия/bridge-билет, первый админ без dev-входа, logout; новая проверка «0 dev-флагов в production-конфиге» (нет SSO_DISABLE=true/RAG_AUTH_DISABLED=true в .env и в env контейнеров); evidence production-stack.json несёт authMode=local-idp.
4. Инварианты ep1 e4 не сломаны: compose-drift (включая productionEnvConstraints и latest-теги) и production-runtime (SSO_DISABLE=true → отказ production-старта) зелёные; корневой сьют без деградации.

## Boundaries

- Механика auth не меняется: oauth2-bridge, validateProduction (services/shared/runtime.cjs), bootstrap-admin — только декларация режима + доки + e2e-признаки.
- Центральный Blitz и P0-SSO-приёмка настоящего IdP — эпик epic-identity (после пилота); локальный IdP говорит тем же контрактом Blitz, переход = смена SSO_HOST/client/secret в операторском конфиге.
- Развёртывание реального локального IdP-инстанса на пилот-хосте и onboarding пилотной команды — HITL-часть пилота (эпик epic-pilot); этот эпик даёт supported-конфигурацию, доки и e2e.
- Dev-обход (SSO_DISABLE=true, mock user) остаётся dev-only: production-гарды (entry 1.4) не ослабляются.

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R1, R2, R12)
- architecture — _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md (AD-OP-1, AD-OP-5)
- readiness — docs/implementation-readiness.md (P0-SSO)
- prd — _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md (FR-901, C1, UJ-1)

## Notes

- Decision (пользователь, 2026-11-09): coverage-аудит G-6 закрыт — локальный auth пилота = supported-конфигурация, не dev-обход (AD-OP-5); кандидат «микро-эпик id=11, after=[E1], блокирует E10» принят; объём ~1 story.
- Decision (Sofia/PO, 2026-11-09): микро-эпик = 1 entry (tracer bullet = единственная сторис; one-session-эпик получает одну сторис); hitl=false — e2e на production-стеке автоматизируема, HITL-часть (реальный локальный IdP, команда пилота) — в epic-pilot.
- Waits on epic-release-baseline because: production-конфиг без dev-обходов (AD-OP-5, entry 1.4) — productionEnvConstraints-матрица и validateProduction — основа, на которую опирается декларация режима.
- Open question: OQ2 — какой именно локальный IdP-инстанс будет на пилоте (self-hosted Blitz vs другой Blitz-совместимый); owner: пользователь, до старта пилота; supported-конфигурация не зависит от выбора (контракт Blitz одинаков).
