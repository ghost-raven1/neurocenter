# Локальная приёмка RAG и текстовых знаний — 1 ноября 2026

Приняты отдельные реальные сценарии текстового UI, протокола синхронизации и локальной embedding-модели. Они не объединяются в заявление о завершении всей цепочки RAG: полный путь одной модельной индексации через сервер до обратного применения ещё требует связного свидетельства. Использованы собственные проекты, PostgreSQL16.15 с pgvector0.8.7 и отдельный Ollama на loopback11435. Пользовательский Ollama11434, его конфигурация и проекты не менялись. Dev-auth стенда не подтверждает настоящий IdP или production.

## Результаты и точные границы

| Срез | Подтверждено | Не следует из результата |
|---|---|---|
| Текстовые знания через UI/API | Добавление синтетического текста, поиск русского фрагмента, пустой результат, сохранение ввода при неправильном документе, project isolation, история при OFF. Потерянный ответ принятого upload восстанавливается через exact request GET | Связный чат принят отдельным срезом ниже; отзыв прав и конкуренция требуют отдельных проверок |
| LanceDB → HTTP → PostgreSQL pgvector → LanceDB | Семь сохранённых фаз: seed-sync/repeat, search, partial-scan отказ без изменения сервера, restore2rows с сохранением постороннего, default empty отказ, явный empty sync, empty restore отказ с сохранением локального | Векторы фиксированные, full-pass provenance синтетический. Это не доказательство semantic embedding. Empty restore не реализует удаление локального индекса |
| Текущий RAG runtime2.12.2 + настоящая модель | Native LanceDB, RU/EN semantic search без keyword-подмешивания, unchanged retry, HTTP503 сохраняет индекс побайтно, recovery достраивает его, несовместимая размерность отклоняется без изменения индекса/config | Не серверный roundtrip этой же модельной индексации; не другие ОС, GPU/нагрузка, установленная пользовательская поставка или внешний провайдер |
| KnowledgeSync lost ACK | Исправление `27cc48f6` принято в main. В настоящем браузере принятый POST с потерянным ответом после remount восстанавливается exact GET receipt без второго POST | Не полная матрица всех отказов/ролей/двух вкладок и restore после прерывания ОС |

После семи фаз отдельная браузерная синхронизация изменила серверный снимок (job `6bc3a7a4-ced3-4b65-b780-37a892b847e3`). Повтор проверки пустого снимка корректно остановился на изменившейся baseline; `protocol-summary.json` связывает его с этой новой фазой, а не с дефектом продукта.

## Runtime и воспроизводимость

Первый smoke смешивал новые adapters со старым подготовленным upstream2.4.4, поэтому MCP закрывался до inference. Отдельный прогон точного старого комплекта прошёл RU/EN индексирование, но не проверку побайтной сохранности после503; это исторический artifact failure, а не доказанный дефект текущего main.

Для текущего прогона скачан закреплённый upstream2.12.2, проверен SHA256 `a92207b01fa04df1ac4df45ead1f8bbca3e556b38f002e6dd94902ec09d609ee`, применён настоящий `prepareManagedRagCommands`. Совпадающие зависимости использованы из кэша; отсутствующие fflate0.8.3 и @clickhouse/client1.24.1 установлены в отдельный overlay с lock, без изменения прежнего artifact и без legacy-peer-deps. Source/dependency hashes сохранены. Node24.22.0, macOS ARM64, qwen3-embedding:0.6b, размерность1024. Все три MCP-процесса завершились, временный проект smoke удалён.

KnowledgeSync хранит только identity запроса: владелец/роль, проект, компьютер, binding, direction и UUID. Неизвестная квитанция блокирует новую отправку;404 допускает только исходный replay. Ошибка хранилища не запускает POST. Terminal receipt очищает точный intent под lock и показывает, что новый запуск требует следующего явного действия. Независимый review выполнен; указанные владельцем проверки —179 frontend tests и844 TypeScript files без диагностик. Эти числа не заменяют реальную браузерную проверку и не обозначают покрытие всего приложения.

## Локальные свидетельства

Каталог `.run/rag-acceptance-20261101/` локален и не поставляется вместе с Markdown. Для внешней проверки нужен очищенный переносимый пакет; private owner/connection-файлы в него не включать.

