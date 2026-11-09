---
title: 'model-weights: 7-й capacity-ресурс (AD-D2)'
type: 'feature'
ticket: '3'
created: '2026-11-09'
status: done
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'medium'
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

**Problem:** Volume `model-weights` (OLLAMA_HOME + MODEL_STORAGE_PATH, compose:36/152/155) не виден capacity-модели: collector монитрирует 6 ресурсов (postgres, skills, projects, backups, runtime-artifacts, capacity — compose:76-82), `capacity.cjs:4-11` описывает ровно 6. Переполнение volume с весами моделей (самый «тяжёлый» volume системы) невидимо: capacity-снапшот не покажет переполнение, backup-reserve/capacity-check на него не сработают.

**Approach:** (1) `capacity.cjs`: 7-й ресурс `model-weights`; (2) `capacity-collector.cjs` + compose: чтение statfs model-weights (монтирование `model-weights:/volumes/model-weights:ro`); (3) `validateSnapshot` (capacity.cjs:29-57) — compat-правило: 6-ресурсные снапшоты (старые коллекторы) остаются валидными, 7-ресурсные обязательны только от нового коллектора (schemaVersion-gate); (4) environment-model.json: volume у collector'а; (5) metrics gauge — OQ-2.

## Boundaries & Constraints

**Always:**
- Формат снапшота capacity расширяется additive-способом: существующие поля не меняются, 7-й ресурс добавляется.
- Compat: `validateSnapshot` принимает и 6-ресурсный (legacy), и 7-ресурсный снапшот; при 6-ресурсном `model-weights` = undefined (не 0 — 0 значит «пустой», а это ложь).
- Collector — read-only (`:ro`), DAC_OVERRIDE как сейчас (compose:79), network_mode: none.

**Never:**
- Не менять 6 существующих ресурсов и их метрики.
- Не делать model-weights write-owned collector'ом (collector — reader по AD-D2).
- Не бросать hard-fail на legacy-снапшот (validateSnapshot:29-57 сейчас hard-fail'ит на невалидном — legacy должен проходить).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Нормальный сбор | collect() | 7 ресурсов, model-weights = statfs-факт |
| 2 | Volume смонтирован, пуст | statfs | model-weights used=0, total > 0 |
| 3 | Legacy-снапшот (6 ресурсов) | validateSnapshot | valid, model-weights = undefined |
| 4 | Новый снапшот без model-weights (7-местный, поле опущено) | validateSnapshot | invalid (новый коллектор обязан заполнить) |
| 5 | model-weights не смонтирован у collector'а | collect() | явная ошибка (не тихий 0) — fail-fast |
| 6 | Volume на 100% | statfs | total/used отражают переполнение (видимость = цель) |
| 7 | statfs-ошибка (IO) | collect() | та же обработка ошибок, что для 6 существующих ресурсов |

## Code Map

- `services/shared/capacity.cjs:4-11` — массив resources (6 шт.), :29-57 — validateSnapshot (hard-fail, schemaVersion-gate)
- `services/shared/capacity-collector.cjs:14-58` — read (statfs per resource), :59-68 — collect
- `compose.production.yml:63-82` — capacity-collector service (mounts :76-82, cap_add DAC_OVERRIDE :79)
- `compose.production.yml:36` — ollama `model-weights:/root/.ollama`; :152 — `MODEL_STORAGE_PATH: /data/models`; :155 — catalog rw
- `deploy/production/environment-model.json` — volumes (model-weights есть), collector-секция (добавить volume), env map
- `scripts/production/environment-model.mjs:268-290` — structuralDrift
- `services/shared/metrics-registry.mjs` — Gauge-реестр (добавить — OQ-2)
- `scripts/test/check-tooling-tests.json` — tooling-тесты (capacity-тест, если есть — проверить)

## Tasks & Acceptance

### Execution
- [ ] capacity.cjs: resources += `model-weights`; validateSnapshot: legacy (6) valid с model-weights=undefined; 7-местный обязан заполнять
- [ ] capacity-collector.cjs: read model-weights (statfs /volumes/model-weights); compose: volume `:ro` у collector'а
- [ ] environment-model.json: collector-секция + volume; drift-тест
- [ ] (OQ-2) metrics-registry: gauge model-weights used/total
- [ ] Тесты: collect() 7 ресурсов (fixture: tmp-каталог как volume); validateSnapshot legacy + new + broken

### Acceptance
- **Given** volume model-weights с данными **when** collect() **then** снапшот содержит model-weights = фактические байты (statfs)
- **Given** legacy 6-ресурсный снапшот **when** validateSnapshot **then** valid, model-weights = undefined
- **Given** 7-местный снапшот с пропущенным model-weights **when** validateSnapshot **then** invalid
- **Given** model-weights не смонтирован **when** collect() **then** fail-fast с явным сообщением

## Design Notes

- `undefined` vs `0` для legacy: consumer (capacity-check) обязан обрабатывать отсутствие ресурса как «данных нет», а не «пусто» — 0 лгал бы о 100ГБ weight-хранилище.
- statfs даёт total/free (не «used приложениями»): семантика = capacity-volume (свободно/всего), как у 6 существующих ресурсов — consistency.
- Collector получает volume в :ro — это reader-монтирование, AD-D2 write-owner model-weights = ollama (story 5) не нарушается.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/capacity*.test.mjs 2>/dev/null || npm test -w shared 2>/dev/null || echo "OQ: точная команда capacity-тестов"
node scripts/test/check-tooling.test.mjs 2>/dev/null || true
```
Ожидаемо: validateSnapshot legacy/new/green; collect() 7 ресурсов; drift compose↔model зелёный.

## Open Questions

1. **Compat-окно**: как долго поддерживать 6-ресурсные снапшоты (всегда? до первого релиза с новым коллектором)? Рекомендация: всегда (cheap).
2. **Metrics gauge**: нужен ли отдельный gauge для model-weights (рекомендация: да, паритет с 6 другими).
3. **Кто ещё читает capacity-снапшоты**: inventory consumers validateSnapshot — проверить, что все сходятся с legacy-правилом (dev-задача: grep validateSnapshot callers).
