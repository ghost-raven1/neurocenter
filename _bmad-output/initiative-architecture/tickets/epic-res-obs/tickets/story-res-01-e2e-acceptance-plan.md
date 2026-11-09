---
title: 'Sweep + RES-01: e2e-приёмка P0-RES (readiness)'
type: 'feature'
ticket: '15'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-observability/architecture-observability.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
  - docs/implementation-readiness.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Эпик 6 (P0-RES) — «Ресурсы и наблюдаемость». 14 entry строят артефакты (non-root, pids, quota enforcement, two-tier limits, config-модуль, logging/correlation, redaction, metrics, health, error-store, error-UI, prometheus/AM compose, alerting, audit) — но readiness P0-RES (implementation-readiness.md:57,89-95) требует **доказательства на живом стеке**: «Применённые ограничения хранилища, проверка конкурирующих writers/WAL/заполнения и нагрузки; настоящий scrape и доставленные уведомления» + «файл Prometheus rules не является доставленным alert» (:95). RES-01 — e2e-приёмка: (1) sweep (grep-инвентарь по правилам эпика — каждый hit: fix или явный exception), (2) 8 блоков проверки на развёрнутом production-стеке (S26). Закрытие readiness-критерия.

**Approach:** (1) Sweep: grep-инвентарь по правилам эпика (console.* в src; error.message в логах; quota-поля без enforcement; секции лимитов без точки; /health; сервисы вне scrape targets; root-контейнеры; сервисы без pids/user в модели; /ready без budgets из shared) — каждый hit: fix или явный exception (allowlist зафиксирован); (2) RES-01 (HITL) на развёрнутом production-стеке по сценарию readiness P0-RES (S26): 8 блоков — (а) лимиты (quota enforcement, two-tier, hardening: UID≠0, pids_limit, fork-стресс), (б) нагрузка (конкурирующие тяжёлые операции, WAL, нехватка диска → 503/507 без повреждения), (в) scrape (6/6 up=1), (г) алерты (disk/queue/service/stale → доставлено+снято), (д) логи (correlation nginx→gateway→сервис, без ticket/error.message), (е) ошибки (crash → error_events + admin UI), (ж) аудит (admin-мутация → единая история), (з) health (/ready семантика). Протокол + артефакты в tickets/epic-res-obs/.

## Boundaries & Constraints

**Always:**
- RES-01 — на **развёрнутом production-стеке** (compose.production.yml, образы manifest, не dev).
- Каждый блок — с артефактом (лог/скриншот/метрика/значение) в протоколе.
- Любой red = баг-тикет (не «потолерировать»).
- Sweep: 0 необъявленных hits (allowlist зафиксирован).
- HITL: запуск на стеке, вызов условий, интерпретация, GO/NO-GO.

**Never:**
- Не менять production-код сервисов (RES-01 — consumer артефактов entry 1-14, не пересобирает).
- Не обходить --pull never / closed-contour (AD-OP-2/AD-15).
- Не «чинить» red-находку в ходе RES-01 (баг-тикет → фикс → повтор RES-01).
- Не считать «файл rules = доставленный alert» (readiness-критерий :95).

## I/O & Edge-Case Matrix

| # | Блок | Условие/Действие | Ожидаемый результат |
|---|------|-----------------|---------------------|
| S | Sweep | grep по 8 правилам | 0 необъявленных hits (allowlist) |
| а1 | Лимиты: quota | запись сверх retentionBytesLimit | явный отказ (507/503), прежние данные целы, used не изменился |
| а2 | Лимиты: two-tier | смена policy (DB) | применяется (enforcement-точка читает) |
| а3 | Лимиты: hardening | docker exec id в 7 app | UID≠0; pids_limit (docker inspect) |
| а4 | Лимиты: fork-стресс | контролируемый fork-bomb в контейнере | контейнер умирает, хост не затронут (pids_limit) |
| б | Нагрузка | конкурирующие тяжёлые операции + WAL + нехватка диска | ранние 503/507 без повреждения + причина в UI/диагностике |
| в | Scrape | prometheus targets | 6/6 up=1 (включая ff:4400) |
| г1 | Алерты: disk | free < 1GiB | alert доставлен (файл/journal, время) → resolve |
| г2 | Алерты: queue | rag pending > 8 | alert → resolve |
| г3 | Алерты: service | down 1 сервиса | alert → resolve |
| г4 | Алерты: stale-backup | external_backup_verified==0 | alert → resolve |
| д | Логи | correlation id | nginx→gateway→сервис сквозной; без ticket/error.message |
| е | Ошибки | crash сервиса (kill -9 / throw) | error_events + admin UI (Error-модуль) |
| ж | Аудит | admin-мутация | в единой истории (fail-тест green) |
| з | Health | /ready | семантика (503+checks при down; /health удалён) |

## Code Map

- `docs/implementation-readiness.md:57` — P0-RES-строка (критерий), `:89-95` — сценарий (включая «файл rules ≠ доставленный alert» :95)
- `docs/publication-scenarios.md:73` — S26 (сценарий)
- `docs/capacity-admission.md` — ограничения (consumer блока а/б)
- `compose.production.yml` — production-стек (14 сервисов post-entry-12)
- `deploy/production/monitoring/` — prometheus.yml + alerts + alertmanager.yml (entry 8/12/13)
- Entry 1-14 — артефакты (non-root, pids, quota, two-tier, config, logging, redaction, metrics, health, error-store, error-UI, prom/AM, alerting, audit)
- `scripts/test/` — sweep-скрипт (grep-инвентарь) + RES-01-драйвер (автоматизируемые блоки)
- `tickets/epic-res-obs/` — протокол RES-01 + артефакты (output)

