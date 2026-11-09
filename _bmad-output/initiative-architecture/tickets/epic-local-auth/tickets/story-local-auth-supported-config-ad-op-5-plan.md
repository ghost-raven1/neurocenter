---
title: 'Локальный auth как supported-конфигурация production-конфига (AD-OP-5)'
type: 'feature'
ticket: '1'
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
  - '{project-root}/_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md'
  - '{project-root}/_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-release-baseline/tickets/story-config-matrix-ad-op-5-plan.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-local-auth/epic-local-auth.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Пилот (эпик 10) идёт на production-стеке с **локальным auth** — решение пользователя 2026-11-06: центральный Blitz IdP — после пилота (эпик 3 в конце очереди), вход пилота — «существующий локальный auth-режим как interim-конфигурация». Но ep1 entry 4 (AD-OP-5) запрещает dev-обходы в production-конфиге, и текущий локальный auth **выглядит** как dev-обход — coverage-аудит 2026-11-09 закрыл это как G-6 (PARTIAL c) с решением пользователя 2026-11-09: **локальный auth = first-class supported-конфигурация**, не обход. Факт по main: dev-обход — это `SSO_DISABLE=true` (mock-пользователь `dev-user`/`dev@localhost` без IdP, services/oauth2-bridge/src/auth/auth.service.ts:72-83), и он запрещён в production всеми слоями (services/shared/runtime.cjs:103-107, :137-140; services/oauth2-bridge/src/main.ts:15-16; services/catalog-service/src/access/bootstrap-admin.cli.ts:13-15; deploy/production/environment-model.json:4 productionEnvConstraints; compose-drift). Локальный auth — **не** это: `SSO_DISABLE=false`, полный OAuth2-authorization-code + PKCE S256-поток против **локального** Blitz-совместимого IdP (тот же контракт /blitz/oauth/ae|te|me|logout) — этот режим уже доказан e2e: scripts/test/production-stack.mjs поднимает production-стек с blitz-fixture (локальный IdP-контейнер, alias blitz.test) и проходит полный логин/сессия/билет (production-stack.mjs:304-320, evidence `realBlitz: false, idp: 'local HTTPS Blitz fixture'` :616-617). Значит, механизм supported; gap формальный: режим нигде **не декларирован** в production-модели (в requiredEnv-заметке SSO_HOST написано «Заполните адрес Blitz» — как будто IdP только один), оператору **не задокументирован** (docs/production-setup.md описывает только «Blitz»), P0-SSO-строка readiness знает только «Настоящий Blitz», а e2e-evidence не называет режим. Приёмка пилота не сможет проверить «вход = supported-конфигурация», пока нет декларации, доков и evidence-признака.

**Approach:** Минимальная формализация без изменения механики auth: (1) production-модель (deploy/production/environment-model.json) декларирует поддерживаемые auth-режимы (`ssoModes: ["local-idp", "corporate"]`) + drift-тест-проверка (наличие, enum; invalid → фэйл) и уточнённая requiredEnv-заметка SSO_HOST («адрес IdP: центральный Blitz или локальный IdP в контуре, HTTPS»); productionEnvConstraints не меняется — SSO_DISABLE=false обязателен в обоих режимах; (2) операторские доки: новая секция «Локальный IdP-режим (пилот, interim)» в docs/production-setup.md + одна вставка в P0-SSO-строку docs/implementation-readiness.md (interim-путь пилота); (3) e2e: в scripts/test/production-stack.mjs новая проверка «0 dev-флагов в production-конфиге» (операторский .env + env всех контейнеров: нет SSO_DISABLE=true / RAG_AUTH_DISABLED=true; oauth2-bridge/bootstrap-admin несут SSO_DISABLE=false) + evidence production-stack.json получает `authMode: 'local-idp'`. Инварианты ep1 e4 остаются зелёными без изменений (compose-drift, production-runtime).

## Boundaries & Constraints

