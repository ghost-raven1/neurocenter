---
title: 'Ресурсная таблица: pids_limit + user в модели, инварианты и drift (AD-OP-6)'
type: 'feature'
ticket: '2'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
  - deploy/production/environment-model.json
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-OP-6 «Prevents: fork-бомба → OOM хоста (9 из 12 сервисов без pids_limit); setup-контейнеры без лимитов». Факт main: pids_limit только у 3 сервисов (model-runtime 512 :26, capacity-collector 32 :74, feature-flags 128 :172 — ратификация); x-service anchor (:2-10) pids_limit не несёт; database-init/bootstrap-admin без mem/pids вообще; postgres/catalog/skills/rag/bridge/gateway/frontend без pids. Ресурсная таблица (mem/cpus/pids/read_only/cap/seccomp) по AD-OP-6(3) «часть модели AD-OP-1 (drift-тест)» — модель уже содержит mem/cpus/pids/readOnly/capDrop/capAdd/seccomp, но НЕТ поля user (non-root, entry 1) и pidsLimit у 9 сервисов = null.

**Approach:** (1) compose: pids_limit в x-service anchor (baseline) + перенос per-service overrides (512/32/128 ратификация) + pids у остальных + mem/pids для database-init/bootstrap-admin; (2) environment-model.json: поле `user` (12 сервисов) + pidsLimit значения + environment-model.mjs (парсинг + сверка); (3) инвариант-тест: каждый long-running сервис — pidsLimit задан; каждый app-сервис — non-root (user задан и ≠ root); memLimit задан; (4) ресурсная таблица = модель (единственный машино-читаемый источник) + проецирующая таблица в docs (docs/capacity-admission.md — секция «Ограничения сервисов», генерируемая сверка).

## Boundaries & Constraints

**Always:**
- Ратифицированные значения не меняются: model 512, capacity 32, ff 128, postgres mem 1g.
- compose = источник, модель = зеркало: drift-тест (structuralDrift) обязан замечать любое рассогласование (в обе стороны через compose→model-сверку entry 2/3 эпика 1).
- Инвариант покрывает long-running сервисы (postgres, 6 app, frontend, model-runtime); one-shot (database-init, bootstrap-admin) — mem/pids заданы (AD-OP-6) но long-running-инвариант на них не распространяется (зафиксировать).
- read_only/cap/seccomp — существующие значения ратификация (capacity-collector read_only, cap_drop model/catalog/capacity).

**Never:**
- Не менять mem/cpus-значения без HITL (значения — OQ для НОВЫХ pids только; mem/cpus — как есть).
- Не трогать pids_limit child-MCP (AD-4 runtime-trust — контейнерный уровень ≠ процесс child-MCP, не дублируется).
- Не создавать отдельную «таблицу» дублирующую модель — модель и есть таблица, docs-проекция = сверяемый артефакт.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Текущий compose | drift-тест | 0 drift (после правки compose+модели синхронно) |
| 2 | pids-превышение | fork-стресс сервиса (контролируемый) | контейнер умирает (pids EAGAIN), хост не затронут, restart policy поднимает |
| 3 | database-init/bootstrap-admin | setup-прогон | работают с mem/pids-лимитами |
| 4 | Инвариант: сервис root | user: null в модели | fail с указанием сервиса |
| 5 | Инвариант: long-running без pids | pidsLimit: null | fail с указанием сервиса |
| 6 | Drift: pids в compose ≠ модели | мутация compose (fixture) | structuralDrift ≠ [] |
| 7 | Drift: user в compose ≠ модели | мутация (fixture) | structuralDrift ≠ [] |

## Code Map

- `compose.production.yml:2-10` — x-service anchor (pids_limit добавить сюда); :21-42 model-runtime (pids 512 :26 — override), :44-61 postgres (mem 1g :47, без pids), :63-90 capacity-collector (32 :74), :92-101 database-init (без лимитов), :103-118 bootstrap-admin (без лимитов), :120-164 catalog (без pids), :166-187 ff (128 :172), :189-211 skills (без pids), :213-241 rag (без pids), :243-267 bridge (без pids), :269-293 gateway (без pids), :295-315 frontend (без pids)
- `deploy/production/environment-model.json` — per-service: memLimit/cpus/pidsLimit/readOnly/capDrop/capAdd/seccomp; user — НОВОЕ поле (12 мест: :12-46 model, :47-75 postgres, :76-100 capacity, :101-118 database-init, :119-148 bootstrap, :149-229 catalog, :230-262 ff, :263-295 skills, :296-335 rag, :336-376 bridge, :377-414 gateway, :415-440 frontend)
- `scripts/production/environment-model.mjs:23-29` — список полей structuralDrift (добавить 'user'); :157-163 — парсинг compose-сервиса (добавить user: service.user)
- `scripts/test/compose-drift.test.mjs:76` — счёт сервисов = 12 (entry 12 поднимет до 14; здесь не менять)
- `scripts/test/` — НОВЫЙ тест инвариантов ресурсной таблицы (паттерн: schema-locks-ddl-invariant.test.mjs — чтение модели + assertions)
- `docs/capacity-admission.md` — секция ресурсных ограничений сервисов (проекция модели)

