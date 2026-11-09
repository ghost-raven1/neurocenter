---
title: 'AD-11: Capability-advisor UI — machine-aware пресеты лимитов'
type: 'feature'
ticket: '17'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '56f8c009cf0c9cb9d18091c5176c36831eb981cd'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/tickets/epic-project/epic-project.md
  - _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/ux/DESIGN.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-11 (architecture-runtime-trust.md:105-109): администратор, настраивая runtime-limits, подбирает значения вручную без связи с реальной машиной («Prevents: админ вынужден подбирать значения вручную без связи с реальной машиной»). Текущий admin-UI (frontend/src/features/RuntimeLimits/RuntimeLimitsSettings.tsx, секции только textKnowledge + ggufImport — fields.ts:7-33) не знает ресурсов хоста. AD-11: одна из системных ролей предлагает в UI machine-aware пресеты лимитов, вычисленные из фактических ресурсов **хоста** (disk/RAM/CPU); все пресеты внутри ceiling; рекомендация advisory — решение за администратором. Целевой набор пресетов — storage/machine-секции AD-1: runtime-cache, rag-quota, snapshot/backup, gguf-disk.

**Approach:** (1) Advisor-расчёт в catalog (системная роль): GET advisor — читает актуальный capacity-snapshot (shared/capacity.cjs:203-222 `getCapacityStatus`; disk уже собирается по 6 ресурсам statfs) + поле `machine` (RAM total/free, CPU count/load — AD-18, закрыт эпик 6 entry 8; validateSnapshot backward-совместимый — снапшоты до AD-18 валидны), и на каждую целевую секцию считает пресеты: 3 уровня (conservative/standard/aggressive), каждый в `[default..ceiling]`, с обоснованием (фактические disk/RAM/CPU значения + observedAt/age). (2) UI: в RuntimeLimitsSettings на каждую секцию — advisor-блок: пресеты как рекомендации (чипы) + «Применить» — через СУЩЕСТВУЮЩИЙ PATCH /api/runtime-limits/admin intent-flow (receipt; обход receipt/confirmation потока запрещён) + advisory-disclaimer. (3) Деградация (AD-18): в снапшоте нет `machine` (до AD-18) → disk-only пресеты + флаг; снапшот недоступен/stale (>90s, maxAgeMs) или CAPACITY_REQUIRED не задан → advisor не показывается, причина показывается, секции остаются редактируемыми.

## Boundaries & Constraints

**Always:**
- Каждое предложенное значение внутри `[default..ceiling]` (AD-1: default ≤ policy ≤ ceiling); вне диапазона — никогда не предлагается.
- Advisory: решение за администратором — advisor НЕ пишет политику сам; «Применить» = существующий PATCH admin intent → receipt (runtime-limits.service.ts:117 advisory lock, audit R9).
- Пресеты — только по целевым секциям AD-11: runtime-cache, rag-quota, snapshot/backup, gguf-disk (storage/machine-секции AD-1).
- Провенанс: advisor-ответ несёт observedAt + age снапшота, из которого посчитаны значения (R9: админ видит, от какого замера пресеты).
- Обоснование: каждый пресет несёт rationale из фактических значений (disk freeBytes / RAM free/total / CPU count-load).

**Never:**
- Не писать политику из advisor напрямую в DB (обход PATCH intent + receipt потока запрещён).
- Не предлагать значения выше ceiling (ceiling — константа, админом не поднимается, AD-1).
- Не fail-close лимитные секции при недоступности advisor: нет снапшота → advisor скрыт, секции редактируемы как до этой истории.
- Не читать env в advisor (лимиты — из DB/ceiling; AD-9: config-модуль — единственный читатель env).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Свежий снапшот (AD-18) | снапшот c `machine {ram, cpu}` + disk 6 ресурсов | Пресеты по целевым секциям, rationale disk+RAM+CPU, observedAt/age |
| 2 | Старый снапшот (до AD-18) | снапшот без поля `machine` | disk-only пресеты + флаг «RAM/CPU недоступны» (деградация AD-18) |
| 3 | CAPACITY_REQUIRED не задан | `CAPACITY_REQUIRED != 'true'` | Advisor не показывается, причина CAPACITY_NOT_CONFIGURED (capacity.cjs:207-208); секции редактируемы |
| 4 | Протухший снапшот | observedAt > 90s (maxAgeMs :6) | Advisor не показывается, причина CAPACITY_UNAVAILABLE (capacity.cjs:220) |
| 5 | Любой пресет | расчёт | Все значения ≤ ceiling и ≥ default (тест по секции) |
| 6 | «Применить» пресет | клик по пресету | Значение сохраняется через существующий PATCH intent → receipt (без обхода) |
| 7 | Админ меняет предложенное значение | ручное редактирование | Новое значение сохраняется (advisory) |
| 8 | Малый свободный диск | freeBytes ≈ reserve (1 GiB, :7) | Пресеты консервативны (→ default), rationale это отражает |

