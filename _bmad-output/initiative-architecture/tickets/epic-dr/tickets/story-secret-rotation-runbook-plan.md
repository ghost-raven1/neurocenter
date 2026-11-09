---
title: 'Rotation-секретов + edge-сертификата: runbook на каждый секрет + запись последствий + алерт (FR-1004, AD-OP-4, AD-OP-7.3)'
type: 'feature'
ticket: '7'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '56f8c009cf0c9cb9d18091c5176c36831eb981cd'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-dr/epic-dr.md'
  - '{project-root}/docs/implementation-readiness.md'
  - '{project-root}/docs/production-setup.md'
  - '{project-root}/docs/production-recovery.md'
  - '{project-root}/docs/production-update.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** FR-1004: «Секреты ротируемы с задокументированными последствиями»; AD-OP-4 (architecture-operational.md:57): «Ротация секретов (internal_token, metrics_token, sso_client_secret, model_credential_key, postgres_password) — **DR-компонент**: runbook на каждый + запись последствий (internal_token → гашение всех билетов, стык AD-4 runtime-trust)»; AD-OP-7(3) (architecture-operational.md:75): «edge-сертификат: **runbook ротации** (замена + пересоздание frontend) + **алерт на days-to-expiry**». Состояние main: генерация/создание секретов закрыта (configuration.mjs:210-211 postgres_password/internal_token, :145-182 ensureMetricsToken, :230-233 sso_client_secret, :213 ensureModelCredentialKey; edge-сертификат — операторские файлы TLS_CERT_FILE/TLS_KEY_FILE, compose.production.yml:327-328, проверка setup.mjs:138-145), НО **операционное действие «ротация» — без runbook нигде**: grep «FR-1004» по `tickets/` = 0 (coverage-аудит G-1), «автоматической ротации нет» (docs/production-update.md:83), «потерянный ключ … не генерируется заново» (docs/production-setup.md:29). R10/NFR-5 требует: «операционные действия (update/DR/ротация) — по runbook». Дыра: при инциденте (утечка/истечение) оператор не знает процедуры и последствий — бьёт приёмку пилота (NFR-5) и DR-контур (AD-OP-4: секреты = «обязательное независимое хранилище … runbook»).

**Approach:** Новый операторский док `docs/secret-rotation.md` — runbook на каждый секрет инвентаря + edge-сертификат, единый формат секции: (1) **что это** (куда монтируется, кто consumer — из environment-model.json / compose.production.yml:318-328), (2) **процедура ротации** (пошагово, из текущего production-конфига: где взять новый, куда положить, что перезапустить, как проверить; postgres_password — включая обновление 4 файлов `*_url` с новым паролем; sso_client_secret — с обновлением в IdP (Blitz) до/после, порядок без окна неавторизованного входа), (3) **запись последствий** (что ломается при истечении/некорректной ротации: internal_token → гашение всех билетов устройств, стык AD-4; metrics_token → падает весь scrape/алертинг; sso_client_secret → token-exchange с IdP, новые сессии не создаются; model_credential_key → сохранённые credentials удалённых моделей не открываются (production-setup.md:29, production-update.md:83); postgres_password → все PG-соединения; edge-сертификат → HTTPS edge-фронта, все TLS-клиенты), (4) **как проверить истечение/свежесть** (edge: `openssl x509 -checkend`; секреты: days-since-генерации по mtime/метке config-каталога + policy-период ротации, рекомендуемый период зафиксирован в runbook). Алерт days-to-expiry edge-сертификата = **consumer ep6 entry 13** (alerting, правило cert-expiry — AD-OP-7/AD-OP-8; механизм доставки — ep6, здесь только ссылка, не дублирование). **Инвариант-тест**: runbook покрывает 100% инвентаря — секция отсутствует для секрета/сертификата из инвентаря = фэйл сьюта.

## Boundaries & Constraints

