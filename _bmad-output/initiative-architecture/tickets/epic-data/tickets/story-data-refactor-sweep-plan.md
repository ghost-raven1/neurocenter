---
title: 'Refactor sweep: AD-D2..D5 по всей кодовой базе'
type: 'feature'
ticket: '13'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'low'
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

**Problem:** После stories 1-12 отдельные фиксы сделаны, но по кодовой базе могут остаться «хвосты»: rw-mount без owner, дубли quota/used, TTL-магические числа вне retention-таблицы, прямые fs-записи в shared volumes вне 4 паттернов, volumes/env вне environment-model. AD-D2..D5 требуют целостности по всей базе, а не по точкам.

**Approach:** Финальный механический проход эпика (по одному commit-классу на правило): (1) **rw-mounts без owner** — grep всех `:rw` в compose + сверка с volume-map (story 6) → каждый rw: writeOwner (иначе fail); (2) **quota/used-дубли** — grep used-bytes/quota-счётов вне accounting API (story 1) → обход = fail; (3) **TTL-магические числа** — grep interval/ttl/days в коде → каждый TTL: из retention.json (story 7) или явный exception; (4) **прямые fs-записи в shared volumes** — grep fs.writeFile/mkdir/rename/link в services → каждая запись в shared volume: через 4 паттерна (story 12) или exception; (5) **environment-model** — все volumes в model + все env в requiredEnv map (drift-тест); (6) **docs** — architecture-data.md Known Defects → resolved по фактическому статусу.

## Boundaries & Constraints

**Always:**
- Каждый grep-hit: **fix** (в рамках AD-D2..D5) или **явный exception** (в таблице с причиной) — не «пропустить молча».
- По одному commit-классу на правило (rw-mounts / quota / TTL / fs-writes / env-model / docs).
- Sweep не вводит новых фич — только приводит базу к AD-D2..D5.

**Never:**
- Не менять ratified-паттерны/механизмы (stories 1-12) — sweep только находит отклонения.
- Не «чинять» то, что вне AD-D2..D5 (отдельные тикеты).
- Не оставлять hit без решения (fix или exception).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | rw-mount без owner | grep :rw | fix (owner) или exception |
| 2 | used-bytes счётчик вне accounting | grep | обход → fail (fix на accounting API) |
| 3 | TTL-магическое число в коде | grep interval | из retention.json или exception |
| 4 | Прямая fs-запись в shared volume | grep fs.write | через 4 паттерна или exception |
| 5 | Volume/env вне environment-model | drift | добавлен в model |
| 6 | Known Defect исправлен | docs | статус → resolved |
| 7 | Hit = ложное срабатывание (test/fixture) | grep | исключение (не production-код) |

## Code Map

- `compose.production.yml` — все `:rw`/:ro mounts (rw-inventory), :332-340 volumes
- `deploy/production/environment-model.json` — volumes + requiredEnv map (drift)
- `scripts/production/environment-model.mjs:268-290` — structuralDrift
- `deploy/production/retention.json` — retention-таблица (story 7, TTL-источник)
- `services/catalog-service/src/runtime-artifacts/runtime-artifacts.ts:61-129` — pattern 1 (базовый fs-write)
- `_bmad-output/initiative-architecture/architecture-data/architecture-data.md` — Known Defects (статусы), AD-D2..D5
- `scripts/test/check-tooling-tests.json` — tooling-тесты (drift, volume-map, retention)

## Tasks & Acceptance

### Execution
- [ ] (1) rw-mounts: grep `:rw` в compose → сверка с volume-map (story 6) → fix/exception
- [ ] (2) quota/used: grep used-bytes/quota-счётов вне accounting API → обход = fail
- [ ] (3) TTL: grep `interval '.* day'`/`ttl`/`_DAYS`/`30 * 24` в services → каждый из retention.json или exception
- [ ] (4) fs-writes: grep `fs.writeFile|fs.mkdir|fs.rename|fs.link` в services (production-код, не test) → каждая запись в shared volume: 4 паттерна или exception
- [ ] (5) environment-model: все volumes в model + все env в requiredEnv (drift-тест зелёный)
- [ ] (6) docs: architecture-data.md Known Defects → resolved по статусу stories 1-12
- [ ] Таблица exceptions (hit → причина) в tickets/epic-data/

### Acceptance
- **Given** grep-инвентарь по 4 правилам **when** sweep **then** 0 необъявленных hits (каждый fixed или exception)
- **Given** environment-model drift **when** test **then** зелёный (все volumes/env в model)
- **Given** Known Defects **when** docs **then** статусы обновлены (resolved/open по факту)

## Design Notes

- Sweep = механика, не дизайн: решения уже в stories 1-12; sweep находит «хвосты» и приводит базу к целостности.
- Exceptions — легитимны (не всё должно быть идеальным), но **явные** (таблица с причиной) — AD-D3 «none — только с зафиксированной причиной» (аналогично для rw/fs-writes).
- Почему last (after [1..12]): sweep проверяет финальное состояние после всех фиксов; между stories база в переходном состоянии (сweep был бы красный).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
# grep-инвентарь (повторяемые команды — зафиксировать в tickets/epic-data/):
grep -rn ":rw" compose.production.yml
grep -rn "interval '" services/ --include=*.ts | grep -iE "day|hour"
grep -rn "fs.writeFile\|fs.mkdir\|fs.rename\|fs.link" services/ --include=*.ts | grep -v test
# drift:
node scripts/test/check-tooling.test.mjs 2>/dev/null || true
```
Ожидаемо: каждый hit — fixed или в exceptions; drift зелёный; docs обновлены.

## Open Questions

1. **Греп-инвентарь как артефакт**: фиксировать raw-вывод grep в tickets/epic-data/ (проверка на приёмке) — да (рекомендация).
2. **Exceptions-таблица**: формат (hit → правило → причина → owner) — подтвердить.
3. **Граница sweep**: только AD-D2..D5 (data-контур) vs все AD? Рекомендация: только AD-D2..D5 (остальные эпики).
