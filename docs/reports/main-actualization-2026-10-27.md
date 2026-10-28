# Обновление main и локального Нейроцентра

27 октября 2026. Пользователь разрешил слить готовую работу и обновить локальные сервисы/мост; после обнаружения недоступной прежней БД явно выбрал **новую локальную базу**. Этот отчёт разделяет исходники, локальные проверки, работающий сервер и установленный мост.

Состояние следующего дня — в [отчёте 28 октября](main-ui-bridge-2026-10-28.md): PR37–39 и новая локальная пересборка. Ниже сохранены свидетельства первого этапа, включая тогда ещё ожидавшееся обновление моста.

## Слияние

PR [33](https://github.com/ghost-raven1/neurocenter/pull/33), [34](https://github.com/ghost-raven1/neurocenter/pull/34), [35](https://github.com/ghost-raven1/neurocenter/pull/35) и [36](https://github.com/ghost-raven1/neurocenter/pull/36) слиты с проверкой ожидаемых head SHA. Исходная рабочая папка `Downloads/neurocenter` переведена на `main`, синхронизирована с `origin/main` на `ba6845dcab872c08b51c1495e2a6973b8eaf80e6`; tree `296d735bf961ab6ff6bab7cf14808358038970b2` совпал с проверенным интеграционным кандидатом.

Готовы desktop recovery fixes, раздельные чаты сервисных ролей, объединённый workflow агентов, полный выбранный локальный executor BMAD/OpenSpec, основной мастер `/start` и связь сохранённой реплики с durable заданием агента. Контракты и границы функций описаны в [отчёте реализации](primary-setup-agent-chat-2026-10-27.md). AP02, SR01/SR02 и ранняя телеметрия bootstrap остаются следующими срезами, не входят в завершённый объём.

На объединённом дереве дополнительно прошли 71/71 проверок операций, 77/77 проверок dev-MCP без пропусков и frontend typecheck. Это отдельные наборы; они не означают покрытие всего продукта. Для точных PR heads GitHub вернул пустые checks/statuses; каталога `.github/workflows` нет. Успешный CI не заявляется.

Три исходных untracked пользовательских отчёта сохранены с прежними SHA. Временный управляемый интеграционный checkout сохранён: приложение определило его как primary и отказало в архивировании. Все операционные команды выполнялись из исходной папки с явным `workdir`.

## Новая локальная база и сервисы

Прежний PostgreSQL не слушал порт 5432; в доступном Docker daemon не было контейнеров или томов. Это наблюдение не доказывает причину исчезновения прежних данных. Восстановление старых проектов, переписок и истории не выполнялось; тестовые данные вместо них не загружались.

Созданы:

- PostgreSQL 16.15 / pgvector 0.8.7: контейнер `neurocenter-local-postgres-20261027`, внешний постоянный том `neurocenter-local-pgdata-20261027`, bind только `127.0.0.1:5432`.
- Закреплённый образ `pgvector/pgvector@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a`, linux/arm64.
- Локальный overlay `.run/local-main-update-20261027/postgres.override.yml` с owner labels и внешним томом. `COMPOSE_FILE` добавлен в исходный `.env` после приватного снимка; прежние байты и значения сохранены, права 0600. Обычный `docker compose ps -q postgres` выбрал тот же контейнер. **Overlay нужно сохранять вместе с этой локальной конфигурацией.**

Старые восемь принадлежащих launcher процессов остановлены штатным `dev.sh down` до появления новой БД. Старый build сохранён. Созданы базы catalog/rag/skills, применена схема до 45 включительно: 46 записей истории с baseline, `check --ready` успешен, pending migrations отсутствуют. До миграции получен custom-format dump новой пустой catalog: `PGDMP`, `pg_restore --list` exit0; полное восстановление dump не проверялось. Этот dump не содержит прежние данные.

Собран образ snapshot verifier `sha256:984cee5cb3760ceaaa5b3f50573c6a28d73cd92dafb964f6826ccff69e6bffe8`. `scripts/dev.sh up --profile fast` завершился exit0 с Node 24.22.0; зависимости и приложения запущены из исходной папки. Ceph использует закреплённый образ, прежние локальные credentials сохранены, private buckets готовы.

Same-chat MCP и OS-проверка подтвердили шесть backend health200 и принадлежащие launcher listeners. Passive readiness bridge/catalog/flags/rag — 200. Skills/Gateway readiness пропущены инструментом как endpoints с побочными эффектами. Frontend на `http://localhost:5173` ответил 200 и прошёл частичную проверку компиляции; полная браузерная проверка учитывается отдельно. Snapshot worker жив, настоящее snapshot-задание не запускалось.

Профиль fast запускает текущие `dist`/Vite, не старую immutable generation. Launch metadata не содержит generation/sourceSha; HEAD/tree и успешные main builds зафиксированы отдельно, неизвестные поля не подменяются предполагаемыми значениями. На момент запуска queued/running/reconciling в bridge_jobs, project_chat_messages, system_role_runs и operations — 0.

Raw свидетельства: `.run/local-main-update-20261027/{preflight.md,dev-up-evidence.json,final-db-source-evidence.json,runtime-processes.json,mcp-final-health.json,catalog-migration-evidence.json,catalog-backup-evidence.json}`. Секретные env/backup остаются локальными и не включаются в Git.

## Мост и архив

Исходная рабочая установка — 0.9.21, bundled Node 24.22.0, detached worker PID 3935. До проверки кандидата она сохранена без изменения. Старый dev pointer 0.9.19 перемещён под собственным install lock в `current.quarantined-before-main-ba6845dc.json`; это предотвращает преждевременное применение из `dev.sh up`. Старое поколение не удалено.

Кандидат main 0.9.23 собран и упакован в `generation-Y5V63V`. Build `9191c83755d4f9ba1255566b3800500984749b43b4dbd5f03e1f2b5ff6fb83ee`, tgz SHA256 `f06436e7853b40feedad75c58a26c253af3b5298eeaf4caccd32413b46954ca0`.

Настоящий `install.sh --archive` прошёл офлайн в собственном HOME с пробелами/Unicode в путях: sidecar SHA, bundled Node/bridge/probe, ручной provider и чужой MCP сохранены; обращения к system node/npm/curl отсутствовали. Это реальная установка архива в изолированный профиль, не обновление рабочего профиля пользователя.

Полная проверка native installer и обновление рабочего подключения ещё выполняются. Первый прогон остановился на 30-секундном deadline случая с отозванным ключом без worker. Диагностический повтор с 60-секундной границей завершил установку, но обнаружил устаревшее ожидание теста: реальный установщик пропускает server pause, если живого worker нет. В тесте исправлено только это ожидание; live-worker guards сохранены. Добавлены bounded stdout/stderr и завершение собственной process group с ожиданием close, чтобы следующий timeout оставлял проверяемую причину. Диагностический повтор не считается полным PASS.

## Живой интерфейс и оставшиеся границы

Живая desktop-проверка Chromium 1440×1000 прошла против настоящих API: штатная кнопка входа создала действительную сессию Главного админа, auth/flags/projects/devices/operations и прочитанные role-chat/system-role endpoints ответили 200. Подмен business API и QA fixtures в основной БД не было. Проверены основной `/start`, честный статус CLI, общая команда установки, keyboard focus, явные legacy/setup=1 входы, пустая очередь операций/фильтр/deep link и входы в пять раздельных сервисных ролей.

В UI виден один существующий проект, он не использовался как QA-сущность; компьютеров и активных операций на момент проверки — 0. Явных бизнес-записей не выполнялось; интерфейс штатно отправил пять фоновых `PUT /api/chat-presence/session`. Новых ошибок продукта не выявлено: первоначальный auth401 предшествовал входу, известный AntD Table defaultProps warning учитывается отдельно. Просмотр и навигация не подтверждают ответы моделей или выполнение системных задач.

Реальные флаги: `unified_project_setup`, `computer_connections`, `service_role_conversations`, `system_role_chat`, `project_chat` включены; `agent_method_workflows`, `project_agent_workflows`, `project_agent_chat_workflows` выключены вместе с зависимостями. Глобальные flags/роли при проверке не менялись. Реальные методические/model-запуски и новые исходные сообщения не создавались; причинные OFF/503/cancel случаи остаются свидетельствами контролируемой приёмки реализации.

Свидетельства: `output/playwright/main-live-20261027/{result.json,auth-evidence.txt,smoke-evidence.txt}` и desktop screenshots. Root отдельно просмотрел основной мастер; screenshot сервисной роли снят до завершения загрузки, его визуальная проверка уточняется отдельно. Обновление установленного рабочего моста пока ожидает полного native gate и официального переподключения.

Native Windows/другие ОС, внешняя production-площадка, реальная модель, полное восстановление и весь регресс продукта этим обновлением не принимаются. Quirk и существующая пользовательская конфигурация не используются как тестовый полигон.
