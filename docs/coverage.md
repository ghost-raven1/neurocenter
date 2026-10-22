# Измерение покрытия

Восемь пакетов используют закреплённые `vitest@4.1.12` и `@vitest/coverage-v8@4.1.12`. Общая конфигурация `services/shared/test-coverage.mjs` включает все production-файлы `src`, включая ни разу не импортированные, и общий JavaScript в `services/shared`. Исключены declarations и сам конфиг отчёта. Искусственного порога100% нет.

Это настроенный AST-знаменатель восьми пакетов и shared. Отдельная файловая инвентаризация включает production CLI, их helpers и поставляемые установщики, но не превращает их в измеренные строки. Цель около 100% по всем модулям остаётся открытой в [бэклоге](backlog-2026-10-22.md).

## Файловый знаменатель CLI и установщиков

Инвентаризацию можно получить без запуска тестов, CLI, установщиков или приложения и без установки coverage-зависимостей:

```sh
node scripts/coverage/source-inventory.mjs --output .run/coverage/source-inventory
```

Источник списка — `git ls-files --cached --others --exclude-standard`: tracked и неигнорируемые новые файлы. Учитываются самостоятельные JS/TS, shell, PowerShell, Python, SQL и другие явно перечисленные языки; shebang проверяется в `scripts`, `bridge-dist`, `bin` и у файлов с executable bit. Огромные `.run`, `node_modules` и прочие ignored-каталоги не обходятся. Секреты и `.env` не открываются; leaf symlink и перенаправление через symlink родительской папки отмечаются `source-unavailable` до чтения/хеширования bytes. Корень нормализуется через realpath. Это проверка уже существующих путей, а не race-free filesystem sandbox: изменение дерева во время замера отслеживается отдельно через source identity. Неожиданно отсутствующий исходник или исходник в sensitive path оставляет явный пробел инвентаризации. Встроенный в строку/шаблон код и declarative-конфигурации без самостоятельного исполняемого исходника не являются отдельными единицами этого списка.

`source-inventory.json` сохраняет путь, SHA, runtime, назначение и основание классификации каждого найденного исходника. Production включает восемь `src`, shared, операционные CLI в `scripts` и versioned установщики `bridge-dist`; generated-происхождение установщика не исключает его из production. Tests/fixtures, coverage/workspace/API tooling, конфиги, declarations и обычные generated outputs перечислены отдельно с основаниями. Неизвестное назначение остаётся `unclassified` и не разрешает объявить полный production-знаменатель.

В `source-inventory.md` видны отсутствующие JS/TS CLI и все неподдержанные runtime. `represented` означает только наличие файла в карте выбранного метода, включая файл с нулевыми hit-счётчиками; `unrepresented` — отсутствие карты JS/TS; `unsupported-runtime` — отсутствие поддержанного измерения Bash/PowerShell/Python/SQL. Это **число файлов**, а не coverage lines/functions/branches/statements. Для отсутствующего файла не генерируются выдуманные AST-счётчики. Исполненная TypeScript-строка с SQL не переводит `.sql` или SQL-семантику в покрытые.

Native c8 теперь допускает production JS/TS CLI и helpers вне `src`, если выбранный сценарий действительно их исполнил. `all:false` сохраняется: неисполненные CLI остаются видимыми в файловой инвентаризации, а не исчезают из отчёта. Shell/PowerShell/SQL требуют отдельных проверок и по-прежнему не получают процент c8. AST и native-карты не смешиваются.

Запуск требует проектный Node24. Каждый замер пишет новый каталог, не заменяя прежнее доказательство:

```sh
npm ci --ignore-scripts --prefix scripts/coverage
node scripts/coverage/run.mjs --output .run/coverage/workspace-baseline
node scripts/coverage/run.mjs --package catalog-service --output .run/coverage/catalog-baseline
```

