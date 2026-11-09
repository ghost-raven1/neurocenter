---
title: 'DR sweep + e2e-приёмка (P0-S3/MNT/UPD + RPO/RTO, UJ-5)'
type: 'feature'
ticket: '6'
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
  - '{project-root}/docs/implementation-readiness.md'
  - '{project-root}/_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md'
  - '{project-root}/_bmad-output/initiative-architecture/.memlog.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Эпик epic-dr закрыт по частям (4.1–4.5), но ни одна линия не доказала **целиком**, что P0-S3/MNT/UPD закрыты приёмками и RPO/RTO задокументированы как единый проверяемый результат. Каждая часть проверена изолированно: 4.1 (image-bundle — локальная self-sufficiency), 4.2 (DR-evidence — офлайн), 4.3 (P0-MNT — целевой таймер), 4.4 (P0-S3 cross-host — независимый S3 + 2-й хост), 4.5 (P0-UPD — копия рабочего объёма + точные образы). Но **связка** «quiesced backup → независимый S3 → cross-host restore → вход/чтение/запись → измеренные RPO/RTO ≤ заявленных → UJ-5 как записан» (C3, R3, R12) **не доказана как единая приёмка** — а именно её ждёт эпик 10 (пилот, `after: {epic 4, needs: P0-S3/MNT/UPD и RPO/RTO}`) и волна 2. Плюс накоплены отложенные cleanup-находки (dead code после dr-images/dr-evidence, осиротевшие доки/фикстуры), которые эпик не закрыл.

**Approach:** Финальный entry = **sweep + e2e-приёмка** (паттерн 1.12/1.13): (1) **Refactor sweep** (cleanup only) — скоуп устанавливается на старте по планам 4.1–4.5 и review-находкам, которые эпик отложил (dead code после dr-images.mjs/dr-evidence.mjs, осиротевшие комментарии/доки/фикстуры, дубли); скоуп, вытесненный из другой сторис — новая сторис, не сюда. (2) **E2E-приёмка** — единая линия, сверяющая **все** доказательства: P0-MNT (4.3: таймер + успешный слот + отказ/повтор + пауза/RPO), P0-S3 cross-host (4.4: независимый S3 + 2-й хост + restore + smoke + RPO/RTO + crossHostRestoreVerified), P0-UPD (4.5: копия рабочего объёма + точные образы + rehearsal + restore + smoke); **RPO/RTO** измерены репетицией и **задокументированы** (4.2 артефакт, baseline в maintenance_settings), **не превышают заявленных** (R3 counter: «восстановление дольше заявленного RTO»); **UJ-5 работает как записан** (PRD:86: quiesced backup → независимый S3 → restore чистого стека на другом хосте → вход/чтение/запись); DR-бандл собирается из текущего compose; **новые compose-сервисы эпика 6** (prometheus/alertmanager) **не** здесь — подхватываются на **финальном** restore при приёмке пилота (эпик 10, epic-dr.md:17). Вывод — единый приёмочный отчёт `dr-acceptance.json`/`.md` (сигнал GO/NO-GO для P0-S3/MNT/UPD, PRD C1).

## Boundaries & Constraints

**Always:**
- Sweep = **cleanup only** (dead code/комментарии/доки/дубли после 4.1–4.5); **не** новая функциональность, **не** изменения поведения.
- E2E-приёмка **сверяет** доказательства 4.3/4.4/4.5 (не переделывает репетиции): timer-run/квитанции, cross-host evidence, upd-rehearsal evidence.
- RPO/RTO — из **задокументированного** артефакта (4.2), baseline в `maintenance_settings`; сверка «≤ заявленных» (policy).
- UJ-5 — как записан (PRD:86); вход/чтение/запись на восстановленном стеке.
- Новый артефакт — `dr-acceptance.json` (machine-verifiable) + `dr-acceptance.md` (человекочитаемый) в `NEUROCENTER_TEST_EVIDENCE`; без секретов.
- Приватные значения .env/секретов в отчёте НЕ раскрываются.
- Тесты/сборка — `~/.nvm/versions/node/v24.22.0/bin/node`.

