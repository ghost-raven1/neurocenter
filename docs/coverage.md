# Измерение покрытия

Восемь пакетов используют закреплённые `vitest@4.1.12` и `@vitest/coverage-v8@4.1.12`. Общая конфигурация `services/shared/test-coverage.mjs` включает все production-файлы `src`, включая ни разу не импортированные, и общий JavaScript в `services/shared`. Исключены declarations и сам конфиг отчёта. Искусственного порога100% нет.

Это настроенный знаменатель восьми пакетов и shared. Production CLI и установщики пока не имеют полной общей инвентаризации покрытия; этот отчёт не измеряет весь исполняемый код репозитория. Цель около 100% по всем модулям остаётся открытой в [бэклоге](backlog-2026-10-22.md).

Запуск требует проектный Node24. Каждый замер пишет новый каталог, не заменяя прежнее доказательство:

```sh
npm ci --ignore-scripts --prefix scripts/coverage
node scripts/coverage/run.mjs --output .run/coverage/workspace-baseline
node scripts/coverage/run.mjs --package catalog-service --output .run/coverage/catalog-baseline
```

Первый шаг ставит отдельный набор закреплённых инструментов отчёта. Он выполняется после обычной установки зависимостей восьми приложений; корневой `npm ci` сам по себе этот отдельный пакет не устанавливает. Runner не запускает сетевую установку автоматически. В CI этот шаг также должен быть явным.

По умолчанию профиль `unit-safe` удаляет из дочернего процесса переменные PostgreSQL/S3 и тестовые admin URL. Наборы, которые могут включить инфраструктуру через fallback, консервативно исключаются по имени файла, импорту или обращению к окружению. В их число могут попасть и SQL-mocked unit-тесты; точные имена перечислены в manifest. Количество исключённых файлов не выдаётся за число пропущенных тестов.

## Native HTTP и реальные базы

Native-профиль собирает V8 coverage с отдельных Node HTTP-проверок собранных сервисов. Он использует явный список сценариев, без подключения внешних баз:

```sh
node scripts/coverage/run.mjs --no-unit --native --output .run/coverage/native-http
```

После свежих согласованных сборок Catalog/Gateway/RAG можно отдельно запустить реальные интеграции. `MODEL_CHAT_TEST_ADMIN_URL` обязателен: только собственный PostgreSQL `127.0.0.1`, порт отличный от5432, административная база `/postgres`. Fixtures сами создают случайные базы, закрывают соединения и удаляют только их штатным DROP. У runner нет значения PostgreSQL по умолчанию.

```sh
MODEL_CHAT_TEST_ADMIN_URL='<URL своей одноразовой PostgreSQL>' \
MODEL_CHAT_TEST_STORAGE_CONFIG='<абсолютный путь к JSON своей QA S3>' \
node scripts/coverage/run.mjs --no-unit --integration --output .run/coverage/owned-integration
```

S3-конфигурация опциональна, но без неё проверка файлов отмечается как исключённая, а полный запрошенный набор не получает `complete:true`. Допускается только явно заданный локальный S3; endpoint основного хранилища19010 запрещён. В конфиге нужны `CHAT_S3_ENDPOINT`, `CHAT_S3_REGION`, `CHAT_S3_ACCESS_KEY`, `CHAT_S3_SECRET_KEY` и отдельные `CHAT_S3_PROJECT_BUCKET`/`CHAT_S3_PERSONAL_BUCKET`. Секреты не сохраняются в manifest.

HTTP-интеграции выполняются последовательно: чаты, сжатие, группы, проектный RAG, общий список, ledger, синхронизация OpenCode, квоты, архивирование, компиляция агентов, hosted MCP, исследовательский MCP и переключение21 флага. С S3 добавляется документный флоу. Список закреплён в `scripts/coverage/profiles.mjs`; он не означает, что запущены все PostgreSQL-тесты проекта.

Полные Vitest-наборы Catalog, RAG и флагов запускаются отдельным opt-in профилем:

```sh
MODEL_CHAT_TEST_ADMIN_URL='<URL своей одноразовой PostgreSQL>' \
MODEL_CHAT_TEST_STORAGE_CONFIG='<абсолютный путь к JSON своей QA S3>' \
node scripts/coverage/run.mjs --owned-pg --output .run/coverage/full-owned-pg
```

Здесь PostgreSQL и S3 обязательны, инфраструктурные файлы не исключаются. Runner заполняет все проверенные fixture aliases одним административным QA-адресом. Для runtime fallback URL создаётся отдельная случайная база `nc_cov_*`; стандартные переменные PostgreSQL также указывают на неё. Обычный DROP после закрытия соединений удаляет только эту базу. Сами fixtures владеют своими случайными базами и bucket-ами. Полный набор использует один worker, timeout теста 30 секунд и hook timeout 60 секунд. Перед полным запуском по-прежнему требуется больше 8 GiB свободного диска. Snapshot S3 fixture теперь использует явно заданную собственную S3-конфигурацию; временный MinIO запускается только с `SNAPSHOT_S3_TEST_SPAWN_DOCKER=1`, уникальным именем/портом и отдельной проверкой диска. Неявного обращения к основной PostgreSQL или запуска Docker больше нет.