</frozen-after-approval>

## Code Map

- `services/shared/capacity.cjs:203-222` — `getCapacityStatus` (available/observedAt/maxAgeSeconds/resources) — вход advisor (disk); `:29-57` validateSnapshot (schemaVersion 1, 6 ресурсов, maxAgeMs 90s); `:7` reserveBytes = 1 GiB; `:4` resources = postgres/wal/skills/projects/backups/runtime-artifacts. Поле `machine` добавляется AD-18 (эпик 6 entry 8).
- `services/shared/runtime-limits.cjs:4-5` — `RUNTIME_LIMIT_CEILINGS` (сейчас textKnowledge + ggufImport) — ceiling-справочник для пресетов; `:62` exports; `:38` ggufImport ceilings. Целевые секции (runtime-cache, rag-quota, snapshot/backup, gguf-disk) — целевой набор AD-1; какие из них уже имеют ceiling-константы — dev-уточнение (итерация advisor по наличным целевым секциям).
- `services/catalog-service/src/runtime-limits/runtime-limits.controller.ts:7-21` — контроллер `/api/runtime-limits` (GET effective, GET/PATCH admin, GET admin/requests/:key) — точка подвеса advisor-endpoint; `:23-29` internal-контроллер (не трогать).
- `services/catalog-service/src/runtime-limits/runtime-limits.service.ts:117` — advisory lock + admin-save flow (intent/receipt) — путь «Применить» (не трогать).
- `services/catalog-service/src/access/access-policy.ts:143-145` — роут-политика runtime-limits (read; admin read+PATCH; requests/:key) — добавить advisor-роут (read-семантика).
- `frontend/src/modules/Settings/Settings.tsx:12,28` — `<RuntimeLimitsSettings />` в Settings системной роли.
- `frontend/src/features/RuntimeLimits/RuntimeLimitsSettings.tsx:9-54` — UI лимитных секций (grid + number-инпуты); `fields.ts:7-33` — поля секций (textKnowledge, ggufImport); `hooks/useRuntimeLimits.ts:24-207` — admin-state, PATCH intent, receipt-polling.
- `_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md:105-109` — AD-11 (эта история); `:147-151` — AD-18 (machine-metrics RAM/CPU в снапшоте, эпик 6 entry 8); `:45-49` — AD-1 (модель ceiling/политика, инвариант ceiling > default).
- `tickets/epic-res-obs/tickets/tickets.toml` (эпик 6 entry 8) — machine-metrics: collector /proc/meminfo + /proc/stat → поле `machine` в snapshot, validateSnapshot compat, capacity-gauges.

## Tasks & Acceptance

### Execution
- [ ] Advisor-расчёт (catalog, новый модуль `runtime-limits/advisor.ts`): читать снапшот через `getCapacityStatus` (capacity.cjs:203) + поле `machine`; на целевые секции считать пресеты (conservative/standard/aggressive) в `[default..ceiling]` из фактических значений: disk — freeBytes соответствующего ресурса минус reserveBytes (:7); RAM — free/total; CPU — count/load; rationale (фактические значения, observedAt, age) — детерминированная функция, без записи в DB.
- [ ] Endpoint: GET `/api/runtime-limits/admin/advisor` (системная роль) → `{available, reason?, observedAt, ageSeconds, presets: {section: [{level, values, rationale}]}}`; access-policy.ts:143-145 + роут (read-семантика).
- [ ] Деградация: нет `machine`-поля → disk-only пресеты + флаг; недоступен/stale → `{available: false, reason}` (UI advisor не рендерит).
- [ ] UI: RuntimeLimitsSettings — advisor-блок на секцию: чипы пресетов (уровень + ключевые значения), «Применить» → существующий useRuntimeLimits PATCH intent-flow (receipt), advisory-disclaimer («Рекомендация по ресурсам хоста на [observedAt]; решение за администратором»).
- [ ] Тесты: пресеты в `[default..ceiling]` (по секции); фикстуры (disk/RAM/CPU) → разные значения; нет `machine` → disk-only; недоступен → available:false; UI «Применить» = receipt-flow (e2e-frontend фикстура).
- [ ] Корневой сьют — без деградации.

