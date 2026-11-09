---
title: 'FR-601: GGUF-импорт из архива (.tar.gz) + фикс E1 nginx 413 (owner: nginx-template)'
type: 'feature'
ticket: '3'
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
  - _bmad-output/initiative-architecture/tickets/epic-project/epic-project.md
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
  - _bmad-output/initiative-architecture/ux/REVIEW-2.md
  - _bmad-output/initiative-architecture/ux/DESIGN.md
  - _bmad-output/initiative-architecture/.memlog.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Два gap FR-601. (a) «GGUF или архив» — сейчас принимается ТОЛЬКО один .gguf: `ggufIntent` (gguf-import.model.ts:45-72) требует `item.fileName.toLowerCase().endsWith('.gguf')` (:54); архив (.tar.gz) не поддерживается — FR-601: «Веса для хостинга добавляются вручную из GGUF или архива». (b) E1 P0 (UX-аудит 2-й линзы, REVIEW-2.md): nginx `client_max_body_size 50m` (frontend/nginx.production.conf.template:18) и `location /api/` (:65-71) наследуют 50m, а политика импорта — до 64GB (shared/gguf-import-policy.cjs maximumBytes) → любой реальный GGUF/архив получает **413 Request Entity Too Large на прокси** ещё до сервиса. Это тупик (NFR-3): пользователь не может импортировать ни один реальный weights-файл.

**Approach:** (1) **Фикс E1 (owner зафиксирован = nginx-template):** добавить `location /api/models/gguf-imports/ { client_max_body_size 8g; proxy_request_buffering off; proxy_http_version 1.1; proxy_pass http://api-gateway:4000; ... }` по образцу архивного `location = /api/asset-sources/archive` (:46-56, там 8g + proxy_request_buffering off). (2) **Архив:** принять .tar.gz с GGUF внутри — серверная распаковка, SHA-256 по архиву И по извлечённому GGUF, строгая проверка формата (архитектура/тензоры/quant, gguf-inspection.ts), квота+retention импорта (gguf-import-policy.cjs), preparation и activation — отдельные явные действия (существующий WAITING→UPLOADING→READY→ACCEPTED, gguf-import.service.ts), per-version runtime-теги. **Стык (не дубликат):** epic 2 entry 9 задаёт body-budgets route-policy; здесь — nginx-template owner для /api/models/gguf-imports/ (конкретный location-блок в шаблоне), не route-policy.

## Boundaries & Constraints

**Always:**
- Fiks E1 = location-блок в `frontend/nginx.production.conf.template` (owner = nginx-template), по образцу :46-56 (8g + proxy_request_buffering off + proxy_http_version 1.1).
- SHA-256: и по архиву (.tar.gz), и по извлечённому .gguf (оба в receipt).
- Строгая проверка формата (gguf-inspection.ts: архитектура/тензоры/quant) — повреждённый/чужой архив = отклонён.
- Preparation и activation — отдельные явные действия (существующий state-machine gguf-import.service.ts), без автоматической активации.
- Per-version runtime-теги (существующий паттерн).
- Квота+retention импорта — по gguf-import-policy.cjs (maximumBytes, expiry, cleanup).
- 8g = interim-ceiling nginx-слоя (по образцу :46-56); серверная политика (64GB) остаётся источником лимита — nginx 8g = защита прокси, не продукт-лимит (OQ-1).

