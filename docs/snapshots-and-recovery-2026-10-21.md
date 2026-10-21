# Закрытие старых данных, восстановление и полные снимки

Работа по выбранным пунктам 1–2 от 21 октября. Общий локальный запуск и живая приёмка завершены; результаты изолированных проверок перечислены ниже. Внешняя production-приёмка остаётся отдельной.

## Старые данные и журнал

Операторский `npm run assets:retire-legacy -- preview` готовит точный план по трём старым демо и unresolved назначениям. Apply требует UUID preview, SHA плана и сохранённый UUID запроса. Исходные байты, доступная история и проектные назначения помещаются в карантин; отсутствующие версии, лицензии и dependencies не выдумываются. Проект не удаляется. Повтор, потеря ACK, изменение источника/прав/назначений и отказ аудита проверены настоящими PostgreSQL/HTTP/FS тестами.

Живой apply по свежему preview завершился SUCCEEDED: три неполных скилла архивированы, три назначения помещены в карантин, активных unresolved назначений — 0. SHA трёх исходных файлов совпали; повтор не создал второе событие аудита. [Квитанция](../output/browser-feedback/legacy-retirement-live.json).

Журнал получает действия от настоящего исполнителя. Retry/cancel для bridge и RAG используют актуальные права, состояние, capabilities, digest и UUID. Историческая запись или неподдерживаемый executor показывают причину и переход к исходному действию. Изменение строки истории не выдаётся за остановку процесса. Проекции RAG и локальных заданий связаны с фактическими очередями.

## Восстановление из панели

UI «Обслуживание» работает с закрытым внешним host runner. HTTP-сервис не получает Docker socket. Runner использует собственные операторские пути, реестр checkpoint и токен; браузер не выбирает команды и пути.

Preview проверяет состав, SHA, точные образы и новый Compose-проект. Подтверждение содержит `RESTORE <target>`. Исполнитель восстанавливает только новый пустой стек, оставляет приложения остановленными и сохраняет отдельную квитанцию. Существующий стек не заменяется. Lease loss/crash не запускает разрушительные действия повторно: неизвестное выполнение требует разбора сохранённого журнала. Для потерянного ответа есть lookup и durable cancellation tombstone.

Одноразовая настройка:

```sh
node scripts/production/web-restore-setup.mjs --directory <private-production-config>
```

Опциональный `compose.web-restore.yml` открывает закрытый control endpoint только на loopback44101. Запускать host runner штатным CLI `scripts/production/web-restore-runner.mjs`; параметры описаны в его help/error contract. Результат настоящего HTTP→PostgreSQL→runner→Compose прогона: [web-restore-compose-live.json](../output/browser-feedback/web-restore-compose-live.json).

## Полные физические образы LanceDB

Новый `neurocenter.lancedb-snapshot/v1` отделён от построчной RAG-синхронизации. Мост с capability `project-snapshots-v1` получает задание `publish-project-snapshot`, привязанное к устройству, проекту, instance/binding и исходному UUID.

Под барьером управляемых записей он фиксирует текущие версии и схемы всех физических корневых таблиц, читает все их столбцы/строки, проверяет индексы и копирует полные `*.lance` деревья. Имеющиеся raw-файлы версий сохраняются вместе с остальными файлами таблицы. Опись содержит только переносимые относительные пути, размеры, SHA файлов и чанки до64МиБ. Приватные настройки и история evaluation не публикуются. Вложенные namespaces и внешние таблицы явно отклоняются. Служебный namespace catalog проверяется отдельно; SDK работает через собственные временные aliases, чтобы его инициализация не записывала `__manifest` в источник или образ.

Перед каждым этапом и после передачи проверяются lease, права и binding. Изменившийся источник не получает complete. После неизвестного ответа pending GET не считается доказательством отказа: сервер сверяет окончательную квитанцию `upload_completed_at`. Мост подтверждает `UPLOADED`; статус `VERIFIED` назначает отдельный исполнитель. Истечение незавершённого readonly capture завершает его отказом, принятые блоки переиспользуются новым снимком.

