# Spec Delta

## Purpose

Позволить пользователю наследовать несколько локальных провайдеров OpenCode и добавлять выбранный API-ключ без переноса секретов на площадку или потери существующей авторизации.

## ADDED Requirements

### Requirement: Complete local provider inventory
Мастер SHALL получать через выбранный мост безопасный список локальных провайдеров до выбора проекта, включая API, OAuth и записи без назначенной модели. Наличие авторизации MUST отличаться от подтверждённого ответа модели.

#### Scenario: Several providers are already configured
- **WHEN** локальный OpenCode имеет несколько провайдеров, включая OAuth и запись только в auth
- **THEN** мастер показывает их и позволяет использовать текущую настройку без повторного ввода ключей и без требования фиктивного проекта.

### Requirement: Targeted local authentication update
Добавление или изменение провайдера SHALL обновлять только явно выбранную локальную запись OpenCode. Остальные провайдеры, OAuth, неизвестные поля и ручная конфигурация MUST сохраняться. Linux путь MUST учитывать `XDG_DATA_HOME`, иначе использовать `~/.local/share/opencode/auth.json`.

#### Scenario: User adds one API provider
- **WHEN** пользователь сохраняет ключ выбранного провайдера в защищённой локальной форме
- **THEN** OpenCode на этом компьютере видит выбранную запись, а остальные локальные записи не изменяются; сайт получает только безопасное состояние.

#### Scenario: Authentication file is malformed or changed externally
- **WHEN** существующая авторизация не читается безопасно либо обнаружено конкурирующее изменение
- **THEN** мастер сохраняет исходные данные, показывает конфликт и доступное продолжение; пустой файл не подставляется автоматически.

### Requirement: Local secret boundary
В командах локальной настройки ключи, OAuth-токены и секретные значения SHALL оставаться на выбранном компьютере. Отдельный явно подтверждённый перенос личного API-ключа регулируется контрактом catalog-actionable-workflows и MUST NOT включаться открытием локального редактора или фоновой синхронизацией. Сайт, очереди, completion, чат, логи и persistent browser draft MUST не получать секрет либо его производный отпечаток. Сохранение MUST повторно проверять локальную сессию и полномочия.

#### Scenario: Local setup session expires
- **WHEN** локальная форма просрочена или доступ к компьютеру отозван до сохранения
- **THEN** сохранение отклоняется без изменения auth; UI предлагает безопасно открыть новую форму, сохраняя публичный выбор провайдера.

#### Scenario: User chooses a local provider
- **WHEN** пользователь наследует локальную авторизацию
- **THEN** отдельный импорт моделей и ключей на сервер не включается автоматически, а платный запрос модели требует отдельного явного запуска.

#### Scenario: Global metadata read while setup is disabled
- **WHEN** `computer_setup` выключен, но выбранный компьютер, учётная запись и роль по-прежнему разрешают чтение
- **THEN** фиксированное чтение безопасного inventory и квитанций доступно; открытие новой приватной формы и каждое сохранение требуют включённых `computer_setup` и `computer_connections`.

### Requirement: Fresh supported authentication owner
Открытие приватного редактора и каждое сохранение SHALL проверять обычную команду OpenCode из текущего PATH с точной поддержанной версией1.14.48. Bundled probe, SDK и прежняя серверная квитанция MUST не заменять эту проверку. Публикация каждого локального файла SHALL повторно проверять полномочия, текущий executable и его отпечаток. Правило совместимости auth-адаптера MUST иметь отдельного владельца версии от установщика CLI.

#### Scenario: Ordinary OpenCode changed after opening
- **WHEN** команда пропала, заменена или больше не соответствует поддержанной версии перед сохранением
- **THEN** запись отклоняется до нового durable intent и публикации auth/config; чтение прежних файлов остаётся доступно.

#### Scenario: A known unsupported version is installed
- **WHEN** текущая наблюдаемая версия обычного OpenCode известна и отличается от1.14.48
- **THEN** мастер показывает прежние файлы без заявления об эффективной авторизации, блокирует приватную запись и предлагает явный переход к настройке в OpenCode; неизвестная версия не подтверждает готовность.

### Requirement: Explicit local partial-write reconciliation
Двухфайловое сохранение SHALL иметь приватный durable intent с точными локальными before/after данными. Публичная квитанция MUST не содержать этот intent, значения auth или их производные отпечатки. Потеря ACK SHALL не создавать новое открытие окна или повтор уже опубликованного файла. Наличие настройки MUST не объявляться проверенным ответом модели.

#### Scenario: Config saved but auth publication interrupted
- **WHEN** конфигурация нового провайдера опубликована, а перед записью auth полномочия отозваны
- **THEN** исход объявлен частичным; новая мутация заблокирована, явное восстановление проверяет точные before/after и публикует только оставшуюся часть после свежего разрешения, либо сообщает конфликт без перезаписи.

#### Scenario: An acknowledged open job later returns receipt404
- **WHEN** браузер уже сохранил UUID принятого открытия, но чтение его квитанции возвращает404
- **THEN** сохраняются request/job UUID и путь повторного чтения; повтор открытия и новый requestKey остаются заблокированы.

