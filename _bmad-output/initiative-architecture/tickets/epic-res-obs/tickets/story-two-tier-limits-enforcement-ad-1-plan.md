---
title: 'Двухуровневые лимиты: enforcement-точки + инварианты (AD-1/9/12)'
type: 'feature'
ticket: '4'
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
  - _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
  - _bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/tickets/tickets.toml
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-1: модель покрывает ВСЕ storage/machine-секции runtime-limits: у каждой секции **ceiling** (константа, единый источник — epic 2 entry 2: re-export из pinned asset-контракта) и **политика** (admin, default ≤ policy ≤ ceiling, DB runtime_limit_settings). P0-RES (R11): «у каждого заявленного лимита есть enforcement-точка; лимит, который не работает — дефект». В main: 2 секции (textKnowledge, ggufImport — shared/runtime-limits.cjs:4-27), enforcement-точки: textKnowledge (chat-project-context.ts:52-53 — admission при выборе контекста), ggufImport (gguf-import.service.ts:450 — ggufPolicy()); вырожденные значения (ceiling = default): textKnowledge.fileBytes 128 KiB, GGUF maximumBytes/storageQuotaBytes 8/32 TiB при default 64/256 GiB (AD-1: «поправить при финализации значений — Deferred»). Нет ни completeness-теста «секция → enforcement-точка+тест», ни инварианта ceiling > default, ни fail-fast «env > default».

**Approach:** (1) таблица «секция → enforcement-точка (файл) + тест» как единый источник (модуль + документ-проекция) — data-driven от RUNTIME_LIMIT_CEILINGS (новые секции epic 2/5 подхватываются АВТОМАТИЧЕСКИ — без хардкода списка); (2) completeness-тест: каждая секция в RUNTIME_LIMIT_CEILINGS имеет enforcement-точку + тест; секция без точки (и без явного allowlist-исключения с причиной) = фэйл; (3) инвариант ceiling > default: вырожденные секции — задокументированный Deferred-allowlist (флаг, не фэйл), НОВОЕ вырождение (секция вне allowlist) = фэйл; (4) env-значение политики > default = fail-fast на старте (механизм — config-модуль entry 5; здесь — правило + тест на gguf-секции как прокси).

## Boundaries & Constraints

**Always:**
- Секции/ceiling — только из единого источника (RUNTIME_LIMIT_CEILINGS → re-export контракта, epic 2 entry 2); локальных ceiling-литералов в сервисных бинариях = фэйл (AD-12).
- Таблица data-driven: источник секций = Object.keys(RUNTIME_LIMIT_CEILINGS), не хардкод.
- Вырожденные allowlisted-секции — флаг в отчёте (Deferred по AD-1), не фэйл.
- Enforcement-точка = место, где политика применяется ДО операции (admission), не пост-фактум проверка.

**Never:**
- Не менять значения ceiling/default (финализация — Deferred по AD-1; изменение ceiling = релиз контракта, epic 2).
- Не реализовывать НОВЫЕ секции (runtime-artifacts, runtime-cache, snapshot, backup, gguf-disk — появляются с epic 2/5; здесь только механизм, который их подхватит).
- Не дублировать env-валидацию (owner — config-модуль, entry 5).
- Не трогать AD-11 (capability-advisor — UI, epic-project; OQ-1) и AD-18 (machine-metrics — entry 8).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Текущие 2 секции | completeness-тест | обе покрыты точкой+тестом (зелёный) |
| 2 | Новая секция в RUNTIME_LIMIT_CEILINGS (fixture) без enforcement-точки | completeness | фэйл с именем секции |
| 3 | Новая секция с enforcement-точкой+тестом | completeness | зелёный (автоматическое подхватывание) |
| 4 | Вырожденная allowlisted-секция (fileBytes 128KiB) | инвариант | флаг (Deferred), не фэйл |
| 5 | НОВОЕ вырождение (ceiling=default, вне allowlist) | инвариант | фэйл с именем секции/поля |
| 6 | policy > ceiling (admin) | runtimeLimitPolicy (runtime-limits.cjs:38-39) | отказ сохранения (существующее — ратификация) |
| 7 | env-значение > default | config-модуль (entry 5) на старте | fail-fast (тест-прокси на gguf-секции) |
| 8 | client-дескриптор limits > ceiling | verify (epic 2 entry 3) | fail-closed (вне скоупа — ратификация epic 2) |

## Code Map

- `services/shared/runtime-limits.cjs:4-27` — RUNTIME_LIMIT_CEILINGS + DEFAULT_RUNTIME_LIMIT_POLICY (2 секции: textKnowledge, ggufImport); :32-46 runtimeLimitPolicy (валидация policy ≤ ceiling :38-39 — ратификация)
- `services/shared/project-text-knowledge.cjs` — TEXT_KNOWLEDGE_LIMITS/CEILINGS (fileBytes ceiling=default=128 KiB — вырожденная, Deferred)
- `services/shared/gguf-import-policy.cjs:39` — configuredGgufImportPolicy (ceiling 8/32 TiB — вырожденные, Deferred); :DEFAULT_GGUF_IMPORT_POLICY (default 64/256 GiB)
- `services/catalog-service/src/model-chat/chat-project-context.ts:52-53` — enforcement-точка textKnowledge (admission при выборе контекста: policy.revision + limits)
- `services/catalog-service/src/project-text/project-text.service.ts:268-275` — применение textKnowledge-лимитов
- `services/catalog-service/src/models/gguf-import/gguf-import.service.ts:450` — enforcement-точка ggufImport (limits.ggufPolicy())
- `services/catalog-service/src/runtime-limits/runtime-limits.service.ts:44-61` — effective() (policy из DB + ceilings); :102-184 save (CAS revision, advisory-лок, securityEvent)
- `services/catalog-service/src/runtime-limits/runtime-limits.schema.ts:1-20` — DDL runtime_limit_settings (singleton, policy JSONB ≤ 32KiB)
- `services/catalog-service/src/runtime-limits/runtime-limits.controller.ts:28` — GET effective (ceiling+policy в API)
- `services/shared/gguf-import-policy.cjs` — env-bootstrap политики (configuredGgufImportPolicy — env-значения до первого чтения DB; AD-1: «никогда выше дефолта: env-значение > default = fail-fast»)

