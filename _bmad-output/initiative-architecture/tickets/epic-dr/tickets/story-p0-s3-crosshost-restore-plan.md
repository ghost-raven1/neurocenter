---
title: 'P0-S3: репетиция cross-host restore (без исходных дисков)'
type: 'feature'
ticket: '4'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-dr/epic-dr.md'
  - '{project-root}/docs/production-recovery.md'
  - '{project-root}/docs/external-backups.md'
  - '{project-root}/docs/implementation-readiness.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** P0-S3 (cross-host DR, R1/R3/C3) — центральный P0-блокер и сердце эпика. readiness (implementation-readiness.md:53) реализован («Есть HTTPS/SigV4, SHA readback, повтор и download; контракт, S24»), но **не принят**: «Независимый S3/retention; независимая доставка секретов/образов; полный restore другого хоста без исходных дисков/контейнеров». `external-backups.md:5` прямо: «Приёмка на независимом S3 и восстановление на другом физическом хосте **ещё не выполнены**». УJ-5 (PRD:86) — «restore чистого стека на другом хосте … (статус сегодня: не принят — C1/C3)». R3 (initiative-architecture.md:32): «Cross-host restore состояния проекта (quiesced backup) пройден на живых данных; RPO/RTO измерены репетицией и задокументированы». Counter (R3): «восстановление дольше заявленного RTO». Эта репетиция закрывает P0-S3 + C3 + UJ-5 — и является тем, что ждёт эпик 10 (пилот) и волна 2.

**Approach:** HITL-репетиция **на стеке, каким он существует на момент эпика** (эпик-dr.md:28: «репетиция на стеке, каком он существует на момент эпика»), с **недоступным исходным сервером**: (1) **независимый S3** — bucket с контрактом S3 (HTTPS-DNS, SigV4, path-style, If-None-Match, немедленное чтение), retention **целых комплектов** (lifecycle/object retention на стороне хранилища), ограниченные ключи, `INDEPENDENT=true` после проверки оператором отдельного хоста/дисков/администрирования (отказной домен ≠ исходный сервер); SHA описи сохраняется **отдельно** (вне исходного хоста). (2) **Доставка** — на **рабочем объёме** (не малая синтетика) сделать quiesced backup → upload на S3 (full SHA readback); проверить **обрыв/retry**, SHA и **отказ изменённых байтов**. (3) **Image-bundle** — передать image-bundle (entry 1) того же релиза на S3 (docker save 7 app + postgres). (4) **Секреты/конфиг/TLS** — независимо сохранить (production-конфиг, model_credential_key, SSO/PG/TLS) в защищённом хранилище вне исходного сервера (AD-OP-4: «production-конфиг/секреты — обязательное независимое хранилище»). (5) **Restore на другом хосте** — при **НЕДОСТУПНОМ исходном сервере**: на втором физическом хосте `external-backup download` комплекта + image-bundle, `docker load` образов (entry 1), `recovery.mjs verify` + `restore` в **новый пустой** Compose-проект (новые имена/тома, assertNewTarget), `setup.mjs up`; **настоящий вход** (локальный auth как interim — Blitz после пилота, эпик 3), **чтение и запись** в проекте, **сверка настроек и артефактов**; **измерить RPO/RTO** + прикладной smoke → DR-evidence (entry 2, scenario=s3-crosshost). (6) `crossHostRestoreVerified=true` **только** после этой репетиции (не по upload/readback/локальному Docker-restore — external-backups.md:5/:62).

## Boundaries & Constraints