#### Scenario: Bridge stops during an admitted file publication
- **WHEN** локальная сессия закрывается, пока публикация auth/config уже выполняется
- **THEN** новое исполнение блокируется, ожидание сетевого разрешения отменяется, а graceful close дожидается всех начатых файловых операций перед разрешением обновления моста; HTTP close не ожидает собственный обработчик.

### Requirement: Retired automatic credential export
Автоматическая синхронизация моделей SHALL передавать только метаданные без чтения локальной авторизации. Контекст MUST возвращать `transferCredentials:false`, а снимок с непустым `credentials` SHALL отклоняться до сохранения. Прежнее разрешение и зашифрованная история MUST сохраняться.

#### Scenario: Existing computer previously allowed credential export
- **WHEN** старое разрешение сохранено, мост перезапущен или пользователь меняет настройку синхронизации метаданных
- **THEN** новый контекст и фоновый процесс не читают и не передают ключи, настройка метаданных не переписывает старое разрешение и зашифрованные записи, а интерфейс предлагает каждому пользователю собственный раздел «Мой доступ» без переключателя экспорта.

#### Scenario: Old bridge submits credentials
- **WHEN** bridge endpoint получает непустые `credentials`, в том числе при прежнем разрешении
- **THEN** он отклоняет весь снимок без новых моделей, соединений, источников, событий или обновления настроек.

#### Scenario: Metadata import uses personal remote authentication
- **WHEN** метаданные создают серверное подключение модели либо новую ревизию автоматически поддерживаемого подключения
- **THEN** новый режим авторизации равен `required` при известном локальном ключе и `optional` в остальных случаях; явно сохранённый режим текущего подключения сохраняется. Прежний общий ключ остаётся в своей исторической строке без расшифрования и копирования, а отсутствие личного ключа не становится общей ошибкой провайдера.

#### Scenario: Metadata import overlaps dispatch or manual configuration
- **WHEN** отправка держит свежие полномочия до завершения quota claim либо ручная настройка уже владеет провайдером
- **THEN** импорт ожидает тот же provider fence до блокировки модели, сохраняет семантическую идентичность и историю, а уже допущенный запрос не ждёт завершения ответа провайдера для освобождения этого fence.

### Requirement: Versioned inventory scope and safe partial explanations
Inventory SHALL describe only global V1 files under HOME/XDG, not effective V2 authorization. Unknown versions MUST NOT confirm readiness. Known versions other than 1.14.48 SHALL retain legacy-file reading and manual continuation without enabling writes.

See [pinned primary evidence](../../opencode-provider-version-evidence.md).

#### Scenario: Inventory contains known issue codes
- **WHEN** inventory содержит одну или несколько известных причин неполного чтения
- **THEN** UI показывает фиксированные понятные причины и следующий шаг без исходных ошибок, путей, значений окружения, ключей и отпечатков; пустой частичный список не объявляется отсутствием настройки.

#### Scenario: Unsupported CLI with partial legacy inventory
- **WHEN** известная версия CLI отличается от1.14.48 и прежние файлы прочитаны частично
- **THEN** запись остаётся запрещённой; UI объясняет ограниченность чтения и доступность ручного продолжения, не обещая эффективную авторизацию V2 и не утверждая, что продолжение запрещено.

### Requirement: Separate OpenCode 2 stored-account adapter
OpenCode 2 SHALL use the explicit `opencode-v2-accounts` adapter and exact tested CLI/server version2.2.2. It MUST require capability `opencode-v2-accounts-2.2.2` and default-OFF flag `opencode_v2_accounts` for opening and writing. V1 behavior remains separately versioned. Reading existing safe account inventory and history SHALL remain possible when the write flag is OFF, subject to fresh access rights.

#### Scenario: Read registered V2 accounts
- **WHEN** the bridge discovers a private regular managed-server registration and verifies loopback address, authenticated server version/PID and OS process owner/birth
- **THEN** it reads credential metadata without starting a server or initializing project integrations; public output contains only integration IDs and API-key/OAuth/external-presence booleans, with fixed safe issue codes. It MUST NOT contain keys, account IDs, labels, fingerprints or server credentials, and MUST NOT claim effective project configuration or model readiness.

#### Scenario: Add a supported V2 API-key account
- **WHEN** the user explicitly prepares and confirms an Anthropic API-key account in the private local form
- **THEN** the bridge rechecks permissions, CLI/server identity and observed inventory, persists a private intent with one fixed credential ID, and creates only that account. Existing accounts are preserved. The form explains that upstream activates the first account even with `activate:false`; replacing keys, deleting accounts and editing provider configuration are not supported by this slice.

#### Scenario: Unknown save acknowledgement
- **WHEN** the create response is lost
- **THEN** recovery reads the same credential ID and compares its private value before declaring success or retrying with that same ID; it MUST NOT create another ID. A changed server registration blocks the previous intent without writing to the replacement server. Cross-process atomic CAS against arbitrary external writers is not claimed.

#### Scenario: Input changes during preparation
- **WHEN** the user changes the key while a prepare response is pending
- **THEN** that late response cannot enable saving the previous key; the current input remains available for a new explicit preparation.