## Tasks & Acceptance

### Execution
- [ ] Модуль-таблица «секция → enforcement-точка (файл:строка) + тест» (scripts/test/ или services/shared/ — OQ-2; data-driven от RUNTIME_LIMIT_CEILINGS): текущие записи: textKnowledge → chat-project-context.ts:52 (+тест), ggufImport → gguf-import.service.ts:450 (+тест)
- [ ] Completeness-тест: каждая секция Object.keys(RUNTIME_LIMIT_CEILINGS) имеет запись в таблице (файл существует, строка содержит применение policy); запись без действующего файла/строки = фэйл (анти-гниение); секция в CEILINGS без записи = фэйл (allowlist с причиной — отдельный механизм, как в AD-8 allowlist'ах)
- [ ] Инвариант-тест ceiling > default: попарно для каждой секции/поля (numeric); вырожденные — Deferred-allowlist (текст: «AD-1: финализация значений — Deferred»): textKnowledge.fileBytes, ggufImport.maximumBytes, ggufImport.storageQuotaBytes; новое вырождение = фэйл
- [ ] Тест env > default → fail-fast (прокси: gguf-секция; полный механизм — entry 5): fixture env NEUROCENTER_GGUF_*>default → сервис не стартует
- [ ] Документ-проекция: секция в architecture-доке или docs (таблица «секция → ceiling → default → точка → тест») — проекция модуля (редактируется вместе с модулем)
- [ ] check-tooling: зарегистрировать тесты (check-tooling-tests.json)

### Acceptance
- **Given** текущая RUNTIME_LIMIT_CEILINGS (2 секции) **when** completeness-тест **then** зелёный (обе покрыты)
- **Given** fixture: новая секция в CEILINGS без enforcement-точки **when** completeness **then** фэйл с именем секции
- **Given** fixture: ceiling=default для новой секции **when** инвариант **then** фэйл; для allowlisted — флаг
- **Given** env-значение gguf-лимита > default **when** старт сервиса **then** fail-fast с именем переменной

## Design Notes

- **Data-driven = защита от гниения**: когда epic 2 добавит секцию runtime-artifacts (compressedBytes/unpackedBytes/filesCount/cacheBytes в контракт, AD-1) и epic 5 — свои секции, completeness-тест АВТОМАТИЧЕСКИ потребует enforcement-точки без правки теста. Это и есть «enforcement-точки для AD-1/12» в P0-RES: механизм гарантии, а не конкретные точки новых секций (они появятся с owners-эпиками).
- **Вырожденные значения — Deferred осознанно**: AD-1 прямо фиксирует: «текущие вырожденные значения ... поправить при финализации значений (Deferred)». Инвариант не должен фэйлить на Deferred-известных — иначе тест будет красным с первого дня. Allowlist = «задокументированный остаток», паттерн AD-17 residual.
- **Почему не «сделать ceiling > default» сразу**: изменение ceiling = релиз контракта + re-pin + bump-тест (AD-12) — продукт-решение о значениях (8 TiB — действительно потолок для GGUF? 128 KiB fileBytes — осознанный лимит текстового знания?). Это не P0-RES.
- **Стык с entry 5**: env > default fail-fast — механически config-модуль (entry 5); здесь — правило + тест-прокси (чтобы entry 5 имела приёмный критерий именно для лимит-секций).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/runtime-limits-enforcement.test.mjs   # completeness + инварианты
node --test scripts/test/compose-drift.test.mjs               # без деградации
cd services/catalog-service && npm test -- runtime-limits     # regression: save/CAS/securityEvent
```
Ожидаемо: completeness зелёный (2/2 секции), инвариант: 3 allowlisted флага + 0 фэйлов, env-fail-fast-прокси зелёный; корневой сьют — без деградации.

## Open Questions

1. **AD-11 (capability-advisor) — в скоупе?** AD-11: системная роль предлагает machine-aware пресеты (вход — capacity-snapshot + AD-18 machine-metrics). Рекомендация: НЕ здесь — это UI-фича (epic-project, системные роли уже живут в catalog+frontend); здесь готов вход (AD-18 machine-metrics, entry 8). Инвариант «пресеты внутри ceiling» появится с реализацией advisor'а.
2. **Расположение модуля-таблицы**: (a) services/shared/ (рядом с runtime-limits.cjs — ближе к данным), (b) scripts/test/ (только тест). Рекомендация: (a) — таблица нужна и тесту, и документу, и будущему advisor'у (AD-11 читает «какие секции есть»).
3. **Формат записи в таблице**: {section, enforcementFile, enforcementLine, testFile} vs {section, enforcementSymbol, testFile}. Рекомендация: файл+символ (имя функции/класса), не строка (строки гниют при правках; файл+символ — стабильнее; точная проверка строки — опционально).
