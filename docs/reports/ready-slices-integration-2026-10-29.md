# Проверенные срезы перед слиянием — 29 октября 2026

База: main `517677e95e4f616057a38b61f355a3bc3c464e1b`. В ветке сохранены отдельные коммиты Header/Start, vendor-контракта, базового запуска и backend текстового RAG. Незавершённые GGUF, новый RAG UI, полный перенос asset-репозитория и общий контекст проекта в поставку не включены.

## Совместная проверка

Root выполнила официальные `npm run build` для Catalog, RAG и Gateway под Node24.22.0. Все три сборки завершились с кодом 0; они использовали совместный текущий исходник перечисленных срезов. Локальные raw и результаты: `.run/ready-integration-20261029/`.

После сборок существующий `scripts/test/asset-source-archive-http.test.mjs` прошёл через настоящие Gateway, Catalog, Skills и отдельный PostgreSQL: 7/7 PASS, 0 fail/skip. Набор проверил auth/role/media, чтение metadata с недостающими файлами, cache-only импорт, SHA/traversal rejection с сохранением источника, догрузку через SHA-cache архив и повтор с неизменными версиями. Внешних asset/model запросов нет по assertions fixture. Это архивная HTTP-приёмка; не Gateway→Catalog→RAG text CRUD и не desktop upload.

Локальное свидетельство: `.run/archive-import-acceptance-20261029/retry1/{http-test.raw.log,result.json}`. Первый запуск до готовности TCP PostgreSQL сохранён отдельно как ошибка окружения и не засчитывается. Повтор сначала проверил настоящий TCP `SELECT 1`.

Header дополнительно принят в браузере 1440×1000 с проверкой отступов, navigation/reload, fixed inspection и Escape/focus. Подробности и границы: `computer-header-2026-10-29.md`. Unit, controlled provider ports, отдельные реальные PG-наборы и source review описаны в отчётах core/vendor/text backend; их нельзя суммировать в процент покрытия всего проекта.

## Ресурсы и текущая площадка

Все собственные fixture-сервисы закрыты; перед удалением QA-контейнера проверены точные CID и owner label, дополнительных тестовых баз и client sessions не осталось. Удалён только собственный disposable tmpfs PostgreSQL; Main и соседние контейнеры не менялись. Квитанция: `.run/owned-core-acceptance-20261029/retry1-closed.json`.

Пассивный same-chat MCP probe подтвердил прежние семь локальных listeners: HTTP200 и совпадение владения. Catalog/RAG/auth/flags readiness успешны; side-effectful readiness Skills/Gateway намеренно не выполнялась, frontend compilation — частичная проверка. Это прежнее работающее поколение, а не применение нового кандидата.

## Что остаётся после исходного слияния

Обновить локальное runtime-поколение с сохранением текущих данных и signing identity, применить additive migrations и повторить затронутую приёмку. Новый backend RAG ещё не имеет завершённого UI; сквозной text HTTP, полноценный контекст всех источников, GGUF hosting, текущая немодельная поставка через Git и удаление asset-репозитория остаются отдельными задачами.

CI, настоящий сервер пользователя, OS-диалоги, новый установленный мост и полная приёмка проекта этим пакетом не подтверждены. Слияние исходников не означает, что работающая площадка или Primary уже обновлены.