## Tasks & Acceptance

### Execution
- [ ] Sweep-скрипт: scripts/test/res-obs-sweep.mjs — 8 grep-правил (console.* в src excl CLI; error.message в логах; quota-поля без enforcement; секции RUNTIME_LIMIT_CEILINGS без точки; /health в src+nginx; сервисы вне scrape targets; root-контейнеры (USER в Dockerfile'ах); сервисы без pids/user в модели) → отчёт (hits + allowlist)
- [ ] Sweep: прогон → каждый hit: fix или явный exception (allowlist зафиксирован в отчёте)
- [ ] RES-01-драйвер: scripts/test/res-01-e2e.mjs — автоматизируемые блоки (в: scrape 6/6; з: /ready; д: correlation-check; в/г — metric-assertions) + HITL-ранбук (а/б/г1-4/е/ж — live-вызовы)
- [ ] HITL-ранбук: docs/res-01-acceptance.md — пошаговый: развёртывание production-стека, вызов каждого условия (а: fork-bomb/quota/two-tier; б: нагрузка; г: disk/queue/service/stale; е: crash; ж: admin-мутация), проверка артефактов, GO/NO-GO
- [ ] Протокол: tickets/epic-res-obs/RES-01-protocol.md — результаты 8 блоков + артефакты (логи/скриншоты/метрики/значения)
- [ ] Readiness-закрытие: implementation-readiness.md P0-RES — «Чего недостаёт» закрыто свидетельством (RES-01 протокол)

### Acceptance
- **Given** sweep **when** прогон **then** 0 необъявленных hits (allowlist зафиксирован)
- **Given** production-стек **when** блок а (лимиты) **then** quota-отказ, two-tier применяется, UID≠0, pids_limit, fork-стресс (контейнер умирает, хост цел)
- **Given** production-стек **when** блок б (нагрузка) **then** ранние 503/507 без повреждения + причина в диагностике
- **Given** prometheus **when** блок в (scrape) **then** 6/6 up=1 (ff:4400 включён)
- **Given** условия (г) **when** вызов **then** alert доставлен (файл/journal) → resolve (4 условия)
- **Given** логи (д) **when** correlation **then** nginx→gateway→сервис сквозной; без ticket/error.message
- **Given** crash (е) **when** error **then** error_events + admin UI
- **Given** admin-мутация (ж) **when** аудит **then** единая история (fail-тест green)
- **Given** /ready (з) **when** health **then** семантика (503+checks; /health удалён)
- **Given** RES-01 протокол **when** readiness **then** P0-RES «Чего недостаёт» закрыто (GO)

## Design Notes

- **Sweep перед RES-01:** sweep (статический) — быстрый, ловит «забыли в entry» до live-приёмки. RES-01 (live) — доказывает на стеке. Порядок: sweep → fixes → RES-01.
- **Автоматизируемое vs HITL:** автоматизируем (без HITL): sweep (статический), scrape (metric-query), /ready (HTTP), correlation (log-grep). HITL: fork-стресс, нагрузка, вызов alert-условий, crash, admin-мутация (живой стек, ресурсоёмко).
- **Fork-стресс (а4):** контролируемый (не настоящий bomb): `sh -c 'while :; do : & done'` в контейнере с pids_limit → контейнер умирает (pids), хост не затронут. Ограничен (timeout, один контейнер).
- **«Файл rules ≠ доставленный alert» (:95):** RES-01 блок г — НЕ «alert в alertmanager UI», а «запись в канал (файл/journal)». Критерий зафиксирован в протоколе.
- **Red = баг-тикет:** RES-01 не чинит (consumer). Red-находка → баг-тикет → фикс → повтор RES-01 (итерация). GO только при 8/8 green.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
# Sweep:
node scripts/test/res-obs-sweep.mjs   # → отчёт (0 необъявленных hits)
# Автоматизируемые блоки (на стеке):
node scripts/test/res-01-e2e.mjs --blocks scrape,health,correlation
# HITL (по ранбуку docs/res-01-acceptance.md):
#   а: quota-отказ, two-tier, UID≠0, pids, fork-стресс
#   б: нагрузка (конкурирующие операции, WAL, диск)
#   г: disk/queue/service/stale → доставлено+снято
#   е: crash → error_events + UI
#   ж: admin-мутация → история
# Протокол:
cat tickets/epic-res-obs/RES-01-protocol.md   # 8/8 green + артефакты
```
Ожидаемо: sweep 0 hits; 8 блоков green; протокол с артефактами; readiness P0-RES закрыто (GO).

## Open Questions (с рекомендациями)

1. **Fork-стресс: насколько агрессивно?** Рекомендация: ограниченный (timeout 10s, один контейнер, pids_limit=512 → ~500 процессов). Не настоящий bomb (не затронет хост благодаря pids_limit).
2. **Нагрузка (б): объём и длительность?** Рекомендация: согласованный объём (S26) + длительный прогон (readiness :93). Конкретные значения — HITL (оператор + QA).
3. **RES-01 на этом стеке vs чистый хост?** Рекомендация: этот production-стек (compose.production.yml, образы manifest) — достаточно для P0-RES (не «чистый хост» как REL-01). Чистый хост = REL-01 (эпик 1).
4. **Повтор RES-01 после каждого баг-фикса?** Рекомендация: да (итерация: red → фикс → повтор RES-01). GO при 8/8 green без red.
5. **Артефакты: где хранить?** Рекомендация: tickets/epic-res-obs/ (протокол + логи/скриншоты/метрики). Не в git (секреты/размер) — ссылка на хранение (OQ: оператор).
