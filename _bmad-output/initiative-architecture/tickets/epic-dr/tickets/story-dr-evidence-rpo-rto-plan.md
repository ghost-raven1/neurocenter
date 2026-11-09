---
title: 'DR evidence: RPO/RTO + отчёт cross-host restore (верифицируемый артефакт)'
type: 'feature'
ticket: '2'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-dr/epic-dr.md'
  - '{project-root}/docs/implementation-readiness.md'
  - '{project-root}/docs/maintenance-schedule.md'
  - '{project-root}/docs/external-backups.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** P0-S3/MNT/UPD и R3 (C3) требуют: «RPO/RTO **измерены репетицией и задокументированы**» (R3, initiative-architecture.md:32; C3 PRD; UJ-5). Сегодня измерений нет как **верифицируемого артефакта**: `maintenance.service.ts` (catalog) считает `externalAgeSeconds`/`rpoExceeded` (maintenance.service.ts:73/:81) для UI-метрик, а `production-update-stack.mjs` (docs/production-update.md:134) фиксирует разрозненные тайминги исторической 12/12-репетиции (36с/26с/33с…) — но единого стандартизованного, machine-verifiable артефакта «RPO/RTO задокументированы», который **потребляет приёмка пилота (эпик 10)**, нет. AD-OP-4 (architecture-operational.md:57): «RPO/RTO — **измеримые цели**: первая измеренная репетиция = baseline, дальше политика в `maintenance_settings`». Без единого инструмента три репетиции (entries 3/4/5) измерят RPO/RTO по-разному, и «задокументированы» не станет проверяемым.

**Approach:** Новый операторский модуль `scripts/production/dr-evidence.mjs` (record/validate/report), который **стандартизирует** DR-замеры и даёт один верифицируемый артефакт: (1) **record** — снимает моменты времени и identity: `dataCreatedAt` (createdAt последнего внешне проверенного комплекта — источник RPO), `verifiedAt`, `restoreStartedAt`/`appsHealthyAt` (источник RTO), data-time/verify-time/restore-time, host identity обоих хостов (source/target: FQDN/UUID/диск), backup ID + SHA описи, image digests (из release-манифеста), storage binding (endpoint/bucket/region/storageId — без ключей); (2) **validate** — strict-схема артефакта, формулы RPO = now − dataCreatedAt, RTO = appsHealthyAt − restoreStartedAt, проверка что RPO ≤ policy.rpoMinutes, отсутствие секретов; (3) **report** — вывод machine-verifiable `dr-evidence.json` (0600) + человекочитаемый `dr-evidence.md` (RPO/RTO, host identity, backup ID/SHA, image digests, data/verify/restore time, smoke-результат). Логика record/validate/report **тестится офлайн** (фиктивные timestamps/identity); реальные цифры заполняются репетициями (entries 3–5). Это артефакт, на который ссылается «RPO/RTO задокументированы» (R3) и который проверяет эпик 10.

## Boundaries & Constraints

**Always:**
- Определения RPO/RTO **совпадают** с действующими: RPO — от `createdAt` внешне проверенного (full SHA readback) комплекта (maintenance.service.ts:73, maintenance-schedule.md:28 «RPO сравнивается с `createdAt` данных последнего комплекта»); RTO — от старта restore до healthy приложений (успешный прикладной smoke).
- Артефакт несёт: RPO, RTO, dataCreatedAt, verifiedAt, restoreStartedAt, appsHealthyAt, host identity (source+target), backup ID + SHA, image digests, storage binding, smoke-результат, policy (rpoMinutes/maxPause).
- Ключи доступа/секреты/пароли **не входят** в артефакт (только несекретная storage binding + identity). Validate отклоняет артефакт с секретоподобными значениями.
- Validate требует `crossHostRestoreVerified` = true **только** при наличии target host identity ≠ source host identity + restore-таймингов (не по upload/readback/локальному Docker-restore — external-backups.md:5/:62).
- Репетиция может записать **несколько** evidence-артефактов (MNT/S3/UPD) — общий формат, разные `scenario` (mnt-slot/s3-crosshost/upd-rehearsal).
- 0600-права, atomic write (паттерн writeReleaseManifest:138).

