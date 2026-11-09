---
title: 'P0-UPD: репетиция обновления на копии рабочего объёма (точные образы)'
type: 'feature'
ticket: '5'
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
  - '{project-root}/docs/production-update.md'
  - '{project-root}/docs/implementation-readiness.md'
  - '{project-root}/docs/production-recovery.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** P0-UPD (P0-блокер, R1) в readiness (implementation-readiness.md:56) реализован («Есть preflight/предварительная копия/идемпотентный update/restore; 12/12 Docker-репетиции, S25»), но **не принят** для текущих изменений: «Репетиция точных актуальных образов на копии рабочего объёма; authenticated smoke и допустимые сроки». Ключевое ограничение (production-update.md:87): «Нынешняя 12/12-репетиция использовала **малую синтетику** и **указанные в runbook прежние образы**; она **не принимает последующие frontend/backend-изменения**». То есть оркестратор обновления (update.mjs preflight/apply/rollback) существует, но репетиция на **рабочем объёме** с **точными актуальными** образами (текущий production-кандидат → следующий релиз) ещё не проходила. AD-OP-3 (architecture-operational.md:51): «Критерии готовности релиза (решение «нет staging»): **rehearsal на копии данных пройден** + cross-host DR-restore пройден (AD-OP-4) + нет деградации против baseline».

**Approach:** HITL-репетиция обновления на **копии рабочего объёма** с **точными актуальными** образами по runbook `production-update.md`: (1) воспроизводимый набор **source/target** images + PostgreSQL — **точные** image ID из верифицированных release-манифестов (source = текущий production-кандидат, target = следующий релиз; не прежние образы исторической 12/12); (2) **согласованная копия данных** = копия **рабочего** объёма (реальные данные проекта/каталога, не малая синтетика); сохранённые настройки/секреты; (3) снять **baseline** данных/настроек/файлов/истории миграций; (4) `update.mjs preflight` (проверяет rehearsal SHA + точные образы + топологию + историю миграций) → `apply` (под общей блокировкой: пауза, согласованная копия + SHA, migrate точными образами catalog→feature-flags→rag-sync, запуск с заранее проверенными image ID, смена только NEUROCENTER_RELEASE); (5) **повтор** того же плана (без повторной копии/миграций) + **контролируемый отказ** (неправильная SHA / несовместимость) → следующие этапы **не** запускаются; (6) при несовместимости — **restore согласованного комплекта в новый проект с прежними образами** (recovery.mjs verify+restore); (7) SHA-квитанция репетиции = **точные image ID текущего плана** (все 5 признаков rehearsal=true: passed/copyOfData/settingsPreserved/repeatSafe/restoreVerified); настройки/данные сохранены; **authenticated smoke** (локальный auth как interim — Blitz после пилота, эпик 3) + **допустимые сроки** → DR-evidence (entry 2, scenario=upd-rehearsal).

## Boundaries & Constraints

**Always:**
- source/target images — **точные** image ID из верифицированных release-манифестов (source = текущий кандидат, target = следующий); `rehearsal` (update.mjs:140) требует `sameImages(report.sourceImages/targetImages, plan)`.
- Копия данных = **рабочий объём** (реальные данные), не малая синтетика (production-update.md:87).
- Rепетиция — на **новом** Compose-проекте из согласованной копии (production-update.md:17), **до** production; production-gate не ослабляется.
- Preflight — read-only (временные контейнеры точных образов без сети/секретов, без DDL/копирования; update.mjs:176/:81).
- Apply — под общей maintenance-блокировкой; backup-копия + SHA всех файлов; migrate catalog→feature-flags→rag-sync точными образами; запуск с заранее проверенными image ID; сборка/pull запрещены (production-update.md:85).
- SHA-квитанция репетиции = **точные image ID текущего плана** (5 признаков rehearsal=true).
- Отказ (неправильная SHA / несовместимость) — **останавливает** следующие этапы; restore = новый проект с **прежними** образами.
- Измеренные сроки (пауза/RTO-аналог) + authenticated smoke → DR-evidence (entry 2, upd-rehearsal).

