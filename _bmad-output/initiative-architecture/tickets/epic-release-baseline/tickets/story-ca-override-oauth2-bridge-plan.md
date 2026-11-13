---
title: 'Баг: oauth2-bridge — тот же env_file-override корпоративного CA (latent)'
type: 'bugfix'
ticket: '14'
created: '2026-11-13'
status: ready-for-dev
baseline_revision: 'd51c49b05da8b4b68096ff3e7d6ab78d6b688559'
route: 'auto'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-release-baseline/epic-release-baseline.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Фикс CA-бага (коммит `d51c49b0`) поставил `NODE_EXTRA_CA_CERTS=/usr/local/share/neurocenter/build-ca/extra.pem` в `environment:` пяти node-сервисов dev-compose (api-gateway, catalog-service, feature-flags-service, skills-service, rag-sync-service). У **oauth2-bridge** тот же механизм: образ зашивает корпоративный CA (`/usr/local/share/neurocenter/build-ca/extra.pem`), а `env_file` (`.env.local` с хостовым путём `~/.ca/corporate-ca-bundle.pem`) переопределяет `NODE_EXTRA_CA_CERTS` на путь, которого нет в контейнере → Node «Ignoring extra certs» → `UNABLE_TO_VERIFY_LEAF_SIGNATURE` на любой outbound-запрос к корпоративному TLS-хосту.

**Почему latent:** в dev-стеке SSO выключен (AD-OP-5 interim: локальный auth, без центрального IdP) → outbound-корпоративного TLS у bridge нет → баг не проявляется. Воспроизведётся, как только в dev-стеке включат SSO (вызовы bridge → корпоративный IdP по TLS с корпоративным CA).

**Approach:** Тот же однострочный override в `environment:` сервиса `oauth2-bridge` в `docker-compose.yml` (CA-файл уже есть в образе — проверено при инвентаризации CA-бага). Drift-тест (AD-OP-1, 1.12 D2): `NODE_EXTRA_CA_CERTS` в compose обязан быть в environment-model + config schema (уже задан — 1.12 D2 pattern: переменная, заданная в compose, обязана читаться кодом/моделью).

## Boundaries & Constraints

**Always:**
- Override = путь из ОБРАЗА (`/usr/local/share/neurocenter/build-ca/extra.pem`), не хостовый путь.
- `.env.local` на хосте НЕ трогать (хостовому npm нужен host path).
- environment-model.json + drift-тесты синхронизированы (1.12 D2: переменная в compose → модель + drift).

**Never:**
- Не менять SSO-настройки и не пересоздавать oauth2-bridge «проверить» без необходимости (в dev SSO off — баг latent; пересоздание сбивает пользовательские сессии).
- Не дублировать фикс в `.env.local` (это host-файл, не dev-compose).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | SSO включён в dev-стеке, bridge → корп-TLS IdP | корпоративный CA в хост-пути .env.local | TLS-рукопожатие проходит (CA из образа подставлен) |
| 2 | SSO выключен (текущий dev) | outbound TLS отсутствует | Поведение не меняется (нет регрессии) |
| 3 | Хостовый npm (host, не контейнер) | `.env.local` с host path | Не тронут — host path работает |

</frozen-after-approval>

## Code Map

- `docker-compose.yml` — сервис `oauth2-bridge`: `environment:` — добавить `NODE_EXTRA_CA_CERTS=/usr/local/share/neurocenter/build-ca/extra.pem` (паттерн — 5 сервисов, коммит `d51c49b0`).
- `deploy/production/environment-model.json` / `scripts/production/environment-model.mjs` — `NODE_EXTRA_CA_CERTS` уже в модели (добавлен при CA-фиксе); проверить, что oauth2-bridge-строка не ломает drift.
- `scripts/test/compose-drift.test.mjs` — drift compose→code (проверить после изменения).

## Tasks & Acceptance

### Execution
- [ ] `docker-compose.yml`: oauth2-bridge `environment:` + `NODE_EXTRA_CA_CERTS=/usr/local/share/neurocenter/build-ca/extra.pem`.
- [ ] Drift-тесты (compose→code, code→compose) зелёные.
- [ ] (Опционально, если SSO включат) live-проверка: `docker exec neurocenter-oauth2-bridge node -e "console.log(process.env.NODE_EXTRA_CA_CERTS)"` → путь из образа.

### Acceptance
- **Given** oauth2-bridge в dev-compose **when** SSO включён и bridge делает outbound-запрос к корп-TLS-хосту **then** TLS-рукопожатие проходит (CA из образа).
- **Given** SSO выключен **when** стек стартует **then** без регрессии (те же сервисы healthy).
- Drift-тесты — 0 dead-env / 0 drift.
- Корневой сьют — без деградации.

## Design Notes

- **Почему не фиксировать в `.env.local`:** `.env.local` — host-файл, хостовому npm нужен host path (`~/.ca/corporate-ca-bundle.pem`). Контейнерный и хостовый пути разные — разведение через `environment:` compose (prior over env_file) — уже принятый паттерн (d51c49b0).
- **Почему не «сломано сейчас»:** SSO off в dev → нет outbound-корпоративного TLS → latent. Но механизм идентичен зафиксированному CA-багу — фиксится тем же паттерном, пока не стало blocking.
- **Стык с 11.1 (local-auth):** если SSO-mode включат в dev — баг проявится; этот тикет = защита на опережение.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/compose-drift.test.mjs scripts/test/production-stack.mjs
```
Ожидаемо: drift-тесты зелёные (oauth2-bridge `NODE_EXTRA_CA_CERTS` в модели). Корневой сьют — без деградации.

## Open Questions

1. **Фиксить сейчас или при включении SSO?** Рекомендация: сейчас (однострочный, паттерн принят d51c49b0, риск ≈ 0). Обоснование: latent-баг того же класса, что зафиксированный CA-баг; дешевле закрыть сейчас, чем ловить при включении SSO.
