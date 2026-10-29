# Spec Delta

## Purpose

Позволяет главному администратору принять выбранный GGUF в каталог моделей, сохранив происхождение, проверку файла и квитанцию при повторах и отказах.

## ADDED Requirements

### Requirement: Bounded authenticated file import
Система SHALL принимать GGUF от действующего главного администратора потоком в пределах настроенного лимита (по умолчанию 64 ГиБ), вычислять SHA-256 и повторно проверять права перед фиксацией.

#### Scenario: Interrupted or revoked upload
- **WHEN** поток оборван, отменён или права отозваны
- **THEN** система не возвращает READY и допускает безопасный повтор при сохранённых правах

### Requirement: Honest structural validation
Система SHALL проверять GGUF v2/v3 LE, метаданные, границы тензоров и обязательную архитектуру; split, adapter и projector отклоняются с понятной ошибкой.

#### Scenario: Invalid tensor extent
- **WHEN** тензор выходит за границы файла
- **THEN** файл не принимается в каталог

### Requirement: Durable idempotent acceptance
Система SHALL закреплять requestKey за неизменным intent и создавать не более одной карточки модели на принятую загрузку. Отмена конкурирует с приёмкой под одной блокировкой.

#### Scenario: Lost acceptance response
- **WHEN** клиент повторяет те же параметры приёмки
- **THEN** возвращается та же карточка модели без второго создания

#### Scenario: Accepted source cancellation
- **WHEN** клиент пытается удалить уже принятую загрузку
- **THEN** система сохраняет источник модели и возвращает конфликт

### Requirement: Feature disable preserves receipts
Система SHALL запрещать новые изменения при выключенном gguf_import, сохраняя разрешённое чтение, отмену и точный повтор принятой операции.

#### Scenario: Flag OFF after accepted operation
- **WHEN** флаг выключен после успешной приёмки
- **THEN** владелец с актуальными правами получает прежнюю квитанцию и ту же карточку по точному повтору

### Requirement: File identity is distinct from runtime identity
Карточка SHALL содержать fileImport с фактическими SHA, размером, именем, архитектурой и версией, runtime ollama и source custom. manifestSha256 остаётся null до реальной проверки runtime.

#### Scenario: Freshly accepted GGUF
- **WHEN** файл принят в каталог
- **THEN** система не объявляет runtime-ready и не скачивает веса или runtime автоматически

### Requirement: Configurable admission snapshot
Система SHALL предоставлять настраиваемые лимиты загрузки, parser и runtime и сохранять их снимок в принятом запросе. Последующее изменение настроек применяется к новым импортам.

#### Scenario: Policy reduced during a pending upload
- **WHEN** администратор уменьшает размер нового импорта после создания квитанции
- **THEN** принятый запрос сохраняет прежний размер и ограничения, новый получает обновлённые лимиты

### Requirement: Explicit local runtime activation
Система SHALL активировать GGUF только в настроенном Ollama 0.35.1 через blob и files-create, сохраняя чужие alias и отдельно проверяя manifest и реальный ответ модели.

#### Scenario: Engine absent
- **WHEN** Ollama недоступен или имеет несовместимую версию
- **THEN** система сообщает о необходимости настройки и не скачивает runtime или веса

#### Scenario: Successful checked activation
- **WHEN** manifest содержит слой принятого GGUF и probe подтверждает назначение модели
- **THEN** карточка закрепляет фактический manifest SHA и для embedding фактическую размерность

### Requirement: Ambiguous creation never blindly repeats
Система SHALL сохранять намерение до отправки create и разрешать потерю ответа через manifest с точным file SHA и повторную сверку tags. Неопределённый результат не вызывает второй create.

#### Scenario: Lost create response with a late manifest
- **WHEN** ответ create потерян, но позже появляется совпадающий manifest
- **THEN** повторная проверка восстанавливает ту же модель без повторного create

#### Scenario: Existing foreign alias
- **WHEN** выбранное собственное имя уже существует без квитанции нашей отправки
- **THEN** система возвращает конфликт и сохраняет чужую модель

### Requirement: Recoverable browser file import
Интерфейс SHALL передавать выбранный браузерный File как raw body, показывать свежий серверный лимит перед новым допуском и отделять передачу, проверку GGUF, создание карточки и runtime-ready. Локальный журнал SHALL хранить только requestKey в области текущего пользователя, активной роли и API; File и ключи провайдеров не сохраняются.

#### Scenario: Reload after a lost response
- **WHEN** пользователь перезагрузил страницу после потери ответа загрузки
- **THEN** интерфейс проверяет прежний requestKey без повторной передачи READY-файла; для незавершённой передачи просит тот же локальный файл

#### Scenario: Late response after grants change
- **WHEN** права пользователя изменились, а ответ прежней передачи пришёл позже
- **THEN** ответ не меняет новое состояние; тот же пользователь и активная роль сохраняют квитанцию для восстановления

#### Scenario: Corrupt or concurrently changed browser journal
- **WHEN** журнал повреждён или другой вкладкой заменён номер запроса
- **THEN** интерфейс сохраняет исходные данные и блокирует незаметную перезапись либо очистку

#### Scenario: Feature disabled during recovery
- **WHEN** импорт выключен при незавершённой загрузке
- **THEN** интерфейс сохраняет проверку состояния и отмену до приёмки, запрещая новую передачу и приёмку READY-файла

#### Scenario: Stale receipt after a terminal result
- **WHEN** поздний ответ возвращает прежнее состояние после READY, CANCELLED или ACCEPTED
- **THEN** интерфейс отвергает регресс; новый импорт после завершения явно очищает прежние File, карточку и квитанцию