**Always:**
- Стек репетиции = **как на момент эпика** (текущий production-кандидат, 7 app + postgres); новые compose-сервисы эпика 6 (prometheus/alertmanager) **не** в этой репетиции — подхватываются на **финальном** restore при приёмке пилота (эпик 10).
- Исходный сервер **недоступен** во время restore (не просто «отдельный проект» на той же машине — другой **физический** хост; external-backups.md:62).
- Restore — в **новый пустой** Compose-проект (новые имя/томы, `assertNewTarget:536`; рабочий стек никогда не является целью — production-recovery.md:85).
- Образы — из **image-bundle** (entry 1), `docker load` до restore; `--pull never` (closed-contour, без registry).
- Секреты/конфиг/TLS — **отдельная** независимая процедура (не в комплекте данных; production-recovery.md:11/:83).
- RPO/RTO **измерены** на рабочем объёме + прикладной smoke; записаны в DR-evidence (entry 2).
- Kвитанции: host identity, backup ID/SHA, image digests, время данных/проверки/восстановления, прикладные результаты — отдельно сохранены (external-backups.md:62).

**Never:**
- Не объявлять `crossHostRestoreVerified=true` по upload/readback или локальному Docker-restore (external-backups.md:5/:62, implementation-readiness.md:69).
- Не считать локальную папку / `INDEPENDENT=true` доказательством независимости (external-backups.md:22, implementation-readiness.md:69) — независимость (отказной домен) проверяет **оператор**.
- Не восстанавливать в рабочий/существующий стек (assertNewTarget отвергает существующие контейнеры/тома).
- Не использовать dev-обходы/синтетику для «промышленного» утверждения (production-recovery.md:149: «Свежесть и RTO малого тестового набора не являются гарантией для рабочего объёма»).
- Не менять model-weights в бандл (задокументированный residual: веса — re-pull/загрузка GGUF по restore-SOP, AD-OP-4:57, production-recovery.md:9).
- Не подменять/удалять `schema-initialization.json` (квитанцию) ради обхода (production-setup.md).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| INDEPENDENT_S3 | bucket (HTTPS-DNS, SigV4, path-style, If-None-Match), retention целых комплектов, ограниченные ключи | оператор подтверждает отказной домен ≠ исходный; INDEPENDENT=true | HTTP/file:/localhost/.internal/redirect → отказ |
| DELIVERY_WORKING | quiesced комплект (рабочий объём) → upload S3 | full SHA readback, manifest последним, SHA описи в квитанции | — |
| DELIVERY_INTERRUPT | обрыв на середине upload | повтор с тем же backup ID + SHA; существующие блоки перечитываются/сверяются | изменённые/конфликтующие байты → стоп |
| TAMPERED_BYTES | изменённый байт объекта | отказ (SHA-mismatch) | — |
| SOURCE_UNAVAILABLE | исходный сервер недоступен | restore на втором хосте без исходных дисков/контейнеров | — |
| LOAD_IMAGES | image-bundle (entry 1) → docker load | 7 app + postgres image ID == release-манифест | несовпадение → фэйл до restore |
| RESTORE_NEW | download комплект → verify → restore в новый проект | все БД/томы восстановлены, assertNewTarget, applicationsStarted:false | существующие тома/контейнеры → отказ |
| APP_SMOKE | `setup.mjs up` → настоящий вход/чтение/запись | вход (локальный auth interim), чтение+запись в проекте, сверка настроек/артефактов | — |
| RPO_RTO | данные/verify/restore time | RPO = now − dataCreatedAt; RTO = restore→apps healthy; в DR-evidence | RTO > заявленного → NO-GO (R3 counter) |
| CROSSHOST_VERIFIED | target host ≠ source host + restore-тайминги + smoke | crossHostRestoreVerified=true | target==source → фэйл |

</frozen-after-approval>

## Code Map

**Recovery (backup/verify/restore):**
- `scripts/production/recovery.mjs` — `backupProduction:245`/`backupOperation:278` (quiesced: pg_dump custom всех БД `:436-442`, 4 тома `volumeTransfer:444`, S3-объекты снимков `:446` + чата `:453`, manifest `images:469`, `verifyBackup:477`), `verifyBackup` (через recovery-manifest), `assertNewTarget:536` (отвергает существующие контейнеры/тома), `previewRestoreProduction:565`, `restoreProduction:626` (новые роли/БД `:666-705`, тома `:708-709`, snapshot/chat recovery `:716-730`, bridge_pairs reset `:756-761`, квитанция `applicationsStarted:false:770`), `main:790` (CLI backup/verify/restore).
- `scripts/production/recovery-manifest.mjs` — `validateManifest:15`, `writeManifest:128`, `verifyBackup:148`.
- `scripts/production/recovery-files.mjs` — `digestFile:41`, `inventory:58`, `copyTree:101`, `transferVolumes:134`.
- `scripts/production/recovery.mjs:652` — restore под `maintenanceLock` (общая daemon-блокировка).

