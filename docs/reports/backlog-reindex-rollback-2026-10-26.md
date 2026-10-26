# Восстановление reindex и собственных SQL-транзакций — 26 октября 2026

Срез ветки `feature/backlog-reindex-recovery` от `d1e87d8`: B25 и два подтверждённых дефекта B09. Изменения сохранены отдельно: `aa41f48` (reindex), `6098d65` (квота), `dfb6008` (испытания агентов).

## Поведение

- **B25.** После потерянного ответа точный POST с прежним requestKey возвращает принятый план при текущем праве чтения. Смена установки/привязки, downgrade до читателя и OFF `rag_sync` не требуют нового допуска. Изменение model/pin/selection revision/connection даёт 409; отзыв чтения — 403. Новый план требует административных прав, флага и действующего target. Проверка установки выполняется до захвата Models pool; повтор под model/project lock не вызывает вторую подготовку. Общие политики пропускают к владельцу только точный root POST; start/retry/local-retry остаются защищёнными.
- **B09, квота.** При реальном UPDATE, потерянном ACK и неотправленном ROLLBACK обычный следующий `ragQuota(read)` фиксировал ошибочное изменение лимита и аудит. Теперь неизвестный rollback уничтожает сессию, исходная ошибка сохраняется.
- **B09, испытания.** При том же отказе после INSERT настоящий `Service.start` завершался ошибкой, а следующий `expire()` фиксировал queued trial без запуска. Сессия теперь уничтожается. Подтверждённый rollback допускает повторное использование соединения. Потерянный COMMIT ACK сохраняет один принятый queued trial; точный повтор не создаёт второй INSERT и не запускает inference автоматически. Успешное выполнение или последующее истечение lease такого trial этим срезом не принимается.

## Причинные проверки

Локальные файлы ниже находятся в `.run/backlog-20261026/` этого worktree и не публикуются в Git.

| Проверка | RED | Итог |
| --- | --- | --- |
| Reindex + policy доступа | `reindex-red.json`: 24 pass / 8 fail; потерянный loopback HTTP-ответ, повторная target validation, отказ при downgrade и timeout pool max1 | Девять новых SQL/HTTP-кейсов входят в окончательные 116 Catalog |
| Квота | `quota-red2-transactions.json`: observer видит limit100/revision0 до read, затем limit150/revision1 и audit `failed@test` на прежнем PID | Пять новых native-кейсов входят в окончательные 38 RAG |
| Испытания агентов | `agent-trial-red2-transactions.json`: до expire строк нет, после появляется queued trial на прежнем PID; provider calls0 | `agent-trial-green-transactions.json`: строк нет и после expire, сессия заменена, cleanup пустой |

Контроли различают неотправленный ROLLBACK и потерю ACK после выполненного ROLLBACK, подтверждённый rollback с reuse PID, успешный COMMIT и потерю его ACK без дублирования принятой записи/аудита. Reindex-конкуренция управляется барьером двух target validation до захвата единственного соединения.

## Итоговые проверки

- **Catalog 116/116**, восемь файлов, `backlog-catalog-final.json`.
- **RAG 38/38**, два файла, `quota-scoped-final.json`.
- **Общая политика 96/96**, `feature-policy-final.tap`.
- Во всех трёх итоговых наборах failed/skipped/TODO — 0. Девятнадцать новых сценариев входят в эти числа; промежуточные прогоны не прибавляются. Vitest JSON не предоставляет отдельного cancelled-counter.
- TypeScript Catalog/RAG/Gateway: [checker](../../.run/check/3a1fb6e1-db98-467c-8a38-a978a4f5c3e1/report.json), все три exit0. Все три новых test-файла также прошли отдельный strict TypeScript.
- Изолированные сборки [Catalog](../../.run/isolated-build/cd019f4f-c0b4-47f1-bf41-ebc2eb763dd8/receipt.json), [RAG](../../.run/isolated-build/c3c8488f-1053-4bed-8ff7-fc4b86078cba/receipt.json) и [Gateway](../../.run/isolated-build/8634e4e2-9388-4762-b137-bd24fe9608ef/receipt.json): ok, sourceCurrent/candidateInputsUnchanged/liveOutputsUnchanged/dependencyLinksUnchanged — true; свои дочерние процессы завершены. После сборок изменены только этот отчёт и бэклог.

Независимые read-only ревью B25, квоты и испытаний не нашли блокирующих замечаний. Единственное уточнение route-fixture (`local-retry`) исправлено и вошло в окончательный прогон.

## Границы и очистка

Использован отдельный managed PostgreSQL16.15: run `6c666451-c416-4a1b-a9be-a883bc1eb61b`, порт52461. Перед каждым native-запуском проверены ownership/nonce/PID/birth/config/listener/SQL и lease. `database-cleanup.json` подтверждает отсутствие тестовых БД/сессий; [финальная квитанция кластера](../../.run/qa-postgres/6c666451-c416-4a1b-a9be-a883bc1eb61b/receipt.json) — closed/stopped. Данные кластера и журналы сохранены. Рабочие сервисы и установленный мост не переключались.

У reindex реальные SQL receipt/lock и потерянный HTTP-ответ, но ACL/actor/flags/device validator управляемые; политики маршрутов проверены отдельно. Испытания используют настоящий Service.start/ACL/INSERT/expire с управляемыми feature/provider-границами. В квотной фикстуре production SQL бюджета/аудита работает с пустым chunk storage и `real[]`; это не приёмка pgvector.

Расширенные попытки сохранены отдельно: auth-набор остановился в setup из-за отсутствия `vector` (14 кейсов не выполнены, exit1); соседние platform-quota rollback-кейсы остановились на существующем пороге 4ГиБ свободного диска (8 failures до упражнений SQL). Начальный квотный запуск также остановился из-за `vector`; причиной продуктового RED считается последующий `quota-red2`, а не этот setup-отказ. Guards не ослаблялись. Настоящие Gateway/IdP, весь owned-PG/S3-набор, все ОС, coverage всего workspace, CI и production остаются открытыми. Linux `dev.sh install` по-прежнему требует первичный `npm error`.