**Never:**
- Не добавлять функциональность под видом sweep (скоуп, вытесненный из другой сторис — новая сторис).
- Не переделывать репетиции 4.3/4.4/4.5 — приёмка **сверяет** их доказательства (если доказательство отсутствует/устарело — возврат в соответствующий entry, не скрытие).
- Не включать сервисы эпика 6 (prometheus/alertmanager) в эту репетицию (эпик 10, финальный restore).
- Не ослаблять production-gate / подменять SHA-квитанции ради GO.
- Не раскрывать секреты в артефакте (validate-гейт, как в 4.2).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| SWEEP | dead code/доки/фикстуры после 4.1–4.5 | cleanup, поведение не изменилось | — |
| E2E_MNT | доказательства 4.3 (timer/слот/отказ/повтор/пауза/RPO) | сверено, P0-MNT пройден | отсутствует/устарело → возврат 4.3 |
| E2E_S3 | доказательства 4.4 (cross-host evidence, crossHostRestoreVerified) | сверено, P0-S3 пройден | target==source / RTO>заявленного → NO-GO |
| E2E_UPD | доказательства 4.5 (rehearsal 5 признаков, точные образы, smoke) | сверено, P0-UPD пройден | прежние образы / smoke fail → NO-GO |
| RPO_RTO_DOC | артефакт 4.2 + baseline в policy | RPO/RTO ≤ заявленных, задокументированы | RTO > заявленного → NO-GO (R3 counter) |
| UJ5 | восстановленный стек (4.4) | вход/чтение/запись как записан | — |
| REPORT | все доказательства | dr-acceptance.json/.md (GO/NO-GO, P0-S3/MNT/UPD, RPO/RTO, UJ-5) | — |

</frozen-after-approval>

## Code Map

**Свёрка доказательств (entries 3–5):**
- `scripts/production/dr-evidence.mjs` (4.2) — `validate`/`report` (схема `neurocenter-dr-evidence-v1`, RPO/RTO, no-secret, cross-host-гейт). Приёмка **читает** evidence-артефакты mnt-slot/s3-crosshost/upd-rehearsal.
- `scripts/production/dr-images.mjs` (4.1) — `verify` (image-bundle == release-манифест).
- `scripts/production/maintenance.mjs` — `maintenanceTick:61`, `runnerLedger:206` (доказательства MNT: maintenance_runs, квитанции).
- `scripts/production/recovery.mjs` — `restoreProduction:626` (квитанция cross-host), `backupOperation:278`.
- `scripts/production/update.mjs` — `rehearsal:140`, `updateProduction:289` (квитанции UPD).

**Приёмочный отчёт (новый):**
- `scripts/test/dr-acceptance.mjs` (new, driver) — sweep-чек + e2e-сверка: читает evidence-артефакты 4.3/4.4/4.5 + policy (maintenance_settings) → `dr-acceptance.json`/`.md` (GO/NO-GO). Паттерн 1.13 (`scripts/test/release-candidate-e2e.test.mjs`: offline node:test + CLI-live HITL).
- Регистрация: `scripts/workspace/check-tooling-tests.json` + `expectedFiles` `scripts/test/workspace-check-tooling.test.mjs` (union+sort при мерже — memlog L49/L63/L72/L76).

**Доки/контракт:**
- `docs/implementation-readiness.md` — P0-матрица (`:50-57`), сценарии P0-MNT/S3/UPD (`:59-87`); приёмка помечает P0-S3/MNT/UPD → «пройдено».
- `_bmad-output/.../prd-neurocenter/prd-neurocenter.md:86` (UJ-5), `:28` (C1), `:30` (C3), `:183-191` (Success Metrics: Приёмки, Надёжность RPO/RTO, Скорость restore ≤ RTO).
- `_bmad-output/.../initiative-architecture.md:30-32` (R1/R3), `:41` (R12/UJ-5).
- `_bmad-output/.../architecture-operational/architecture-operational.md:51,53-57` (AD-OP-3/4 критерии готовности).
- `_bmad-output/.../.memlog.md` — прецеденты load-менеджмента (L54/L59/L73), union+sort (L49/L63/L72/L76).

