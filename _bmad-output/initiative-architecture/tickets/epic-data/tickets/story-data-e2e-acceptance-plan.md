---
title: 'DATA-01: e2e-приёмка data-инвариантов на развёрнутом стеке'
type: 'feature'
ticket: '14'
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
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/tickets/epic-data/epic-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Эпик 5 (epic-data, AD-D2..D5) закрыт по частям (entries 1-13), но ни одна data-инвариант не доказана на **развёрнутом production-стеке** целиком: volume map (один write-owner), capacity 7-ресурс (model-weights виден), retention (тик прунит, skill-versions N=2), project deletion (полный каскад + receipt), crash (backup lock auto-release, runtime-artifact SHA), quota (used-bytes правдив после операций), artifact-cache (персистентность + LRU). Каждая часть проверена изолированно (unit/static/свой сегмент), но **связка на живом стеке** (HITL) — нет. DATA-01 — финальная e2e-приёмка data-контура: 6 инвариантов AD-D2..D5 на live-стеке, протокол + артефакты.

**Approach:** e2e-линия `scripts/test/data-invariants-e2e.mjs` (driver) + HITL-ранбук `docs/data-invariants-e2e.md`. 6 фаз (инвариантов) на **развёрнутом production-стеке** (паттерн `production-stack.mjs`: unique compose-проект + fresh volumes + live-чеки): (D1) **Volume map** — drift-тест на live compose: у каждого volume один write-owner (rw), остальные ≤ ro; (D2) **Capacity** — 7 ресурсов, model-weights = фактические байты (statfs); (D3) **Retention** — maintenance-тик прунит fixture-строки старше TTL, skill-versions N=2; (D4) **Project deletion** — полный каскад (RAG-БД + S3 + skills + receipt) на реальном fixture-проекте; (D5) **Crash** — kill -9 бэкап-процесса → auto-release по TTL; kill -9 device при стриме runtime-artifact → SHA-верификация; restart gateway → кэш жив; (D6) **Quota** — used-bytes правдив после операций (RAG-запись, artifact-cache build). Протокол + скриншоты/логи в `tickets/epic-data/` (аудирует DATA-01). HITL: запуск на стеке, kill -9, интерпретация.

## Boundaries & Constraints

**Always:**
- Все 6 инвариантов — на **развёрнутом production-стеке** (не dev, не unit): unique compose-проект + fresh volumes (паттерн `production-stack.mjs`).
- Каждый инвариант: **green** (прошёл) или **red** (баг-тикет, не «потолерировать»).
- Протокол + артефакты (логи, скриншоты, отчёт JSON) — в `tickets/epic-data/` (аудит).
- Crash-сценарии (kill -9) — **HITL** (на живом стеке, осознанно ломаем).
- Node 24 (`~/.nvm/versions/node/v24.22.0/bin/node`).
- Приватные значения (`.env`, секреты) — не раскрывать в плане/артефактах.

**Never:**
- Не править production-код сервисов — DATA-01 **консумирует** артефакты entries 1-13, не пересобирает.
- Не «потолерировать» red-инвариант (red = баг-тикет, эскалация).
- Не запускать crash-сценарии на dev-стеке (только production-стек — иначе не доказано).
- Не дублировать unit-тесты entries 1-13 (e2e = связка на live, не повтор unit).
- Не выполнять деструктивные операции на **реальных** проектах (только fixture-проекты).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|----------|--------------|----------|----------------|
| D1_VOLUME_MAP | live compose после entries 2,4,5,6 | у каждого volume один rw = writeOwner, остальные ≤ ro | 2 rw / нет rw → red (баг-тикет) |
| D2_CAPACITY_7 | live collect() | 7 ресурсов, model-weights = statfs-факт | 6 ресурсов / model-weights=0-ложь → red |
| D3_RETENTION_PRUNE | fixture-строки старше TTL + тик | застарелые удалены, свежие нет; skill-versions N=2 | не прунил / прунил свежие → red |
| D4_PROJECT_DELETION | fixture-проект (RAG-БД + S3 + skills) + DELETE | FK-cascade + RAG DROP + S3 + skills + receipt | домен не удалён / нет receipt → red |
| D5_CRASH_BACKUP_LOCK | kill -9 бэкап-процесса | auto-release по TTL, следующий бэкап стартует | лок вечно → red |
| D5_CRASH_ARTIFACT_SHA | kill -9 device при стриме / битый байт | SHA-верификация: mismatch → файл не активирован | активирован битый → red |
| D5_CRASH_GATEWAY_RESTART | restart gateway | кэш жив (volume персистентен) | кэш потерян → red |
| D6_QUOTA_USED | операции (RAG-запись, artifact build) → GET quota | used-bytes = фактические (± Δ) | used=0 / не соответствует → red |
| EVIDENCE | все фазы | `data-invariants-e2e.json` + протокол в tickets/epic-data/ | неполный отчёт → red |

