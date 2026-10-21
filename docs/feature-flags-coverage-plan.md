# Покрытие функций флагами: план, 22 октября 2026

Это карта требуемого поведения, а не заявление о готовности. В общем реестре зарегистрирована 21 возможность; исходные значения `model_hosting`, `tool_builds`, `rag_sync` сохраняются. Скрытие кнопки само по себе не является ограничением функции.

## Общая политика

- Выключение запрещает новые операции и ещё не начавшиеся внешние/платные шаги фоновых заданий. Уже начатый inference заканчивается по прежнему контракту; флаг не отменяет сохранение оплаченного ответа. ACL, выбранная версия модели и исходная ревизия проверяются независимо.
- Просмотр имеющихся данных, получение receipt по ключу, прогресс, отмена, отключение подключения, отзыв ключа, восстановление и удаление незавершённых загрузок остаются доступны. Повтор, который создаёт новое исполнение, проходит актуальную проверку всех зависимостей.
- Внешний OpenCode, самостоятельно запущенные процессы и уже установленные файлы не выключаются задним числом. Проверяется начало управляемых платформой действий и выдача новых полномочий через API.
- Управление самими флагами, вход, текущие роли, готовность сервисов и аварийное восстановление не зависят от отключаемого business-флага. Изменение флагов остаётся за главным администратором, с CAS и аудитом.
- Собственное положение переключателя сохраняется. Эффективное состояние учитывает зависимости; UI отдельно объясняет зависимость, не переписывая чужие переключатели.
- Неполный/недоступный сервис флагов не разрешает новое ограниченное действие. Проверки чтения истории и аварийного восстановления не должны обращаться к нему.

## Матрица бизнес-возможностей

Ключи и зависимости согласованы; таблица задаёт контракт каждой границы. Результаты проверок приведены отдельно ниже.