- `text-search.yml`, `text-no-results.yml`, `text-invalid-retention.yml`, `text-project-isolation.yml`, `text-off-history.yml`, `text-lost-ack.yml`, `text-network.txt` — UI/HTTP текстового пути.
- `protocol-summary.json` — семь фаз с отдельными receipt SHA и указателем на поздний неуспешный повтор; fixed vectors/synthetic provenance явно обозначены.
- `embedding-smoke-current-ready.json` —9 пройденных проверок,3 завершённых MCP, temporaryRemoved=true; `current-runtime-provenance.json` — архив, патчи, exact dependency versions/source hashes/overlay lock.
- `embedding-smoke-initialize-failed.json`, `embedding-smoke-mixed-adapter-failed.json`, `embedding-smoke-retained244-failed.json`, `embedding-smoke-deps-incomplete-failed.json` — сохранённые неуспешные попытки, не включаемые в PASS.
- `postgres-create.json`, `postgres-inspect.json`, `vector-sql-receipt.json`, `toolchain-provenance.md`, `ollama-owner.json`, `ollama-inspect.json`, `ollama-tags.json` — локальные зависимости и владение; owner-файл не является публичным приложением.
- `sync-lost-ack-network.txt`, `sync-lost-ack-remount.yml` — browser POST/receipt без повторного POST. Компонентные RED/GREEN логи находятся отдельно в `/tmp/neurocenter-knowledge-sync-*.log` и также непереносимы.

## Оставшиеся допуски

Основной текстовый контекст чата принят ниже. Для Q16 нужен полный модельный roundtrip одной генерации с проверкой origin/profile/hash/count, отменой/перезапуском и сохранением ручных изменений. Также открыты cross-role/flag/concurrency варианты, остальные платформы, CI и целевая площадка. История при OFF и безопасный отказ пустого restore не означают поддержку всех операций при OFF или применение пустого снимка.

## Текстовый контекст чата и готовность модели

Срез `20e9b147` добавляет явный выбор через существующий поиск текста внутри чата. Preview принимает тот же revision/hash/query, учитывает цитаты в бюджете и повторно проверяет актуальность. Выбор сохраняется в журнале сообщения для точного повтора. Явная кнопка отключает конфликтующие режимы, сохраняя поисковый запрос, цитаты и черновик. Открытие настройки ничего не отправляет.

Реальный браузер → Gateway → Catalog → RAG → собственный Ollama Ministral-3:8b: два сообщения получили ответ `сакура-7319`, источник `Инструкция-日本語.md`, строки 3–4. Сервер сохранил `mode:text`, revision2, corpusHash `23a5b6147c93a781aab399e7c91892ee2eb4562fda55e5947d77f63cc57026c7`. У проекта нет embedding-модели. Счётчик `/api/embed` остался 19→19; `/api/chat` вырос 1→3. Потеря второго принятого ответа и reload сохранили ровно два turn с исходными requestId и выбором контекста. Использована локальная копия имеющихся весов.

Срез `a47b5b4f` исправляет карточку «Готова» с заблокированным чатом: после проверки перечитывается подтверждённая identity модели. Изменение подключения сбросило verification; повторная проверка включила кнопку без reload. Ready сам по себе не заменяет verification gate.

Финальные проверки: frontend 188 тестов / 37 файлов PASS; inclusive TypeScript 850 файлов / 0 ошибок. Backend preview: 6 тестов PASS, 1495 файлов / 0 TypeScript ошибок. Scoped ESLint без ошибок; прежние React hook warnings сохранены. Форматирование и независимый review пройдены.

Catalog применён из isolated build `8eb8be7b-7403-4df7-80c0-31b431a8d876`; финальный frontend `f9015cbf-a161-4274-8a7a-91369ee219d4`, artifact SHA256 `94528f12a158021c572a32a9a8cc00b4d71dc134c9e5544c3f89a63df872a71f`. Основной chat/ACK проход выполнен на frontend полного build; последняя сборка повторно проверяет переключение режима и model-ready без reload.

Свидетельства: `text-chat-proof.json`, `text-chat-citation.yml`, `text-chat-reload.yml`, `text-context-first-use-fixed.yml`, `chat-ready-disabled.yml`, `chat-ready-enabled-no-reload.yml`, `q17-frontend-final.log`, `q17-inclusive-final.log`, `text-preview-backend-proof.json`. Отмена, отзыв прав и остальные варианты OpenSpec 4.4 остаются отдельными допусками.
