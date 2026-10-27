# Design

## Context

См. proposal.md и принятый `project-agent-full-cycle`. DeviceJobs уже фиксирует выбранный compiled agent/model/target и управляет lease, durable receipt и идемпотентностью. ProjectChat имеет права проекта, отдельные PUBLIC/PRIVATE комнаты, неизменяемое авторство сообщений и постраничную историю. Native протокол методики строгий и не нуждается в идентификаторах чата.

## Goals / Non-Goals

**Goals:** связь фактического выполнения с исходным сообщением, общий безопасный результат и честное восстановление без второй inference очереди.

**Non-Goals:** универсальный runtime чатовых инструментов, автоматический запуск от текста модели, новая ветка ProjectChatRunner, общий доступ к личной очереди компьютера и персональная изоляция project plugins.

## Decisions

1. Browser добавляет `workflow.origin={roomId,messageId}` только для selected-agent режима. Сервер валидирует уже существующее `kind=user` сообщение и текущие room/project grants. Исходное сообщение может принадлежать другому участнику: администратор явно запускает задачу от общей реплики; инициатор исполнения фиксируется отдельно от автора.
2. Аддитивная таблица с FK к заданию и composite FK к сообщению хранит origin вне bridge payload. Узкий post-insert hook существующего enqueue пишет связь в той же транзакции; request hash включает origin. Exact replay выполняется до новых feature gates. Альтернатива с новым protocol capability не нужна для серверной связи.
3. Read/history после существующей chat ACL добавляет одну новейшую карточку каждого source и отдельный history cursor. Остальные записи читаются страницами не более8 из scoped endpoint: cursor обязан относиться к тому же source/room/project. Нормализованный результат публикуется в server-only snapshot после fresh origin ACL с блокировками. При отзыве доступа publication становится withheld, без сырых текстов ошибок. Уже опубликованная квитанция остаётся историей для действующих читателей комнаты.
4. Завершение реальной локальной работы и публикация в чат имеют отдельные исходы: отказ публикации не создаёт повтор модели или бесконечный rejected ACK. Существующие проверки успешного job completion не ослабляются. Claim/authorize для связанного задания дополнительно проверяют origin и новый флаг.
5. UI действие у сообщения открывает reused AgentMethodWorkflow в keyed modal. Draft key включает auth/project/room/message; initial instruction применяется лишь при отсутствии сохранённого draft. Pending intent содержит exact origin, target, agent revision и request key. Обычный composer не меняет свой draft.
6. `project_agent_chat_workflows` default false зависит от `project_agent_workflows` и `project_chat`. Новое создание проверяется владельцем после replay lookup; OFF сохраняет чтение, recovery и отмену. Отмена method job использует существующий poll-stop и защищает terminal state от позднего success.
7. Для общего origin результата принимаются только существующие UI presets `npm test`, `npm run typecheck`, `npm run check`. Произвольные argv остаются у приватного legacy метода: секретные аргументы не должны стать общим результатом из-за автоматической публикации. Потерявший право запуска владелец с действующим правом чтения сохраняет разрешённую отмену своего задания.

## Risks / Trade-offs

- Закрытая история → same-room FK, текущая ACL при чтении/admission/publication; идентификатор компьютера не открывает его очередь.
- Повтор или потеря ответа → атомарная связь и request hash, отдельный scoped pending; без скрытой повторной генерации.
- Изменение model/agent/binding → принятый selected-agent snapshot и текущие guard остаются обязательными.
- Большая история → одна карточка на source разрешённой страницы, bounded cursor history и индекс по source; число новых задач искусственно не ограничивается.
- Браузерные fixtures → отдельно фиксируются unit, реальная SQL транзакция и Chromium; они не являются live/CI/installed runtime доказательством.

## Migration Plan

Миграция45 добавляет связь и контракт измеряемой схемы без переписывания сообщений или старых bridge jobs. Обновить Catalog/Gateway/flags/frontend, затем явно включить флаг. Rollback выключает новые admissions и сохраняет таблицу истории; протокол и установленный мост для этой связи не обновляются.
