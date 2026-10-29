# Tasks

## 1. Файл и контракт

- [x] 1.1 Добавить shared DTO, raw route и серверный parser; проверить валидные и повреждённые GGUF fixture-тестами.
- [x] 1.2 Добавить потоковую запись с SHA, лимитом, fsync и nofollow; проверить обрыв, overflow, checksum, неизменность файла.

## 2. Durable control plane

- [x] 2.1 Добавить отдельную миграцию 48 и readiness; проверить SQL на собственном disposable Postgres после согласования очереди.
- [x] 2.2 Реализовать create/read/cancel/accept с актуальными ACL, epoch, lease, capacity и идемпотентностью; проверить целевыми тестами.
- [x] 2.3 Подключить raw Gateway и флаг gguf_import с сохранением OFF receipt/read/cancel; проверить маршрут и policy.

## 3. Runtime activation

- [x] 3.1 Добавить отдельную миграцию 50 и устойчивое намерение runtime; проверить переходы и неопределённые ACK на собственном PostgreSQL.
- [x] 3.2 Реализовать pinned blob/create API и bounded manifest reconciliation; проверить controlled HTTP, чужой alias, body timeout и отсутствие blind retry.
- [ ] 3.3 Подключить hosting start/check/stop и fileImport pinVerified, сохранив legacy; проверить узкие regression tests и actual daemon при наличии явно выбранной fixture-модели.

## 4. Приёмка

- [x] 4.1 Проверить typecheck и узкие regression tests; записать точные ограничения runtime и доказательств.
- [x] 4.2 Получить независимое ревью diff и закрыть подтверждённые замечания; проверить OpenSpec strict.

Остаток 3.3: интеграция start/check/stop, raw-file pin и targeted legacy проверены; фактический daemon с явно выбранными реальными весами в этом срезе не запускался. Свидетельства и ограничения: `docs/gguf-hosting-import-verification-2026-10-29.md`.

## 5. Browser import

- [x] 5.1 Добавить отдельный компактный Ant Design modal: raw File, свежий лимит, серверная проверка, name/capability/accept и callback подтверждённой модели.
- [x] 5.2 Проверить UUID-only journal, reload/lost ACK, отмену/late ACK, owner/role/grants fences, OFF recovery и сохранение введённого целевыми controller/API/UI тестами.
- [x] 5.3 Получить независимое ревью UI и закрыть подтверждённые замечания; зафиксировать финальный noEmit/test/source receipt.
- [x] 5.4 Интегрировать launcher в каталог и проверить браузерную цепочку через Gateway/Catalog/PostgreSQL на собственном стенде (владелец Root).

UI source handoff: 25/25 targeted tests, frontend noEmit и OpenSpec strict PASS на Node 24.22.1; source pins неизменны. Receipt: `.run/gguf-ui-final-adf84577-c761-4d0b-b890-9f0d7cce0a0c/receipt.json`, SHA-256 `5351b6fc4c95674ff8edb66ec5287d83d7dacbe1e54906e94f6807b8a91c52e4`. Root и независимый reviewer сверили flow; monotonic receipt и browser-reset findings закрыты RED→GREEN. Browser gate после reset-исправления отдельно у Root; prior 144-byte fixture доказывает API/catalog, не actual inference.

Root browser gate 5.4 PASS: настоящий Gateway/Catalog/PostgreSQL, загрузка синтетического144-byte GGUF, accept→catalog, повторное открытие, новый импорт, повреждённый файл и отмена. Обнаруженный reset-bug воспроизведён и закрыт повтором через UI. Реальная inference остаётся отдельным gate3.3.