**Always:**
- Инвентарь = канонический список AD-OP-4 (internal_token, metrics_token, sso_client_secret, model_credential_key, postgres_password) + edge-сертификат (AD-OP-7.3); источник истины инвентаря = `deploy/production/environment-model.json` (secrets) + `compose.production.yml:318-328` (docker secrets) + `frontend/nginx.production.conf.template:12-13` (tls_cert/tls_key).
- Каждая секция runbook несёт: процедуру ротации + запись последствий + как проверить истечение (три обязательных блока — формат фиксирован).
- Запись последствий — конкретная цепочка (секрет → consumer → что ломается → следующий шаг), не абстракция.
- postgres_password: ротация = новый пароль И 4 файла `*_url` (catalog_url/rag_url/rag_provision_url/backup_url) + restart postgres+consumers — атомарность окна зафиксирована в runbook.
- model_credential_key: ротация = **не автосовместима** (новые ключи старые credentials не откроют — production-update.md:83); runbook фиксирует «ротация = только при отсутствии сохранённых credentials ИЛИ с миграцией (re-encrypt) — OQ-3».
- Алерт days-to-expiry — ссылка на ep6 entry 13 (правило cert-expiry), механизм не дублируется.
- Дополнительные секреты инвентаря (restore_runner_token, chat_s3_access_key, chat_s3_secret_key, *_url) — решение зафиксировано в runbook (включены в тот же формат ИЛИ явно исключены с причиной).

**Never:**
- Не вводить автоматическую ротацию (AD-OP-4: ротация — операторское действие по runbook; «автоматической ротации нет» — ратификация, production-update.md:83).
- Не дублировать механизм алертинга (ep6 entry 13) — только ссылка.
- Не менять код генерации/валидации секретов (configuration.mjs/model-credentials.mjs) — runbook-сторис, не код-сторис (исключение — OQ-1: если при описании процедуры выяснится дыра в механизме, фикс = отдельная сторис).
- Не писать значения секретов в runbook/логи (только имена + пути + процедуры).
- Не описывать dev-обходы (SSO_DISABLE и пр. — AD-OP-5) в runbook production-ротации.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| RUNBOOK_COVERAGE | инвентарь (5 секретов + edge) | docs/secret-rotation.md: 6 секций, каждая 3 блока | секция/блок отсутствует → тест фэйл |
| ROTATE_INTERNAL | ротация internal_token | все билеты гаснут (AD-4), устройства ре-подключаются (re-issue, entry ep2 e6) | без re-issue-пути = записан следующий шаг |
| ROTATE_METRICS | ротация metrics_token | scrape временно падает → восстанавливается; алерты в окне ротации — ожидаемы | окно записано в runbook |
| ROTATE_SSO | ротация sso_client_secret | token-exchange: порядок «IdP сначала» — без окна отказа входа | порядок шагов зафиксирован |
| ROTATE_MODEL_KEY | ротация model_credential_key при сохранённых credentials | старые credentials НЕ открываются — runbook фиксирует ограничение + миграционный путь | не «тихо сломать» — явная запись последствий |
| ROTATE_PG | ротация postgres_password | 4 файла *_url + password + restart — PG-соединения восстановлены | частичная ротация = записан rollback-шаг |
| EDGE_EXPIRY | edge-сертификат истекает/истёк | HTTPS edge-фронта down; `openssl x509 -checkend` детектит | алерт days-to-expiry (ep6 e13) + процедура замены |
| INVENTORY_DRIFT | новый секрет в environment-model/compose | invariant-тест фэйл «секция отсутствует» | actionable: добавить секцию |

</frozen-after-approval>

## Code Map

**Генерация/создание (что ротируем и где живёт):**
- `scripts/production/configuration.mjs:184-233` — `configureProduction`: `:210` postgres_password, `:211` internal_token, `:214-221` 4 файла `*_url` (catalog/rag/rag_provision/backup), `:230-233` sso_client_secret (внешний ввод IdP).
- `scripts/production/configuration.mjs:145-182` — `ensureMetricsToken` (64 hex, 0600, «автоматическая замена запрещена» :179).
- `scripts/production/configuration.mjs:213` + `scripts/workspace/model-credentials.mjs:1-30` — `ensureModelCredentialKey` (AES-256, «Восстановите сохранённый model_credential_key; автоматическая замена запрещена»).
- `scripts/production/setup.mjs:138-145` — проверка presence tls_cert/tls_key перед `up` (источник — операторские файлы).