Первый шаг ставит отдельный набор закреплённых инструментов отчёта. Он выполняется после обычной установки зависимостей восьми приложений; корневой `npm ci` сам по себе этот отдельный пакет не устанавливает. Runner не запускает сетевую установку автоматически. В CI этот шаг также должен быть явным.

Для компьютера с ограниченной памятью добавьте `--max-workers 1`: пакеты выполняются последовательно, каждый Vitest использует один worker. По умолчанию их два; допустимы только `1` и `2`, ошибочное значение отвергается до запуска тестов и создания отчёта. Профиль `--owned-pg` всегда использует один worker.

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

В этот же owned-integration профиль включены семь native SQL-сценариев восстановления оригиналов чата: `chat-recovery-postgres.test.mjs`. Его `CHAT_RECOVERY_TEST_ADMIN_PG_URL` заполняется только уже проверенным `MODEL_CHAT_TEST_ADMIN_URL`; значение caller не наследуется. Без явного QA-адреса standalone-набор видимо пропускается. S3-протокол в этих SQL-тестах контролируется локальной HTTP-фикстурой; настоящие ограничения и транзакции выполняются в своих случайных PostgreSQL-БД. Wiring-тест профиля не заменяет полный интеграционный прогон.

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

`complete` и `suiteCompletion` означают завершение запрошенного набора, а не покрытие всего проекта. `denominator.configuredPackageSourcesIncluded` показывает выбор всех восьми production-наборов. Новый `denominator.allWorkspaceSourcesIncluded` требует полной файловой инвентаризации без неизвестных назначений и наличия карты для каждого production-исходника; неподдержанный runtime оставляет его `false`. В старых сохранённых manifest это поле обозначало только восемь пакетов: merge не доверяет старому флагу без source inventory. Даже `true` нового файлового флага не означает100% покрытия строк. При `--no-unit` HTTP-отчёт содержит только исполнявшиеся файлы; его высокий процент нельзя сравнивать с полным production-denominator.

`gaps.md` и `gaps.json` группируют покрытие по модулям, перечисляют непроверенные функции, ветви и строки, отдельно отмечают файлы с SQL. Текст SQL, попавший в исполнявшуюся строку TypeScript, не доказывает корректность ограничений, триггеров, миграций или блокировок. Их фактические тесты PostgreSQL/S3, браузер, CI и целевые платформы фиксируются самостоятельно.

Сопоставимые Vitest AST-запуски можно объединить, сохранив исходные каталоги:

```sh
node scripts/coverage/merge.mjs --run .run/coverage/workspace-baseline \
 --run .run/coverage/full-owned-pg --output .run/coverage/combined-baseline
```

Merge сохраняет SHA каждого входного manifest и его источник. Счётчики тестов разных запусков не считаются уникальными: сценарии могут пересекаться. Разные source identities явно помечаются; такой union не является атомарным замером одной сборки.

Файловая инвентаризация merge восстанавливается только из одинаковых сохранённых списков с SHA исходников, не из сегодняшней рабочей папки. Отсутствующая историческая инвентаризация или разные версии файлов дают `inventoryComplete:false` и явную причину. Прежний `allWorkspaceSourcesIncluded:true` не скрывает этот пробел. `gaps.json` и `gaps.md` ссылаются на отдельные `source-inventory.json`/`.md`; runtime-проценты и файловая полнота остаются разными показателями.

Vitest4 использует AST-based V8 counters, а c8 native — другую детализацию statement/branch/line ranges. Проценты этих методов имеют несопоставимые denominator-ы. Runner не разрешает смешивать их в одном запуске; merge по умолчанию также отклоняет смешивание. Для цели покрытия всех модулей используются только сопоставимые Vitest AST-карты, включая полный owned-PG профиль. Native HTTP остаётся самостоятельным подтверждением поведения и исполнения SQL/S3.