## Tasks & Acceptance

**Execution:**
- [ ] **Refactor sweep** (cleanup only): скоуп на старте по планам 4.1–4.5 + review-находкам (dead code после dr-images.mjs/dr-evidence.mjs, осиротевшие доки/фикстуры/комментарии, дубли). Поведение не меняется.
- [ ] `scripts/test/dr-acceptance.mjs` (new, driver) — e2e-сверка: (E1) P0-MNT (timer/слот/отказ/повтор/пауза/RPO из 4.3), (E2) P0-S3 cross-host (crossHostRestoreVerified + RPO/RTO из 4.4), (E3) P0-UPD (rehearsal 5 признаков + точные образы + smoke из 4.5), (E4) RPO/RTO ≤ заявленных (policy) + задокументированы (4.2), (E5) UJ-5 (вход/чтение/запись на восстановленном стеке); вывод `dr-acceptance.json`/`.md` (GO/NO-GO) в `NEUROCENTER_TEST_EVIDENCE`.
- [ ] HITL-ранбук `docs/dr-acceptance.md` (new) — пошаговый: сборка доказательств, запуск driver, интерпретация GO/NO-GO; HITL-точки явно.
- [ ] Регистрация tooling (check-tooling-tests.json + expectedFiles, union+sort).
- [ ] Обновить `docs/implementation-readiness.md` P0-S3/MNT/UPD → «пройдено» (финальные свидетельства).

**Acceptance Criteria:**
- Given cleanup (sweep), when корневой сьют, then поведение не изменилось (без деградации против baseline); cleanup-список закрыт.
- Given доказательства 4.3 (MNT), when E1, then P0-MNT пройден (таймер/слот/отказ/повтор/пауза/RPO); устарело/отсутствует → возврат 4.3.
- Given доказательства 4.4 (S3 cross-host), when E2, then P0-S3 пройден (crossHostRestoreVerified, RPO/RTO, smoke); target==source или RTO>заявленного → NO-GO.
- Given доказательства 4.5 (UPD), when E3, then P0-UPD пройден (rehearsal 5 признаков, точные образы, smoke); прежние образы/smoke fail → NO-GO.
- Given артефакт 4.2 + baseline в policy, when E4, then RPO/RTO ≤ заявленных и задокументированы; RTO > заявленного → NO-GO (R3 counter).
- Given восстановленный стек (4.4), when E5, then UJ-5 работает как записан (вход/чтение/запись).
- `dr-acceptance.json`/`.md` содержит GO/NO-GO по P0-S3/MNT/UPD + RPO/RTO + UJ-5 (аудирует C1/C3); `check --tooling` зелёный.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Sweep + e2e в одном entry (паттерн 1.12/1.13).** 1.12 = sweep, 1.13 = e2e-приёмка. Здесь объединяем (как разрешено task-описанием: «Последний entry = sweep + e2e-приёмка (hitl=true) по паттерну 1.12/1.13»): sweep зачищает накопленное, e2e доказывает цель эпика целиком. E2E **сверяет** доказательства 4.3/4.4/4.5, не переделывает репетиции.

2. **Приёмка = сигнал GO/NO-GO для волны 2.** tickets.toml эпика 10: `after: {epic 4, needs: "P0-S3/MNT/UPD и RPO/RTO"}`. `dr-acceptance.json` (GO) = формальный сигнал, что волна 2 (эпик 10/пилот) может стартовать. Это «кандидат-приёмка» DR-линии, аналог REL-01 (1.13) для release-линии.