**Montage/consumers (куда монтируется, кто читает):**
- `compose.production.yml:317-328` — docker secrets: model_credential_key, metrics_token, internal_token, sso_client_secret, postgres_password, catalog_url, rag_url, rag_provision_url, backup_url, tls_cert, tls_key.
- `deploy/production/environment-model.json` — secrets-поля сервисов: postgres (`:58`), catalog (`:160-218`: chat_s3_*, internal_token, metrics_token, model_credential_key, restore_runner_token, *_url), postgres_password (`:58`).
- `services/api-gateway/src/app.controller.ts:15-32` — /ready/dependencies (5 upstream'ов — consumer-контекст для internal_token).
- `frontend/nginx.production.conf.template:12-13` — `ssl_certificate /run/secrets/tls_cert` / `ssl_certificate_key /run/secrets/tls_key` (edge-сертификат).
- `compose.production.yml:254-259` — oauth2-bridge: SSO_CLIENT_SECRET_FILE (sso_client_secret consumer).

**Доки (что уже есть, куда встраивать):**
- `docs/production-setup.md:29` — model_credential_key: «Потерянный ключ … не генерируется заново … seed и up проверяют соответствие keyId».
- `docs/production-update.md:83` — «автоматической ротации нет; требуется исходный ключ из независимой копии».
- `docs/production-recovery.md:13` — model_credential_key + .id в recovery-конфигурации.
- `docs/implementation-readiness.md` — P0-матрица (NFR-5 «операционные действия по runbook» — куда ссылается runbook).
- `docs/maintenance-schedule.md`, `docs/external-backups.md` — соседние операторские runbook (формат-образец).

**Контракт:**
- `_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md:57` (AD-OP-4), `:75` (AD-OP-7(3)), `:81` (AD-OP-8: cert-expiry в матрице алертов), `:101` (Consistency: «runbook ротации + запись последствий на каждый секрет»).
- ep6 entry 13 (`tickets/epic-res-obs/tickets/tickets.toml`, alerting): правило cert-expiry (AD-OP-7, days-to-expiry edge-сертификата) — consumer алерта.

## Tasks & Acceptance

**Execution:**
- [ ] `docs/secret-rotation.md` (new) — инвентарь-таблица (секрет → файл → consumer → период ротации) + секция на каждый: internal_token, metrics_token, sso_client_secret, model_credential_key, postgres_password, edge-сертификат; формат секции: (1) что это, (2) процедура ротации (пошагово), (3) запись последствий, (4) как проверить истечение.
- [ ] postgres_password: процедура с 4 файлами `*_url` + порядок restart (postgres → consumers) + rollback-шаг при частичной ротации.
- [ ] sso_client_secret: порядок «сначала IdP (Blitz) — потом server-файл» (без окна отказа входа) + запись последствий (token-exchange, новые сессии).
- [ ] model_credential_key: явная запись «новые ключи старые credentials не откроют» + миграционный путь (re-encrypt) или ограничение (только без сохранённых credentials) — по OQ-3.
- [ ] edge-сертификат: замена TLS_CERT_FILE/TLS_KEY_FILE + пересоздание frontend (AD-OP-7.3) + `openssl x509 -checkend` + ссылка на алерт days-to-expiry (ep6 entry 13, правило cert-expiry).
- [ ] Дополнительные секреты (restore_runner_token, chat_s3_access_key/secret_key, *_url): решение — включены в runbook (тот же формат) или явно исключены с причиной (OQ-2).
- [ ] `scripts/test/secret-rotation-runbook.test.mjs` (new) — офлайн: парсит инвентарь (environment-model.json secrets + compose secrets + tls) и проверяет docs/secret-rotation.md: секция + 3 обязательных блока на каждый = зелёный; отсутствие = фэйл с именем секрета. Регистрация в `scripts/workspace/check-tooling-tests.json`.
- [ ] Ссылки: `docs/production-setup.md` / `docs/production-recovery.md` / `docs/production-update.md` — указатель на secret-rotation.md (1 строка каждый).

**Acceptance Criteria:**
- Given инвентарь = 5 секретов AD-OP-4 + edge-сертификат, when открыть docs/secret-rotation.md, then 6 секций, каждая: процедура + последствия + проверка истечения.
- Given postgres_password, when ротация, then runbook охватывает 4 файла `*_url` + порядок restart + rollback-шаг.
- Given новый секрет в environment-model.json, when invariant-тест, then фэйл «секция отсутствует» с именем.
- Given edge-сертификат, when runbook, then `openssl x509 -checkend` + ссылка на алерт days-to-expiry (ep6 e13) без дублирования механизма.
- `node --test scripts/test/secret-rotation-runbook.test.mjs` — офлайн зелёный; корневой сьют — без деградации.

## Design Notes

1. **Один док, а не 6 файлов:** операторские доки репо — один файл на операционный домен (production-setup/recovery/update, maintenance-schedule, external-backups). Rotation — один домен (инвентарь + единый формат секции) → `docs/secret-rotation.md`. Per-файл runbook'и создали бы 6 мелких файлов с общим инвентарём и общим форматом — против паттерна репо.
2. **Runbook, не код:** сторис не трогает генерацию (configuration.mjs) — только операторское действие + инвариант-тест покрываемости. Это согласуется с AD-OP-4 («runbook на каждый + запись последствий» = документ) и R10/NFR-5 («операционные действия — по runbook»).
3. **Алерт = ссылка, не механизм:** days-to-expiry edge-сертификата — правило cert-expiry в матрице AD-OP-8 (alerting ep6 entry 13). Runbook ссылается («алерт есть — ep6 e13»), не описывает delivery (единый механизм — AD-O6).
4. **Запись последствий = анти-паттерну «тихая поломка»:** модель-ключ и postgres_password — два случая, где ротация «без последствий на бумаге» ломает данные/соединения молча. Именно поэтому формат секции обязывает блок (3) — это и есть требование FR-1004.

## Verification

**Commands:** (Node 24: `~/.nvm/versions/node/v24.22.0/bin/node`)
- `node --test scripts/test/secret-rotation-runbook.test.mjs` -- expected: офлайн зелёный (6 секций × 3 блока по инвентарю)
- `node scripts/workspace/check.mjs --tooling` -- expected: secret-rotation-runbook-тест в tooling-списке, гейт зелёный
- `grep -c "Процедура ротации\|Последствия\|Проверка истечения" docs/secret-rotation.md` -- expected: 6×3 блока на месте (визуальная сверка)
- Корневой сьют -- expected: без деградации против baseline.

## Open Questions (с рекомендациями)

- **OQ1 — Дыра в механизме при описании процедуры?** Если пошаговая процедура выявит, что механизм не поддерживает ротацию (например, нет способа обновить sso_client_secret без re-configure), фикс механизма = отдельная сторис (не сюда). Рекомендация: при написании runbook фиксировать такие места в Plan Change Log и выносить тикеты.
- **OQ2 — Дополнительные секреты (restore_runner_token, chat_s3_*, *_url)?** Рекомендация: **включить** в runbook тем же форматом (они в инвентаре compose/environment-model, «секреты ротируемы» — FR-1004 без исключений); `_url`-файлы — как часть процедуры postgres_password (не отдельные секции, чтобы не раздуть). Обоснование: инвариант-тест покрывает инвентарь — исключение без причины = дыра.
- **OQ3 — model_credential_key: миграция credentials при ротации?** Рекомендация: runbook фиксирует **ограничение** (новые ключи старые credentials не откроют — production-update.md:83) + путь «ротация только при отсутствии сохранённых credentials ИЛИ с re-encrypt-миграцией (механизм — отдельная работа, Deferred)». Обоснование: re-encrypt-механизм не существует в main; изобретать в runbook-сторис нельзя.
- **OQ4 — Policy-период ротации (сколько дней)?** Рекомендация: зафиксировать в runbook рекомендуемый период (например, 90 дней — стандарт для service-секретов; edge-сертификат — по дате истечения, алерт при ≤30 днях) как **рекомендацию** (policy в `maintenance_settings` — ep4 entry 3/2, не здесь). Обоснование: период — операторская политика, runbook даёт рекомендуемое значение + как измерить days-since-генерации.