</frozen-after-approval>

## Code Map

**e2e-harness (переиспользовать, не дублировать):**
- `scripts/test/production-stack.mjs` — **существующий e2e-harness** (build→up→~30 live-чеков; unique project, fresh volumes, `configureProduction`, override-ports, `request()`, fixtures). DATA-01 **переиспользует** его для деплоя + live-доступа; НЕ дублирует.
- `scripts/test/release-candidate-e2e.mjs` (entry 1.13, epic 1) — паттерн driver-фаз + отчёт JSON (F1-F6) — референс структуры.
- `scripts/test/production-backups.fixture.mjs:59-68` — fixture бэкап-лока (расширить под D5 crash).
- `scripts/test/project-profile-delete-db.mjs` — delete-fixture (D4).

**Инварианты (консумируемые артефакты entries 1-13):**
- D1: `scripts/test/volume-map-invariant.test.mjs` (entry 6) — volume map на live compose
- D2: `services/shared/capacity.cjs:4-11` (7 ресурсов), `capacity-collector.cjs` — collect() на live
- D3: `scripts/production/maintenance.mjs:351-402` (runMaintenance), `deploy/production/retention.json` (entry 7), `retention-prune.mjs` (entry 8)
- D4: `services/catalog-service/src/catalog/project-deletion.ts:6-63` (entry 11), `retired-rag.service.ts`, `chat-attachment-storage.ts`
- D5: `backup-storage.ts:38-67` + TTL/heartbeat (entry 10), `runtime-artifact-stream.ts:7-60` + SHA (entry 12), `artifact-cache.ts` (entry 2)
- D6: `project_quota_usage` + accounting API (entry 1), quota API (catalog.controller.ts:112-143,171-197)