Зависимость флагов для этих DB fixtures — отдельный локальный HTTP-сервис с полным evaluated snapshot. Отрицательные тесты по-прежнему задают свои off/revoke ответы. Это подмена внешней зависимости, а не SQL: ограничения, блокировки, миграции и данные исполняются настоящим PostgreSQL. Пропуск S3/DB-теста остаётся виден в результате, даже если остальные проверки прошли.

## Что сохраняет отчёт

Для каждого пакета и HTTP-профиля остаются исходный log, JSON результатов, JSON/lcov/HTML coverage. Для Node HTTP остаётся и сырой `NODE_V8_COVERAGE`; `c8@10.1.3` использует source maps, чтобы объединить его с исходными TypeScript-файлами. Отсутствующий TAP footer, пустая карта production-исходников или неуспешный процесс считаются незавершённым замером. Пропуски и cancellation не превращаются в passed.

`manifest.json` содержит команды, версии, точные pass/fail/skip, исключённые наборы, все ожидаемые production-файлы и отсутствующие в карте. До и после запуска фиксируются Git HEAD, tracked diff и SHA содержимого всех неигнорируемых untracked-файлов. Изменение нового, ещё не закоммиченного исходника также делает `sourceChangedDuringRun:true`.

Дополнительный Vitest reporter записывает `test-file-inventory.json` в `onTestRunStart`: это реальные resolved specifications до загрузки и collection тестов, уже с текущими include/exclude. После завершения runner сопоставляет пути с JSON `testResults`. Отсутствующая/повреждённая квитанция, потерянные, лишние или повторные файловые результаты дают `complete:false` и exit 1 даже при exit 0 дочернего процесса. Отдельный `reportValidation` использует тот же строгий валидатор статусов/счётчиков, что общий `check`; failed suite с нулём failed assertions также не считается успехом. Исходные отчёты остаются неизменными.

`complete` и `suiteCompletion` означают завершение запрошенного набора, а не покрытие всего проекта. `denominator.allWorkspaceSourcesIncluded` показывает, вошли ли все восемь production-наборов. При `--no-unit` HTTP-отчёт содержит только исполнявшиеся файлы; его высокий процент нельзя сравнивать с полным production-denominator.

`gaps.md` и `gaps.json` группируют покрытие по модулям, перечисляют непроверенные функции, ветви и строки, отдельно отмечают файлы с SQL. Текст SQL, попавший в исполнявшуюся строку TypeScript, не доказывает корректность ограничений, триггеров, миграций или блокировок. Их фактические тесты PostgreSQL/S3, браузер, CI и целевые платформы фиксируются самостоятельно.

Сопоставимые Vitest AST-запуски можно объединить, сохранив исходные каталоги:

```sh
node scripts/coverage/merge.mjs --run .run/coverage/workspace-baseline \
 --run .run/coverage/full-owned-pg --output .run/coverage/combined-baseline
```

Merge сохраняет SHA каждого входного manifest и его источник. Счётчики тестов разных запусков не считаются уникальными: сценарии могут пересекаться. Разные source identities явно помечаются; такой union не является атомарным замером одной сборки.

Vitest4 использует AST-based V8 counters, а c8 native — другую детализацию statement/branch/line ranges. Проценты этих методов имеют несопоставимые denominator-ы. Runner не разрешает смешивать их в одном запуске; merge по умолчанию также отклоняет смешивание. Для цели покрытия всех модулей используются только сопоставимые Vitest AST-карты, включая полный owned-PG профиль. Native HTTP остаётся самостоятельным подтверждением поведения и исполнения SQL/S3.

Явный `--experimental-native-union` разрешает технический union разных методов. Он получает `coverageKind:experimental-mixed-instrumentation`, `comparablePercentages:false`, `summary:null`; сырые метрики доступны только как `experimentalSummary`. В gaps.md проценты заменяются пометкой «несопоставимо». Такой отчёт нельзя использовать как доказательство достижения near100. Исходные raw V8 и отдельные чистые карты остаются доступными.

## Первый срез

`.run/coverage/services-baseline-20261022` — первоначальный неполный срез семи backend/bridge-пакетов. Он сохранил отказы старых fixtures и пропуски; исходники менялись во время замера. Он полезен как исходный список пробелов, но не является финальной приёмкой. Исправленные fixtures проверены отдельно; новый полный замер хранится в новом каталоге.

