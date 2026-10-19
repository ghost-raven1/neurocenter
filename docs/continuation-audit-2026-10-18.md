# Продолжение доработок — 18 октября 2026

Доработаны аудит папок, очередь моста и загрузка интерфейса. Исправлены подтверждённые ошибки доступа, повторной отмены, переполненной недоступной очереди и кэша истории. Изменения применены локально; промышленный допуск остаётся **NO-GO** по [реестру](implementation-readiness.md).

## Что изменилось

| ID | Проблема / задача | Реализация и проверка |
| --- | --- | --- |
| C01 | Создание папок скиллов не попадало в аудит | Отдельное `skill.directory.create`, проверенный actor, UUID и безопасное состояние `{directory:true}`. Один event на запрошенный путь; созданные родители нужны только для rollback. Prepared откатывается, committed доставляется через прежний outbox. Повтор — noop, отказ ACK — сохранённый результат с pending. Непустые/подменённые папки не удаляются. |
| C02 | Старые задания моста оставались видны после отзыва проекта | `/api/device-jobs` применяет свежие назначения до ограничения списка. Сохраняется владение email, Main видит свои задания; личный выбор корня без проекта доступен владельцу. Отозванные назначения и недействительная активная роль проверены в PostgreSQL. |
| C03 | Повтор отмены после потерянного ответа возвращал ложный конфликт | Уже отменённое собственное доступное задание подтверждается без новой SQL-записи/события. Running/failed не меняются. Свежий отказ доступа продолжает действовать. |
| C04 | Offline компьютер с 100 заданиями отозванного проекта блокировал новую работу при пустом списке | Перед новым enqueue под блокировкой устройства отменяются только queued с доказанно утраченными правами. Проверяются сохранённая роль задания, текущая роль устройства, свежие назначения и существование проекта. Отмена, её аудит и новое задание — одна транзакция. Running/reconciling, доступные задания и повтор requestKey сохраняют прежний контракт; ошибки claims/audit откатывают всё. |
| C05 | Redux истории удерживал записи другого аккаунта/роли после смены доступа | Сброс по подтверждённой auth scope и выходу; поздние ответы игнорируются. Новые 401/403/404 очищают кэш, временный сетевой отказ сохраняет известные записи с ошибкой. Проверены настоящие RTK-thunks с отложенными ответами. |
| C06 | Авторизованный пользователь без разрешённых разделов видел пустую страницу | Guard различает неподтверждённую сессию и подтверждённый пустой список прав. Второй получает 403; код запрещённого раздела не загружается. |
| C07 | Все страницы и закрытая полная очередь входили в начальную загрузку | Разделы и Drawer загружаются по запросу. Доступны статус загрузки, ошибка и перезагрузка с сохранением адреса. Навигация остаётся доступна; query/tab не сбрасывают страницу, глобальная очередь сохраняется при навигации. |

В старом компоненте `Skills.tsx` дополнительно исправлены отсутствие `unwrap()` при создании папки, блокировка повторной отправки и отображение pending. Этот компонент сейчас не подключён как маршрут `/skills` (там 404); правка **не объявляется проверкой пользовательского сценария основного каталога**. Новый аудит папок принят на уровне API/controller/service/storage. Дублирующий экран не добавлялся.

## Размер сборки

Измерен полный граф статических зависимостей production entry, включая импортируемые shared chunks; динамические разделы включаются при открытии. Gzip суммируется по отдельным файлам.

| Показатель | До | После |
| --- | ---: | ---: |
| Начальный JavaScript | 1 529 866 байт | 832 378 байт (−45,59%) |
| Начальный JavaScript gzip | 490 131 байт | 277 275 байт (−43,43%) |
| Начальный CSS | 605 368 байт | 561 129 байт |
| Все JavaScript-файлы gzip | 539 943 байт | 567 978 байт |

Это уменьшение начальной загрузки, а не всего приложения или измеренная скорость сети. Для отдельного холодного раздела учитываются его динамические зависимости; они сохранены в [измерениях после](../output/continuation-20261018/frontend/lazy-size.json). [Базовые измерения](../output/continuation-20261018/frontend/baseline-size.json). Порог Vite не повышался: предупреждение о начальном chunk >500 КБ остаётся. Существующее предупреждение AntD также не объявлено исправленным.

## Проверки точного локального кандидата

