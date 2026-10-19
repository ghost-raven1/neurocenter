# Настройки проектов и первый запуск — 19 октября 2026

**P2-RET закрыт локально.** Исправлены пять связанных групп ошибок: сохранение retention, форма PATCH, атомарность аудита настроек/квот, права по имени проекта и первый запуск на пустой БД. Три агента подготовили независимые проверки; основной агент свёл исправления, проверил браузер и применил catalog локально. Рабочие данные сохранены. Production-допуск — **NO-GO**.

## Исправления и контракт

| Группа | До | После |
| --- | --- | --- |
| Срок хранения | `PATCH /api/projects/:id/retention` возвращал присланное тело даже для отсутствующего проекта, ничего не сохраняя. Тип frontend API содержал другие поля | Принимает ровно `{retention: целое 1..100}` — число сохраняемых снимков. Ответ `{retention: сохранённое число}`; неверное тело/лишние поля — 400, отсутствующий проект для главного администратора — 404. Frontend API согласован с этим контрактом. |
| Форма общего PATCH | `null`, массив, число и строка превращались object spread в допустимый пустой запрос и давали 200 | Проверяется исходное тело до чтения проекта/записи; эти формы дают 400. Обычный пустой объект остаётся совместимым no-op. |
| Настройки и аудит | Общий PATCH не записывал аудит; квоты сохранялись раньше отдельной fire-and-forget операции, ошибка журнала скрывалась, точный повтор создавал лишнюю запись | Общий `ProjectSettingsRepository`: текущая строка `FOR UPDATE`, merge частичных квот, UPDATE и `security_events` в одной транзакции. Сбой записи/аудита откатывает изменение; здоровый повтор работает. Точное/параллельное одинаковое значение не меняет `updated_at` и не создаёт дополнительный аудит. |
| Права и alias | Gateway разрешал проектному админу обновление квот по имени, но controller искал участников по этому имени как по ID и отвечал 403 | Для общего PATCH, retention и квот используется единая свежая проверка claims/активной роли. ID и имя работают одинаково; observer/developer и чужие области отклоняются. Отзыв платформенных/проектных прав действует на следующем запросе без нового входа. |
| Первый запуск | Параллельные lifecycle catalog/access/maintenance создавали общую таблицу журнала; на свежем PG воспроизведён `23505 pg_type_typname_nsp_index` | Подготовка `security_events` использует отдельную транзакцию и advisory lock в своей БД. DDL выполняется последовательно, блокировка освобождается при commit/rollback. Обычные записи событий этим schema lock не сериализуются. |

Аудит настройки: `action=project.settings.update`, `resource_id=постоянный ID`, `actor=нормализованная почта из свежих claims`; before/after содержат projectId, state, retention, quotas и fsRootPath. Сохраняется только реальное изменение. Общий `/api/audit` показывает событие как «Настройки проекта», исполнителя, ресурс и результат; внутренний before/after payload в этот API не передаётся. Отдельная операция для такого события не фабрикуется.

Большие controller/service/db получили делегирование в отдельный небольшой репозиторий; строка PostgreSQL вынесена в `project-row.ts`. Общий рефакторинг остальных доменов не выполнялся. Ant Design/Redux/Less сохранены.

## Проверки

[Машинная квитанция](../output/retention-audit-20261019/report.json) сверяет counts, SHA исходников/кандидата/применённого JS, документы, готовность и сохранность данных.