**S3-транспорт (независимая доставка/получение):**
- `scripts/production/external-backup.mjs` — `externalBackupConfiguration:39` (ENV: ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET/SESSION_TOKEN/STORAGE_ID/INDEPENDENT), `signedS3Request:95` (SigV4), `forbiddenAddress:25` (loopback/link-local/мультicast/интерфейсы), `createExternalS3Store:200`, `uploadExternalBackup:304` (blobs 32MiB + readback + manifest последним), `downloadExternalBackup:423` (SHA + безопасные пути + 700-родитель), `retryExternalOperation:156`, `main:517`.
- `docs/external-backups.md` — контракт S3 (`:24-26`: path-style, SigV4, If-None-Match, немедленное чтение; redirect запрещён), Доставка (`:29-45`), Получение+проверка (`:47-62`, «Критерий промышленного завершения» `:62`).

**Image-bundle (образы — entry 1):**
- `scripts/production/dr-images.mjs` (entry 1) — `bundle`/`verify`/`load` (docker save/load 7 app + postgres по image ID из release-манифеста). Restore **требует** loaded-образы (restoreProduction читает `images:644/:652/:672`).
- `scripts/production/release-manifest.mjs` — `buildReleaseManifest:125` (image digests), `verifyReleaseManifest:169`.

**Секреты/конфиг (независимое хранилище):**
- `docs/production-recovery.md:11` (production-конфиг/пароли/SSO/TLS **не** в комплекте), `:13` (model_credential_key + identity marker — отдельно, до configure), `:83` (точное восстановление образов + секреты), `:95` (новые секреты, роли).
- `scripts/production/configuration.mjs` — production-конфиг (0700-каталог, file-secrets, AD-OP-5).

**Локальная DR-репетиция (базис, не заменяет cross-host):**
- `scripts/test/production-recovery-stack.mjs` — 2 независимых стека (локальная, **не** cross-host; production-recovery.md:147). Репетиция entry 4 **расширяет** на второй физический хост + недоступный исходный.
- `scripts/test/external-backup.test.mjs` (750) + `external-backup-s3.test.mjs` (138, local minio peer) — локальный транспорт, **не** независимый S3 (external-backups.md:70).

**Доки/контракт:**
- `docs/implementation-readiness.md:53` (P0-S3 «чего недостаёт») + `:65-69` (сценарий «P0-S3 — доказать восстановимость после потери площадки», Завершение `:69`).
- `_bmad-output/.../architecture-operational/architecture-operational.md:53-57` (AD-OP-4: scope бандла, RPO/RTO измеримые цели, критерии готовности: (1) приёмка на независимом S3, (2) cross-host restore на другом физическом хосте, (3) supply образов из бандла).
- `docs/production-recovery.md:81-111` (Восстановление на чистой машине), `:140-149` (Репетиция и допуск).

## Tasks & Acceptance