**Never:**
- Не поднимать глобальный `client_max_body_size 50m` (:18) — только конкретный location /api/models/gguf-imports/ (точечный фикс, не глобальный).
- Не дублировать body-budgets route-policy epic 2 entry 9 — здесь только nginx-template location (стык, не дубликат).
- Не активировать модель автоматически после импорта (preparation/activation — раздельно, FR-601).
- Не принимать архивы с несколькими GGUF/вложенными каталогами без явной политики (один GGUF на архив, OQ-2).
- Не раскрывать SHA/секреты импорта в логах.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | GGUF >50m через nginx | POST /api/models/gguf-imports/ файл 2GB | НЕ 413 (location 8g), дошёл до сервиса |
| 2 | .tar.gz с валидным GGUF | upload архива | Распаковка + SHA-256 архива и GGUF + проверка формата → READY |
| 3 | Повреждённый архив | .tar.gz с битым GGUF | Отклонён (строгая проверка формата/SHA) |
| 4 | Чужой/не-GGUF в архиве | .tar.gz с .txt | Отклонён (проверка формата gguf-inspection) |
| 5 | Архив > квоты | bytes > maximumBytes | Отклонён (квота gguf-import-policy.cjs) |
| 6 | Preparation vs activation | импорт завершён | Модель подготовлена (READY), активация — отдельное явное действие (ACCEPTED) |
| 7 | Повторный импорт (idempotency) | тот же request_key | no-op (существующий request_key) |
| 8 | Прямой .gguf (существующий путь) | upload .gguf | Работает как прежде (ggufIntent :54 не сломан) |
| 9 | Архив с несколькими GGUF | .tar.gz с 2 .gguf | ОQ-2 (рекомендация: отклонить, один GGUF на архив) |

</frozen-after-approval>

## Code Map

- `frontend/nginx.production.conf.template:18` — `client_max_body_size 50m` (глобальный, НЕ менять); `:46-56` — `location = /api/asset-sources/archive` (8g + proxy_request_buffering off + proxy_http_version 1.1) — ОБРАЗЕЦ; `:65-71` — `location /api/` (наследует 50m) — рядом добавить новый location.
- `services/catalog-service/src/models/gguf-import/gguf-import.model.ts:45-72` — `ggufIntent` (`.gguf`-только, `endsWith('.gguf')` :54) — расширить на .tar.gz; `:73-82` ggufAcceptance (capability, entry 1 — не трогать).
- `services/catalog-service/src/models/gguf-import/gguf-import.service.ts` — state-machine WAITING→UPLOADING→READY→ACCEPTED/CANCELLED, SHA-256, advisory locks, quota, expiry, cleanup — точка расширения (распаковка архива).
- `services/catalog-service/src/models/gguf-import/gguf-inspection.ts` — строгая проверка формата (архитектура/тензоры/quant) — переиспользовать для извлечённого GGUF.
- `services/shared/gguf-import-policy.cjs` — maximumBytes (64GB interim), expiry, cleanup — источник лимитов.
- `services/catalog-service/src/models/hosting.service.ts` — preparation/activation (entry 4 cancel — стык).
- `frontend/src/modules/Projects/` (Store/Catalog) — UI импорта модели (файл — dev-уточнение): выбор .gguf ИЛИ .tar.gz.

## Tasks & Acceptance

### Execution
- [ ] `frontend/nginx.production.conf.template` — добавить `location /api/models/gguf-imports/ { client_max_body_size 8g; proxy_request_buffering off; proxy_http_version 1.1; proxy_pass http://api-gateway:4000; proxy_read_timeout 600s; proxy_send_timeout 600s; proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Request-ID $request_id; }` по образцу :46-56 (перед `location /api/` :65, чтобы матчился первым).
- [ ] `gguf-import.model.ts:45-72` `ggufIntent` — принять `.gguf` ИЛИ `.tar.gz` (расширить endsWith-проверку :54 + имя); валидация bytes/expectedSha256 сохраняется.
- [ ] `gguf-import.service.ts` — серверная распаковка .tar.gz (один GGUF, OQ-2), SHA-256 по архиву и по извлечённому GGUF (оба в receipt), вызов gguf-inspection на извлечённом GGUF; повреждённый/чужой → отклонён.
- [ ] Квота+retention (gguf-import-policy.cjs) — применяются к архиву (bytes архива) и к извлечённому GGUF.
- [ ] Preparation/activation — отдельные явные действия (существующий state-machine, не менять); per-version runtime-теги.
- [ ] UI: выбор .gguf ИЛИ .tar.gz (Store/Catalog import-форма, файл dev-уточнение).
- [ ] Тесты: nginx (локальный прокси-тест: >50m → не 413), приёмка .tar.gz (распаковка+SHA+инспекция), повреждённый архив, чужой файл, квота, idempotency, прямой .gguf (не сломан).