Явный `--experimental-native-union` разрешает технический union разных методов. Он получает `coverageKind:experimental-mixed-instrumentation`, `comparablePercentages:false`, `summary:null`; сырые метрики доступны только как `experimentalSummary`. В gaps.md проценты заменяются пометкой «несопоставимо». Такой отчёт нельзя использовать как доказательство достижения near100. Исходные raw V8 и отдельные чистые карты остаются доступными.

## Первый срез

`.run/coverage/services-baseline-20261022` — первоначальный неполный срез семи backend/bridge-пакетов. Он сохранил отказы старых fixtures и пропуски; исходники менялись во время замера. Он полезен как исходный список пробелов, но не является финальной приёмкой. Исправленные fixtures проверены отдельно; новый полный замер хранится в новом каталоге.

Приоритет для роста покрытия определяется пропущенными ветвями исполнения: приватный chat/research lifecycle, выдача и подтверждение device jobs, переиндексация, snapshot/restore, обучение, source import и синхронизация моделей. Простое выполнение schema constants или искусственное включение файлов в тест не закрывает эти сценарии.

## Последний срез — 22 октября

| Профиль | Исходники и результат | Граница |
| --- | --- | --- |
| Транзакционный аудит, новый unit-safe | Чистый `776b747`, 7416 pass / 0 fail / 53 skip; все 545 выбранных файлов присутствуют, 115 инфраструктурных файлов исключены; lines64.80%, functions58.92%, branches62.18%, statements60.68% | Node24.22.0, один worker, 8/8 пакетов exit0; sourceBefore=sourceAfter. `complete:false`, `allWorkspaceSourcesIncluded:false`. `.run/coverage/frozen-unit-safe-audit-776b747`; actual-PG и native SDK перечислены отдельно ниже |
| Unit-safe `e43e474` (предыдущий) | Чистый `e43e474`, 7389 pass / 0 fail / 53 skip; все 543 выбранных файла присутствуют, 112 инфраструктурных файлов исключены; lines64.82%, functions58.97%, branches62.28%, statements60.73% | Node24.22.0, один worker, все восемь пакетов exit0; sourceBefore=sourceAfter. `complete:false` из-за skips, `allWorkspaceSourcesIncluded:false`. `.run/coverage/frozen-unit-safe-reliability-e43e474` |
| Сопоставимый AST union | `b2d0faf`, 1134 файла; lines 80.61%, functions 72.22%, branches 74.84%, statements 76.03% | Только два frozen AST-входа; их RED/skip сохранены, c8 и прежние scoped-срезы не добавлены. `.run/coverage/frozen-exact-ast-union-review-20261022` |
| Прежний unit-safe | Чистый `5fcade8`, 6983 pass / 2 fail / 26 skip; все 517 выбранных файлов присутствуют, 92 инфраструктурных файла исключены; lines 64.60%, functions 58.14% | Два beforeEach отказа совпали с thermal sleep 945 с; отдельный повтор этих файлов 30/30 без правки исходников. Полный прогон остаётся RED. `.run/coverage/frozen-unit-safe-5fcade8-awake` |
| Полный owned-PG | `b2d0faf`, 3180 pass / 2 fail / 25 skip; все 222 выбранных файла присутствуют | Из 25 skips 24 относятся к failed suite. Три затронутых файла отдельно 41/41; полный повтор на `5fcade8` не стартовал при 6.025 ГиБ вместо требуемых >8 ГиБ. `.run/coverage/frozen-owned-pg-b2d0faf` |
| Защита файлового отчёта | 18/18 safety и короткий actual flags 29/29; expected 4 = reported 4, штатных исключений 3 | Включает настоящий скопированный runner с synthetic child exit 0: потерянный файл или failed suite всё равно дают runner exit 1. `.run/coverage/inventory-flags-smoke-validated-20261022` |