Приоритет для роста покрытия определяется пропущенными ветвями исполнения: приватный chat/research lifecycle, выдача и подтверждение device jobs, переиндексация, snapshot/restore, обучение, source import и синхронизация моделей. Простое выполнение schema constants или искусственное включение файлов в тест не закрывает эти сценарии.

## Последний срез — 22 октября

| Профиль | Исходники и результат | Граница |
| --- | --- | --- |
| Сопоставимый AST union | `b2d0faf`, 1134 файла; lines 80.61%, functions 72.22%, branches 74.84%, statements 76.03% | Только два frozen AST-входа; их RED/skip сохранены, c8 и прежние scoped-срезы не добавлены. `.run/coverage/frozen-exact-ast-union-review-20261022` |
| Последний unit-safe | Чистый `5fcade8`, 6983 pass / 2 fail / 26 skip; все 517 выбранных файлов присутствуют, 92 инфраструктурных файла исключены; lines 64.60%, functions 58.14% | Два beforeEach отказа совпали с thermal sleep 945 с; отдельный повтор этих файлов 30/30 без правки исходников. Полный прогон остаётся RED. `.run/coverage/frozen-unit-safe-5fcade8-awake` |
| Полный owned-PG | `b2d0faf`, 3180 pass / 2 fail / 25 skip; все 222 выбранных файла присутствуют | Из 25 skips 24 относятся к failed suite. Три затронутых файла отдельно 41/41; полный повтор на `5fcade8` не стартовал при 6.025 ГиБ вместо требуемых >8 ГиБ. `.run/coverage/frozen-owned-pg-b2d0faf` |
| Защита файлового отчёта | 18/18 safety и короткий actual flags 29/29; expected 4 = reported 4, штатных исключений 3 | Включает настоящий скопированный runner с synthetic child exit 0: потерянный файл или failed suite всё равно дают runner exit 1. `.run/coverage/inventory-flags-smoke-validated-20261022` |

В первом unit JSON отсутствовал результат `workspace-bounds.test.ts` целиком; разница двух отчётов — 11 кейсов. Без ранней квитанции нельзя восстановить полноту исполнения/отчётности этого старого прогона. В новом полном unit отчёте все выбранные файлы подтверждены независимой сверкой; последующие запуски выполняют такую сверку автоматически.

На macOS запуск под `caffeinate -i node scripts/coverage/run.mjs ...` удерживает idle assertion только на время команды и не меняет настройки энергосбережения. Это не предотвращает аварийную thermal-паузу. Для полного непрерванного замера нужен стабильный стенд с достаточными ресурсами. Счётчики пересекающихся запусков не складываются; ни один из этих результатов не означает достижение цели около 100% или production acceptance.

## Целевой аудит хранения — 22 октября

После исправлений S3 privacy, переноса вложений и неизвестного состояния PostgreSQL-сессий выполнены новые прогоны на неизменных production SHA:

| Область | Результат | Покрытие и знаменатель |
| --- | --- | --- |
| Чат | 73/73, пять файлов, 0 skips; `.run/ceph-audit-20261022/chat/cleanup-regression-final-73/` | Vitest AST, только `chat-attachment-storage.ts` и `chat-object-storage.ts`: 100% lines/functions, 93.71% branches, 97.66% statements |
| Снимки | 143/143, восемь файлов, 0 skips; `.run/ceph-audit-20261022/snapshots/unlock/frozen-final/` | Vitest AST: `snapshot-storage.ts` 99.18% lines / 82.60% functions / 79.24% branches / 89.01% statements; `backup-storage.ts` 92.30% / 90.90% / 84.78% / 80.51%. Общий CJS helper и operator CLI в этой карте отсутствуют |
| Внешняя резервная копия | 80/80, 0 skips/cancellation; `.run/ceph-audit-20261022/external/final-with-boundaries/` | Native c8, `external-backup.mjs`: 100% lines/functions/statements, 93.17% branches. Второй файл helper в этой частичной карте: 100% lines/functions/statements, 70.21% branches |
| Локальная S3-конфигурация | 28/28; `.run/ceph-rgw-audit/` | Поведение Docker inventory, сохранность ключей и запуска; процент всего DevOps не заявляется |

Дополнительные 48 signed-HTTP кейсов общего privacy helper входят в набор снимков. Попытка собрать их worker coverage через внешний c8 не дала production-карту: такой нулевой знаменатель невалиден и не означает 100%. С AST или другой native-картой этот результат не смешивается. После изменения только QA guards отдельно прошли 12/12 chat и 32/32 snapshot/fixture с прежними production SHA; их счётчики к полным прогонам не прибавляются.

Тестовые PG/S3 принадлежат fixtures; основное приложение не используется для мутаций. Реальный Ceph RGW, cross-host DR, полный зелёный повтор и цель покрытия всех модулей остаются открыты. [Дефекты, условия и свидетельства аудита](ceph-storage-audit-2026-10-22.md).