**Never:**
- Не использовать **прежние** образы исторической 12/12-репетиции (production-update.md:87/:138) — нужны точные актуальные.
- Не запускать старое приложение поверх изменённой схемы (production-update.md:85/:97); in-place rollback **не существует** — только restore-new-project (AD-OP-3, update plan rollback=restore-new-project).
- Не повторять уже завершённые операции (повтор того же плана только проверяет результат, не создаёт копию — production-update.md:89).
- Не подменять/удалять SHA-квитанцию ради обхода preflight (production-update.md:132: «Ошибочная SHA-квитанция отклонена настоящим preflight»).
- Не менять PostgreSQL/секреты/домены/тома оркестратором (отклоняются — production-update.md:13).
- Не использовать dev-обходы; authenticated smoke — на локальном auth как interim (не Blitz).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| EXACT_IMAGES | source/target = точные image ID (release-манифесты) | rehearsal sameImages OK | прежние образы → отказ rehearsal |
| WORKING_COPY | согласованная копия рабочего объёма | copyOfData=true | малая синтетика → не принимает |
| BASELINE | данные/настройки/файлы/миграции до | baseline снят | — |
| PREFLIGHT | plan + rehearsal + точные образы + история миграций | preflight OK (read-only, без DDL) | несовпадение образ/миграций → отказ до паузы |
| APPLY | preflight OK | пауза → копия+SHA → migrate точными → запуск (проверенные ID) → смена NEUROCENTER_RELEASE | — |
| REPEAT | повтор того же плана | только проверка результата (без копии/миграций) | повторное копирование → дефект |
| SHA_TAMPER | изменённая SHA-квитанция | preflight отклоняет | — |
| INCOMPATIBLE | несовместимое изменение | restore согласованного комплекта в **новый** проект с **прежними** образами | in-place rollback → дефект |
| FAILURE_STOP | отказ на этапе | следующие этапы не запускаются; приложения остановлены, PostgreSQL + копия сохранены | — |
| SMOKE_TIMING | после apply | authenticated smoke (локальный auth interim) + измеренные сроки → DR-evidence | smoke fail → NO-GO |

</frozen-after-approval>

## Code Map

**Оркестратор обновления (репетиция/apply):**
- `scripts/production/update.mjs` — `validateUpdatePlan:42` (format neurocenter-update-v1, sourceImages/targetImages 7 app, postgresImage, catalogMigrations, migrationCompatibility, rollback=restore-new-project, rehearsalSha256, maxPauseMs), `assertMigrationPrefix:76` (история = точный префикс), `topology:100` (сравнение без image), `rehearsal:140` (SHA + 5 признаков: passed/copyOfData/settingsPreserved/repeatSafe/restoreVerified + sameImages + postgresImage), `assertLive:160` (healthy + Image == ожидание), `preflightUpdate:176` (read-only: имена/образы/топология/миграции/model_credential_key identity, временные контейнеры без сети/DDL), `updateProduction:289` (журнал + backup-копия+SHA + migrate + запуск + смена NEUROCENTER_RELEASE), `main:497`.
- `scripts/production/schema-migrations.mjs` — `inspectSchemaManifests:37` (опись из pinned-образа), `runSchemaCommands:78` (check/migrate, ready+applied+pending).
- `scripts/production/recovery.mjs` — `verifyBackup`/`restoreProduction:626` (restore согласованного комплекта в новый проект при отказе/несовместимости), `withQuiescedProductionBackup:253` (update держит ту же блокировку, получает управление после проверенной копии).

**Тестовый harness (локальная 12/12-репетиция — базис):**
- `scripts/test/production-update-stack.mjs` — `createSide:112` (изолированный стек), `fingerprint:167` (SHA публичных таблиц/файлов), `assertPreserved:180` (данные/настройки сохранены), `assertTargetSchemas:198`, `filesFingerprint:218`, `verifyFilesOffline:230`, `restore:237` (restore в ещё один проект с прежними образами), `cleanupSide:248`. **Текущий harness требует 7 приложений и новый прогон** (production-update.md:128/:138).
- `scripts/test/production-update-interruption.fixture.mjs` — прерывание/отказ.
- `scripts/test/production-update.test.mjs` — unit оркестратора.

**Release-манифест (точные образы):**
- `scripts/production/release-manifest.mjs` — `buildReleaseManifest:125` (source/target image ID), `verifyReleaseManifest:169`.
- `scripts/production/compose-client.mjs` — `serviceImageIds:235` (image ID), `applicationServices:11-19` (7 сервисов).