**Never:**
- Не вычислять RPO/RTO по upload/readback времени или локальному Docker-restore (external-backups.md:5: «Успешный SHA readback подтверждает переданные байты… но не работоспособность после потери исходной площадки»).
- Не дублировать метрики UI (maintenance-metrics.cjs) — evidence = операторский артефакт приёмки, не runtime-gauge.
- Не хранить секреты/ключи в JSON/MD (validate-гейт).
- Не объявлять `crossHostRestoreVerified=true` без target host ≠ source host (external-backups.md:62).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| RECORD_S3 | restore на втором хосте (target≠source), тайминги + identity | dr-evidence.json (RPO/RTO/host/backup ID/SHA/digests/binding) | отсутствие target identity → фэйл |
| RECORD_MNT | успешный слот + измеренная пауза | evidence (scenario=mnt-slot, pause, RPO) | — |
| RECORD_UPD | репетиция обновления (source/target images, тайминги) | evidence (scenario=upd-rehearsal, pause/RTO) | — |
| VALIDATE_RPO | RPO > policy.rpoMinutes | фэйл с указанием RPO и policy | actionable |
| VALIDATE_NO_CROSSHOST | crossHostRestoreVerified=true, но target==source | фэйл (не cross-host) | actionable |
| VALIDATE_NO_SECRET | артефакт с accessKey/паролем | фэйл (секретоподобное значение) | actionable |
| REPORT | валидный артефакт | dr-evidence.md (RPO/RTO, identity, smoke) | — |
| OFFLINE_TEST | фиктивные timestamps/identity | record/validate/report зелёные без docker/S3 | — |

</frozen-after-approval>

## Code Map

**Определения RPO (совместимость):**
- `services/catalog-service/src/maintenance/maintenance.service.ts` — `get:42` (`externalAgeSeconds:73` = now − createdAt внешне проверенного комплекта; `rpoExceeded:81` = age > policy.rpoMinutes). Evidence **повторяет** эту формулу RPO, не изобретает новую.
- `services/shared/maintenance-policy.cjs` — `validateMaintenancePolicy:53` (policy: rpoMinutes, maxPauseMinutes, retention), `defaultPolicy`. Evidence читает `rpoMinutes` для валидации.
- `docs/maintenance-schedule.md:28` — «RPO сравнивается с `createdAt` данных последнего комплекта, подтверждённого полным внешним SHA readback. RTO остаётся целью до измеренной репетиции.»

**Источники identity/SHA/digests:**
- `scripts/production/external-backup.mjs` — `uploadExternalBackup:304` (квитанция: storage ID, backup ID, SHA описи, createdAt/verifiedAt), `externalStorageBinding:30` (maintenance.mjs — несекретная binding endpoint/bucket/region/storageId). Evidence читает квитанцию upload как источник RPO-времени + backup ID/SHA + binding.
- `scripts/production/recovery.mjs` — `restoreProduction:626` (квитанция restore: `restoredAt:767`, `databases`, `durationMs:769`, `applicationsStarted:false:770`), `backupOperation:278` (квитанция backup: `createdAt:488`, `sha256:491`). Evidence читает квитанции backup/restore как источник dataCreatedAt/restoreStartedAt/restore-time.
- `scripts/production/release-manifest.mjs` — `buildReleaseManifest:125` (image digests для артефакта).

**Модель артефакта (паттерны):**
- `scripts/production/release-manifest.mjs` — `validateReleaseManifest:90` (strict-схема + список расхождений), `writeReleaseManifest:138` (atomic 0600), `verifyReleaseManifest:169`. Evidence переиспользует паттерн validate/write.
- `scripts/production/maintenance.mjs` — `validReceipt:42` (проверка квитанции по storageId/backupId), `runMaintenance:351` (квитанции слотов). Источник scenario=mnt-slot.