### Acceptance
- **Given** свежий снапшот (с `machine`) **when** GET advisor **then** пресеты по целевым секциям, все значения в `[default..ceiling]`, rationale + observedAt.
- **Given** снапшот без `machine` **when** GET advisor **then** disk-only пресеты + флаг «RAM/CPU недоступны» (деградация AD-18).
- **Given** CAPACITY_REQUIRED не задан **when** GET advisor **then** available:false, reason=CAPACITY_NOT_CONFIGURED; UI-секции лимитов редактируемы как прежде.
- **Given** предложенный пресет **when** «Применить» **then** значение сохранено через существующий intent/receipt-flow (без обхода).
- **Given** админ изменил предложенное значение **when** сохранить **then** новое значение сохранено (advisory).
- Корневой сьют — без деградации.

## Design Notes

- **Advisory, не автоматизация:** AD-11 — решение за администратором. Advisor считает рекомендации; запись идёт через существующий поток (PATCH admin + receipt + advisory lock) — сохраняется R9 (100% admin-мутаций в транзакционном аудите).
- **Почему 3 уровня пресета, а не одно значение:** conservative/standard/aggressive дают диапазон, привязанный к фактическим ресурсам, без лишения выбора.
- **Деградация по AD-18:** `machine`-поле факультативно, старые ридеры обязаны терпеть отсутствие → advisor деградирует до disk-only; `reserveCapacity` НЕ fail-closes на старом снапшоте (правило AD-18) — advisor следует тому же.
- **Стык с entry 1 (open capability set, after):** gguf-disk-пресет учитывает capability/назначение модели (размер по назначению) — после entry 1 (capability-контракт на месте).
- **Стык с эпиком 6 entry 8 (AD-18):** machine-metrics (RAM/CPU) появляются в снапшоте после той истории; advisor обрабатывает оба случая (с/без `machine`) — порядок сборки не блокирует (деградация реализована с первого коммита).
- **Стык с entry 16 (sweep):** новые целевые секции (runtime-cache, rag-quota, snapshot/backup, gguf-disk) могут получить ceiling-константы в `RUNTIME_LIMIT_CEILINGS` в других историях; advisor итерирует по целевым секциям, наличным в ceilings (dev-уточнение).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- runtime-limits
node --test scripts/test/runtime-limits-advisor.test.mjs 2>/dev/null || true
```
Ожидаемо: пресеты в `[default..ceiling]` (по секции), фикстуры disk/RAM/CPU → разные значения, деградация (нет machine / недоступен / stale), UI «Применить» через receipt — зелёные; корневой сьют без деградации.

## Open Questions

1. **Advisor-endpoint: отдельный GET /admin/advisor или поле в GET /admin ответе?** Рекомендация: **отдельный endpoint**. Обоснование: admin-view — это политика + receipt (потребляется useRuntimeLimits); advisor — динамический расчёт от ресурсного снапшота со своей доступностью/деградацией, не стоит перегружать admin-ответ.
2. **Формулы пресетов — фиксированные в коде или настраиваемые оператором?** Рекомендация: **фиксированные (код)** по 4 целевым секциям — прозрачно, тестуемо, без новых admin-knob'ов; revisit: если оператор захочет тюнинг.
3. **Какой из 6 disk-ресурсов соответствует каждой целевой секции?** Рекомендация: gguf-disk → 'projects' (хранение GGUF) / 'runtime-artifacts' — dev-уточнение по раскладке; rationale указывает имя ресурса.
4. **UI: advisor-блок на секцию или единый сводный?** Рекомендация: **на секцию** (под полями секции в RuntimeLimitsSettings) — пресет относится к конкретным полям; сводный — Deferred.