**Доки/контр:**
- `docs/production-update.md` — план JSON (`:19-54`), Проверка и запуск (`:62-93`), Ошибка и восстановление (`:95-113`), «Нынешняя 12/12-репетиция … не принимает последующие изменения» (`:87`), Историческая 18 октября (`:126-138`), harness (`:140-149`).
- `docs/implementation-readiness.md:56` (P0-UPD «чего недостаёт») + `:83-87` (сценарий «P0-UPD — принять актуальное обновление», Завершение `:87`).
- `_bmad-output/.../architecture-operational/architecture-operational.md:47-51` (AD-OP-3: upgrade-модель, rehearsal на копии данных, критерии готовности).

## Tasks & Acceptance

**Execution:**
- [ ] HITL-ранбук `docs/p0-upd-rehearsal.md` (new) — пошаговый: сборка/выбор source/target release-манифестов (точные image ID), создание согласованной копии рабочего объёма, снятие baseline, репетиция на новом проекте (rehearsal 5 признаков), preflight/apply, повтор, контролируемый отказ, restore при несовместимости, authenticated smoke + сроки → DR-evidence. HITL-точки явно.
- [ ] (hitl=false часть) Обновить `scripts/test/production-update-stack.mjs` для **7 приложений** + точных актуальных образов (production-update.md:128/:138: «Текущий harness требует семь приложений и новый прогон»); убедиться что локальный прогон (на синтетике, но с точной топологией 7 app) зелёный **до** целевой репетиции.
- [ ] Репетиция на копии рабочего объёма (HITL): source/target точные образы → согласованная копия рабочего объёма → baseline → rehearsal (5 признаков) → preflight → apply → повтор (без копии) → контролируемый отказ (SHA/несовместимость) → restore в новый проект с прежними образами → authenticated smoke (локальный auth interim) + сроки → DR-evidence (upd-rehearsal).
- [ ] Записать DR-evidence (entry 2) scenario=upd-rehearsal: measured pause/сроки, source/target image ID, smoke, settingsPreserved.
- [ ] Обновить `docs/implementation-readiness.md` P0-UPD → «пройдено» со свидетельством.

**Acceptance Criteria:**
- Given source/target = точные image ID (release-манифесты), when rehearsal, then sameImages OK (5 признаков=true), **не** прежние образы 12/12.
- Given согласованная копия **рабочего** объёма, when rehearsal, then copyOfData=true, settingsPreserved=true.
- Given baseline, when preflight, then OK (read-only, без DDL/копирования); несовпадение образов/миграций → отказ до паузы.
- Given preflight OK, when apply, then пауза → копия+SHA → migrate точными образами (catalog→ff→rag) → запуск с проверенными image ID → смена только NEUROCENTER_RELEASE; данные/настройки сохранены.
- Given повтор того же плана, when repeat, then только проверка результата (без повторной копии/миграций).
- Given изменённая SHA / несовместимость, when preflight/apply, then отказ, следующие этапы не запускаются; restore согласованного комплекта в **новый** проект с **прежними** образами (restoreVerified=true).
- Given после apply, when authenticated smoke (локальный auth interim) + измеренные сроки, then smoke успешен, сроки в DR-evidence (upd-rehearsal); RTO-аналог ≤ допустимого.
- SHA-квитанция репетиции = точные image ID текущего плана; P0-UPD в readiness → «пройдено».

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Разрыв с исторической 12/12.** Историческая репетиция (production-update.md:126-138) — 6 app, малая синтетика, **прежние** образы (verify-20261018-v09-final → p0-20261018-final-6e31). Она **не принимает** последующие frontend/backend-изменения и 7-й сервис (feature-flags-service). Entry 5 = та же механика (update.mjs), но **7 app + точные актуальные образы + рабочий объём**. Механика не меняется — меняется вход (образы/объём) и harness.

2. **HITL + небольшой hitl=false код.** Основная работа — HITL-репетиция. hitl=false часть: обновление `production-update-stack.mjs` под 7 app + точных образов (production-update.md:128 явно требует «новый прогон»). Это локальный прогон на синтетике, но с правильной топологией — до доказательств целевой репетиции.