**Доки/контракт:**
- `docs/external-backups.md:62` — «Отдельно сохранить host identity, image digests, backup ID/SHA, время и прикладные результаты» (это и есть schema evidence-артефакта).
- `docs/implementation-readiness.md:53,69` — P0-S3 «Завершение»: host identities, backup ID/SHA, image digests, время данных/проверки/восстановления, измеренные RPO/RTO, успешный прикладной smoke.
- `_bmad-output/.../architecture-operational/architecture-operational.md:57` (AD-OP-4: «RPO/RTO — измеримые цели: первая измеренная репетиция = baseline»).

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/production/dr-evidence.mjs` (new) — подкоманды: `record --scenario <mnt-slot|s3-crosshost|upd-rehearsal> --from <квитанции backup/restore/upload> --source-host <id> --target-host <id> [--smoke <result>]` (снимает RPO/RTO/identity/SHA/digests/binding → dr-evidence.json), `validate --evidence <file>` (strict-схема + формулы RPO/RTO + no-secret + cross-host-гейт), `report --evidence <file>` (→ dr-evidence.md). Формат `neurocenter-dr-evidence-v1`.
- [ ] Схема артефакта: `{format, scenario, rpoSeconds, rtoSeconds, dataCreatedAt, verifiedAt, restoreStartedAt, appsHealthyAt, sourceHost:{...}, targetHost:{...}, backupId, backupSha256, imageDigests:{...}, storageBinding:{endpoint,bucket,region,storageId}, policy:{rpoMinutes,maxPauseMinutes}, smoke:{login,read,write,settingsMatched}, crossHostRestoreVerified}`.
- [ ] Validate: RPO = now − dataCreatedAt ≤ policy.rpoMinutes; RTO = appsHealthyAt − restoreStartedAt; `crossHostRestoreVerified` только при target≠source + restore-тайминги; reject секретоподобных значений (accessKey/secretKey/password/token).
- [ ] `scripts/test/dr-evidence.test.mjs` (new) — офлайн unit: record (фиктивные квитанции) → валидный артефакт; validate RPO>policy → фэйл; validate cross-host при target==source → фэйл; validate no-secret; report → MD содержит RPO/RTO/identity. Регистрация в `check-tooling-tests.json` + `expectedFiles`.
- [ ] Обновить `docs/implementation-readiness.md` (P0-S3/MNT/UPD) + `docs/production-recovery.md` / `maintenance-schedule.md`: ссылка на dr-evidence как артефакт «RPO/RTO задокументированы».

**Acceptance Criteria:**
- Given квитанции backup+restore+upload с target host ≠ source host, when `dr-evidence record --scenario s3-crosshost`, then dr-evidence.json содержит RPO/RTO, dataCreatedAt/verifiedAt/restoreStartedAt/appsHealthyAt, host identity обоих хостов, backup ID/SHA, image digests, storage binding (без ключей), smoke.
- Given артефакт с RPO > policy.rpoMinutes, when `validate`, then фэйл с указанием RPO и policy.
- Given `crossHostRestoreVerified=true` при target==source, when `validate`, then фэйл (не cross-host).
- Given артефакт с accessKey/паролем, when `validate`, then фэйл (секретоподобное значение).
- Given валидный артефакт, when `report`, then dr-evidence.md содержит RPO/RTO, host identity, backup ID/SHA, image digests, smoke-результат.
- `node --test scripts/test/dr-evidence.test.mjs` — офлайн зелёные без docker/S3; корневой сьют без деградации.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

1. **RPO/RTO — не новые метрики, а операторский артефакт приёмки.** `maintenance-metrics.cjs` (gauge для Prometheus) и `maintenance.service.ts get()` (для UI) уже считают age/rpoExceeded в runtime. Evidence **не дублирует** их — он **фиксирует разовый замер репетиции** (разовые квитанции backup/restore/upload) в проверенный артефакт, который приёмка пилота (эпик 10) сверяет с policy. Разное назначение: runtime-gauge vs приёмочный артефакт.

2. **Один формат на три сценария.** MNT (pause+RPO), S3 (RPO+RTO+cross-host), UPD (pause+RTO) — разные `scenario`, общая схема. Это даёт эпик 10 единый критерий сверки и предотвращает «измерили по-разному». `crossHostRestoreVerified` — только для s3-crosshost.

3. **Источники — существующие квитанции.** Evidence не измеряет сам (не ставит таймеры в backup/restore) — он **читает** квитанции backupOperation (createdAt/sha256), restoreProduction (restoredAt/durationMs), uploadExternalBackup (storageId/backupId/SHA/createdAt/verifiedAt) + identity хостов (оператор передаёт) + smoke-результат. Это минимальная врезка (не менять backup/restore) и гарантирует, что RPO/RTO основаны на реальных квитанциях, а не на ручном вводе.

4. **Baseline (первая репетиция).** AD-OP-4: «первая измеренная репетиция = baseline, дальше политика в maintenance_settings». Первый принятый s3-crosshost evidence = baseline RPO/RTO; значения фиксируются в `maintenance_settings` (policy) оператором после entry 4. Evidence валидирует против действующей policy.

## Verification

**Commands:** (Node 24: `~/.nvm/versions/node/v24.22.0/bin/node`)
- `node scripts/production/dr-evidence.mjs record --scenario s3-crosshost --from <backup.json> --from <restore.json> --from <upload.json> --source-host <id> --target-host <id> --smoke ok` -- expected: dr-evidence.json (RPO/RTO/identity/SHA/digests/binding, без ключей)
- `node scripts/production/dr-evidence.mjs validate --evidence <file>` -- expected: валиден; RPO>policy → фэйл; cross-host при target==source → фэйл; no-secret
- `node scripts/production/dr-evidence.mjs report --evidence <file>` -- expected: dr-evidence.md (RPO/RTO, host identity, backup ID/SHA, image digests, smoke)
- `node --test scripts/test/dr-evidence.test.mjs` -- expected: офлайн unit зелёные (record/validate/report, без docker/S3)
- `node --test scripts/test/maintenance-runner.test.mjs` -- expected: без регрессии (квитанции слотов не сломаны)
- `node scripts/workspace/check.mjs --tooling` -- expected: dr-evidence + тест в tooling-списке, гейт зелёный

## Open Questions (с рекомендациями)

- **OQ1 — Evidence читает квитанции или сам ставит таймеры?** Рекомендация: **читает существующие квитанции** (backup/restore/upload) + оператор передаёт host identity + smoke. Обоснование: минимальная врезка, RPO/RTO на реальных квитанциях, не меняем backup/restore. Альтернатива (сам замер) — только если квитанции не несут нужных моментов времени (сверить в dev).
- **OQ2 — Host identity: что считать «другим хостом»?** Рекомендация: FQDN + machine-id (или UUID) + диск/hostname; `target≠source` по FQDN/machine-id. Обоснование: external-backups.md:62 «host identity»; достаточно для проверки cross-host без криптографии.
- **OQ3 — Где хранить принятые evidence-артефакты (baseline)?** Рекомендация: в `NEUROCENTER_TEST_EVIDENCE` (паттерн 1.13/production-update-stack) + копия в приватном каталоге оператора; baseline RPO/RTO фиксируется в `maintenance_settings` (policy) после entry 4.
- **OQ4 — RTO для UPD/MNT (где нет полного restore)?** Рекомендация: для UPD/MNT RTO = pause (остановка → возврат приложений) + время повторного запуска; `crossHostRestoreVerified` не применяется. RTO cross-host (полный restore) — только s3-crosshost.