Передача идёт через API Gateway, включая raw PUT и проверяемый бинарный GET/HEAD. Поток ограничен64МиБ, учитывает отключение получателя и не заканчивает Content-Length до проверки SHA.

В dev блоки находятся в `data/runtime-artifacts/.project-snapshots`. Production использует закрытый HTTPS MinIO/S3 с versioning. SQL хранит точный versionId; чтение проверяет размер и SHA. До PUT/link сохраняется write intent, входящий в квоту. Потеря ACK после записи восстанавливается по nonce/owned stage. Лишние собственные S3-версии очищаются ограниченными порциями; чужие версии не удаляются. LIVE metadata и снятие write intent фиксируются вместе.

Host verifier собирает новый staging, проверяет SHA, затем запускает закреплённый SDK0.29.0 в отдельном контейнере: без сети, с read-only образом, ограничениями CPU/RAM/PID и временным tmpfs. Все файлы проверяются до и после полного SDK-чтения текущих версий таблиц. Сервер проверяет квитанцию и подписывает образ Ed25519. Общий срок проверки ограничен15минутами, включая скачивание. Контейнер имеет собственный timeout на случай гибели host runner. Staging имеет durable owner/reservation, квоту32ГиБ и резерв свободного места; после SIGKILL удаляются только доказанно собственные папки мёртвого процесса.

Операции head/rollback используют точный CAS ревизии. Release profile атомарно закрепляет проверенный снимок и полный exact пакетный граф проекта; опционально перемещает head в той же транзакции. Подписанная capsule сохраняет ресурсы и прежние pins. Смена серверного head не переключает локальную сессию OpenCode.

Удаление защищает текущий снимок и все исторические профили. После явного запроса действует период ожидания1–720часов. GC фиксирует DELETING intent до удаления точной физической версии, сохраняет разделяемые блоки и продолжает после потери ACK. Физическая очистка снимков удалённого проекта автоматически не запускается.

Настройка production ключа/токена:

```sh
node scripts/snapshots/setup.mjs --directory <private-production-config>
docker build -f services/catalog-service/snapshot-verifier.Dockerfile -t neurocenter-snapshot-verifier:local .
node scripts/snapshots/runner.mjs --directory <private-worker-state> --catalog-url http://127.0.0.1:44102 --image neurocenter-snapshot-verifier:local --token-file <private-production-config>/secrets/snapshot_verifier_token
```

`compose.snapshots.yml` добавляет только catalog secrets и loopback44102. Нужны `SNAPSHOT_S3_ENDPOINT`, `SNAPSHOT_S3_BUCKET`, `SNAPSHOT_S3_REGION` и закрытые `snapshot_s3_access_key`/`snapshot_s3_secret_key`. Потерянный или чужой ключ при существующих подписях не заменяется автоматически. Исторические публичные ключи задаются отдельным `SNAPSHOT_TRUSTED_KEYS_FILE`; их файл монтируется явным операторским overlay. Dev подготавливает ключ и verifier перед остановкой предыдущего запуска и учитывает worker в status/down.

## Согласованная копия S3 и SQL

Новые полные комплекты имеют recovery-v3. Все зарегистрированные блоки экспортируются по точной S3-версии с readback SHA; служебная опись связывает их с SQL. VERIFYING/VERIFIED обязаны иметь все LIVE блоки. UPLOADING/REJECTED могут содержать ещё не переданные ссылки. Любой незавершённый write intent останавливает backup/preview: сначала завершить восстановление записи и повторить копирование. Утраченная физическая версия DELETING также не превращается в успешную копию.

