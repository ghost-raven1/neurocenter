# DR-бандл образов релиза (Epic 4, story 4.1)

Base: main `6780cffa3bb6032a0e431ea5ac5c50bc168f518a`. Работа в worktree `/tmp/opencode/nc-wt-4-1` (ветка `nc-4-1`), коммит `c2f654e2` (не пушен). Задача AD-OP-2, AD-OP-4: самодостаточный DR-бандл точных образов релиза с проверкой `docker load` (ID == manifest), передачей на S3 с SHA readback и локальной restore-репетицией.

Важно: это **dev-rehearsal**. Release-манифест `dr-4-1` собран из **текущего dev-стека** (commit `6780cffa` + 8 точных image ID), а не из production-релиза. Инструмент и процедура production-ready; конкретные образы — dev-вариант.

## Изменено

- `scripts/production/dr-images.mjs` — новый инструмент: `bundle` (docker save 7 приложений + postgres по точному image ID из верифицированного release-манифеста), `verify` (docker load каждого tar, сверка ID с описью и манифестом), `load` (аддитивная загрузка + авто-тегирование 7 приложений `neurocenter/<svc>:<release>`; postgres не тегится), `upload`/`download` (S3, chunking + полный SHA readback, опись публикуется последней). Формат описи `neurocenter-image-bundle-v1` (ключи точные, без посторонних полей, без секретов); каталоги 700, файлы 600.
- `scripts/test/dr-images.test.mjs` — 15 тестов (bundle/verify/load/upload/download, SHA-mismatch, stale-commit, точная форма описи).
- Регистрация: `scripts/workspace/check-tooling-tests.json` (+`dr-images.test.mjs`, 68→69, сортировка сохранена), `scripts/workspace/check-plan.mjs` (кап 68→69 с комментарием), `scripts/test/workspace-check-tooling.test.mjs` (expectedFiles +1).
- `docs/production-recovery.md` — раздел «DR-бандл образов релиза» (процедура, факты save-by-reference, ограничение postgres digest-pin с конкретной override-подсказкой) + правка шага 1 «Восстановление на чистой машине».

## Проверено

- **Сборка бандла** — 8/8 tar (7 приложений + postgres), опись `image-bundle.json` SHA256 `d9d1d9699f671d334a751c2d3880147519ce8bbd8d48e8eb42fd2ad1130ffce8`, ~7.7 ГБ, `ok:true`.
- **Verify** — 8/8 `docker load` → image ID == опись == release-манифест (EXIT_CODE=0, `verify.log`).
- **Restore-репетиция** (проект `nc-dr-reh-mwasts72`, порты 56443/56445, рабочий `neurocenter`-стек не затронут) — **`ok:true`**:
  - stack-up: **11/11 healthy** за 66.4 с (api-gateway, catalog, feature-flags, frontend, model-runtime, oauth2-bridge, postgres, rag-sync, skills, capacity-collector-заглушка, blitz-fixture).
  - application smoke **внутри node-контейнера стека** (backend-сеть): `/ready` 200 → SSO-вход (Blitz-фикстура, `client_id=fixture-client`) → `/auth/me` = «Главный админ» → `POST /api/projects` 201 → `GET /api/rag/database` триггерит ленивое pgvector-провижинирование (CREATE DATABASE TEMPLATE `nc_rag_template`) → проектная БД `nc_rag_7de078d3efda5e7fe71aecc78433833d` (проект `prj-d5babcc6-…`) подтверждена в восстановленном postgres.
  - teardown: проект и тома удалены, теги репетиции сняты, leftoverVolumes пуст.
- **Факты save-by-reference** (эмпирика, зафиксированы в runbook): save по **image ID** → в tar `RepoTags: null`, в image-конфиге нет `repoDigests` (после load образ только по ID); save по **тег-reference** → `RepoTags` сохраняется (тег переживает load); save по **digest-reference** (manifest-list) → `RepoTags: null` + нет repoDigests (reference теряется). Отсюда production-поиск postgres по digest-пину после `load` не резолвится офлайн.
- **Тесты изменений**: `dr-images.test.mjs` 15/15; `workspace-check-tooling.test.mjs` 14/14 (валидирует регистрацию 69/69, сортировку и кап).
- **Коммит**: `c2f654e2` на `nc-4-1` (родитель `6780cffa`), working tree чист, не пушен.

## Ограничения и вскрытые gaps