3. **RPO/RTO ≤ заявленных = R3 counter.** R3 (initiative-architecture.md:32): Counter — «восстановление дольше заявленного RTO». E4 сверяет измеренные RPO/RTO (4.2) с baseline/policy (maintenance_settings). Превышение → NO-GO (не «поправим позже»).

4. **Сервисы эпика 6 не здесь.** epic-dr.md:17: «новые compose-сервисы (prometheus/alertmanager — эпик 6) подхватываются на **повторном финальном restore** при приёмке пилота (эпик 10)». Эта репетиция = стек момента эпика (7 app + postgres). Финальный restore **с** сервисами эпика 6 — эпик 10. Не раздувать.

5. **HITL-тяжесть.** E2E требует доступ к доказательствам 4.3/4.4/4.5 (целевой сервер, независимый S3, 2-й хост) — то есть инфраструктуру, подготовленную в 4.3/4.4/4.5. Driver автоматизирует **сверку** (offline, где возможно); **интерпретация GO/NO-GO** — HITL (оператор/QA).

## Verification

**Commands:** (Node 24: `~/.nvm/versions/node/v24.22.0/bin/node`)
- Sweep: корневой сьют (`node scripts/workspace/check.mjs`) -- expected: без деградации против baseline; cleanup-список закрыт
- `node --test scripts/test/dr-acceptance.mjs` (offline-часть: схема отчёта, NO-GO-ветки на фиктивных доказательствах) -- expected: зелёные без docker/S3
- **HITL (e2e):** `node scripts/test/dr-acceptance.mjs --evidence <dir-4.3> <dir-4.4> <dir-4.5> --policy <maintenance_settings>` -- expected: E1–E5 сверены, `dr-acceptance.json`/`.md` = GO (P0-S3/MNT/UPD + RPO/RTO ≤ заявленных + UJ-5)
- **HITL (NO-GO-контроль):** устаревшее/отсутствующее доказательство или RTO>заявленного -- expected: NO-GO с указанием причины
- `node scripts/workspace/check.mjs --tooling` -- expected: dr-acceptance в tooling-списке, гейт зелёный
- `docs/implementation-readiness.md` P0-S3/MNT/UPD → «пройдено» (финальные свидетельства)

## Open Questions (с рекомендациями)

- **OQ1 — Sweep и e2e в одном entry или раздельно?** Рекомендация: **в одном** (task-описание явно: «Последний entry = sweep + e2e-приёмка по паттерну 1.12/1.13»). Обоснование: 1.12/1.13 были раздельно, но здесь sweep малый (после 4.1–4.5) и e2e требует финального состояния — объединение экономит entry.
- **OQ2 — E2E переделывает репетиции или только сверяет?** Рекомендация: **только сверяет** доказательства 4.3/4.4/4.5; если доказательство отсутствует/устарело — возврат в соответствующий entry (не скрытие, не переделка здесь). Обоснование: повторные дорогие HITL-репетиции не должны жить в sweep-entry.
- **OQ3 — GO/NO-GO принимает driver или оператор?** Рекомендация: driver вычисляет **кандидатный** GO/NO-GO (по доказательствам), **оператор/QA** подтверждает финальный (как 1.13 F6: оператор «кандидат принят»). Обоснование: приёмка P0 — продуктовое решение.
- **OQ4 — Fинальный restore с сервисами эпика 6 — сюда или в эпик 10?** Рекомендация: **в эпик 10** (epic-dr.md:17 явно). Обоснование: сервисы эпика 6 ещё не существуют на момент этого эпика; финальный restore с ними — при приёмке пилота.
- **OQ5 — dr-acceptance.json — новый артефакт или расширение dr-evidence?** Рекомендация: **новый** (aggregating-отчёт поверх evidence-артефактов 4.2), не расширение. Обоснование: dr-evidence = замер одного сценария; dr-acceptance = агрегированная приёмка эпика. Разное назначение.