3. **Rollback = restore-new-project (in-place не существует).** AD-OP-3 (architecture-operational.md:51): «rollback = **только restore-new-project** (in-place rollback не существует — зафиксировано)». Plan `rollback: restore-new-project`. При несовместимости/отказе — `recovery.mjs verify`+`restore` согласованной копии в новый проект с **прежними** образами + прежней конфигурацией (production-update.md:99-113).

4. **authenticated smoke = локальный auth (interim).** Как и в entry 4, «authenticated smoke» — на локальном auth как interim-конфигурация (Blitz — эпик 3, после пилота). readiness:85 упоминает «результаты P0-S3/P0-SSO для полного прикладного smoke» — P0-SSO (Blitz) после пилота, поэтому smoke = локальный auth + результаты P0-S3 (entry 4).

5. **Зависимость от entry 4 (P0-S3).** readiness:85: P0-UPD предпосылки включают «результаты P0-S3/P0-SSO для полного прикладного smoke». P0-S3 (entry 4) даёт доказательство restore + smoke; P0-SSO — после пилота (эпик 3). after=[2,4].

## Verification

**Commands:** (Node 24: `~/.nvm/versions/node/v24.22.0/bin/node`; целевой сервер + Docker + точные образы)
- Локальный harness (hitl=false): `node --test scripts/test/production-update.test.mjs` -- expected: unit оркестратора зелёные
- Локальный harness (7 app, точная топология): `NEUROCENTER_UPDATE_SOURCE_RELEASE=<source> NEUROCENTER_UPDATE_TARGET_RELEASE=<target> NEUROCENTER_TEST_EVIDENCE=.run/p0-upd node scripts/test/production-update-stack.mjs` -- expected: rehearsal 5 признаков, apply, repeat, restore — зелёные (синтетика, но 7 app + точные ID)
- **HITL (копия рабочего объёма):** создать согласованную копию рабочего объёма → baseline → rehearsal (5 признаков, точные image ID) → preflight → apply
  - expected: копия+SHA, migrate точными, запуск с проверенными ID, смена NEUROCENTER_RELEASE; данные/настройки сохранены
- **HITL (повтор/отказ):** повтор того же плана (без копии) + контролируемый отказ (SHA/несовместимость)
  - expected: повтор только проверяет; отказ останавливает следующие этапы; restore в новый проект с прежними образами
- **HITL (smoke/сроки):** authenticated smoke (локальный auth interim) + измеренные сроки → `dr-evidence record --scenario upd-rehearsal`
  - expected: smoke успешен, сроки ≤ допустимого, в DR-evidence
- `docs/implementation-readiness.md` P0-UPD → «пройдено» (свидетельство)

## Open Questions (с рекомендациями)

- **OQ1 — source/target: какие точные релизы?** Рекомендация: source = **текущий** production-кандидат (REL-01, замороженный), target = **следующий** релиз (кандидат после изменений). Оба — верифицированные release-манифесты с точными image ID. Обоснование: «точные актуальные образы» (readiness:56); исторические 12/12-образы не подходят.
- **OQ2 — Рабочий объём: реальные данные или согласованная копия?** Рекомендация: **согласованная копия реального рабочего объёма** (реальные данные проекта/каталога того же размера), не малая синтетика. Обоснование: production-update.md:87 «малая синтетика не принимает последующие изменения»; копируем рабочий объём, репетируем на копии (не на production).
- **OQ3 — Обновить production-update-stack.mjs под 7 app — в этот entry?** Рекомендация: **да** (hitl=false часть, production-update.md:128 явно требует «новый прогон»). Обоснование: без этого нет локального доказательства механики 7 app до целевой репетиции.
- **OQ4 — Контролируемый отказ: какой тип?** Рекомендация: **два** — (a) изменённая SHA-квитанция (preflight отклоняет), (b) несовместимое изменение (restore в новый проект с прежними образами). Обоснование: readiness:86 «повтор и контролируемый отказ … при несовместимости восстановить … с прежними образами».
- **OQ5 — Допустимые сроки: какие пороги?** Рекомендация: maxPauseMs из plan (SLO 60с…24ч, AD-OP-3) + измеренные реальные сроки (пауза/apply/restore) в DR-evidence; пороги фиксирует оператор на целевой нагрузке. Обоснование: production-update.md:134 исторические замеры (36с/26с/33с) — малый стенд, не гарантия рабочего объёма.