**Протокол/артефакты:**
- `docs/data-invariants-e2e.md` (new) — HITL-ранбук: деплой, 6 фаз, kill -9, интерпретация
- `tickets/epic-data/data-invariants-e2e.json` (new) — отчёт (инварианты, результаты, артефакты)
- `_bmad-output/initiative-architecture/architecture-data/architecture-data.md` — AD-D2..D5 (инварианты-цели)

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/test/data-invariants-e2e.mjs` (new, driver) — 6 фаз D1-D6 на live-стеке (паттерн `production-stack.mjs` + `release-candidate-e2e.mjs`); отчёт `data-invariants-e2e.json` в `NEUROCENTER_TEST_EVIDENCE` / tickets/epic-data/
- [ ] D1: вызов `volume-map-invariant` (entry 6) на live compose → 0 drift (один rw-owner per volume)
- [ ] D2: live `collect()` (capacity-collector) → 7 ресурсов, model-weights = statfs (сверка с docker volume)
- [ ] D3: fixture-строки старше TTL (catalog-БД, rag_quota_events) + skill-versions 5 версий → maintenance-тик → prune (застарелые удалены, свежие нет, N=2)
- [ ] D4: fixture-проект (RAG-БД nc_rag_<hash> + S3-объекты + skills-каталог) → DELETE /projects/:id → FK-cascade + RAG DROP + S3 + skills + receipt (per-домен статус)
- [ ] D5-crash: (a) kill -9 бэкап-процесса → ждать TTL → следующий бэкап стартует (auto-release); (b) стрим runtime-artifact + bit-flip/kill -9 → SHA-верификация (mismatch → не активирован); (c) restart gateway → materialize кэша жив
- [ ] D6: fixture-проект → RAG-запись 50МБ + artifact-cache build → GET quota → used = фактические (± Δ)
- [ ] HITL-ранбук `docs/data-invariants-e2e.md` (new) — пошаговый: деплой, 6 фаз, kill -9 (HITL-точки), интерпретация отчёта
- [ ] Регистрация: `scripts/test/check-tooling-tests.json` (driver в tooling-список)

**Acceptance Criteria:**
- Given развёрнутый production-стек, when D1, then у каждого volume один rw = writeOwner (0 drift).
- Given live collect(), when D2, then 7 ресурсов, model-weights = фактические байты (не 0-ложь).
- Given fixture-строки старше TTL + тик, when D3, then застарелые удалены, свежие нет, skill-versions N=2.
- Given fixture-проект (RAG+S3+skills), when D4 (DELETE), then полный каскад + receipt (все домены).
- Given kill -9 бэкап-процесса, when D5, then auto-release по TTL (следующий бэкап стартует); SHA-верификация (битый → не активирован); restart gateway → кэш жив.
- Given операции (RAG+artifact), when D6, then used-bytes = фактические (± Δ).
- Given все фазы, when отчёт, then `data-invariants-e2e.json` + протокол в tickets/epic-data/ (аудирует DATA-01); любой red → баг-тикет (не «потолерировать»).
- `check --tooling` зелёный; корневой сьют — без деградации (driver добавлен, не ломает существующее).

## Implementation Notes

- **Граница с entries 1-13:** DATA-01 не пишет unit-тесты (они в entries) — он **запускает** инварианты на live-стеке и проверяет **связку** (что изолированные фиксы работают вместе в production). Red на live = разрыв связи (баг), не «unit не покрыл».
- **Crash-сценарии = HITL (осознанно ломаем):** kill -9 бэкап-процесса / device / gateway на живом стеке — ресурсоёмко + деструктивно (fixture-проект). Автоматизируем то, что автоматизируется (D1 static, D2 collect, D3 тик, D6 quota); D5-crash + D4 (деструктивный delete) — HITL-ручное на fixture.
- **Fixture-проект, не реальный:** D4/D6 используют **fixture-проект** (unique, fresh volumes) — не реальные проекты. D4-деструкция только на fixture.
- **Почему production-стек (не dev):** data-инварианты (volume mounts, capacity statfs, S3, kill -9) доказуемы только на production-топологии (volumes, network, secrets). Dev-стек не доказывает D1/D2/D5.
- **Отчёт JSON** (паттерн release-candidate-e2e.json): инвариант → результат (green/red) → артефакт (лог/скриншот) → при red: баг-тикет ID. Аудирует DATA-01.

## Verification

**Commands:** (Node 24 обязателен: `~/.nvm/versions/node/v24.22.0/bin/node`)
- `node scripts/test/data-invariants-e2e.mjs` -- expected: D1-D6 зелёные, `data-invariants-e2e.json` записан
- `node scripts/test/data-invariants-e2e.mjs --phase D1` (по фазам, для HITL) -- expected: фаза зелёная
- `node --test scripts/test/production-stack.mjs` (существующий harness) -- expected: без регрессии (DATA-01 не ломает его)
- `node scripts/workspace/check.mjs --tooling` -- expected: driver в tooling-списке, гейт зелёный
- **HITL (D5-crash, главная):** на live-стеке kill -9 бэкап-процесса → ждать TTL → следующий бэкап стартует (auto-release, без офлайн-вмешательства); стрим runtime-artifact + bit-flip → SHA mismatch → не активирован; restart gateway → кэш жив
- **HITL (D4):** fixture-проект (RAG+S3+skills) → DELETE → полный каскад + receipt (все домены green)
- **HITL (отчёт):** `data-invariants-e2e.json` содержит 6 инвариантов + результаты + артефакты; оператор подтверждает «data-контур принят» (DATA-01 GO)

## Open Questions (с рекомендациями)

- **OQ1 — Crash-сценарии: автоматизировать или HITL?** Рекомендация: **HITL** (kill -9 на живом стеке — деструктивно + ресурсоёмко, осознанно ломаем fixture). Автоматизируем D1/D2/D3/D6 (не-деструктивные); D5-crash + D4-delete — HITL-ручное. Обоснование: kill -9 на production-стеке требует осознанного оператора (не cron).
- **OQ2 — Production-стек: реальный деплой или симуляция (unique compose-проект)?** Рекомендация: **симуляция** (паттерн `production-stack.mjs`: unique compose-проект + fresh volumes) — детерминированно, изолированно; реальный production-стек = отдельная HITL-приёмка (если нужен «промышленный» стейтмент). Обоснование: симуляция даёт production-топологию (volumes/network/secrets) без риска для реальных данных.
- **OQ3 — D4 (project deletion) на live: fixture-проект или «реальный»?** Рекомендация: **fixture-проект** (unique, fresh) — деструкция только на fixture. Реальный проект = риск. Обоснование: DATA-01 доказывает **механизм** каскада, не конкретный проект.
- **OQ4 — Артефакты: где хранить (tickets/epic-data/ vs NEUROCENTER_TEST_EVIDENCE)?** Рекомендация: **tickets/epic-data/** (рядом с тикетами, аудит эпика) + копия в evidence-dir. Обоснование: DATA-01 = приёмка эпика, артефакты должны быть с эпиком.
- **OQ5 — Red-инвариант: баг-тикет в epic-data или отдельный?** Рекомендация: **отдельный баг-тикет** (ссылка на DATA-01 + инвариант) в board, не в epic-data (эпик уже закрыт по entries). Обоснование: red = новый дефект, не часть epic-data scope.