**Always:**
- Локальный auth проходит **все** production-гарды как есть: SSO_DISABLE=false, HTTPS-SSO_HOST, REDIRECT_URI = PANEL_URL/auth/callback, secret-файл sso_client_secret (0600 в 0700-конфиг-каталоге), bootstrap-admin с BOOTSTRAP_ADMIN_EMAIL; режим не ослабляет ни одну из них.
- Локальный IdP говорит контрактом Blitz (OAuth2 authorization code + PKCE S256, client_secret_basic, эндпоинты /blitz/oauth/ae, /te, /me, /logout) — тот же контракт, что центральный Blitz (сверено с docs/production-setup.md:15 и blitz-provider.fixture.cjs).
- Dev-обход (SSO_DISABLE=true, mock user) остаётся dev-only: production-гарды entry 1.4 не ослабляются и не меняются (runtime.cjs, productionEnvConstraints, drift-тест).
- Доки для оператора — в docs/ (production-setup.md + implementation-readiness.md); частные значения секретов в доках и evidence не раскрываются.
- Test-IdP (blitz-fixture) живёт только в compose-overlay изолированного тест-проекта и **не входит** в production-стек (blitz-provider.fixture.cjs:7; compose.production.yml и модель compose-структуры не меняются).

**Never:**
- Не менять механику auth: services/oauth2-bridge/**, services/shared/runtime.cjs, services/catalog-service/src/access/bootstrap-admin*.ts — правки запрещены (эпик = декларация + доки + e2e-признаки).
- Не ослаблять entry 1.4: SSO_DISABLE/RAG_AUTH_DISABLED в productionEnvConstraints остаются обязательными 'false'; mock-режим SSO_DISABLE=true в production не легализуется.
- Не вводить в production-конфиг/модель dev-флаги, latest-теги или «обходные» значения (AD-OP-5).
- Не менять compose.production.yml и dev-стек (docker-compose.yml): локальный IdP — внешний для стека сервис (отдельный инстанс в контуре пилота), не compose-сервис production-стека.
- Не трогать Epic-3 территорию: P0-SSO-приёмка на центральном Blitz, отзыв прав без re-login, FR-901-чеклисты — остаются за epic-identity; здесь — только декларация режима и interim-доки.

</frozen-after-approval>

## Code Map

**Механизм auth в production (как устроен СЕЙЧАС, main = 56f8c009):**

- `compose.production.yml:243-267` — сервис `oauth2-bridge`: `SSO_DISABLE: 'false'` (:252, захардкожено — обхода нет в стеке), `SSO_HOST: ${SSO_HOST:?Заполните адрес Blitz}` (:253 — адрес IdP из операторского .env, **свободный HTTPS-параметр**: локальный IdP проходит без изменения стека), `SSO_CLIENT_ID` (:254), `SSO_CLIENT_SECRET_FILE: /run/secrets/sso_client_secret` (:255), `REDIRECT_URI` (:256), `SSO_SCOPE: ${SSO_SCOPE:-openid profile email}` (:257). Секрет `sso_client_secret: {file: '${NEUROCENTER_CONFIG_DIR:?}/secrets/sso_client_secret'}` — :321.
- `compose.production.yml:103-118` — сервис `bootstrap-admin` (profile `setup`, command `node dist/access/bootstrap-admin.cli.js` :108): `SSO_DISABLE: 'false'` (:112), `BOOTSTRAP_ADMIN_EMAIL: ${BOOTSTRAP_ADMIN_EMAIL:?...}` (:114), `BOOTSTRAP_ADMIN_NAME` (:115) — первый админ создаётся операторской one-shot-командой, не через dev-вход.
- `compose.production.yml:283` — api-gateway: `AUTH_SERVICE_URL: http://oauth2-bridge:22222` (мост — единственный auth-провайдер панели).
- `services/oauth2-bridge/src/auth/auth.service.ts:17-32` — конфиг моста из env; :28 `ssoDisabled: (SSO_DISABLE || 'false') === 'true'` — единственный переключатель «обход vs SSO».
- `services/oauth2-bridge/src/auth/auth.service.ts:40-52` — `authorizeUrl`: URL /blitz/oauth/ae с `response_type=code`, `code_challenge_method=S256` (PKCE). `:109-145` — `exchangeCode`: POST /blitz/oauth/te (client_secret_basic + code_verifier) → access token; GET /blitz/oauth/me (Bearer) → профиль (sub/uid/preferred_username, email, name; email_verified обязателен :200). `:157-183` — `refreshAccess`: роли из каталога `GET /internal/access/profile?email=` (x-neurocenter-internal); 403 → «Учётная запись не добавлена или отключена».
- `services/oauth2-bridge/src/auth/auth.service.ts:72-83` — **`mockUser()` — сам dev-обход**: `dev-user`, `DEV_USER_EMAIL || 'dev@localhost'`, «Локальный администратор», без IdP/PKCE/профиля. Используется только при `SSO_DISABLE=true` (auth.controller.ts:43-48 — `login` сразу выставляет bridge_session с mock-профилем; :67-69 — `callback` без валидации). Это то, что AD-OP-5 запрещает в production.
- `services/shared/runtime.cjs:103-107` — `validateProduction` (вызывается на импорте :193, до БД :86-88): любой сервис production с `SSO_DISABLE`/`RAG_AUTH_DISABLED` ≠ 'false' → throw «SSO_DISABLE=false обязателен в production». `:137-148` — oauth2-bridge дополнительно: SSO_DISABLE обязан быть ровно 'false' (:138-140), SSO_HOST — HTTPS (:141), SSO_CLIENT_ID/SSO_CLIENT_SECRET обязательны, REDIRECT_URI обязан быть ровно PANEL_URL/auth/callback (:144-147).
- `services/oauth2-bridge/src/main.ts:15-16` — второй runtime-слой моста: production + SSO_DISABLE=true → отказ старта.
- `services/catalog-service/src/access/bootstrap-admin.cli.ts:10-15` — bootstrap **отказывается** при `SSO_DISABLE === 'true'` («Bootstrap production-администратора нельзя выполнять с dev-входом»); `services/catalog-service/src/access/bootstrap-admin.ts:9-60` — one-shot: пустая таблица platform_users, advisory-лок 72465381, receipt platform_bootstrap('first-admin'), security_events admin.bootstrap; повтор → created:false, отозванные права не восстанавливаются.

**Где production-конфиг выбирает auth-режим (СЕЙЧАС):**

- `scripts/production/configuration.mjs:35-119` — `validateInput`: `ssoHost` — любой HTTPS origin (:63 — локальный IdP в контуре проходит без ограничений), `ssoClientId` (:76), `adminEmail` (:68); **поля auth-режима нет** — режим нигде не декларирован, SSO_HOST = свободный параметр. `:222-233` — secrets/sso_client_secret (0600). `:234-252` — production `.env`: SSO_HOST/SSO_CLIENT_ID/REDIRECT_URI/SSO_SCOPE/BOOTSTRAP_ADMIN_*; **SSO_DISABLE/RAG_AUTH_DISABLED не пишутся никогда** (ратификация entry 1.4).
- `deploy/production/environment-model.json:336-375` — модель oauth2-bridge: env `SSO_DISABLE: "false"` (:357), `SSO_HOST: "${SSO_HOST:?Заполните адрес Blitz}"` (:358 — заметка знает только «Blitz»); requiredEnv-заметка :370 «в production обязателен SSO_DISABLE=false; без переменной включён обход SSO и старт отклонён»; :371-374 — обязательность SSO_HOST/CLIENT_ID/SECRET_FILE/REDIRECT_URI. `:3-6` — top-level `productionEnvConstraints: {SSO_DISABLE: "false", RAG_AUTH_DISABLED: "false"}` (введено entry 1.4).

**Локальный auth на production-стеке — существующий e2e (доказательство режима):**

- `scripts/test/production-stack.mjs:33-69` — тестовый TLS (SAN: panel.test, blitz.test, IP:127.0.0.1 :50) + `configureProduction` с **локальным IdP как SSO-целью**: `ssoHost: 'https://blitz.test'`, `ssoClientId: 'fixture-client'`, `ssoClientSecret: 'fixture-only'` (:60-62) — production-конфиг без единого dev-флага.
- `scripts/test/production-stack.mjs:71-93` — overlay `compose.fixture.yml`: сервис `blitz-fixture` (node:24.22.0, command node /fixture/provider.cjs, alias blitz.test, порт 127.0.0.1:18444) + oauth2-bridge `NODE_EXTRA_CA_CERTS: /fixture/tls.crt` (доверие сертификату локального IdP) — **не входит в production-стек** (overlay отдельного compose-проекта :94-106).
- `scripts/test/blitz-provider.fixture.cjs:1-101` — локальный IdP, эмулирующий контракт Blitz: /blitz/oauth/ae (проверка client_id/redirect_uri/PKCE S256 :15-33), /blitz/oauth/te (code+verifier→token, Basic :34-66), /blitz/oauth/me (sub=fixture-admin, email=admin@example.test, email_verified :67-82), /blitz/oauth/logout (:83-92). Заголовок :7 «Тестовый IdP живёт только в изолированном Compose-проекте и не входит в production-стек».
- `scripts/test/production-stack.mjs:256-265` — e2e-проверки режима: `up -d --wait postgres blitz-fixture`; «Первый администратор создаётся один раз без dev-входа» (:260-265: bootstrap-admin → created:true, повтор → created:false).
- `scripts/test/production-stack.mjs:304-320` — «Полный HTTPS-поток Blitz с PKCE возвращает к исходному разделу»: /auth/login?returnTo=/projects → 302 authorize (oauth_state Secure) → callback → bridge_session cookie → /auth/me activeRole='Главный админ' → повторное state → login_error=state (fail-closed).
- `scripts/test/production-stack.mjs:595-602` — logout: /auth/logout → redirectUrl /blitz/oauth/logout → IdP 302 → сессия отозвана (/api/projects 401). `:603-624` — evidence `production-stack.json`: `realBlitz: false, idp: 'local HTTPS Blitz fixture'` (:616-617) — **режим в evidence уже есть, но не называется «authMode» и не проверяет dev-флаги**.
- `scripts/test/release-candidate-e2e.test.mjs:477-496` — F4 (REL-01-приёмка): тот же blitz-fixture-паттерн в override кандидата; `:499-519` — `assertCandidateConfig`: точные fixture-значения (SSO_HOST=https://blitz.test :515, SSO_CLIENT_ID=fixture-client :516, BOOTSTRAP_ADMIN_EMAIL=admin@example.test :517 — «/blitz/oauth/me отдаёт sub admin@example.test»); `:579-581` — F4: bootstrap-admin run; `:679-698` — F5: негативный контроль validateProduction: `SSO_DISABLE=true` → production-старт остановлен; `:850-871` — H5: полный PKCE-поток + мост на кандидате.

**Инварианты ep1 e4 (AD-OP-5), которые нельзя сломать:**

- `scripts/test/compose-drift.test.mjs:11,16,63-64` — drift-тест: `productionConstraintViolations` (env из productionEnvConstraints со значением ≠ constraint в любом сервисе модели → фэйл) + `latestTagViolations`; :379 — сверка productionEnvConstraints = {SSO_DISABLE: 'false', RAG_AUTH_DISABLED: 'false'}; :437 — отсутствие переменной из constraints ≠ нарушение.
- `scripts/production/environment-model.mjs:215-226` — `validateModelShape`: валидация productionEnvConstraints (объект {ENV: string}); :476 `productionConstraintViolations`, :504 `latestTagViolations` — экспорт, переиспользовать для новой проверки режимов.
- `scripts/test/production-runtime.test.cjs:64-70` — runtime-слой: SSO_DISABLE=true/RAG_AUTH_DISABLED=true → throw (не менять).
- `services/shared/runtime.cjs:87-188` — `validateProduction` (runtime-слой, не менять).

**Доки (куда ложится операторская часть):**

- `docs/production-setup.md:1-31` — «Подготовка production с Blitz»: предрасположения (зарегистрированное веб-приложение Blitz :10, callback/logout :10), мастер configure :25, `configure --json-stdin` :31. **Локального режима нет.**
- `docs/production-setup.md:80` — «Автотест node scripts/test/production-stack.mjs --build сам создаёт тестовый TLS… Используются … тестовый Blitz» — единственное упоминание локального IdP в доках (как тест, не как режим).
- `docs/implementation-readiness.md:54,71-77` — P0-SSO-строка: «Настоящий Blitz» / «принять реальную идентификацию» — interim-путь пилота (локальный auth как supported-конфиг) в матрице не отражён.

**Ответ на аудит (что именно dev-обход, а что нет):** dev-обход = `SSO_DISABLE=true` (mock user без IdP; auth.service.ts:72-83; запрещён: runtime.cjs:103-107 + :138-140, main.ts:15-16, bootstrap-admin.cli.ts:13-15, environment-model.json:4 + :357, compose-drift, configuration.mjs:234-252 не пишет его в production .env). Локальный auth = `SSO_DISABLE=false` + полный PKCE-поток против локального IdP (production-stack.mjs:304-320 — всё проходит); разница от центрального Blitz — только инстанс IdP в контуре. Поэтому режим легализуется декларацией, не кодом.

## Tasks & Acceptance

**Execution:**
- [ ] `deploy/production/environment-model.json` — top-level поле `"ssoModes": ["local-idp", "corporate"]` (рядом с `productionEnvConstraints` :3-6): декларация supported-режимов (local-idp — локальный Blitz-совместимый IdP в закрытом контуре; corporate — центральный Blitz); requiredEnv-заметка SSO_HOST oauth2-bridge (:371) уточнить: «адрес IdP (центральный Blitz или локальный IdP в контуре, режим — ssoModes), HTTPS; без переменной сервис не стартует»
- [ ] `scripts/production/environment-model.mjs` — `validateModelShape` (~:215): опциональное поле `ssoModes` — если есть, массив строк из допустимого enum {`local-idp`, `corporate`}, не пустой; новый exported `ssoModeViolations(model)`: нарушения (поле отсутствует / значение вне enum / пустой массив) -- механизм проверки
- [ ] `scripts/test/compose-drift.test.mjs` — в `report()` (:63-64) добавить `ssoModeViolations(checked)`; тесты: текущая модель (ssoModes = оба режима) → 0 нарушений; отсутствие поля → фэйл; значение вне enum → фэйл -- AC
- [ ] `docs/production-setup.md` — новая секция «Локальный IdP-режим (пилот, interim)» (после предрасположений :10, перед мастером): когда (до центрального Blitz, пилот; после — эпик 3), предпосылки (Blitz-совместимый IdP в контуре: self-hosted Blitz для пилота / fixture-эмулятор для e2e стека; HTTPS; сертификат IdP, которому доверяет стек — NODE_EXTRA_CA_CERTS), конфигурация (тот же configure/`--json-stdin`: ssoHost=адрес локального IdP, client id/secret локального приложения, callback https://<площадка>/auth/callback), первый админ (bootstrap-admin, BOOTSTRAP_ADMIN_EMAIL = почта из IdP), ограничения (fail-closed: неверный state/отказ IdP не создают сессию; 0 dev-флагов — SSO_DISABLE=false в обоих режимах, AD-OP-5), переход (смена SSO_HOST/client/secret на центральный Blitz после пилота — эпик 3, переделка режима не требуется)
- [ ] `docs/implementation-readiness.md` — P0-SSO-строка (:54, :71-77): вставка, что interim-вход пилота = локальный auth как supported-конфигурация (эпик local-auth, e2e production-stack.mjs, evidence authMode=local-idp), а «Настоящий Blitz» — после пилота (эпик 3); строку перестраивать не нужно (контракт центрального Blitz не меняется)
- [ ] `scripts/test/production-stack.mjs` — новая проверка «Production-конфиг не содержит dev-флагов»: прочитать операторский .env (:70 vicinity) + env всех контейнеров (паттерн F5 release-candidate-e2e.test.mjs:640-653: `docker ps`-env-скан): нет `SSO_DISABLE=true`/`RAG_AUTH_DISABLED=true` в любом сервисе; oauth2-bridge и bootstrap-admin несут `SSO_DISABLE=false`; evidence `production-stack.json` (:603-624) — новое поле `authMode: 'local-idp'`
- [ ] Верификация инвариантов (без изменений): `compose-drift.test.mjs`, `production-runtime.test.cjs` — зелёные после правки модели (см. Verification)
- [ ] Регистрация: `scripts/workspace/check-tooling-tests.json` / `scripts/test/workspace-check-tooling.test.mjs` — НЕ менять (новые проверки в существующих файлах compose-drift.test.mjs и production-stack.mjs)

**Acceptance Criteria:**
- Given production-модель с `ssoModes: ["local-idp", "corporate"]`, when `node --test scripts/test/compose-drift.test.mjs`, then зелёно: 0 ssoModeViolations, productionEnvConstraints-проверки entry 1.4 без изменений.
- Given модель без поля ssoModes / со значением вне enum, when drift-тест, then фэйл с указанием нарушения (missing/invalid).
- Given production-стек, поднятый production-stack.mjs (overlay blitz-fixture, SSO на локальный IdP), when полный прогон, then все существующие проверки зелёные (логин PKCE/сессия/bridge-билет :304-320, bootstrap :260-265, logout :595-602) + новая проверка «0 dev-флагов» зелёная + evidence `authMode: 'local-idp'`, `realBlitz: false`.
- Given docs/production-setup.md, when оператор следует секции «Локальный IdP-режим (пилот, interim)», then у него достаточно предрасположений/команд configure/-bootstrap-admin/ограничений/перехода для развёртывания режима без чтения кода.
- Given P0-SSO-строка readiness, then interim-путь пилота (локальный auth = supported-конфиг) назван явно; «Настоящий Blitz» остался контрактом эпика 3.
- Given `node --test scripts/test/production-runtime.test.cjs` и `node --test scripts/test/compose-drift.test.mjs`, then зелёные (инварианты ep1 e4: SSO_DISABLE=true в production → отказ старта; матрица constraints не ослаблена); корневой сьют — без деградации против baseline.

## Design Notes

1. **Декларация, а не новый механизм.** Локальный режим уже проходит все production-гарды (production-stack.mjs — доказательство: SSO_DISABLE=false, PKCE, bootstrap без dev-входа, fail-closed state). Gap — формальный: режим не декларирован в модели, не задокументирован, не назван в evidence. Поэтому кодовые изменения минимальны: одно поле модели + одна проверка drift-теста + одна e2e-проверка + evidence-поле. oauth2-bridge/runtime.cjs/bootstrap-admin не трогаются.

2. **Почему поле `ssoModes`, а не `ssoMode`.** Модель (AD-OP-1) — описание production-окружения как данных; конкретный режим конкретного развёртывания живёт в операторском .env (SSO_HOST), а не в модели. `ssoModes` = контракт: список supported-режимов продукта (статичный, machine-checkable). Конкретный режим развёртывания фиксируется в evidence e2e (`authMode`) и в operator-доках — модель не дублирует состояние хоста.

3. **Локальный IdP — внешний для стека, не compose-сервис.** composition production-стека (12 сервисов модели) не меняется: локальный IdP — отдельный инстанс в контуре (self-hosted Blitz на пилоте; blitz-fixture-контейнер в e2e-проекте). Доверие к его сертификату — NODE_EXTRA_CA_CERTS у oauth2-bridge (механизм уже есть — Dockerfile'ы, AD-OP-7), как в production-stack.mjs:77-80. Это сохраняет AD-OP-1 (модель ↔ compose) и не раздувает стек.

4. **Gраница с эпиком 3 (epic-identity).** Переход на центральный Blitz = смена SSO_HOST/SSO_CLIENT_ID/sso_client_secret в операторском конфиге (configure) — никаких кодовых/моделей-изменений: контракт IdP один (Blitz, PKCE, client_secret_basic). P0-SSO-чеклист (docs/p0-external-acceptance.md, S01-S03) применяется к центральному Blitz без изменений; здесь не дублируется.

5. **Риск конфликтов при правке docs/.** docs/ правится параллельно другими сессиями (на момент плана): при сборке заново прочитать целевые секции (production-setup.md :1-31, implementation-readiness.md :54/:71-77) на актуальной версии main и вливать точечными вставками, не перезаписывая секции.

## Verification

**Commands:** (Node 24 обязателен: `export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH`; docker sequential, load-гating по quirk окружения)
- `node --test scripts/test/compose-drift.test.mjs` -- expected: зелёный (структурный drift entry 1.2 + productionEnvConstraints/latest entry 1.4 + новая проверка ssoModes; текущая модель с `ssoModes: ["local-idp", "corporate"]` — 0 нарушений)
- `node --test scripts/test/production-runtime.test.cjs` -- expected: зелёный без изменений (runtime-слой: SSO_DISABLE=true → throw)
- `node --test scripts/test/workspace-check-tooling.test.mjs` -- expected: зелёный (регистрация не меняется)
- `node scripts/test/production-stack.mjs` (собранные образы; при необходимости `--build`) -- expected: все проверки зелёные, включая новую «0 dev-флагов»; evidence `.run/production-stage-1/production-stack.json` содержит `authMode: "local-idp"`, `realBlitz: false`; стек убран (finally)
- `node scripts/workspace/check.mjs --tooling` -- expected: гейт зелёный
- Корневой сьют (sequential, low-load) -- expected: без деградации против baseline 56f8c009

## Open Questions (с рекомендациями)

- **OQ1 — Форма декларации режима: поле модели vs только доки.** Рекомендация: **поле `ssoModes` в модели + drift-проверка** (вариант плана). Обоснование: модель = единственный машино-читаемый источник production-окружения (AD-OP-1), AD-OP-5-матрица живёт в модели (productionEnvConstraints, entry 1.4); декларация только в доках была бы не проверяемой (coverage-аудит G-6 и возник потому, что «выглядит как обход»). Альтернатива (доки+evidence без поля) допустима, если оркестратор решит, что enum-контракт преждевременен.
- **OQ2 — Какой локальный IdP-инстанс на пилоте (self-hosted Blitz vs другой Blitz-совместимый)?** Рекомендация: **self-hosted Blitz** (тот же продукт, что центральный — переход после пилота = перенастройка, не миграция); owner: пользователь, до старта пилота. На supported-конфигурацию выбор не влияет: контракт один (Code Map: blitz-provider.fixture.cjs эмулирует именно его). Fixture (blitz-provider.fixture.cjs) — только для e2e: один хардкод-пользователь admin@example.test, пилотной команде (N пользователей) нужен реальный инстанс.
- **OQ3 — Глубина правки P0-SSO-строки readiness.** Рекомендация: **одна вставка** (interim-путь пилота), без перестройки строки — контракт центрального Blitz (контракт эпика 3) не меняется; docs/ правится параллельно, точечная вставка минимизирует конфликты.
- **OQ4 — Имя режима: `local-idp` vs `local` vs `pilot-local`.** Рекомендация: **`local-idp`** (описательно: локальный IdP-инстанс; не путать с dev-обходом; `pilot-local` привязало бы режим к пилоту, хотя supported-конфигурация живёт и после).
