---
title: 'Volume map: write-owner как данные + drift-тест (AD-D2)'
type: 'feature'
ticket: '6'
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
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/tickets/epic-data/epic-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Правило AD-D2 «у каждого shared-volume один write-owner» сейчас держится в документе и в compose-комментах. Каноническая карта «volume → кто пишет → mode» по AD-D2 — **часть данных окружения** (drift-тест — стык с AD-OP-1 operational spine). Без карты в данных: добавление второго rw-монтирования (как было с model-weights) проходит незаметно до ручного ревью.

**Approach:** (1) `environment-model.json`: у каждого volume поле `writeOwner` (имя сервиса или special-value — OQ-1) + `readers` (опционально); (2) invariant-тест (scripts/test/, паттерн `schema-locks-ddl-invariant.test.mjs`): парсит `compose.production.yml` — каждый volume из модели: ровно один rw-монтирующий сервис = `writeOwner`, все остальные монтирования ≤ `:ro`, volume без rw-владельца или с двумя rw = fail с указанием volume+сервисов; (3) тест в check-tooling (check-tooling-tests.json). Story идёт **последней среди AD-D2** (after [2,3,4,5]) — фиксирует финальное состояние после всех фиксов write-owner'ов.

## Boundaries & Constraints

**Always:**
- Карта = данные (environment-model.json), не код и не документ: drift-тест читает JSON + compose.
- Тест deterministic: парсинг compose (YAML) без запуска docker.
- Special-value для «владелец вне контейнеров» (OQ-1): `external:operator` (backups — dump-оператор? — проверить, кто пишет в backups), `external:ollama` (ollama = container, но не «наш» сервис — writeOwner = имя compose-сервиса `ollama`).

**Never:**
- Не менять compose в этой story (все rw/ro-фиксы — stories 2,4,5; здесь только карта + тест).
- Не требовать `readers` для всех volumes (опциональное поле; writeOwner — обязательное).
- Не ломать structuralDrift (environment-model.mjs:268-290) — новые поля additive.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Текущий compose после stories 2,4,5 | test | зелёный: у каждого volume один rw-owner |
| 2 | Добавлен второй rw-монтирование | test | fail: «volume X: rw = [A, B], writeOwner = A» |
| 3 | Volume без rw-монтирований (все :ro) | test | fail: «volume X: нет write-owner» (кто-то обязан писать — иначе volume мёртв) |
| 4 | Volume в модели, нет в compose | test | fail (drift) |
| 5 | Volume в compose, нет в модели | test | fail (drift) |
| 6 | writeOwner = сервис без rw-монтирования | test | fail (owner лжёт) |
| 7 | Special-value external:* | test | допустим, но rw-монтирований быть не должно (external = пишет извне, не контейнер) — OQ-1 |

## Code Map

- `deploy/production/environment-model.json:34-45` — volumes (сейчас без owner-полей), :25 — ollama volumes, :94/182/184 — пример rw/ro-монтирований, :55-65 — env map
- `compose.production.yml:332-340` — volumes list; :33-43 ollama (rw model-weights), :76-82 capacity-collector (ro), :155 catalog (rw model-weights → убирается story 5), :155-158 gateway (+artifact-cache story 2), :227-232 rag-sync (:ro story 4)
- `scripts/production/environment-model.mjs:268-290` — structuralDrift (существующий парсер compose↔model — переиспользовать парсер)
- `scripts/test/schema-locks-ddl-invariant.test.mjs` — паттерн invariant-теста
- `scripts/test/check-tooling-tests.json` — реестр tooling-тестов (добавить)
- `scripts/production/production-env.mjs:151-183` — composeEnv (контекст compose-генерации)

## Tasks & Acceptance

### Execution
- [ ] environment-model.json: у каждого volume `writeOwner` (значения: `catalog`, `rag-sync`, `skills-service`, `api-gateway` (artifact-cache), `ollama` (model-weights), `postgres` (postgres), `capacity-collector` (capacity), `external:operator`/`catalog` (backups — проверить, кто пишет: backup-storage.ts у catalog → `catalog`; skills → `skills-service`; projects → `catalog`); `readers` — опционально
- [ ] Tест `volume-map-invariant.test.mjs` (scripts/test/): парсинг compose + environment-model.json → проверки edge 1-7; fail-сообщения с volume+сервисами
- [ ] check-tooling-tests.json: добавить тест
- [ ] (dev) проверить write-owner'ов по факту кода: backups (backup-storage.ts — кто вызывает: catalog → `catalog`), capacity (collector write → `capacity-collector`), postgres (обvious), projects (catalog rw — подтверждено story 4 аудитом)

### Acceptance
- **Given** compose после stories 2,4,5 **when** volume-map test **then** зелёный (у каждого volume ровно один rw = writeOwner)
- **Given** интродукция второго rw на любой volume **when** test **then** fail с указанием volume и обоих сервисов
- **Given** volume в compose без rw-монтирований **when** test **then** fail

## Design Notes

- Карта как данные = AD-D2: «каноническая карта volume→service→mode — часть данных окружения (drift-тест — стык с AD-OP-1 operational spine)». Т.е. operational spine (AD-OP-1) будет использовать эту же карту — формат должен быть совместимым (OQ-1: имя поля, special-values).
- Парсер compose: переиспользовать из structuralDrift (environment-model.mjs:268-290) — не писать второй парсер.
- Почему last-среди-AD-D2: stories 2,4,5 меняют rw/ro-состояние; карта фиксирует **результат**, а не промежуточное (иначе тест красный между stories).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/volume-map-invariant.test.mjs
node scripts/test/check-tooling.test.mjs 2>/dev/null || true
```
Ожидаемо: volume-map тест зелёный на текущем compose (после stories 2,4,5); negative-тесты (fixture compose с 2 rw) fail'ят с правильным сообщением.

## Open Questions

1. **Формат special-values**: как обозначить «владелец не контейнер» (backups, если пишется оператором/скриптом)? Рекомендация: `external:<имя>` + правило «external → нет rw-монтирований в compose». Подтвердить совместимость с AD-OP-1 (operational spine использует ту же карту).
2. **readers**: поле нужно (полная карта «volume → кто пишет/читает → mode») или достаточно writeOwner? Рекомендация: да, readers (AD-D2 говорит «карта volume→service→mode», не только owner).
3. **backups write-owner**: кто реально пишет в volume backups (catalog backup-storage.ts:38-67 — да, catalog; backup-копии в maintenance.mjs — да) → `catalog`. Подтвердить в dev.