**Execution:**
- [ ] HITL-ранбук `docs/p0-s3-crosshost-rehearsal.md` (new) — пошаговый: подготовка независимого S3 (bucket/retention/ключи/INDEPENDENT), доставка комплекта + image-bundle + секретов/конфига на рабочий объём, индукция обрыва/retry + отказ на изменённых байтах, **остановка/недоступность исходного сервера**, download+docker load+verify+restore на втором хосте, `setup.mjs up`, настоящий вход/чтение/запись, сверка настроек/артефактов, замер RPO/RTO → DR-evidence. HITL-точки явно (инфра, остановка исходного, второй хост).
- [ ] (hitl=false часть) Убедиться что `production-recovery-stack.mjs` + `external-backup*.test.mjs` покрывают **локальную** механику (backup/verify/restore/download) перед HITL; при пробелах — добрать фикстуры (без изменения recovery/external-backup).
- [ ] Репетиция на целевом кандидате (HITL): независимый S3 → delivery (рабочий объём, SHA readback) + обрыв/retry + отказ изменённых байтов → image-bundle (entry 1) → секреты/конфиг/TLS отдельно → **исходный сервер недоступен** → на 2-м хосте download + docker load + verify + restore (новый проект) + up + вход/чтение/запись + сверка → RPO/RTO → DR-evidence (s3-crosshost).
- [ ] Записать DR-evidence (entry 2) scenario=s3-crosshost: RPO/RTO, host identity (source≠target), backup ID/SHA, image digests, storage binding, smoke; `crossHostRestoreVerified=true`.
- [ ] Обновить `docs/implementation-readiness.md` P0-S3 → «пройдено» + `external-backups.md:5` (принято); baseline RPO/RTO в `maintenance_settings` (policy).

**Acceptance Criteria:**
- Given независимый S3 (контракт S3, retention целых комплектов, ограниченные ключи, отказной домен ≠ исходный), when оператор подтверждает, then INDEPENDENT=true; HTTP/file:/localhost/redirect → отказ.
- Given quiesced комплект на рабочем объёме, when upload S3, then full SHA readback + SHA описи в квитанции; обрыв → повтор по тому же backup ID+SHA; изменённые байты → отказ.
- Given исходный сервер недоступен, when на 2-м хосте download + docker load (image-bundle) + verify + restore в новый пустой проект, then все БД/томы восстановлены (assertNewTarget, applicationsStarted:false), `setup.mjs up` → healthy.
- Given восстановленный стек, when настоящий вход (локальный auth interim) + чтение/запись в проекте, then работают; настройки и артефакты сверены.
- Given data/verify/restore time, when RPO/RTO, then RPO = now − dataCreatedAt, RTO = restore→apps healthy; записаны в DR-evidence; RTO ≤ заявленного (иначе NO-GO, R3 counter).
- `crossHostRestoreVerified=true` только при target host ≠ source host + restore-тайминги + smoke (не по upload/readback/локальному Docker-restore).
- P0-S3 в implementation-readiness.md + external-backups.md:5 → «пройдено» со свидетельством.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Это HITL-репетиция, не новый код.** Механика (recovery backup/verify/restore, external-backup upload/download, dr-images bundle/load) реализована и покрыта локальными тестами. Entry 4 **запускает** её на **независимом S3 + втором физическом хосте + недоступном исходном сервере** — то, что локальные тесты **не** закрывают (external-backups.md:70: «Эти проверки не являются подключением к настоящему S3… или репетицией аварии другой площадки»). Единственный hitl=false код — добор локальных фикстур при пробелах.

2. **Почему «на стеке момента эпика».** epic-dr.md:28: «репетиция на стеке, каком он существует на момент эпика». Это фиксирует: репетиция = текущий production-кандидат (7 app + postgres), **без** сервисов эпика 6. Финальный restore **с** сервисами эпика 6 (prometheus/alertmanager) — при приёмке пилота (эпик 10), DR-бандл их подхватит (AD-OP-4, epic-dr.md:17). Не раздувать эту репетицию.

3. **Недоступность исходного сервера — ключевой инвариант.** «cross-host restore **без исходных дисков**» (эпик) + external-backups.md:62 «на другом хосте получить комплект и секреты/образы **при недоступном исходном сервере**». Репетиция требует реально остановить/сделать недоступным исходный сервер на время restore (не просто отдельный compose-проект на той же машине). Это отличает от production-recovery-stack.mjs (2 стека на одной машине).

4. **Репетиция зависит от entry 1 (image-bundle) + entry 2 (evidence) + целевого кандидата + реального S3 + второго хоста.** Это самый тяжёлый HITL (инфра: независимый S3, второй физический хост, остановка исходного). after=[1,2].