| Уровень | Результат и границы |
| --- | --- |
| Catalog | [1031/1031](../output/retention-audit-20261019/backend/vitest.json), без пропусков; [TypeScript](../output/retention-audit-20261019/backend/typecheck.log). [4 RED](../output/retention-audit-20261019/reads/settings-shape-red.json) исходной формы PATCH, новые retention/schema/shape tests входят в полный набор. |
| Frontend | [976/976](../output/retention-audit-20261019/frontend/tests.json), без пропусков; [TypeScript/build/SHA](../output/retention-audit-20261019/frontend/validation.json). Новый label тестирует также поиск по русскому названию. |
| Retention/settings HTTP + PG | [29/29](../output/retention-audit-20261019/integration/postgres.json): реальный Nest controller/service/AccessDb, отдельный PG, обычный lifecycle без schema warmup. [До исправления](../output/retention-audit-20261019/integration/red.json): 26 RED и 3 parser-level 400. SQL-триггеры реально отклоняют UPDATE/INSERT аудита; проверены rollback, healthy retry, полный before/after, no-op, concurrent repeat, ID/alias, общий PATCH/квоты и настоящая проекция GET audit. |
| Gateway и доступ | [10/10](../output/retention-audit-20261019/access/postgres.json), [старые два RED](../output/retention-audit-20261019/access/old-postgres.json): ProxyService/Axios → Nest AccessController/AccessDb → CatalogController, собственный PG. Настоящий SQL-отзыв назначения/платформенной роли между запросами; неразрешённый запрос не достигает downstream. Логин заменён session fixture, IdP здесь не проверялся. |
| Первый запуск | [3/3 исходных падения](../output/retention-audit-20261019/reads/startup-red.json) и [3/3 GREEN исходного AppModule](../output/retention-audit-20261019/reads/startup-green.json). Дополнительно [3/3 запуска конечного скомпилированного AppModule](../output/retention-audit-20261019/integration/startup-green.json), health200; каждый раз новая БД/папка, без предварительной подготовки схемы. Проверен lifecycle AppModule; production entrypoint/bootstrap/SSO этим не принимаются. |
| Регрессия | [109 прежних SQL/HTTP/FS](../output/retention-audit-20261019/integration.json) и [11 размеров проекта](../output/retention-audit-20261019/integration/project-size.json) повторены на конечном `.retention-audit-dist`. Собственные БД и папки удалены. |
| Независимый review | [Репозиторий/транзакции/права](../output/retention-audit-20261019/access/review.json), [shape, audit, первый запуск](../output/retention-audit-20261019/reads/review.md) — новых блокеров после исправления не обнаружено. |

RAG/gateway/MCP/skills/auth полностью повторно здесь не тестировались; их прошлые suites сохраняют прежние границы. SQL/HTTP интеграции выше используют новый catalog и неизменённые соответствующие компоненты.

Промежуточные проблемы проверки сохранены отдельно: два старых unit pool-mock не имели `connect` и обновлены; одновременные собственные SQL-тесты дали несовпадение списка временных БД, последовательный повтор прошёл; первая size-регрессия выбрала прежний кандидат из-за неверного имени env, конечные 11 сверены по SHA нового кандидата. Первые UI-кадры сняты до окончания анимации Drawer; ожидание полного положения панели исправлено. Эти проблемы harness не объявляются дополнительными продуктовыми исправлениями. Исходный DDL-отказ, напротив, воспроизведён настоящим AppModule и исправлен в продукте.

## Браузер и применение

[4 UI checks](../output/retention-audit-20261019/frontend/ui.json): понятное название события/исполнитель, русский поиск, подробности транзакционного события без запроса выдуманной операции, полностью открытая панель 390 px без горизонтального переполнения. Строка взята из настоящего GET изолированного Nest/PG и подана браузеру как явный fixture; все записи API блокировались. [Desktop](../output/retention-audit-20261019/frontend/audit-details.png), [390 px](../output/retention-audit-20261019/frontend/audit-mobile.png). Рабочий проект ради изменения retention не редактировался.

Catalog применён после [двух idle-снимков](../output/retention-audit-20261019/idle.json) и проверки PID: [перезапуск](../output/retention-audit-20261019/restart.json). Прежняя сборка в `.run/retention-audit-previous/catalog`; frontend использует текущие Vite-исходники, production build сохранён отдельно. [Настоящие GET после применения](../output/retention-audit-20261019/session.json): проект/журнал200, вложенные размеры согласованы, прежний мост0.9.4. Своя сессия завершена, закрыта только своя вкладка.

[Шесть сервисов готовы](../output/retention-audit-20261019/health.json); [сверка данных](../output/retention-audit-20261019/cleanup.json) подтверждает прежние проекты, участников, пользователей, назначения, карточки, реестр, файлы скиллов и список БД. Необработанных browser page errors нет; [console](../output/retention-audit-20261019/frontend/console-full.txt) содержит прежнее AntD defaultProps предупреждение и ожидаемые 401 вокруг сессии. Предупреждение общего bundle >500КБ остаётся.

## Границы

Retention задаёт число будущих сохраняемых снимков; автоматический purge, snapshot executor и внешняя политика bucket этим endpoint не реализуются. Разные конкурентные значения используют прежний last-write-wins, без CAS; отзыв прав проверяется на границе следующего запроса, не отменяет уже авторизованную транзакцию. CAS обслуживания остаётся отдельным действующим механизмом.

Текущий UI не вызывает отдельный retention endpoint; новый экран настройки срока не добавлялся. Внешние шесть P0, семь остальных native-целей, web/snapshot restore, generic retry/cancel, purge и согласованное восстановление FS/PG остаются открыты. `.git` отсутствует: commit/push, CI и production deployment не выполнялись.
