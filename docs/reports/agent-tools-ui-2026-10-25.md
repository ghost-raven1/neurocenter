# Тонкий UI инструментов обычных агентов

Ветка `feature/agent-tools-ui-20261025`, база `921979e`. Это отдельный frontend срез; backend/shared grant parser и миграция 42 принадлежат другому исполнителю. Для рабочего сквозного запуска нужны его immutable commit и совместная приёмка.

Контракт согласован с backend: `GET /api/agent-tools/capabilities?projectId` возвращает реальные доступность, причины, подходящие embedding-модели с точными pins и пределы. UI не выводит capability из промпта. MCP показывается недоступным. Открытие выполняет только чтение metadata; не создаёт чат, задачу, индекс или inference.

Новый нетронутый draft текущего проекта включает доступные RAG и безопасную системную помощь. Постоянная подпись сообщает о трёх дополнительных шагах на ответ и возможной дополнительной стоимости модельного/embedding запроса. Вне проекта источники не наследуются. Ручное выключение, clear и выбранная версия модели сохраняются при refresh. Неизвестная доступность блокирует выбранный инструмент, сохраняя возможность явно выключить его и продолжить обычным сообщением.

Публичный поиск включается явно, выбирает первую подходящую модель только для нетронутого draft и требует отдельного согласия на передачу запроса/публичных сообщений. Pin доступен под disclosure. Изменившаяся версия не подменяется новой; отсутствие модели даёт ссылку на настройку. Ограничение сохранённого grant конкретным roomId не расширяется при редактировании других полей.

Существующие controls общего composer используются для источников: отдельной формы ролей или второй переписки нет. Старый research и agentTools взаимоисключаются. Оба выбора и текст сохраняются, пока человек явно не выберет способ. Hook дополнительно отвергает одновременную передачу, не отправляя запрос.

Grant передаётся в личный, групповой и командный owners. Optimistic turn и pending intent содержат копию exact grant. Повтор использует прежние request key, адресатов и grant, а не текущее состояние widgets. Неизвестное подтверждение сохраняет public consent для точного replay. Только подтверждённое принятие закрывает публичный поиск для следующего сообщения; поздний callback не меняет отредактированный draft другого owner.

История шагов доступна под disclosure через abortable GET `/api/agent-tools/steps` и `/steps/:id`, независимо от execution flag. Показаны реальные сохранённые состояния, включая UNKNOWN и закрытый автоматический повтор. Подробности открываются отдельным чтением, без нового исполнения. Backend остаётся владельцем current ACL, PUBLIC visibility, authority и проекции private diagnostics.

Локальные свидетельства без живых model/MCP/user-file вызовов:

- 247/247 в 14 scoped suites, 0 failed/skipped: `/private/tmp/agent-tools-ui-final.json`. Включены actual React/Ant Design DOM/StrictMode для single, group и team; pin/consent, frozen replay, OFF receipt recovery, late actor ACK, stale project capability, история, research conflict и прежние chat hooks.
- После последних небольших UI правок focused 13/13 в 3 новых suites: `/private/tmp/agent-tools-ui-focused-final.json`.
- Frontend TypeScript noEmit и `git diff --check`: GREEN.
- Wire assertions проверяют фактический body model/team API и read-only capability/history routes.

Непроверено этим срезом: совместный запуск immutable backend42, реальная модель, installed bridge, native tools/MCP, ручной браузер, CI и production. Backend worker отдельно исправляет shared projection и проверяет, что project-chat не читает личные bridge/queue данные инициатора; его PG receipts не являются свидетельством frontend проверки и должны войти в совместную приёмку.