| Возможность / ключ | UI | API / обход прямым запросом | Worker / мост / зависимости |
|---|---|---|---|
| Проекты — `projects` | Создать/изменить проект | Новое создание и изменение проекта | Создание проектной инфраструктуры; просмотр, retirement/recovery остаются |
| Компьютеры — `computer_connections` | Подключить компьютер, новую общую папку/привязку | Pair/register, choose-root, prepare-bind/bind | Перед выдачей нового job; identity/heartbeat/completion/unpair/recovery доступны |
| Общий каталог инструментов — `tool_catalog` | Создать/редактировать MCP, плагины, скиллы | ai-plugins, skills publication, добавление project refs | До native publication; чтение, архив/отзыв существующих refs доступны |
| Источники ассетов — `asset_sources` | Источник, архив, выборочный импорт, bridge source | asset-sources/bridge-source и upload/import actions | Import worker до скачивания/публикации; зависит от `tool_catalog` для инструментов, `model_catalog` для моделей, `agents` для агентов, а не от всех одновременно |
| Упаковщик — `tool_builds` (existing) | Упаковать, npm/GitHub/archive/files | tool-builds, source-upload, imports/export initiation | Build runner до начала загрузки/сборки; публикация учитывает соответствующий catalog flag |
| Установка инструментов — `tool_installation` | План, одобрение, установка/обновление | install plans, device job install, retry from operations | enqueue + claim + выдача разрешения перед управляемой записью; зависит от `computer_connections`; uninstall/recovery доступны |
| Каталог моделей — `model_catalog` | Добавить/редактировать/подключить модель, параметры | models + remote connection + project assignment | Синхронизация не обходит этот флаг; отзыв credential/назначения и архив доступны |
| Использование моделей — `model_hosting` (existing) | Запустить/проверить модель, новый inference | Все OpenAI/Ollama adapters, hosting start/check, device embedding, learning analyses | Central ModelRuntime перед фактическим вызовом + локальные/удалённые verification probes; stop и статус доступны |
| Модели из OpenCode — `opencode_model_sync` | Импорт/синхронизация/явный перенос ключа | devices/:id/opencode-model-sync + internal context/sync | Background snapshot и credential transfer до записи; зависит от `model_catalog`; отключение синхронизации доступно |
| Агенты — `agents` | Общий шаблон, prompt, настройки/подключение проекта | agents + project agent mutations | configure-project-agents и авторизация доставки; disable/remove/recovery доступны |
| Личный чат — `model_chat` | Новый чат/сообщение, файлы | model-chats create/upload/send/retry (context-preview не исполняет модель) | До каждого нового actual inference, включая compaction; зависит от `model_hosting`; история/rename/delete/cancel доступны |
| Групповой чат — `group_chat` | Добавление участников, @адресат, раунд | create/convert group, participants, send/retry group | Проверять по фактическому mode из БД, не по телу клиента; каждый новый участник; зависит от `model_chat`,`agents` |
| Проектное обучение — `project_learning` | Опыт, гипотезы, проверки, одобрение | learning mutations + internal device record/observe/propose | Analysis enqueue/worker; генерация дополнительно требует `model_hosting`; просмотр/revoke/recovery доступны |
| Проектный поиск — `project_search` | Поиск по данным, RAG контекст чата | RAG search + ephemeral chat project retrieval | До embedding и получения новых snippets; зависит от `model_hosting`; off не выдаётся за пустой индекс |
| Индекс базы знаний — `rag_sync` (existing) | Обновить/переиндексировать/подключить индекс | rag/sync, reindex start/retry, device sync/connect | Catalog coordinator, RAG write-authorize и bridge job before new write; hosting embedding дополнительно требует `model_hosting`; manifest/export/read/cancel/rollback доступны |
| Полные снимки — `project_snapshots` | Создать/опубликовать/выпустить профиль | versions create, snapshot-uploads, release-profile | Publisher/verifier до нового шага; уже принятые bytes/recovery/GC не зависают; зависит от computer flag только при новом bridge job |
| Резервные копии — `project_backups` | Новая копия и расписание | backups create, schedule config | Scheduled backup до создания; просмотр/download/restore/retention cleanup доступны |
| Заявки — `catalog_requests` | Добавить/редактировать/отправить заявку, принятие | catalog-requests mutations/actions | Принятие, которое создаёт карточку, проверяет её catalog flag; чтение/отзыв заявки доступны |
| Использование моделей — `model_usage` | Dashboard и его refresh | Отчёт model-usage | Выключается только отчёт. Обязательный operational ledger продолжает записываться, как журнал аудита |
| Локальные изменения — `local_changes` | Inventory/adopt/новый план исправления | device prepare/apply-adopt/change jobs | Gate новой подготовки/принятия файлов; сравнение имеющегося отчёта, repair/restore/recovery остаются доступны |
| Инструменты исследования — `research_tools` | Явный запуск поиска/исследования | Новое сообщение с research и internal research MCP | Каждый новый tool/inference; зависит от `model_chat`, project search дополнительно требует `project_search`, внешний MCP — `tool_catalog` |
| LSP — справка; управляемого флага нет | В текущем Start есть справка, не управляемый LSP lifecycle | Самостоятельного server endpoint включения/настройки LSP в текущих исходниках нет | Нельзя заявлять выключение внешнего LSP флагом платформы. Если добавляется managed LSP flow, нужны install/configure job и before-write guard |

## Изменения и владение

1. Backend agent: срочный Learning P1; общий реестр определений/зависимостей; единая каноническая route/job policy; Gateway и серверная точка enforcement; Catalog call boundaries; unit/route/worker матрица и документация.
2. Frontend agent, после заморозки overlay: единый evaluated-state hook без stale owner, группы переключателей и зависимости в FeatureFlagsPanel; доступность действий соответствующих feature entrypoints. История и recovery не скрываются целиком.
3. Protocol agent после migration17 freeze: OpenCode global/project sync + bridge enqueue/claim/authorize и MCP tool boundaries; отсутствие ретроактивного управления самостоятельно запущенным OpenCode явно сохраняется.
4. Root/integration: RAG service write/search boundaries, backup/snapshot scheduled workers, CI/coverage wiring и независимая actual HTTP проверка. Точное разделение утверждается до параллельных правок shared files.