Закрытый `<production-config>/snapshot-recovery.json` задаёт source/target endpoint,bucket,region и относительные accessKeyFile/secretKeyFile. signingKeyFile по умолчанию `secrets/snapshot_signing_key`, optional trustedKeysFile — `secrets/snapshot_trusted_keys.json`. Bundle содержит exact private signing key и историческое кольцо в `operatorsecrets` с правами0700/0600 и SHA. Он чувствителен так же, как остальные операторские секреты восстановления.

Restore проверяет старые v1/v2 без исполнения SQL при preview; копия без требуемых snapshot bytes/keys или с незавершёнными записями отклоняется до создания target. S3 restore создаёт только отсутствующий новый bucket, включает versioning, проверяет точные байты/все версии target и выполняет CAS переназначения storageId/versionId в SQL. Исходный bucket и конфигурация не меняются. Private target overlay в `recovery-receipts/<target>-snapshot-config/compose.json` подключается **последним** при последующем операторском запуске восстановленного стека. Частичный target сохраняется для разбора, повторное исполнение в занятый target запрещено.

Настоящая проверка: [snapshot-recovery-minio-compose-live.json](../output/browser-feedback/snapshot-recovery-minio-compose-live.json).

## Удалённые проекты и RAG-базы

Удаление проекта сохраняет retirement tombstone и блокирует повторное использование ID. Отдельная project DB сохраняется до решения главного администратора. UI показывает retained/purging/purged, retention и blockers. Preview фиксирует project tombstone, cluster identity, OID, marker и факты; purge требует digest, сохранённый UUID и свежие права.

Shared per-project leases и эксклюзивный fence блокируют DROP при использовании. Перед DROP отключаются новые подключения и повторно проверяются финальные факты. DROP выполняется без FORCE; потеря ответа сверяется по exact identity, чужая/recreated DB не удаляется. Backup/provision/purge разделяют глобальную lifecycle-блокировку. Исторические migrationSource копии в общей RAG admin DB этим purge не удаляются: безопасная связь старого имени с retired ID не доказана. Полные VERIFIED образы хранятся отдельно и не удаляются вместе с project DB.

## Проверки и границы

Изолированно проверены реальные PostgreSQL/HTTP/FS, MinIO versioning и отдельный Compose restore. Native снимок проверен на настоящем OpenCodeRAG: addChunks→capture→materialize в новую папку→offline/read-only Docker SDK→семантический поиск. Тесты подменяют CLI только там, где проверяются аргументы/таймаут/cleanup; это не заменяет отдельный настоящий SDK прогон.

Общий `dev.sh up --profile fast` собрал приложения и поднял 8/8 процессов, включая host verifier. В живом отдельном проекте три снимка получили VERIFIED через Gateway и host worker; отменённая публикация сохранила REJECTED. Через браузер проверены создание после отмены, activate/rollback, выпуск профиля вместе с head, reload, защита закреплённых снимков и диалог удаления. На ширине 570 px ширина содержимого совпала с viewport. Старый мост получает явное требование обновления. Повторное монтирование React StrictMode выявило зависания загрузки restore/snapshot intent: добавлены воспроизводящие owner/ABA-регрессии, затем исправлены оба hook.

Итоговые полные прогоны: frontend 1971/1971 без пропусков; catalog 1781 пройден / 1 отдельный live-сценарий пропущен в общем наборе; scripts 1113 пройден / 2 пропущены. Catalog запускался с обоими PostgreSQL environment. Bridge 970 пройден / 11 пропущены; RAG 133/133. Отдельные настоящие Gateway raw-stream, S3/PG, restore Compose и native Darwin ARM64/Linux x64 проверки имеют собственные отчёты и не превращают остальные пропуски в пройденные. После последней текстовой правки snapshot notice целевые owner/UI 25/25 повторены.

Локальные результаты не подтверждают оставшиеся ОС, целевую площадку, независимый cross-host DR, корпоративный вход и длительную нагрузку на рабочем объёме. Также не реализована автоматическая установка capsule/переключение локального OpenCode от смены server head; интерфейс прямо показывает эту границу.
