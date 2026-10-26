# B09: откат отмены поколения RAG — 26 октября 2026

Продолжение от `main`/`origin/main` на `9f721ab` после PR19. Функциональный коммит `e1da757` меняет только собственную транзакцию `RagGenerations.cancel`: failed ROLLBACK вызывает `release(true)`, исходная ошибка сохраняется. SQL, `source/create/build/finish/retry`, Catalog ACL и выбор активного поколения не менялись.

## Причинный отказ

Тест выполняет настоящий DELETE chunks кандидата и теряет его ACK; ROLLBACK не доставляется. Отдельный observer сразу после ошибки ещё видит прежние три строки. Следующий обычный `applyPlatformQuotaPolicy → RagGenerations.source` через pool размером1 фиксирует прежнюю отмену: строк становится две, занятое место основного проекта падает с216 до118 байт. Это фактический первый consumer cached project path: `ProjectDatabases.withProject` обновляет политику квоты перед действием.

Исправление уничтожает неизвестную сессию, поэтому следующий запрос не получает её открытое удаление. Контроли проверяют подтверждённый rollback с reuse, потерянный ACK настоящего rollback со сменой PID, потерянный COMMIT ACK с сохранением ровно одного принятого результата и точный повтор обычной отмены. Полные snapshots строк, метаданных, квот, audit и policy сохранены; активное поколение и соседний проект остаются прежними. Речь о frozen candidate и его квоте: потери Catalog active head этот стенд не доказывает.

## Проверки

| Набор | Результат |
| --- | --- |
| RED нового файла | **2 PASS / 3 FAIL**, `.run/backlog-cancel-20261026/cancel-red.{json,log}`, наблюдения `cancel-red-cancel.json`; до product-правки |
| GREEN связанного набора | **70/70**, 0 fail/skip/TODO: новый cancel5, прежние generation-session5, migration10, quota initialization12, quota rollback5, quota unit33; `cancel-green.{json,log}` |
| TypeScript нового теста | Strict noEmit, exit0; `.run/backlog-cancel-20261026/tsconfig-cancel-test.json` |
| TypeScript сервиса | Полный service noEmit, exit0; `source-typecheck.log` |
| Изолированная сборка RAG | `.run/isolated-build/6825974a-009f-47a9-a43b-183280774732/receipt.json`, успешно; source/current, candidate inputs, dependency links и рабочие dist сохранены |
| Очистка | `database-cleanup.json`: 0 fixture-БД/сессий; managed кластер `f94705f0-0358-4a18-a101-4ccdf1f21cbd`, порт60876, закрыт с сохранением квитанции |

Admission проверял принадлежащий запуску loopback PostgreSQL16.15 вне5432, активный SCRAM/nonce/PID/birth/lease. Fixture извлекает зарегистрированные `rag_chunks`/`rag_generations` CREATE TABLE и заменяет только неиспользуемый vector-тип на real[], добавляя совместимую `vector_dims`. Production quota/cache SQL и DELETE triggers выполняются без изменения. Это узкая проверка транзакции, без pgvector-поиска/HNSW, inference, физического wire failure, Gateway/browser или production. Все пять fixture-БД удалены и в RED, и в GREEN. Независимое read-only ревью подтвердило границы правки и полезность проверок.

## Остаток B09

Следующие находки остаются source-кандидатами до RED: own-TX `RagDb.exportPage` и `searchProjectIndex` могут передать retained READ ONLY следующему writer; `source/create/build/finish` поколений требуют собственного разбора; DROP INDEX в cancel требует отдельной проверки project scope при чужом id. Их нельзя считать исправленными по текущему набору. Полный infrastructure/coverage, корпоративные ОС/сеть, CI и production остаются отдельными допусками.