## Tasks & Acceptance

### Execution
- [ ] compose: x-service anchor + `pids_limit` (baseline — OQ-1, рекомендация 256); overrides остаются per-service (512/32/128); pidsLimit: postgres, catalog, skills, rag, bridge, gateway, frontend (значения — OQ-2); database-init + bootstrap-admin: mem_limit + pids_limit (OQ-3)
- [ ] environment-model.json: `user` поле у 12 сервисов (app-сервисы: non-root uid из entry 1; model-runtime/postgres: uid образов — зафиксировать фактический, external-note) + pidsLimit-значения синхронно с compose
- [ ] environment-model.mjs: 'user' в списке полей сверки (:23-29) + парсинг (:157-163: user: service.user ?? null)
- [ ] Инвариант-тест (scripts/test/resource-limits-invariant.test.mjs): (a) long-running (10: model-runtime, postgres, capacity-collector, 6 app, frontend): pidsLimit ≠ null; (b) app-сервисы (7 + setup 2): user ≠ null и ≠ 0/root; (c) memLimit ≠ null у всех; (d) ратифицированные значения (512/32/128/1g) не изменились
- [ ] docs/capacity-admission.md: секция «Ограничения сервисов» (таблица mem/cpus/pids/user/read_only/cap/seccomp) + пометка «проекция environment-model.json, drift-тест сверяет»
- [ ] check-tooling: зарегистрировать новый тест (scripts/workspace/check-tooling-tests.json)

### Acceptance
- **Given** compose с pids_limit в якоре **when** drift-тест **then** 0 drift (модель синхронна)
- **Given** long-running сервис без pidsLimit в модели **when** инвариант-тест **then** fail с именем сервиса
- **Given** app-сервис с user: null/root **when** инвариант-тест **then** fail с именем сервиса
- **Given** fork-стресс (контролируемый, dev-стек) **when** pids_limit достигнут **then** контейнер получает EAGAIN/умирает, хост стабилен, restart policy возвращает сервис

## Design Notes

- pids_limit в якоре = baseline для всех сервисов; per-service override — только осознанные отклонения (model 512 — ollama-workers, ff 128 — ратификация). Базовый процесс Node — 1-2 PID; 256 с большим запасом против fork-бомбы.
- postgres: pids_limit — OQ (pg-процессы: main + backends + walwriter и т.д.; рекомендация 256 — backends ограничены max_connections, по умолчанию 100).
- database-init/bootstrap-admin: one-shot, но AD-OP-6 прямо называет их («получают mem/pids-лимиты»); mem 512m/pids 128 (OQ-3) — они используют тот же catalog-образ (CLI).
- Модель — единственный источник: docs-таблица НЕ редактируется руками, только как проекция (drift-тест сверяет compose↔модель; docs-проекция — review-артефакт, автоматическая сверка — OQ-4, рекомендация: на старте — вручную при правках, автоматизация — Deferred).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/compose-drift.test.mjs
node --test scripts/test/resource-limits-invariant.test.mjs
# Live (dev-стек): docker compose exec catalog-service sh -c 'cat /sys/fs/cgroup/pids.max' (или docker inspect: PidsLimit)
```
Ожидаемо: drift-тест зелёный; инвариант зелёный; docker inspect показывает PidsLimit у всех long-running сервисов.

## Open Questions

1. **Baseline pids в якоре**: 256 (рекомендация) vs 128 vs 512. Рекомендация 256: Node-сервис = 1-3 PID + child-MCP (у gateway — пул до 4 хостов × процессы — но child-MCP pids — AD-4, свой уровень); запас против fork-бомбы при нормальном запасе по pids для рабочих процессов.
2. **Per-service pids (новые значения)**: postgres 256 (OQ с max_connections), catalog 256 (bwrap-песочницы! — каждый build = несколько PID, проверить под нагрузкой), skills 256, rag 256, bridge 256, gateway 512 (MCP-host пул + proxy), frontend 64 (nginx worker'ы). Рекомендация: 256 baseline, gateway 512, frontend 64 — зафиксировать после проверки bwrap-счётчика PID у catalog.
3. **database-init/bootstrap-admin mem/pids**: mem 512m, pids 128 (рекомендация — catalog-CLI).
4. **Автоматическая сверка docs-проекции**: на старте — нет (review), Deferred после стабилизации.