- Catalog: **930** tests, 0 failed/skipped; [квитанция и SHA](../output/continuation-20261018/catalog/validation.json), [Vitest](../output/continuation-20261018/catalog/vitest.json), TypeScript candidate.
- Skills: **239** tests, 0 failed/skipped; [Vitest](../output/continuation-20261018/folder-audit/skills-tests.json), [TypeScript](../output/continuation-20261018/folder-audit/skills-typecheck.log).
- Frontend: **905** tests, 0 failed/skipped; [Vitest](../output/continuation-20261018/frontend/vitest.json), [TypeScript](../output/continuation-20261018/frontend/typecheck.log), [production build](../output/continuation-20261018/frontend/lazy-build.log).
- Gateway: **38** проверок (29 фильтрации + 9 инвалидаций, включая папку); [фильтр](../output/continuation-20261018/gateway-access.log), [события](../output/continuation-20261018/gateway-live.log).

В собственных БД повторены **109 PostgreSQL/HTTP/FS сценариев**: [20 publication](../output/continuation-20261018/publication-postgres.json), [11 project assets](../output/continuation-20261018/project-assets-postgres.json), [18 dependency/recovery](../output/continuation-20261018/dependency-protocol-postgres.json), [18 файлового аудита](../output/continuation-20261018/audit-protocol-postgres.json), [14 операций/progress](../output/continuation-20261018/operation-scope-db.json), [10 папочного аудита](../output/continuation-20261018/folder-audit/postgres.json), [9 доступа/отмены очереди](../output/continuation-20261018/catalog/device-queue-db.json) и [9 освобождения очереди](../output/continuation-20261018/catalog/queue-capacity.json). Все процессы завершились с exit 0: [общая квитанция](../output/continuation-20261018/integration.json).

Новый папочный прогон использует настоящие FS, HTTP ACK и PostgreSQL, экземпляр controller с проверенным заголовком; HTTP-путь пользовательской авторизации не подменяется этим результатом. Три SIGKILL затронули только собственные процессы: частичный mkdir, committed outbox и prepared с ручным файлом. Проверено сохранение ручного файла, остановка до первого rmdir и отсутствие повторного mkdir после commit. Собственные БД/папки удалены. [Повторяемый сценарий](../scripts/test/skill-directory-audit-db.mjs).

Через Playwright MCP проверены production JS/CSS восьми страниц, Drawer, удержанная загрузка, навигация во время ожидания, отказ загрузки chunk и reload, 403 с отсутствием импорта запрещённого раздела. Сборка подставлялась только в собственную вкладку; API-чтения настоящие, записи блокировались. Пустые права и сетевой отказ — явные browser fixtures. [Квитанция](../output/playwright/neurocenter-continuation-20261018/ui.json), [ожидание](../output/playwright/neurocenter-continuation-20261018/compiled-loading.png), [отказ](../output/playwright/neurocenter-continuation-20261018/compiled-load-error.png), [390 px](../output/playwright/neurocenter-continuation-20261018/compiled-rag-mobile.png).

Первая мгновенная проверка после resize дала переходное переполнение; пять последовательных замеров после перестройки дали 390/390 px. Устойчивый дефект не подтвердился, CSS не менялся. WebSocket в browser-static fixture ограничен Local Network Access браузера; отдельный обычный Vite-прогон без interception подтвердил «На связи». Preview-порт 5174 сам по себе не принят как production origin. Защиты браузера/ОС не отключались.

## Сохранность и применение

Все исходные файлы скиллов, registry, карточки, список БД и хэши проектов/участников/состава/пользователей сохранены: [baseline](../output/continuation-20261018/baseline.json), [до](../output/continuation-20261018/relations-before.json), [после](../output/continuation-20261018/relations-after.json), [проверка](../output/continuation-20261018/cleanup.json). Рабочие fixtures не создавались.

Catalog и skills перезапущены после двух свежих idle-снимков и проверки управляемых PID; [idle](../output/continuation-20261018/idle.json), [применение](../output/continuation-20261018/restart.json). Прежние сборки сохранены в `.run/continuation-previous`. Все шесть сервисов дали 200: [health](../output/continuation-20261018/health.json). Своя сессия завершена (logout 200, `/auth/me` 401), собственная вкладка и preview закрыты. Чужая вкладка оставлена.

## Открытая подтверждённая проблема

**P1-DUR:** унаследованная семантика файлового журнала считает commit видимым сразу после rename, до успешного directory-fsync. Два искусственных EIO на fsync каталога журнала дали success + pending. [Fault injection](../output/continuation-20261018/folder-audit/durability-gap.json), [повторяемый скрипт](../.run/continuation-skill-journal-durability.mjs). Потеря питания не симулировалась; сохранность такого commit после неё не доказана. Нужны явное состояние неопределённой durability и блокировка дальнейших записей/готовности с безопасным восстановлением; нельзя откатывать уже видимый commit и обещать, что операция не выполнялась. Это не закрыто успешными SIGKILL-тестами.

Остальные внешние P0 и функциональные пробелы остаются в [реестре](implementation-readiness.md). `.git` отсутствует; commit/push, CI и production deployment не выполнялись.
