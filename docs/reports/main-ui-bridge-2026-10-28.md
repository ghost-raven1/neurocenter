# Main, светлый чат и обновление моста — 28 октября 2026

Продолжение [первого обновления](main-actualization-2026-10-27.md). Пользователь разрешил слияние готового кода, обновление локальных сервисов и моста, а также хранение только актуальной версии. Новая локальная PostgreSQL база сохраняется; прежние данные не восстанавливались.

## Поставка исходников и локальные сервисы

В `main` слиты с проверкой ожидаемых head SHA:

- [PR37](https://github.com/ghost-raven1/neurocenter/pull/37): исправления native обновления 0.9.25, сохранения установки и очистки предыдущих версий; merge `f506cc33`.
- [PR38](https://github.com/ghost-raven1/neurocenter/pull/38): [светлое оформление чатов](light-chat-2026-10-27.md), merge `ba109b4b`.
- [PR39](https://github.com/ghost-raven1/neurocenter/pull/39): [компактная настройка, проекты и каталоги](setup-catalog-ui-2026-10-28.md), merge `9dc32efc`.

Исходная папка `Downloads/neurocenter` синхронизирована с `origin/main` на `9dc32efc9bf15038ce996cc736423623a8b4a0ab`. Для точных PR heads GitHub не предоставил checks/statuses; CI не считается пройденным. Пользовательские отчёты и WIP сброса/нового мастера сохранены отдельно.

Локальный `scripts/dev.sh up --profile fast` с Node 24.22.0 завершился exit0: приложения пересобраны до штатной остановки прежних процессов, затем запущены из исходной папки. Существующие PostgreSQL/постоянный том и Ceph сохранены. Новых QA-сущностей, сброса БД и model-запусков в этом процессе не было. Режим source watch не включён; веса моделей не скачивались.

Same-chat MCP подтвердил шесть принадлежащих launcher backend listeners с health200; passive readiness OAuth/Catalog/Flags/RAG — 200. Skills/Gateway readiness намеренно пропущены как endpoints с файловыми побочными эффектами. Frontend5173 ответил200 и прошёл частичную компиляционную проверку. Это не полный браузерный регресс и не проверка production. Журнал: `.run/local-main-update-20261028/up-fast.log`.

## Изолированная приёмка архива 0.9.25

Архив собран из `542f6eda56cf089b068b182820869cbfa64924d1`, build `3868b74a06bc15e338aa9d37f34f385b44b367651dff43eae3a956e4fae6a69e`. Последующие тестовые и UI-коммиты не подменяют фактический source pin архива. Пересобранный main MCP подтвердил тот же build.

| Граница | Результат |
| --- | --- |
| macOS ARM64 offline | Настоящий `install.sh --archive`, bundled Node, пробелы/Unicode, сохранённые ручные настройки; системные Node/npm/curl не использовались. |
| macOS canonical installer | 13/13 PASS: установка/повтор, reconnect, блокировки, lease, штатные pause/purge/resume и отказы. |
| Методика из распакованного архива | Настоящие OpenCode1.14.48/OpenSpec1.15.0, выбранный агент, чтение/запись/проверка и replay/ACK. Три ответа локальной HTTP model-фикстуры, без реального провайдера. |
| Linux x64 | Offline install и shared cleanup58/58 PASS. Под x64-эмуляцией на ARM дополнительно прошли first install и canonical case7, включающий настоящий repeat/pause/purge/resume. |

Бюджет host harness — 60 секунд; Linux emulation harness явно120 секунд на вызов. Product stop grace остаётся10 секунд. Linux repeat занял72.223 секунды, штатный pause/stop —2.335 секунды. Это не производительность физической Linux-машины. Полные13Linux, Windows и Linux download не проверялись. Старые30-секундные отказы сохранены как FAIL и не переименованы в PASS.

Первый приватный Linux build завершился host validation failure после успешного producer; причина не установлена. SDK A/B с обоими npm toolchain прошёл на одном прежнем архиве, поэтому несовместимость npm не заявляется причиной. Повторная приватная сборка прошла неизменённые валидации; защиты не ослаблялись. Собственные контейнеры и профили завершённых native-сценариев удалены; сохранённые offline-QA и диагностические копии учитываются отдельно и не выдаются за очищенные.

Host archive SHA256 `840536fc64041bdeca70b5cd6778660465f7ec5316ec6d391fb73ce505ec4b89`; Linux SHA256 `a1b518c1080130e9bb84a238ad1b96cccaac0e041d75e1f397ff992e1f631982`. Точные файлы и квитанции: `.run/bridge-maintenance-stop-20261027/archive-reader/acceptance-preflight.json`, `acceptance-and-delivery-plan.md`, `native-installer-heartbeat-fenced60.json`, `selected-archive-native.json`, `linux-qa/native-linux-emulation120.json`.

Финальный offline portable-комплект отдельно прошёл распаковку и установку из своей внешней оболочки; исходный AppleDouble FAIL и его исправление описаны в [отчёте стабилизации](release-stabilization-2026-10-28.md). Это не новая сборка внутреннего runtime.

## Рабочий компьютер

Штатное переподключение к новой локальной БД подтверждено в реальной MainAdmin-сессии: локальные имя/fingerprint совпали, компьютер выбран, online, версия на этом этапе0.9.21. Выполнены одно официальное подтверждение pairing и обычный presence PUT. Подмены auth/API, QA-fixtures и изменений ролей/флагов не было.

После pairing создан новый приватный снимок восьми файлов; относительно прежнего снимка изменились только штатные credentials. Содержимое ключей не включено в отчёт или Git. Снимок: `.run/current-only-bridge-20261027/private-after-reconnect-NO55vp/receipt.json`. UI-свидетельство: `.run/bridge-maintenance-stop-20261027/ui-reconnect-report.md`.

Официальный updater применил0.9.25/build3868. Новый worker запущен от прежнего UID с точным installed entrypoint; старый процесс завершён. Шесть защищённых файлов post-reconnect — credentials, оба OpenCode config, launcher, workspaces и instances — сохранились побайтно. Это фактическое обновление рабочего профиля, отдельно от изолированных тестов архива.

Реальные API и выбранная UI-карточка подтвердили тот же device, свежий heartbeat/build, online0.9.25 и отсутствие требования reconnect; действующий MainAdmin сохранён. Официальный повтор завершился `already-current` за0.26с: все8 файлов сохранили hash и inode, переустановки не было. Квитанции: `.run/bridge-maintenance-stop-20261027/private-reconnect/{actual25-update,actual25-already-current,ui-verify25-result}.json`.

Единственный официальный UI inspect завершился `succeeded`, revision2/schema2, effective cleanup `enabled:true,keepPrevious:0,minAgeDays:0`. Policy не переписывалась. Первоначальная ошибка проверяющего runner не содержала фактического state; свежий GET подтвердил успех, поэтому она не считается дефектом продукта. Raw отказ и уточнение сохранены раздельно.

При работающем собственном worker обычный CLI вернул removed0/warnings0; это не выдаётся за выполненную очистку. Затем штатные prepare/pause → подтверждённый graceful stop → server-authorized cleanup → finish/connect удалили один receipted21 backup, warnings0. После resume новый реальный worker и свежие API/UI вновь подтвердили прежний device, online25/build3868/noReconnect и неизменность защищённых файлов.

Дополнительно удалены4 неактивных runtime18/19 и13 приватных неактивных поколений. Перед удалением каждого runtime полная streaming-сверка файлов/хешей/mode с его точным старым архивом, UID, стабильных inode и отсутствия потребителей подтвердила состав. Единственное активное dev-поколение — current25 `generation-qeqW1t`. Metadata-less recovery-каталог с original configs/recovery.json сохранён; автоматическое принятие неизвестных данных не выполнялось. Свидетельства: `.run/bridge-maintenance-stop-20261027/private-reconnect/{inventory-before-cleanup,manual-old-cleanup,inventory-final,ui-verify25-resume-result}.json`. JSON-история, identity backups и ручная конфигурация сохранены.

Поддержанные readonly GET показали старый source snapshot с bridge0.9.17, `imported:null` и devSupply25. Владельцы всех исторических immutable blobs через эти GET не устанавливаются; такие blobs не удалялись. Эта граница отделена от успешной очистки установленного и приватных dev runtime.

Публикация private dev pointer обслуживает только host-target; она не означает публичный GitHub release, multi-OS поставку сайта или импорт в каталог. В одноразовом ignored promotion-driver до применения был исправлен собственный APFS directory.nlink guard; первоначальный отказ не изменил pointer или рабочую21. Это не исправление product/archive.

## Незавершённые изменения

Новый порядок bridge → пользовательский CLI → локальные провайдеры → папка → агенты/инструменты → проверки остаётся отдельным WIP. API ограниченного `opencode --version` проверен unit/собственным PostgreSQL; native исполнитель прошёл source review/typecheck, его реальные process/crash проверки ещё предстоят. Настройка нескольких провайдеров и API-key, новый встроенный RAG и backend полного/частичного сброса БД этим main-срезом не объявляются готовыми. Предварительная миграция сброса46 не зарегистрирована и на рабочей БД не применялась; отдельная quota-ветка занимает46 после текущих0–45, поэтому reset перед интеграцией получит47 и повторную проверку схемы. Следующий кандидат компактной панели и тестового запуска описан в [отчёте стабилизации](release-stabilization-2026-10-28.md).