Прогон `e43e474` заменил RED `c8f78ab` (7373 pass /16 fail /53 skip), сохранённый отдельно. Воспроизведены устаревшие doubles Redux/RAG и raw-error oracle очереди обучения; исправления не меняли production-код этих модулей и сохранили исходные проверки поведения. Восьмипакетный повтор выполнен после фиксации всех изменений. Новое разделение отсутствующих и повреждённых автономных ассетов также входит в его исходники. Native CLI-набор ассетов57/57, смежные Catalog48/48 и установщики проверены отдельно; их счётчики и c8-карты не добавлены в этот AST-отчёт. Цель около100%, полный owned-PG/S3 и внешняя приёмка остаются открыты.

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

Тестовые PG/S3 принадлежат fixtures; основное приложение не используется для мутаций. На этом срезе настоящий Ceph RGW ещё не проверялся; последующая локальная PUT/read/restart/delete приёмка описана в [обновлённом аудите](ceph-storage-audit-2026-10-22.md). Cross-host DR, полный owned-PG/S3 и цель покрытия всех модулей остаются открыты.

## Повтор ранних возможностей — 22 октября

После аудита хранения отдельно перепроверены Access93, Gateway85, flags47, import37, OpenCode119, RAG91, Catalog reindex/replay36, binding/learning71, partial-scan42, frontend264 и installer75. Пять native QA CLI дали 56/56 проверок на свежем изолированном Catalog; guards этих CLI — 22/22. Положительные наборы без skips; отсутствующий QA URL видимо пропускает соответствующие SQL-тесты. Пересекающиеся повторы не складываются; ранние RAG72/Catalog26 заменены финальными 91/36.

