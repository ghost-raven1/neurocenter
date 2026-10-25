# Приватные системные задачи из существующего чата: backend40

Основание: `feature/unified-chat-roles-20261025`, base `a3feb480`. Основной checkout main этим срезом не изменён. Frontend, браузер и полный регресс проекта подтверждаются отдельно.

Сохранённый личный или групповой диалог модели и комната проекта получают каноническую привязку к одному личному `system_role_dialog` на пользователя. Общие сообщения не публикуются. Привязка хранит только неизменяемые идентификаторы, владельца и проект; текст чата и приватные параметры не копируются. Два одновременных bind сериализуются advisory lock и ограничением UNIQUE NULLS NOT DISTINCT. Для общего project room ключ включает project_id. Пустая общая комната остаётся виртуальной: запуск задачи не создаёт shared room или сообщение. Canonical ID проекта проверяется существующим chatProject, включая ручные и legacy идентификаторы.

GET `/api/chat-system-roles/origin?kind&originId&projectId` возвращает собственный `SystemDialog|null`. POST того же пути с `{kind,originId,projectId}` возвращает существующий либо атомарно создаёт один private dialog с привязкой. Исполнитель требует актуальный admin-level3 для новой связи, проверяет исходного владельца/комнату, канонический проект, флаги `chat_system_roles`, `system_role_chat` и исходного чата. Именованные проектные комнаты дополнительно требуют `project_chat_dialogs`; PRIVATE room не предоставляет главному администратору неявного членства.

Существующий bind replay и private history доступны с текущими правами чтения при выключенных флагах или исчезнувшем исходнике. Новые prepare/send, runtime checkpoint и apply снова проверяют origin. Откат подтверждённых изменений, cancellation и exact accepted request recovery не получают нового origin gate. Старый `StartRoleRun.source` и прежние миграции не расширены. Legacy service dialogs без привязки сохраняют прежнюю семантику.

Проверено:

- 27/27 mocked сценариев в `chat-system-roles.test.ts`, `system-role-chat.test.ts`, `system-role-application.test.ts`. Проверены owner/scope, relevant flags, отсутствие implicit PRIVATE membership, отказ до сбора контекста, apply checkpoints и rollback.
- 8/8 targeted PostgreSQL-сценариев, 0 пропусков: одновременный bind, nullable uniqueness, immutable UPDATE, чужой источник/неверный проект, default room в двух проектах, PRIVATE access, OFF/demotion/deletion recovery, отсутствие orphan dialog после отказа. Реальная SQL-транзакция, без модели или внешних API.
- PostgreSQL16.14: 16 физических фактов migration40 измерены на явно принадлежащем root QA PostgreSQL с loopback-портом, отличным от5432. Прежние физические факты сохранены.
- Миграции0–40: 41 запись ledger; прежние checksums0–39 сохранены, полный current-schema readiness пройден. Собственные UUID-базы удалены; общий QA-контейнер не останавливался. Основной PostgreSQL не использован.

Локальные свидетельства: `.run/chat-system-roles-verification/schema-receipt.json`, `ledger-receipt.json`, `postgres-tests.json`. Для повторения measurement использует `CHAT_SYSTEM_ROLES_TEST_ADMIN_URL`, `scripts/test/chat-system-roles-measure-contract.mjs --verify-all`; targeted SQL — `test/chat-system-roles-postgres.test.ts` с тем же явно переданным owned URL. Учётные данные в отчёт не включаются.

Ограничения: эти результаты не подтверждают browser acceptance, все функции workspace, CI/deploy, production или paid inference. Вызовы модели при проверках не выполнялись. Подключение actual tools обычным агентам и расширенный подробный ответ системных ролей относятся к следующему срезу.