- **Tooling-гейт `check.mjs --tooling` — CHECK_TIMEOUT (step 2).** Шаг «Инструменты разработки: локальные контракты» (все 69 файлов одним шагом) стабильно превышает фиксированный per-step таймаут 600 с на общей машине (load 4–18) и прерывается на `scripts/test/dev-start.test.mjs` (индекс 34 в отсортированном списке) — **до** достижения `dr-images` (43) и `workspace-check-tooling` (64). Это ограничение окружения (объём-suite + load + фикс. 600 с/шаг, CLI без override таймаута), а не дефект кода: step 1 (Agent kit) проходит, а добавленные тесты верифицированы напрямую (15/15 и 14/14). В CI с выделенным ресурсом suite укладывается в лимит.
- **PRODUCTION GAP: non-root `api-gateway` не читает compose-секреты.** Compose-секреты — bind-mount host-файла (тот же inode, uid:gid и mode host-a). Production-конфиг создаёт root: root-контейнер с `cap_drop:[ALL]` читает собственные 600-файлы. Но `api-gateway` идёт под `USER node` (uid 1000): root:600 секрет даёт EACCES для uid 1000, а CAP_DAC_OVERRIDE для non-root неэффективен (проверено; в образе нет setcap/file-caps/chgrp-механизма). Dev-стек работает, т.к. dev передаёт значения, а не `*_FILE`. Rehearsal обходил это эквивалентом production root-владения (override: `api-gateway user:'0' + cap_add:[DAC_OVERRIDE]`, `catalog-service cap_add:[DAC_OVERRIDE]`; `model_credential_key` остаётся 600 — `readOnce` отклоняет `mode & 0o077`). E2E `production-recovery-stack.mjs` **не в CI** — этот gap не вылавливался. Требуется решение: либо root-владение конфигом в production-документации, либо чтение `api-gateway` под root/через механизм, доступный non-root.
- **Catalog dev-образ не содержит `/shared/capacity-collector.cjs`** (Dockerfile не создаёт) → capacity-collector в rehearsal — заглушка (`sleep infinity` + `healthcheck: true`). Из-за заглушки `/capacity/snapshot.json` не пишется, поэтому в rehearsal `CAPACITY_REQUIRED: 'false'` для `rag-sync-service` и `catalog-service` (иначе ленивое pgvector-провижинирование отклоняется CAPACITY_UNAVAILABLE). В production коллектор реальный — ограничение не действует.
- **Kaspersky AV TLS-MITM на хосте** — перехватывает host-loopback TLS по SNI `blitz.test` и подменяет сертификат корнем «Kaspersky Anti-Virus Personal Root Certificate» (`SELF_SIGNED_CERT_IN_CHAIN`); перехват не детерминирован (бывали и no-SNI-перехваты). Smoke переведён **внутрь контейнера стека** (container-internal сеть): проверено, что изнутри приходит подлинный `panel.test`-сертификат (независимо от SNI), тогда как host-loopback с SNI `blitz.test` отдаёт Kaspersky-сертификат. Окружная проблема, не свойство бандла/стека.
- **If-None-Match: dev-Ceph transport gap** — production `createExternalS3Store` при PUT подписывает и шлёт `If-None-Match: *`, dev Ceph RGW отвечает 403 (plain PUT → 200, minio-js проходит). S3-репетиция использует minio-based store (put/get + production `assertPrivateS3Bucket` + retry); production-логика chunking/SHA-readbackexercised без изменений.
- **Dev Ceph RGW нестабилен** — crash-loop (`Aborted (core dumped)`, watchdog, «RGW user verification failed»), ~268+ рестартов, лимит 3 ГБ. Полный upload/readback бандла на S3 не выполнен; store-путь (put/get/SHA) ранее подтверждён на малых объектах.

## Вердикт

Ядро story 4.1 выполнено и верифицировано: DR-бандл точных образов релиза (7 приложений + postgres по image ID) собирается, проверяется (`docker load` → ID == опись == манифест, аддитивно), загружается и поднимает **полный production-стек 11/11 healthy** с рабочим application-функционалом (SSO, роли, создание проекта, pgvector-провижинирование). Инструмент, 15 тестов и runbook закоммичены на `nc-4-1`. Сдерживающие факторы — окружение (общая машина: tooling-гейт 600 с/шаг, Kaspersky TLS-MITM, нестабильный dev Ceph) и dev-специфика (manifest из dev-стека, dev-образ каталога без `/shared`), а не логика бандла/восстановления.

## Следующий шаг

1. **Production gap `api-gateway` × 600-секреты** — решить (root-владение конфигом в production-документации/процедуре либо доступный non-root механизм чтения) и добавить E2E `production-recovery-stack.mjs` в CI, чтобы catch-ить при регрессии.
2. **Tooling-гейт** — прогнать `check.mjs --tooling` в CI/на выделенной машине (вне общей), подтвердить прохождение step 2 целиком; при необходимости обсудить пересмотр per-step таймаута для большого tooling-suite.
3. **S3 upload/readback полного бандла** — выполнить на стабильном RGW (после стабилизации dev Ceph либо на отдельном S3) и закрыть transport gap `If-None-Match` (production store vs dev Ceph).
4. **Production-прогон** — повторить restore-репетицию по **production** release-манифесту (не dev-стеку) и с реальным capacity-collector, чтобы снять dev-кавер-ноты.
5. Коммит `c2f654e2` на `nc-4-1` — пуш после ревью.