Единая policy должна возвращать список нужных флагов. Single-key `requiredFeatureFlag` недостаточен для group/chat+agents, RAG+hosting и импорта смешанных типов. Политика проверяется Gateway после RBAC и повторно сервером, а не только фронтом. Неизвестные пути не получают разрешение автоматически: ACL и feature policy — разные независимые проверки.

Rollout: сначала feature-flags-service регистрирует новые ключи и определения, затем обновляются потребители. Старый неполный evaluated-ответ не трактуется как «всё включено». Существующие значения трёх ключей сохраняются, новые ключи по умолчанию включены для сохранения работающих возможностей.

## Базовый план измерения покрытия

Начальный снимок перед внедрением 22.10.2026: V8/istanbul provider и coverage thresholds ещё не были подключены. Процент на момент планирования был неизвестен. Наличие тестового файла или успешный test run само по себе не является процентом покрытия. Далее внедрён закреплённый V8 provider во всех восьми пакетах; команды, ограничения методов и измеренные артефакты описаны в [coverage.md](coverage.md). Числа файлов в следующей таблице относятся к начальному снимку.

| Пакет | Исходных файлов в src | Файлов *.test.* в собственном test | Provider на момент планирования |
|---|---:|---:|---|
| frontend | 445 | 233 | нет |
| catalog-service | 353 | 188 | нет |
| api-gateway | 29 | 0 | нет; существенная часть HTTP тестов находится в scripts/test |
| feature-flags-service | 11 | 7 | нет |
| oauth2-bridge | 12 | 0 | нет; auth-security и gateway тесты находятся в scripts/test |
| rag-sync-service | 35 | 12 | нет |
| skills-service | 25 | 18 | нет |
| neurocenter-asset-sync | 148 | 88 | нет |

Порядок baseline: pinned `@vitest/coverage-v8` той же версии 4.1.12, source-map отчёты json/lcov/html по каждому пакету, include всех production src-файлов, включая ни разу не импортированные. Node native HTTP suites собирают V8 coverage отдельно как подтверждение поведения. Их c8 counters имеют другую детализацию и не объединяются с Vitest AST в сопоставимый процент; технический mixed union допускается только с явной experimental-пометкой. Декларации типов и сгенерированные schema facts учитываются отдельно, не прячут production-файлы. Артефакт обязан хранить commit/worktree identity, Node version, suite command, включённые PG/S3 фикстуры, passed/failed/skipped.

Сначала измеряется честный baseline без заявленного порога. Затем по фичам закрываются uncovered ветви, устанавливается неизменяемый минимум для исправленного пакета и differential coverage для новых изменений. Цель near100% строится по statements/functions/branches, а не одним числом lines. Для ACL, expectedRevision/digest, feature gates, idempotency, abort/recovery и SQL publication guards обязательны обе стороны каждого условия и сценарии гонки, а не только line coverage.

Для каждого флага необходимы тесты: on; off до enqueue; off после enqueue до claim; off до следующего внешнего шага; in-flight paid response сохраняется; повтор off не создаёт работу; re-enable требует явного нового исполнения; stale owner/role; canonical encoded/trailing-slash route; internal API/bridge bypass; недоступный/неполный flag service; все зависимости; доступность read/receipt/cancel/recovery/admin flags при полном off. Actual PG/S3/native HTTP/browser checks фиксируются отдельно от coverage отчёта и от production/CI результатов.

## Проверенный срез флагов

Ранний целевой срез: общая политика — 49 сценариев; прямые native guards, ModelRuntime, verification probes и worker boundaries — 20 сценариев; Gateway — 92 сценария, включая выключение и повторное включение каждой из 21 возможности без перезапуска. Отдельная snapshot receipt regression сохраняет status/completion при выключении и блокирует новую передачу файлов. Сервис флагов: 55 лёгких проверок и 17 проверок миграции на отдельной PostgreSQL. Позднейшие расширенные наборы сохраняются в coverage manifest, а не подменяют этот исторический срез. Ни эти результаты, ни число файлов не являются общим процентом покрытия или production acceptance.
