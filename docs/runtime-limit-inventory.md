# Настройки лимитов: текущие владельцы и следующие срезы

Этот документ описывает исходники ветки `feature/project-knowledge-and-hosting-20261029`. Наличие формы не заменяет проверку HTTP, браузера или работающей площадки. Первый общий редактор покрывает текстовую базу знаний и GGUF; всё приложение пока не объявляется полностью настраиваемым.

## Общий редактор

`/settings` → «Лимиты операций», только главный администратор. `GET /api/runtime-limits` возвращает безопасную действующую политику, ревизию и поддерживаемые технические границы. Администратор сохраняет политику через CAS и собственный requestKey; после потери ответа проверяет квитанцию либо явно повторяет тот же запрос. Выключение `runtime_limit_configuration` закрывает новые сохранения редактора; действующая политика, чтение и exact recovery сохраняются.

Владельцы: `services/shared/runtime-limits.cjs`, `services/catalog-service/src/runtime-limits/`, `frontend/src/features/RuntimeLimits/`.

| Группа | Реально применяемые параметры | Приёмка |
| --- | --- | --- |
| Текст | Файлы в пакете, байты файла/пакета/пути/query, количество источников и байты цитаты | Shared validation, RAG SQL/excerpt owner; новая квитанция содержит admission revision/limits |
| GGUF | Размер файла, квота импортов, pending/active upload, метаданные/тензоры/массивы/строки, upload/check/retention, disk reserve, runtime request timeout/response bytes | `GgufImportService` получает `RuntimeLimitsService.ggufPolicy()`; принятый импорт сохраняет снимок; runtime50 проверяется своим owner |

Загрузка текста включает UTF-8 байты путей в batchBytes. Разрешённые символы текста расширяются при JSON-кодировании максимум вдвое: 8MiB данных с envelope помещаются в20MiB RAG parser. Query допускает более сильное escaping; его технический максимум согласован с131072-byte accepted selector. Цитаты согласованы с2MiB accepted evidence и8MiB RPC response. Это проверяется реальным JSON.stringify, а не только числовым сравнением констант.

Файл остаётся ограничен128KiB: [PostgreSQL16 ограничивает один tsvector размером менее1MiB](https://www.postgresql.org/docs/16/textsearch-limitations.html). Увеличение до мегабайт требует отдельного индекса частей документа; скрытое индексирование префикса не используется. До этого администратор меняет лимит файла в поддерживаемом диапазоне, а остальные параметры могут превышать прежние default значения.

## Уже существующие самостоятельные настройки

| Область | Что настраивается сейчас | Владелец / интерфейс |
| --- | --- | --- |
| Токены пользователя по модели | enabled, tokenLimit, periodMs; расход+активный резерв+неизвестный расход учитываются при admission | `model-token-quotas/`, `frontend/src/features/ModelTokenQuotas/`, карточка модели |
| Частота модели | enabled, requests, windowMs, revision CAS | `model-rate-limits/`, `frontend/src/features/ModelRateLimits/`, карточка модели |
| Лимит ответа модели | Параметры конкретного provider/model; входят в оценку резерва | `models/model-planning-options.ts`, `model-token-quotas/quota-estimate.ts`; не все transport поддерживают одинаковые параметры |
| Общая политика квот RAG | defaultBytes, maximumBytes, revision | `services/rag-sync-service/src/rag/quota/platform-quota.ts`, `frontend/src/features/RagQuotaPolicy/`, `/maintenance` |
| Квота конкретного проекта | limitBytes, expectedRevision; уже существующие бюджеты не переписываются при снижении общего максимума | `rag/quota/rag-quota.ts`, `frontend/src/modules/Projects/features/RagQuota/` |
| Кэш локального моста | limitBytes и cleanup policy на выбранном компьютере, версия capability учитывается | `services/shared/runtime-cache-policy.cjs`, `frontend/src/features/McpBridge/RuntimeCacheSettings.tsx` |
| Резервные копии | Расписание, окна, pause, copies, retention, RPO/RTO | `services/shared/maintenance-policy.cjs`, `maintenance/maintenance.service.ts`, `frontend/src/modules/Maintenance/FullBackupSettings.tsx` |

Эти формы имеют собственные права, CAS и квитанции. Общий редактор их не дублирует и не подменяет существующий ledger токенов. Резерв не является настраиваемой произвольной суммой: он вычисляется из запроса и лимита ответа; fallback output estimate4096 в `model-token-quotas.types.ts` пока константа.

## Оставшиеся product-limit consumers

| Следующий срез | Конкретные владельцы | Что ещё необходимо |
| --- | --- | --- |
| Параллельные работы, очереди | `services/rag-sync-service/src/rag/project-databases.ts`, `system-roles/system-role.service.ts`, `package-build/`, `devices/device-jobs.ts` | Вынести продуктовую admission policy с сохранением принятых lease; не менять параллелизм посреди уже принятой операции |
| Таймауты и бюджеты агентов | `system-roles/system-role.definitions.ts` (`ROLE_BUDGET`, `ROLE_RAG_POLICY`, `ROLE_GUIDANCE_POLICY`), `model-chat/chat-round.ts` | Ревизионный снимок для deadline/calls/fanout/context/receipt; изменённые consent pins должны быть проверяемы |
| Таймауты текстового SQL и межсервисных вызовов | `project-text/text-store.ts`, `project-text/text-policy.ts`, `models/project-rag-client.ts` | Согласовать UI ожидание, lock/statement/HTTP budgets и отмену; текущий редактор регулирует размеры и выдачу |
| Резерв токенов и весь model coverage | `model-token-quotas/quota-estimate.ts`, `model-token-quotas.model.ts`, `model-usage/` | Настройка planning default с сохранением accepted estimates, отказом новых запросов по расходу+резерву и учётом последнего превышения; coverage remote/OpenCode проверяется отдельно |
| Вложения и история чата | `model-chat/chat-validation.ts`, `chat.repository.ts`, `chat-context.ts`, `chat-compaction.ts`, `project-chat-inference/project-chat-context.ts` | Согласовать file/total/text/window/history/compaction limits с transport и immutable history; текущие10MiB/50MiB/100KiB константы не выдаются за новую настройку |
| Полные документы сверх128KiB | `project-text/text-schema.ts`, `text-store.ts` | Индексировать все части без потери слов на границах, сохранить точные пути/строки и общую квоту; затем повысить supported file ceiling additive migration |
| Общая capacity safety policy | `services/shared/capacity.cjs` | Отдельно определить что является продуктовой настройкой: disk reserve/staleness и фактическая защита ресурса не должны исчезнуть от выключения UI |
| Личные ключи remote provider | `models/remote-connection.repository.ts`, `remote-model-secret.ts`, `device-codex-connections.ts` | Отдельный срез51: личный ключ каждого пользователя, auth mode provider, без общего admin fallback; секреты не попадают в лимиты/RAG/prompts/Git |

Полнота всех ограничений требует отдельного аудита consumers из последних строк и проверок из задач5 OpenSpec `configurable-runtime-limits`. Данный inventory не является результатом измерения покрытия всего проекта.