5. **Локальный auth как interim.** «Настоящий вход» (UJ-5) — на пилоте через Blitz (эпик 3, после пилота). В этой репетиции вход = существующий локальный auth-режим как interim-конфигурация (решение пользователя 2026-11-06, эпик 10). Это не dev-обход (validateProduction) — интеримная production-конфигурация. См. OQ2.

## Verification

**Commands:** (Node 24: `~/.nvm/versions/node/v24.22.0/bin/node`; целевой сервер + независимый S3 + второй хост + Docker)
- Локальная механика (hitl=false): `node --test scripts/test/production-recovery.test.mjs` -- expected: backup/verify/restore зелёные
- Локальная механика: `node --test scripts/test/external-backup.test.mjs scripts/test/external-backup-s3.test.mjs` -- expected: транспорт (SHA readback/повтор/отказ) зелёные (локальный, **не** независимый S3)
- **HITL (независимый S3):** настройка bucket/retention/ключей → `node scripts/production/external-backup.mjs upload --source <рабочий комплект> --backup-id <id> --expect-sha256 <SHA>` -- expected: full SHA readback, SHA описи в квитанции
- **HITL (обрыв/tamper):** обрыв на середине → повтор с тем же ID+SHA; изменение байта → отказ
- **HITL (image-bundle):** `dr-images bundle` (entry 1) → upload на S3
- **HITL (исходный недоступен → 2-й хост):** `external-backup download` + `dr-images load` + `recovery.mjs verify --expect-sha256` + `recovery.mjs restore --project-name <новый>` -- expected: все БД/томы, assertNewTarget, applicationsStarted:false
- **HITL (smoke):** `setup.mjs up` → настоящий вход (локальный auth interim) + чтение/запись + сверка настроек/артефактов
- **HITL (evidence):** `node scripts/production/dr-evidence.mjs record --scenario s3-crosshost ...` -- expected: RPO/RTO + host identity (source≠target) + backup ID/SHA + image digests + smoke; crossHostRestoreVerified=true
- `docs/implementation-readiness.md` P0-S3 + `external-backups.md:5` → «пройдено»

## Open Questions (с рекомендациями)

- **OQ1 — Где взять независимый S3 + второй физический хост?** Рекомендация: **инфраструктурное решение оператора/пользователя** (не в скоупе кода): Ceph RGW / независимое S3-хранилище + второй физический хост (или VM на отдельной машине) в закрытом контуре. Оператор подтверждает отказной домен (отдельные диски/хост/администрирование). Это ключевой внешний ресурс репетиции — нужен **до** старта entry 4.
- **OQ2 — «Настоящий вход» = локальный auth (interim) или Blitz?** Рекомендация: **локальный auth как interim** (решение пользователя 2026-11-06: Blitz — эпик 3, после пилота). Репетиция проверяет restore+workload, не IdP. Blitz-часть UJ-1 — эпик 3. Обоснование: не блокировать P0-S3 на SSO.
- **OQ3 — Насколько «недоступен» исходный сервер?** Рекомендация: **полная остановка** (docker down + недоступность дисков/сети) на время restore — не просто «не используем». Обоснование: external-backups.md:62 «при недоступном исходном сервере»; это доказывает self-sufficiency бандла. Минимально: остановить контейнеры + отмонтировать/отключить доступ к исходным томам.
- **OQ4 — Рабочий объём: реальные данные или синтетика крупного размера?** Рекомендация: **рабочий объём целевого кандидата** (реальные данные проекта/каталога), не малая синтетика (production-recovery.md:149: RTO малого набора ≠ гарантия рабочего объёма). Если реальные данные чувствительны — согласованная копия реального объёма того же размера.
- **OQ5 — model-weights при restore?** Рекомендация: **не в бандл** (задокументированный residual, AD-OP-4:57) — re-pull/загрузка GGUF по restore-SOP. Репетиция фиксирует, что карточки/SHA моделей сохранены, inference — отдельная проверка (production-recovery.md:109).
