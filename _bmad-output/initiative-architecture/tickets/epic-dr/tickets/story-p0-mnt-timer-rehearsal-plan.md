---
title: 'P0-MNT: репетиция maintenance-таймера (успешный слот + отказ + повтор)'
type: 'feature'
ticket: '3'
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
  - '{project-root}/docs/maintenance-schedule.md'
  - '{project-root}/docs/external-backups.md'
  - '{project-root}/docs/implementation-readiness.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** P0-MNT (P0-блокер, R1) в readiness (implementation-readiness.md:52) реализован («Есть политика, timezone/окна, CAS, аудит, runner, nextRunAt и возраст внешней копии; runbook, UI S23»), но **не принят**: «Включённый таймер целевого сервера; реальные успешный слот, отказ и повтор; измеренные пауза/RPO/RTO». То есть код maintenance (runner, policy, CAS, аудит, UI, метрики) существует, но на **целевом production-кандидате** никогда не прогонялся реальный цикл: включённый systemd-таймер → успешный внешний слот (с SHA readback) → отказ доставки → повтор по прежней квитанции. До этой репетиции P0-MNT не закрыт, и «maintenance-таймер реален (успешный слот + отказ + повтор, измеренные пауза/RPO/RTO)» (эпик epic-dr.md:17) не доказано.

**Approach:** HITL-репетиция на **целевом production-кандидате** (замороженный релиз, entry 1/5 предпосылка) по runbook `maintenance-schedule.md` + `deploy/maintenance/neurocenter-maintenance.{service,timer}`: (1) оператор включает systemd-таймер (OnCalendar每分钟, Persistent) на целевом сервере; (2) главный администратор сохраняет политику через UI/API (PATCH `/api/maintenance/policy`, CAS expectedRevision, аудит `maintenance.policy.update`) — проверить 409 двух черновиков и запрет остальных ролей; (3) дождаться/инициировать **успешный слот**: runner (maintenance.mjs tick) создаёт quiesced комплект, возвращает приложения, делает внешнюю доставку на S3 + full SHA readback, пишет квитанцию в maintenance_runs (state=succeeded, receipt.verification=sha256-readback); (4) **отказ доставки** (оператор отключает S3/порт) → следующий тик **повторяет** по прежней квитанции **без новой паузы** и **без двойного успешного слота**; (5) **измерить** паузу (остановка→возврат приложений) + RPO (createdAt внешне проверенного комплекта) → записать в DR-evidence (entry 2). SIGKILL/running разбирается оператором вручную (без авто-снятия чужой блокировки — maintenance-schedule.md:24).

## Boundaries & Constraints

**Always:**
- Репетиция на **целевом production-кандидате** (замороженный релиз, точные образы) — не на dev/синтетике.
- Таймер включается штатным systemd (deploy/maintenance units), `User=neurocenter-operator`, `EnvironmentFile=/etc/neurocenter/maintenance.env` (S3-креденшелы в закрытом окружении, не в репо/UI/аудите).
- Политика сохраняется **главным администратором** (requireMain, maintenance.controller.ts:30); CAS по expectedRevision; аудит `maintenance.policy.update` в одной транзакции с политикой.
- Успешный слот = quiesced комплект (все БД + 4 тома) + внешняя доставка + **full SHA readback** (локальный дамп не учитывается как внешняя копия — maintenance-schedule.md:20).
- Повтор после отказа — по **прежней квитанции** (та же публичная binding endpoint/bucket/region/storageId), без нового стоп-окна (maintenance-schedule.md:22).
- Пауза ≤ maxPauseMinutes (policy); полная реальная длительность паузы (включая секунды тика) — в одном разрешённом окне (maintenance-schedule.md:34).
- Измерения (пауза/RPO) — в DR-evidence (entry 2), scenario=mnt-slot.

