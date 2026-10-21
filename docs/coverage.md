# Измерение покрытия

Восемь пакетов используют закреплённые `vitest@4.1.12` и `@vitest/coverage-v8@4.1.12`. Общая конфигурация `services/shared/test-coverage.mjs` включает все production-файлы `src`, включая ни разу не импортированные, и общий JavaScript в `services/shared`. Исключены declarations и сам конфиг отчёта. Искусственного порога100% нет.

Запуск требует проектный Node24. Каждый замер пишет новый каталог, не заменяя прежнее доказательство:

```sh
node scripts/coverage/run.mjs --output .run/coverage/workspace-baseline
node scripts/coverage/run.mjs --package catalog-service --output .run/coverage/catalog-baseline
```

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

Здесь PostgreSQL и S3 обязательны, инфраструктурные файлы не исключаются. Runner заполняет все проверенные fixture aliases одним административным QA-адресом. Для runtime fallback URL создаётся отдельная случайная база `nc_cov_*`; стандартные переменные PostgreSQL также указывают на неё. Обычный DROP после закрытия соединений удаляет только эту базу. Сами fixtures владеют своими случайными базами и bucket-ами. Полный набор использует один worker, timeout теста 30 секунд и hook timeout 60 секунд. Перед запуском требуется больше 8 GiB свободного диска: snapshot S3-тест поднимает собственный временный MinIO с уникальным именем и портом.

Зависимость флагов для этих DB fixtures — отдельный локальный HTTP-сервис с полным evaluated snapshot. Отрицательные тесты по-прежнему задают свои off/revoke ответы. Это подмена внешней зависимости, а не SQL: ограничения, блокировки, миграции и данные исполняются настоящим PostgreSQL. Пропуск S3/DB-теста остаётся виден в результате, даже если остальные проверки прошли.

## Что сохраняет отчёт

Для каждого пакета и HTTP-профиля остаются исходный log, JSON результатов, JSON/lcov/HTML coverage. Для Node HTTP остаётся и сырой `NODE_V8_COVERAGE`; `c8@10.1.3` использует source maps, чтобы объединить его с исходными TypeScript-файлами. Отсутствующий TAP footer, пустая карта production-исходников или неуспешный процесс считаются незавершённым замером. Пропуски и cancellation не превращаются в passed.

`manifest.json` содержит команды, версии, точные pass/fail/skip, исключённые наборы, все ожидаемые production-файлы и отсутствующие в карте. До и после запуска фиксируются Git HEAD, tracked diff и SHA содержимого всех неигнорируемых untracked-файлов. Изменение нового, ещё не закоммиченного исходника также делает `sourceChangedDuringRun:true`.

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