### Acceptance
- **Given** GGUF/архив >50m **when** POST /api/models/gguf-imports/ **then** НЕ 413 (nginx location 8g), дошёл до сервиса.
- **Given** .tar.gz с валидным GGUF **when** импорт **then** распаковка + SHA-256 архива и GGUF + проверка формата → READY.
- **Given** повреждённый/чужой архив **when** импорт **then** отклонён (строгая проверка).
- **Given** preparation завершена **when** activation **then** активация — отдельное явное действие (READY→ACCEPTED).
- **Given** прямой .gguf **when** импорт **then** работает как прежде (ggufIntent :54 не сломан).
- Корневой сьют — без деградации.

## Design Notes

- **E1 owner = nginx-template (фиксация стыка):** UX-аудит 2-й линзы (REVIEW-2.md) подтвердил E1 P0 (GGUF 413). Owner фикса зафиксирован здесь (epic 8, FR-601) = nginx-template location-блок. Epic 2 entry 9 (route-policy body budgets) — НЕ дубликат: entry 9 задаёт политику body-budgets на уровне route-policy (сервисный слой), здесь — конкретный location в nginx-шаблоне (прокси-слой). Стык задокументирован, не дублируется.
- **8g = interim nginx-ceiling, не продукт-лимит:** продукт-лимит = gguf-import-policy.cjs (64GB). nginx 8g = защита прокси (по образцу :46-56 archive 8g). Если продукт-лимит поднимут выше 8g — nginx location поднимут синхронно (OQ-1). Не глобальный 50m (:18) — только точечный location.
- **proxy_request_buffering off:** как в :48 (archive) — большой upload не буферизуется на диске nginx (streaming в gateway). Обязательное условие для больших weights.
- **Один GGUF на архив:** FR-601 «GGUF или архив» — архив = обёртка над одним GGUF (приватный формат поставки). Несколько GGUF в архиве — не явная политика (OQ-2: отклонить).
- **Распаковка на сервере:** архив не хранится как weights — извлекается GGUF, инспектируется, хранится GGUF (архив-обёртка зачищается по retention). SHA-256 и архива, и GGUF — провенанс (R9).
- **Сык с entry 1 (FR-608):** ggufAcceptance (:79) расширяет capability в entry 1; здесь — ggufIntent (архив). Разные функции, не конфликт.
- **Сык с entry 4 (FR-602 cancel):** cancel in-flight import/prepare — entry 4; здесь preparation/activation-разделение (не менять state-machine).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
# nginx: локальный прокси-тест (большой upload не 413)
node --test scripts/test/nginx-gguf-body.test.mjs 2>/dev/null || true
cd services/catalog-service && npm test -- gguf-import
```
Ожидаемо: nginx location /api/models/gguf-imports/ (8g, >50m не 413); приёмка .tar.gz (распаковка+SHA+инспекция→READY); повреждённый/чужой отклонён; квота; idempotency; прямой .gguf не сломан; корневой сьют без деградации.

## Open Questions

1. **nginx 8g vs продукт-лимит 64GB — расхождение?** Рекомендация: **nginx 8g = interim прокси-ceiling (по образцу :46-56), продукт-лимит = gguf-import-policy.cjs**; при необходимости импорта >8g — поднять nginx location синхронно с продуктовой политикой. Обоснование: 8g покрывает реальные модели (70B Q4 ≈ 40GB — уже >8g!). **Внимание:** если целевые модели >8g — nginx location поднять до продукт-лимита (dev-решение, согласовать с entry 9 body-budgets).
2. **Несколько GGUF в архиве?** Рекомендация: **отклонить** (один GGUF на архив). Обоснование: FR-601 «GGUF или архив» = архив-обёртка над одним weights; несколько — не явная политика.
3. **Распаковка: tmp или прямая в weights-хранилище?** Рекомендация: tmp-распаковка → инспекция → перенос в weights (атомарно). Обоснование: повреждённый архив не должен оставлять частичный GGUF.
4. **UI: отдельная кнопка «архив» или один upload с авто-определением?** Рекомендация: один upload, авто-определение по расширению (.gguf/.tar.gz). Обоснование: NFR-1 простота.
