# Tasks

## 1. Policy and administration

- [x] 1.1 Ввести shared DTO/defaults/ceilings и проверку взаимных ограничений; проверить malformed/unsafe values и максимальный JSON wire budget.
- [x] 1.2 Добавить Catalog49, fresh MainAdmin CAS, аудит, exact request receipts, effective/internal endpoints и флаг редактора; проверить unit и isolated PG stale/revoked/lostACK/OFF.

## 2. Runtime consumers

- [x] 2.1 Подключить снимок политики к text upload/search/excerpt и accepted receipts, расширив схему additive migration; проверить уменьшение лимита после lostACK, конкуренцию revision и сохранение semantic baseline.
- [x] 2.2 Подключить GGUF provider к central policy; проверить, что новая операция получает обновлённую политику, принятая сохраняет свой снимок.

## 3. User interface

- [x] 3.1 Добавить компактную Ant Design форму администратора с ranges/units, сохранением draft, conflict и exact retry; проверить компонентные сценарии и типы.
- [x] 3.2 Подключить effective text policy к пользовательскому вводу и чтению квитанций совместно с UI owner; проверить лимиты на уровне реального HTTP и браузера.

## 4. Inventory and evidence

- [x] 4.1 Документировать существующие token/model-reserve/storage/rate/maintenance owners и оставшиеся product limits с конкретными файлами; проверить каждую ссылку.
- [x] 4.2 Собрать отдельные unit/PG/HTTP/UI свидетельства с SHA и обновить задачи только после проверок.

## 5. Remaining product limit slices

- [ ] 5.1 Согласовать и подключить оставшиеся лимиты параллельных работ, очередей и таймаутов к их runtime owners; проверить admission, cancel и принятые lease при изменении политики.
- [ ] 5.2 Согласовать оставшиеся размеры истории, вложений и контекста с квотами и UI owners; проверить transport/database worst cases и сохранность истории.
- [ ] 5.3 Проверить полноту всех product-limit consumers по inventory, включая существующие token reserve/quota и storage forms; отчёт не должен приравнивать первые text/GGUF срезы ко всему приложению.
- [ ] 5.4 Расширить индекс больших текстовых документов через отдельные части без потери слов на границах; доказать full-file retrieval и квоту прежде чем повышать file ceiling сверх128KiB.

Проверка первых text/GGUF срезов: authored receipts `.run/runtime-limits-20261029/verification-receipt.json` и Root report `docs/reports/knowledge-hosting-acceptance-2026-10-29.md`. Реальный UI сохраняет политику и применяет её после reload; прежняя text receipt читается при OFF. Остальные product-limit consumers перечислены разделом5 и не объявлены завершёнными.