**Never:**
- Не снимать автоматически чужую/зависшую maintenance-блокировку (SIGKILL/running — только оператор, maintenance-schedule.md:24, recovery.md:117).
- Не менять retention-значения в UI как «настроенный bucket» — retention обеспечивается политикой независимого S3, CLI не удаляет внешние копии (maintenance-schedule.md:28).
- Не использовать dev/обходные auth (production fail-closed, AD-OP-5); вход/админ — настоящая роль главного администратора (локальный auth как interim — Blitz после пилота, эпик 3).
- Не объявлять P0-MNT пройденным по локальному Docker-прогону — нужен целевой сервер + реальный S3.
- Не нарушать окно: пропущенный запуск догоняется только в тот же локальный день и при достаточном окне (maintenance-schedule.md:3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| TIMER_ENABLED | systemd-таймер активен, Persistent | тик раз в минуту, nextRunAt виден в UI/метриках | таймер не активен → явное |
| POLICY_SAVE_MAIN | главный админ, expectedRevision | политика сохранена, ревизия+1, аудит maintenance.policy.update | — |
| POLICY_CONFLICT | два черновика, разная ревизия | второй получает 409 | — |
| POLICY_FORBIDDEN | не-главный-админ роль | 403 (requireMain) | — |
| SUCCESS_SLOT | допустимое окно, S3 доступен | quiesced комплект + внешняя доставка + SHA readback; maintenance_runs state=succeeded, verification=sha256-readback; приложения возвращены | — |
| DELIVERY_FAIL | S3 недоступен в слоте | локальная квитанция сохраняет путь+SHA; следующий тик повторяет **без новой паузы** | — |
| RETRY_NO_DOUBLE | повтор по прежней квитанции | один успешный слот (квитанция последнего успешного в БД предотвращает повтор) | двойной слот → дефект |
| PAUSE_MEASURED | успешный слот | измеренная пауза ≤ maxPauseMinutes; в DR-evidence (mnt-slot) | пауза > max → MAINTENANCE_PAUSE_EXCEEDED |
| SIGKILL_RUNNING | kill runner в работе | slot=running; авто-захват запрещён; оператор разбирает вручную | авто-снятие блокировки → дефект |
| RPO_MEASURED | внешне проверенный комплект | RPO = now − createdAt ≤ rpoMinutes; в DR-evidence | RPO > rpo → neurocenter_backup_rpo_exceeded |

</frozen-after-approval>

## Code Map

**Runner (тик/слот/повтор):**
- `scripts/production/maintenance.mjs` — `maintenanceTick:61` (атомарный claim: ревизия, единственный running, отсутствие успешного слота; повтор ≤ 5 мин), `externalStorageBinding:30` (несекретная binding), `validReceipt:42` (проверка квитанции по storageId/backupId), `maintenanceFeatureAdmission:151`, `runnerLedger:206` (локальный ledger, удаление старых после внешнего подтверждения), `createMaintenanceStore:292` (maintenance_runs), `runMaintenance:351` (CLI tick), `main:403`.
- `services/shared/maintenance-policy.cjs` — `validateMaintenancePolicy:53` (policy: дни/окна/timezone/maxPauseMinutes/retention/rpoMinutes), `nextMaintenanceRun:156`, `dueMaintenanceRun:177`, `inWindow:38`, `defaultPolicy`.

**API/аудит (политика):**
- `services/catalog-service/src/maintenance/maintenance.controller.ts` — `MaintenanceController:9` (`@Controller('api/maintenance')`), `get:20`, `save:25` (PATCH policy), `requireMain:30` (роль «Главный админ» + claims).
- `services/catalog-service/src/maintenance/maintenance.service.ts` — `save:85` (CAS expectedRevision, `maintenance.policy.update` в securityEvent, одна транзакция), `get:42` (nextRunAt/external/externalAgeSeconds/rpoExceeded/runs), `onModuleInit:21` (метрики каждые 30с).
- `services/shared/maintenance-metrics.cjs` — `renderMaintenanceMetrics:14` (neurocenter_backup_status_available/external_backup_verified/rpo_exceeded/last_run_failed).

**Система/таймер:**
- `deploy/maintenance/neurocenter-maintenance.timer` (OnCalendar=`*-*-* *:*:00`, Persistent=true) + `neurocenter-maintenance.service` (ExecStart=`maintenance.mjs tick`, User=neurocenter-operator, EnvironmentFile=/etc/neurocenter/maintenance.env, TimeoutStartSec=6h).

**Внешняя доставка (S3):**
- `scripts/production/external-backup.mjs` — `uploadExternalBackup:304` (full SHA readback, manifest последним), `downloadExternalBackup:423`. Квитанция upload = источник RPO-времени (entry 2).

**Тестовые фикстуры (локальная проверка механики перед HITL):**
- `scripts/test/maintenance-runner.test.mjs` (396 строк) — runner-механика (claim/повтор/ledger).
- `scripts/test/production-maintenance.fixture.mjs` — `verifyProductionMaintenance:4` (политика/слот), `verifyProductionMaintenancePermissions:105` (409/запрет ролей), `verifyProductionCapacityAdmission:137`.
- `scripts/test/production-backups.fixture.mjs` — fixture бэкапов.

**Доки/контракт:**
- `docs/maintenance-schedule.md` — runbook (Runner на production-сервере `:7-24`, Границы приёмки `:26-34`).
- `docs/implementation-readiness.md:52` (P0-MNT «чего недостаёт») + `:59-63` (сценарий «P0-MNT — проверить работу обслуживания», Завершение `:63`).
- `_bmad-output/.../architecture-operational/architecture-operational.md:57` (AD-OP-4: backup lock TTL + auto-release по heartbeat — сейчас ручное после краха; RPO/RTO измеримые цели).

## Tasks & Acceptance

**Execution:**
- [ ] HITL-ранбук `docs/p0-mnt-rehearsal.md` (new) — пошаговый: включение systemd-таймера на целевом сервере (units, EnvironmentFile, права Docker), сохранение политики главным администратором, ожидание/инициация успешного слота, индукция отказа доставки (отключить S3), проверка повтора, разбор SIGKILL/running, измерение паузы/RPO → DR-evidence. HITL-точки явно.
- [ ] (Опционально, hitl=false часть) Убедиться что `maintenance-runner.test.mjs` + `production-maintenance.fixture.mjs` покрывают claim/повтор/409/запрет ролей **офлайн** (локальная проверка механики перед целевой репетицией); при пробелах — добрать фикстуры (без изменения runner).
- [ ] Репетиция на целевом кандидате (HITL): включить таймер → политика (главный админ, 409 двух черновиков, запрет ролей) → успешный слот (SHA readback) → отказ доставки → повтор (без новой паузы, без двойного слота) → измерить паузу/RPO → DR-evidence (mnt-slot).
- [ ] Записать DR-evidence (entry 2) scenario=mnt-slot: измеренная пауза, RPO, nextRunAt, policy/CAS/аудит.
- [ ] Обновить `docs/implementation-readiness.md` P0-MNT → «пройдено» со свидетельством (дата, кандидат, тайминги).

**Acceptance Criteria:**
- Given целевой production-кандидат с включённым systemd-таймером, when политика сохранена главным администратором, then ревизия+1 + аудит maintenance.policy.update; второй черновик → 409; не-главный-админ → 403.
- Given допустимое окно и доступный S3, when успешный слот, then quiesced комплект + внешняя доставка + full SHA readback; maintenance_runs state=succeeded, verification=sha256-readback; приложения возвращены; пауза ≤ maxPauseMinutes.
- Given отказ доставки в слоте, when следующий тик, then повтор по прежней квитанции **без новой паузы** и **без двойного успешного слота** (один успешный слот в БД).
- Given SIGKILL/running, when слот в running, then авто-захват запрещён; оператор разбирает вручную (без авто-снятия чужой блокировки).
- Given внешне проверенный комплект, when RPO, then RPO = now − createdAt ≤ rpoMinutes; пауза/RPO записаны в DR-evidence (mnt-slot).
- P0-MNT в implementation-readiness.md помечен пройденным со свидетельством.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Репетиция = HITL, код уже есть.** Механика (runner/claim/повтор/ledger/CAS/аудит/метрики) реализована и покрыта `maintenance-runner.test.mjs` + `production-maintenance.fixture.mjs`. Entry 3 **не пишет новый runner-код** — он **запускает** существующий цикл на целевом сервере с реальным S3 и фиксирует свидетельства. Единственный возможный hitl=false код — добор офлайн-фикстур при пробелах (claim/повтор/409/запрет).

2. **Пауза ≠ RTO ≠ RPO.** Пауза (остановка→возврат приложений) — ограничена maxPauseMinutes (policy) и измеряется в слоте. RPO = now − createdAt внешне проверенного комплекта (maintenance.service.ts:73). RTO (полный restore) — не для MNT (только S3 cross-host, entry 4). DR-evidence (entry 2) для mnt-slot фиксирует паузу + RPO.

3. **Отказ + повтор — ключевой сценарий.** readiness:59 требует «повтор должен использовать прежний комплект без новой паузы и без двойного успешного слота». Это проверяет `runnerLedger:206` (повтор по квитанции) + «квитанция последнего успешного слота в БД предотвращает его повтор» (maintenance-schedule.md:22). Индуцируется отключением S3 (не убийством runner — это отдельный SIGKILL-кейс).

4. **SIGKILL/running — только оператор.** AD-OP-4 (:57) отмечает: «сейчас — ручное освобождение после краша». Авто-снимание чужой блокировки **запрещено** (recovery.md:117, maintenance-schedule.md:24). Репетиция проверяет, что авто-захват running-слота **не** происходит.

5. **Зависимость от целевого кандидата + S3.** Нужны: замороженный production-кандидат (REL-01, entry 1/5), реальный независимый S3 (entry 4 инфра), включённый systemd-таймер. Это HITL — оператор + QA.

## Verification

**Commands:** (Node 24: `~/.nvm/versions/node/v24.22.0/bin/node`; целевой сервер + Docker + S3)
- Локальная механика (hitl=false): `node --test scripts/test/maintenance-runner.test.mjs` -- expected: claim/повтор/ledger зелёные
- Локальная механика: `node --test scripts/test/production-maintenance.fixture.mjs` (через production-stack) -- expected: политика/409/запрет ролей/слот зелёные
- **HITL (целевой сервер):** включить systemd-таймер → `systemctl status neurocenter-maintenance.timer` (active) → политика (главный админ) → успешный слот (SHA readback) → отказ S3 → повтор → измерить паузу/RPO
  - expected: `maintenance_runs` state=succeeded + verification=sha256-readback; повтор без новой паузы; один успешный слот; пауза ≤ maxPause
- **HITL:** `node scripts/production/dr-evidence.mjs record --scenario mnt-slot ...` -- expected: evidence (пауза/RPO/nextRunAt/policy-аудит)
- Сверка UI: nextRunAt, возраст внешней копии, neurocenter_backup_* метрики (metrics:14)
- `docs/implementation-readiness.md` P0-MNT → «пройдено» (свидетельство)

## Open Questions (с рекомендациями)

- **OQ1 — Как индуцировать «отказ доставки» детерминированно?** Рекомендация: отключить доступ runner'а к S3 (firewall/отключить порт/сменить endpoint на недоступный) на один слот, не убивая runner. Обоснование: проверяет путь «локальная квитанция → повтор без новой паузы» (maintenance-schedule.md:22), а не crash-путь. SIGKILL — отдельный кейс (OQ3).
- **OQ2 — Дожидаться календарного слота или инициировать вручную?** Рекомендация: для репетиции — **инициировать** тик вручную (`maintenance.mjs tick`) в разрешённом окне + один реальный календарный тик (доказательство таймера). Обоснование: календарное ожидание может занять день; ручной тик доказывает механику, один календарный — что таймер реален.
- **OQ3 — SIGKILL/running — в эту репетицию или отдельно?** Рекомендация: **в эту** (readiness:59 упоминает), но как отдельный задокументированный шаг: kill runner в работе → проверить что авто-захват **не** происходит → оператор разбирает вручную. Обоснование: это часть «реальных … отказ и повтор» + AD-OP-4 (ручное освобождение).
- **OQ4 — Целевой сервер = тот же хост, что и entry 4?** Рекомендация: **да**, репетиции MNT и S3 на одном целевом кандидате (экономия инфраструктуры); S3-бандл/restore (entry 4) — отдельный сценарий. Обоснование: один production-кандидат + один независимый S3 покрывают обе репетиции.