В Access93 новый feature-local helper и `ProjectMemberRepository` имеют 100% всех четырёх метрик; четыре Access-файла вместе — 83.87% lines / 62.16% functions / 85.81% branches / 77.91% statements. Это сохраняет lifecycle/read-пробелы. Import worker: 91.30 / 80.64 / 75.34 / 86.66. RAG91 и Catalog36 имеют отдельные карты: исполнения RAG из десяти Catalog receipt-кейсов не объединены с RAG91 для нового процента. Полная [таблица исходников, результатов и ограничений](earlier-features-audit-2026-10-22.md#покрытие-и-сборка).

Пять исторических native CLI (`access-database`, `production-bootstrap`, `project-profile-delete-db`, `project-retention-access-db`, `project-size-db`) требуют явный `PUBLICATION_TEST_PG_URL`, `TEST_ADMIN_PG_URL` или `CATALOG_TEST_PG_URL` на owned `127.0.0.1` с явным non5432 портом и `/postgres`. Application `CATALOG_PG_URL` больше не включает тест по умолчанию. Для актуальных проверок нужна свежая сборка; audit-кандидат использует отдельные dist overrides/hook и не заменяет рабочий runtime. Полный workspace и внешняя приёмка сохраняют прежний открытый статус.

Остальные 24 CLI приёмки БД (включая `tool-build-db`, installation, publication, device queue и model credentials/snapshots) используют тот же guard до создания `Pool`: их профильная переменная подключения должна явно указывать собственный `postgres`/`postgresql` URL с `127.0.0.1`, портом кроме 5432 и `/postgres`, без query/hash. Для `dev-model-credentials-db`, `dev-snapshots-db` и `production-model-credentials-db` имя `CATALOG_TEST_PG_URL` сохранено, но путь `/catalog` теперь отклоняется: передайте admin URL `/postgres`; сценарии сами создают временную БД. `rag-recovery-db` требует отдельный `RAG_RECOVERY_TEST_PG_URL`; application `CATALOG_PG_URL` не разрешает тестовые мутации и не используется как fallback. Guard не выводит значение URL и пароль.

## Транзакции и допуск — следующий срез 22 октября

После `a26c788` получены новые целевые результаты: devices119 unit +11 actual PG, learning54 actual PG +16 URL guards, runtime/research17 новых unit +31 actual PG, frontend70 и отдельно18 native Chromium. Повторы не складываются. Все положительные наборы без skips, с фактической сверкой файлов до collection. Общий owned-PG environment дополнен `LEARNING_TEST_ADMIN_PG_URL`; smoke через настоящий helper исполнил все10 новых learning SQL-кейсов без skip. Эти10 уже входят в54, полного owned-PG/S3-прогона здесь нет.

Три неизменённых browser intent store: 98.79% lines /100% functions /95.04% branches /98.33% statements; прежде на тех же исходниках функции79.54%, ветви87.62%. Четыре learning-файла: 98.92/100/81.09/91.66. Шесть device/workspace-файлов с per-file SHA union: 68.39/75.92/54.34/63.15. Два runtime/research-файла имеют раздельные unit/PG карты, Chromium не смешивается с AST. Это разные знаменатели; глобальная цель около100% остаётся открытой. [Дефекты, итоговые карты и границы](functional-audit-transactions-admission-2026-10-22.md).

## Транзакционные отказы и готовность Ceph QA — `776b747`

[Последующий аудит](functional-audit-transactions-admission-2026-10-22.md#продолжение-после-локального-ceph--776b747) добавил 12 actual-PG случаев чата и 8 actual-PG случаев квот с независимыми наблюдателями; целевые регрессии 27/27 и 35/35. Эти пересекающиеся наборы не прибавляются к общему unit-safe. Новые PG-тесты используют существующие aliases owned-PG runner; отсутствие URL даёт видимый skip, заданный пустой URL отклоняется до TCP.

Один `platform-quota.ts` в scoped Vitest AST по 35 сценариям: lines97.29%, functions100%, branches95%, statements96.72%. Native Node V8 по 35 config/SDK случаям для `dev-chat-storage.mjs`: lines100%, functions100%, branches94.25%; statements этим отчётом не измерялись. Последний native набор запуска 76/76 содержит эти 35 случаев, поэтому счётчики не суммируются и native карта не смешивается с AST.

Общая карта восьми пакетов остаётся частичной из-за 53 skips и 115 исключённых инфраструктурных файлов. Полный owned-PG/S3, оставшиеся live Docker restore и цель около100% не закрыты; прошлые RED и ограничения сохраняются.

## Bash-установщик и переход площадки — `c5be79b`

[Исторический проход до новых connect-сценариев](bridge-installers.md#переход-между-площадками--22-октября-2026): 93/93 Node-регрессии из пяти фактически выбранных файлов, без skips, и отдельно 10/10 сценариев настоящего macOS ARM64-архива. Среди 93 — 45 lifecycle fixtures с собственными HTTP/HOME и проверенной очисткой. Семь начальных site RED воспроизводили один запрет перехода, два mode RED — один дефект umask; промежуточные 20 повторов не прибавляются к 93. Bash не получил искусственный процент из Node-карты. Общий unit-safe срез `776b747` выше остаётся историческим; новый workspace/owned-PG/S3 замер здесь не выполнялся.

## Подключение установленного моста через Gateway — 22 октября

Новая команда использует проверенный Gateway, а `/api/bridge/connect.sh` и `.ps1` не требуют Supply. Исправный существующий runtime запускается через bundled Node без повторного архива; известный preflight отсутствующих файлов/регистрации допускает один установщик, ошибка Node/CLI не запускает его повторно. [Контракт и восстановление](bridge-installers.md#подключение-через-gateway--22-октября-2026).

| Срез | Результат и квитанция | Граница доказательства |
| --- | --- | --- |
| Frontend | 132/132, 11/11 файлов, 0 skips; [final-receipt](../.run/start-deadends-20261022/final-receipt.json) | SSR/захваченные обработчики, управляемые hook-регрессии, Bash с fake curl. Два новых actual-component случая: ошибка списка устройств сохраняет retry/connect и кнопку dev-install с настоящим `BridgeSourcePanel`, без ложной готовности. Все frontend-исходники и четыре изменённых теста прошли strict TS; scoped lint и отдельная Vite-сборка прошли. Старые типовые дефекты двух неизменённых test fixtures не объявлены исправленными; браузерный error-state/Windows не запускались |
| Controlled installer/connect | 112/112, 7/7 файлов, 0 skips; [final-receipt](../.run/bridge-custom-root-20261022/final-receipt.json) | Настоящие Bash/curl/Node и собственный HTTP, 63 временных lifecycle fixtures; CLI/pairing-нагрузка контролируется. Восемь новых случаев включают custom root по точному формату launcher без его исполнения. Это не полный архив, не race-free filesystem sandbox и не production pairing |
| Gateway | 123/123, 5/5 файлов, 0 skips; [final](../.run/bridge-dev-abort-race-20261022/final/receipt.json) | Контроллер и шаблоны, connect без Supply, safe origin/отмена. Шесть native child-кейсов воспроизводят настоящую семантику stream errors; Nest переживает 8 отменённых запросов и затем GET 200 без Catalog. Выдаваемые connect-скрипты этим набором не исполняются. Полный candidate собран отдельно: [квитанция](../.run/bridge-connect-gateway-20261022/full-candidate-abort-fixed/receipt.json) |
| Архив macOS ARM64 | 12/12; [native-bundle-final12](../.run/bridge-custom-root-20261022/native-bundle-final12/receipt.json) | Текущие скрипты с настоящим архивом 0.9.18 build `0f9357f…`, source `083195d`, bundled Node/dependencies; custom root без `INSTALL_DIR`, прямое подключение с прежними ключами без скачивания архива. Архив не пересобирался. Временный профиль и одноразовый сервер; пользовательский профиль не изменён, браузер/Windows/Linux этим набором не приняты |

Scoped Vitest AST охватывает ровно три frontend-файла: `connectionCommands.ts` — 100% всех четырёх метрик; `InstalledBridgeConnect.tsx` — 100% lines/functions/statements, 91.66% branches; весь существующий `BridgeSetup.tsx` — 89.28% lines, 60% functions, 91.58% branches, 81.81% statements. Общий знаменатель этих трёх файлов — 93.02/76.47/92.90/88.46; SSR не исполняет часть effects/дочерних callbacks. Это не глобальное покрытие и не native-карта Bash/Gateway. [Отдельная карта](../.run/installed-bridge-site-20261022/final-device-recovery-frozen/coverage/coverage-summary.json).

Наборы и их исторические повторы не суммируются: прежние frontend130, controlled104, Gateway117 и archive11 заменены текущими 132/112/123/12. Это целевые проверки; свежий общий unit-safe после `776b747` не выполнялся. Source-коммиты: `3f3f0f0`, `4b88dbe`, `ac37e18`, `905d692`; тесты текущих скриптов с архивом `083195d` не означают новую сборку архива. Цель около100% всех модулей не закрыта. Полный Linux build `9f588…` известен только из сообщения пользователя, нативный PowerShell не запускался.

Первый локальный HTTP-green не закрыл найденное затем падение Gateway на отменённом чтении dev-архива. После временного отключения `DEV_BRIDGE_RUNTIME_DIR` и исправления stream abort выполнена итоговая локальная активация: [PID 89943, dev-поставка 0.9.18 восстановлена, 4 GET 200, 8 клиентских отмен и healthy GET, остальные runtime-деревья сохранены](../.run/bridge-connect-gateway-20261022/local-activation-abort-fixed/activation-receipt.json). Это отдельная локальная HTTP-проверка, она не прибавляется к тестовым счётчикам. CUA login/reload `/start` подтвердили текущую команду и dev0.9.18 в [ручном AX/DOM-наблюдении](../.run/start-deadends-20261022/browser-observation.json), первичный источник — transcript; screenshot нулевой ширины не является визуальной/адаптивной приёмкой. Удалённый рабочий Linux и пользовательская установка моста этим проходом не обновлялись.
