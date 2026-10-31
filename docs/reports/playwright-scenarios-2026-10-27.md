# Реестр пользовательских сценариев Playwright — 27 октября 2026

Базовая ревизия: `89a96ea62f8c48e2597b0a4da9245f92d2556723`. Реестр составляется **до первого браузерного сценария** по текущим маршрутам, компонентам, помощи, ролям и каталогу функций. Все строки первоначально имеют статус «Не начат». Результаты будут записываться отдельно с конкретными шагами, ревизией, скриншотами, сетью/console, дефектом и повторной проверкой исправления.

Десктоп Chromium 1440×1000; адаптив отложен по прежнему указанию пользователя. Открытие страницы не подтверждает завершение операций внутри неё. Unit, управляемый UI-отказ, настоящий backend, native-мост и внешний сервис — разные свидетельства. Полного декартова произведения всех условий нет: перечисленные варианты обязательны только у своей строки.

Предусловия: **U** — собственные сессии четырёх ролей; **Q** — собственные QA-проекты/участники/карточки; **I** — изолированная платформа для глобальных ACL/флагов/расписаний; **D** — временный QA-профиль моста и папка; **F** — локальный тестовый провайдер без платных вызовов; **S** — маленькие проверенные исходники/архивы; **J** — собственные задания разных состояний; **B** — собственные копии и отдельное назначение восстановления; **W** — управляемая задержка/ошибка в отдельном контексте браузера.

Варианты: `empty` — пустое состояние; `error` — отказ и явный повтор с сохранением ввода; `refresh` — отказ обновления после успешного чтения; `reload` — reload/direct URL; `cancel` — отмена без непредусмотренной записи; `scope` — смена роли/аккаунта/проекта и поздний ответ; `off` — выключение функции с сохранением разрешённой истории/отмены/восстановления; `conflict` — конкурентная редакция; `ack` — неизвестный результат записи и точный повтор прежнего намерения. Happy path подразумевается у каждой строки, кроме явно отрицательной проверки.

Рабочие проекты, пользовательский `bank`, установленный профиль моста, основная PostgreSQL и глобальные настройки работающей площадки не используются как разрушительные QA-фикстуры. Для таких шагов требуется отдельный стенд. Внешний IdP, платный API, реальная внешняя DR и целевая ОС не получают PASS по локальной заглушке.

## Вход, оболочка и управление

| ID | Действие → проверяемый результат | Условия и варианты |
|---|---|---|
| A01 | `/`/защищённый URL без сессии → вход без защищённых данных | U |
| A02 | Войти с вложенного URL → возврат к pathname/query | U; error |
| A03 | Начальный `/auth/me` → подтверждённая оболочка; сеть/401/403 различимы | U,W; error |
| A04 | Reload сессии → пользователь, роль и разрешённая страница восстановлены | U; reload |
| A05 | Повторить проверку доступа → устаревшие права не объявлены актуальными | U,W; error,scope |
| A06 | Выйти → сессия отозвана; Back/reload не раскрывают данные | U; reload |
| A07 | Отказ выхода → нет ложного logout, доступен повтор | U,W; error |
| A08 | Одна/несколько ролей → текст/селектор только назначенных ролей | U |
| A09 | Сменить роль → актуальные меню, страницы и проектные действия | U,Q; reload |
| A10 | Ошибка смены роли → прежняя подтверждённая роль сохранена | U,W; error |
| A11 | Отозвать роль/назначение из второй QA-сессии → актуальный отказ старой формы | U,Q,I; scope |
| A12 | Поздний 401 прежнего аккаунта → новая сессия не завершена | U,W; scope |
| A13 | Меню/группы/вложенные маршруты → правильные разрешения и выделение | U; четыре роли |
| A14 | Компактное меню → переход/Escape/возврат фокуса | Отложено: адаптив вне текущего объёма |
| A15 | Запрещённый/неизвестный URL → различимые 403/404 и выход к разделам | U |
| A16 | `/operations`, `/modal-usage` → корректные aliases с query/hash и правами | U; reload |
| A17 | Отказ lazy-раздела → оболочка/объяснение/повтор доступны | U,W; error |
| A18 | Клавиатура → skip-link, меню, Modal/Drawer, Escape и возврат фокуса | U |
| A19 | Socket connect/disconnect/reconnect → честный статус автообновления | U,W; error |
| A20 | Appearance ON/OFF/reduced motion → управление остаётся доступным | U,I; error,off |
| A21 | Настройка звука → открыть/громкость/тест/выключение согласованы с Settings | U |
| A22 | Звук 0%, blocked, unsupported → объяснение без скрытого включения | U,W; error |
| A23 | Личный звук → reload сохраняет; другой аккаунт не наследует; storage error виден | U,W; reload,scope,error |
| A24 | Новый фоновый результат → один сигнал; история/свои/прочитанные молчат | U,J |
| A25 | Непрочитанный чат/операция → title/favicon; чтение снимает свою метку | U,Q,J |
| A26 | OFF/logout/смена роли → старые badge/звук очищены, job не отменён | U,I,J; off,scope |
| A27 | `/settings` → общие настройки только главному админу | U |
| A28 | Сведения о мосте → найденная/подготовленная версия/offline различимы | U,I; empty,error,refresh |
| A29 | Сохранить источник моста → валидный URL; ошибка сохраняет ввод | U,I; error,reload,off |
| A30 | Проверить версии → результат не назван импортом/обновлением устройства | U,I; error,off |
| A31 | Конфликт источника → актуальная редакция и сохранённый мой вариант | U,I,W; conflict,scope |
| A32 | Поставка ассетов → режим/commit/SHA/ошибка/переход в `/assets` | U,I; empty,error,refresh |
| A33 | Settings-ссылки → правильные обслуживание/доступ/ассеты/подключение | U |
| A34 | `/access` пользователи → поиск/paging/обновление и границы роли | U,I; empty,error,refresh |
| A35 | Добавить QA-пользователя → валидация/нормализация, без отправки письма | U,I; cancel,error |
| A36 | Изменить имя → почта неизменяема; подтверждённое сохранение | U,I; cancel,error,reload,scope |
| A37 | Отключить/включить QA-аккаунт → запросы запрещены/доступ восстановлен | U,I; reload |
| A38 | Назначить/снять главного админа → только выбранный QA-пользователь | U,I; второй активный админ |
| A39 | Последний главный админ → запрет отключения/снятия с объяснением | Только I |
| A40 | Конфликт пользователя → сравнение и сохранённый черновик | U,I,W; conflict,scope |
| A41 | Проектный доступ → фильтры/поиск/обновление/пусто | U,Q; empty,error,refresh |
| A42 | Выдать доступ → валидная почта/QA-проект/роль, назначение сохранено | U,Q; cancel,error |
| A43 | Изменить проектную роль → актуальные права только выбранного участника | U,Q; reload,scope |
| A44 | Отозвать доступ → QA-проект закрыт, другие проекты сохранены | U,Q; cancel,scope |
| A45 | Частичный отказ назначений → точные результаты и повтор оставшегося | U,Q,W; error |
| A46 | Конфликт назначений → новые права не перезаписаны старым выбором | U,Q,I; conflict |
| A47 | Проектный админ → только свои проекты; без выдачи роли админа проекта | U,Q |
| A48 | Мои права → актуальная область и детали решения без чужих данных | U,Q; empty,error,scope |
| A49 | Maintenance tab/hash/Back/reload → правильная вкладка и сохранённый редактор | U,I; reload |
| A50 | Служебные БД → размер/лимит/область/недоступность, честная свежесть | U,I; empty,error,refresh |
| A51 | Физические ресурсы → fresh/stale/absent/low-space различимы | U,I,W |
| A52 | Ручная копия каталога → последнее время/отсутствие/ошибка и повтор | U,I; empty,error,refresh |
| A53 | Создать копию каталога → успех только после подтверждённых файлов | U,I,B; error,off,scope |
| A54 | Внешние копии → расписание/timezone/RPO/SHA/состояния достоверны | U,I,B; empty,error,refresh |
| A55 | Сохранить расписание/retention/RPO/RTO → подтверждённые значения | U,I; reload; расписание изначально OFF |
| A56 | Неверное расписание → понятная валидация без потери ввода | U,I; error |
| A57 | Ошибка/CAS расписания → черновик не затёрт фоном | U,I,W; error,conflict,scope |
| A58 | `project_backups` OFF → включение закрыто, выключение/история/recovery доступны | U,I; off |
| A59 | Политика квот RAG → МиБ сохранены, прежние проектные лимиты неизменны | U,I; reload |
| A60 | Ошибка/CAS квот → валидация, черновик, актуальная ревизия | U,I,W; error,conflict,scope |
| A61 | Restore runner/checkpoint → absent/empty/доступный/история различимы | U,I,B; empty,error |
| A62 | Preview restore → точные SHA/новый target; занятый target без записи | U,I,B; error |
| A63 | Reload/неизвестный preview ACK → прежний request/checkpoint/target | U,I,B,W; ack,reload |
| A64 | Restore confirm → точная фраза; отмена без записи; expired preview закрыт | U,I,B; cancel,error |
| A65 | Применить restore → только новый QA-стек; приложения остаются остановлены | Только I,B |
| A66 | Отменить queued restore → подтверждённый статус; текущий стек сохранён | U,I,B |
| A67 | Restore failed/interrupted/missing → неизвестность и путь продолжения | U,I,B,W; error,reload,scope |
| A68 | Базы удалённых проектов → поиск/paging/детали/квитанции | U,I,B; empty,error |
| A69 | Удержание QA-базы → будущая дата/причина, снятие; отмена без записи | U,I,B; cancel,error |
| A70 | Preview удаления QA-базы → identity/impact/digest/точное имя | Только I,B; cancel,error |
| A71 | Подтвердить удаление → своя БД/квитанция; новая identity не удаляется повтором | Только I,B |
| A72 | Блокер/ошибка удаления БД → удержание/job/anomaly; управляемый повтор | U,I,B,W; error |
| A73 | Все 54 флага → группы/поиск/count/ошибки строк/повтор | U,I; empty,error,refresh |
| A74 | Каждый флаг: ON/OFF → подтверждённый Switch без двойного запроса | Только I; отдельные `<key>.on`/`.off` |
| A75 | Зависимости флагов → configured ON/effective blocked без переписывания выбора | I; все пары dependsOn |
| A76 | CAS флага → перечитать актуальное без автоматического применения | U,I,W; conflict |
| A77 | Потерян ACK флага → сначала проверить, затем явно применить/принять | U,I,W; ack |
| A78 | Отзыв админ-роли → старые формы и поздние ответы закрыты | U,I,W; scope |
| A79 | Сводка операций → проверка/ноль/unknown/stale/denied, медленный ответ не ложный ноль | U,J,W; error,refresh |
| A80 | Drawer операций/query → открыть/закрыть/reload без потери чужих параметров | U,J; reload,cancel |
| A81 | Статусы/paging операций → правильный список/count/сброс | U,J; empty |
| A82 | Подробности job → ID/project/actor/progress/log и понятные ошибки | U,J; empty,error,refresh |
| A83 | Poll/realtime/смена области → нет отката к старым данным | U,Q,J,W; scope |
| A84 | Повтор собственного job → один POST; отказ GET не создаёт второй | U,J,W; ack,error |
| A85 | Отмена job → confirm/возврат/двойной клик без дубля | U,J; cancel |
| A86 | Отмена одновременно с terminal → фактическое состояние, не ложная отмена | U,J,W |
| A87 | Чужой/unsupported job и OFF → права записи, история и разрешённая отмена | U,I,J; off,scope |
| A88 | Старая RAG-ошибка → правильный проект/tab=rag без слепого повтора | U,Q,J |
| A89 | Ошибка сборки → упаковщик с правильным проектом только разрешённой роли | U,Q,J |
| A90 | Audit → сохранённые события/paging/realtime, не пусто вместо ошибки | U,I; empty,error,refresh |
| A91 | Фильтры audit → область текущей страницы/count/сброс честны | U,I |
| A92 | Детали audit → before/after/correlation/связанная операция и повтор | U,I,J; error |
| A93 | Audit role → главный админ читает, другие роли запрещены | U |
| A94 | Model usage scope → все/управляемые/свои/нет маршрута по четырём ролям | U,Q |
| A95 | Usage фильтры/facets → только доступная область и итог периода | U,Q,J |
| A96 | Usage «Ещё» → без дублей, totals не сумма страницы | U,J; empty,error |
| A97 | Usage OFF/error/смена роли → журнал не остановлен, старые данные не перенесены | U,I,W; off,error,scope,reload |
| A98 | Swagger в отдельной вкладке → авторизованный доступ/схема, без выдачи приватных данных | U; error |

## Каталог, ассеты и упаковщик

| ID | Действие → проверяемый результат | Условия и варианты |
|---|---|---|
| C01 | `/store`: проект/tab/тип/поиск → нужная карточка и сохранённый deep-link | Q; reload |
| C02 | Пустой каталог/поиск → различимые состояния и рабочий сброс | Q; empty |
| C03 | Частичный отказ skills/plugins/project → ошибка/прежние данные/повтор | W; error,refresh |
| C04 | Детали MCP/плагина → источник/runtime/файлы/совместимость/версии | S; error |
| C05 | Детали skill → читать/исходник/копировать/ресурсы/dependencies | S; error |
| C06 | Создать удалённый MCP → валидные URL/JSON/env references | Q; error,off,scope |
| C07 | Создать файловый MCP/плагин → entrypoint и точные зависимости | Q,S; error,off |
| C08 | Создать skill → ручной slug/Markdown/ресурсы/pins сохранены | Q,S; error,off |
| C09 | Ошибка полей/имени → конкретное поле, введённое и ID сохранены | Q,W; error |
| C10 | CAS карточки → сравнение/явное продолжение с моим вводом | Q,W; conflict,scope |
| C11 | Архивировать/вернуть QA-карточку → история/pins читаемы | Q; off,scope |
| C12 | Добавить/убрать в проект → выбранный проект, не ложная локальная установка | Q; reload,off,scope |
| C13 | Пакетное назначение → точные частичные результаты без повторных дублей | Q,W; error,ack |
| C14 | Смена проекта/роли → поздний ответ не меняет новую область | Q,W; scope |
| C15 | План установки → точная версия/комплект/права/одобрение/установка | Q,D,S; error,scope |
| C16 | Нет binding/offline/platform mismatch → причина и путь подключения, без установки | D; empty,error |
| C17 | Неизвестный ACK установки → прежнее намерение без второго job | D,W; ack,reload |
| C18 | `tool_installation` OFF → запрет нового, история/отзыв/recovery доступны | D,I; off |
| C19 | Упаковщик npm → точная версия и явный выбор entrypoint | S; error |
| C20 | Упаковщик GitHub → ref/commit/subdir/entry/release закреплены | S; error |
| C21 | Упаковщик files/archive → JS/TS/skill, инструкция и ресурсы сохранены | S; error |
| C22 | Архив MCP → выбор entrypoint/отмена/recovery без смешения архивов | S,W; error,reload,cancel |
| C23 | Type/platform/runtime validation → неполный источник не допущен | S; error |
| C24 | Агент Упаковщик → модель/бюджет/согласие/рецепт/evidence | F,S; error,off |
| C25 | Сборка → прогресс/скрыть/переоткрыть/reload принятой операции | S; reload |
| C26 | Неизвестный ACK сборки → сохранённый запрос и точный recheck | S,W; ack,reload |
| C27 | Ошибка сборки → диагностика/к исходникам с сохранением формы | S; error |
| C28 | Отмена сборки/ACK/OFF → нет поздней публикации, recovery доступен | S,W,I; ack,off |
| C29 | Успех сборки → скачать пакет/asset.json/открыть свою карточку | S; error |
| C30 | Новая версия → актуальная основа; разные CAS до/после допуска | Q,S,W; conflict,ack |
| C31 | `/assets`: опись/поиск/выбор/импорт → точные версии/dependencies | S; empty,error |
| C32 | Обновить/перечитать поставку → commit/SHA и прежняя проверенная опись при отказе | S,W; error,refresh |
| C33 | Импорт ZIP/TAR/TGZ → полнота/SHA, без скрытого скачивания missing | S; error |
| C34 | Отмена/ошибка архива → прежняя поставка и возможность повторить | S,W; cancel,error |
| C35 | Конфликт локальной редакции → заменить/оставить явно, история/pins сохранены | Q,S; conflict |
| C36 | Import partial/failed/needs-input/cancel/ACK/OFF → точный результат/recovery | S,W,I; error,ack,reload,off |
| C37 | Заявка → создать/править/отправить; scoped filters/paging/history | Q; empty,error,reload |
| C38 | Рассмотрение заявки → разрешённые переходы/карточка результата | Q; scope,off |
| C39 | CAS/ACK заявки → комментарий/намерение сохранены, 403 закрывает детали | Q,W; conflict,ack,scope |
| C40 | Шаблон агента → поиск/детали/create/edit/slug/prompt/model/permissions | Q; empty,error,off,scope |
| C41 | Агент проекта → pin/overrides/enable/disable/reset/remove | Q; error,scope |
| C42 | Применить агента → QA-профиль/provider/preview; Build/Plan не затёрты | Q,D; error,ack,off |
| C43 | Испытание агента → модель/контекст/согласие/ответ/pins; путь настройки | Q,F; empty,error |
| C44 | Испытание ACK/stop/OFF → прежний запрос, история/отмена без второго inference | Q,F,W,I; ack,reload,off |
| C45 | Текущие установки/история папок → правильная binding, история без текущих write-действий | Q,D; error,reload,scope |
| C46 | Проверить файлы/отменить queued-проверку → достоверная сверка, не ложный запуск | Q,D,W; error,cancel,ack |
| C47 | Проверить запуск OpenCode → отдельное согласие и точный инструмент/результат | Q,D,S; error,cancel |
| C48 | Compare/repair → preview/diff/confirm/локальная копия; expired/target conflict закрыты | Q,D,S,W; error,conflict,cancel,ack |
| C49 | Сохранённые локальные варианты → выбрать файлы/новый preview/restore с сохранением нынешнего | Q,D,S; empty,error,cancel |
| C50 | Настроить MCP/local settings → точная установка, скрытые секреты, отдельное ready | Q,D,S; error,scope |
| C51 | Удалить с компьютера → cancel/confirm; modified files blocker, каталог сохранён | Q,D,S; error,cancel,ack |
| C52 | Найдено в проекте → только QA-root, empty/partial/stale не приняты за полный scan | Q,D,S,W; empty,error,refresh |
| C53 | Принять под управление → одобренная identity/metadata, файлы/подключения сохранены | Q,D,S; error,conflict,ack |
| C54 | Auto-update opt-in/check/disable/cancel → личная policy, CAS/ACK/OFF без скрытого повтора | Q,D,S,I,W; error,conflict,ack,cancel,off |

## Модели и чаты

| ID | Действие → проверяемый результат | Условия и варианты |
|---|---|---|
| M01 | `/store?tab=models`: поиск/project/details/API → выбранная область | Q; reload,scope |
| M02 | Нет моделей/отказ → добавить/подключить/повтор, не ложный ноль | Q,W; empty,error |
| M03 | Добавить local/remote chat/embedding → точные model/version/capability/dimension | Q,F; error,off |
| M04 | Изменить модель → редакция сохранена, индекс не объявлен перестроенным | Q,F; error,scope |
| M05 | Подключить API OpenAI/Ollama native → верный адрес/протокол без двойного пути | Q,F; error |
| M06 | Auth none/stored/env → секрет скрыт; пустое поле оставляет прежний | Q,F; error,scope |
| M07 | Сохранить/проверить/обновить модели → ошибки фаз сохраняют ввод/нужное продолжение | Q,F,W; error,ack |
| M08 | Отозвать подключение → новый вызов закрыт, история сохранена | Q,F; error,off |
| M09 | Подготовить/запустить/проверить/выгрузить → достоверные состояния/операция | F; error,reload,off |
| M10 | Лимит запросов → диапазоны/CAS/мой ввод/точный ACK-retry | Q,F,W; error,conflict,ack,off |
| M11 | Назначить/снять модель проекта → меняется только выбранный проект | Q,F; scope,off |
| M12 | Выбрать embedding → точный профиль/target; явный reindex | Q,F,D; error |
| M13 | Из OpenCode: device/global/project → правильный источник/кандидаты | Q,D; empty,error |
| M14 | Импорт модели/ключа → отдельное согласие, старый source-result не применяется | Q,D; error,ack,scope |
| M15 | Настроить OpenCode/Codex → временный профиль/совместимость/identity | D,F,I; error,off |
| M16 | Личный диалог → project/model и закреплённая модель; другая модель — другой разговор | Q,F; empty,scope |
| M17 | История/ранние сообщения/rename/delete своего → приватность и reload | Q,F; error,reload,scope |
| M18 | Отправить/поток/Stop/retry → подтверждённые terminal states | Q,F; error |
| M19 | Скрыть/сменить страницу/reload → принятый turn продолжается, это не Stop | Q,F; reload |
| M20 | Неизвестный ACK send/retry → тот же request ID без второго turn | Q,F,W; ack |
| M21 | Документ чата → upload/preview/remove/отказ без потери текста | Q,F,S; error,cancel |
| M22 | Контекст/compaction → бюджет/ошибка/история без тупика | Q,F; error,off |
| M23 | Личная группа/@mentions → состав/отдельные ответы/частичный отказ | Q,F; error,scope,off |
| M24 | Исследование → выбор tools/согласие/ход/сохранённые источники | Q,F,S; error,off |
| M25 | Контекст/инструменты → явные scopes/receipts; несовместимые выборы сохранены | Q,F,D; error,scope,off |
| M26 | Системный агент → подготовка без inference, затем явный бюджет/согласие | Q,F; empty,error |
| M27 | Системная роль → история/отмена/предложение/явное apply/rollback | Q,F,I; error,ack,off,scope |
| M28 | Старые service chats → только история, без нового сервисного ввода | Q; reload,scope |
| M29 | Usage period/facets/totals | Объединено с A94–A95, не повторять счётчик |
| M30 | Usage paging/error/OFF | Объединено с A96–A97, не повторять счётчик |
| M31 | Legacy usage alias | Объединено с A16, не повторять счётчик |
| M32 | Отзыв модели/chat/grant во время запроса → свежие права без утечки позднего ответа | Q,F,W; scope |

## Помощь и обсуждения

| ID | Действие → проверяемый результат | Условия и варианты |
|---|---|---|
| H01 | Help поиск/сброс/article/все статьи → правильный документ | Q; reload |
| H02 | Пусто/неизвестный slug/отказ → различимые состояния/повтор | Q,W; empty,error |
| H03 | Markdown/code/links → безопасный рендер, HTML/script не исполняются | S |
| H04 | Скачать .md → имя/точные UTF-8 bytes | Q,S |
| H05 | Создать статью → slug/#title/непустой UTF-8/512КиБ, ввод сохранён | Q; error,scope |
| H06 | Импорт .md → slug/preview; плохой файл не стирает текст | Q,S; error |
| H07 | Сохранить QA-статью → подтверждённый текст/маршрут/reload | Q; reload |
| H08 | Закрыть/открыть редактор без save → draft внутри страницы сохранён | Q |
| H09 | SHA/CAS → читать актуальное/сравнить/применить с моим текстом | Q,W; conflict |
| H10 | Неизвестный save ACK → read-current и правильное явное продолжение | Q,W; ack |
| H11 | Help OFF/отзыв редактора → читать/download/history доступны, save закрыт | Q,I,W; off,scope |
| H12 | Комментарий/reply → Markdown/parent/count/пусто | Q; empty |
| H13 | Ошибка/ACK комментария → текст/файлы/намерение и точный повтор | Q,W; error,ack |
| H14 | CAS комментария → актуальный текст и сохранённый draft | Q,W; conflict |
| H15 | Удалить свой комментарий → confirm/tombstone/ответы/права | Q; cancel,scope |
| H16 | Файлы комментария → лимиты/upload/download/remove/неизвестный PUT | Q,S,W; error,ack |
| H17 | История/ещё/refresh → без дублей/ложных totals | Q; error,refresh |
| H18 | Сердечко → count/aria-pressed/точное желаемое состояние при ACK | Q,W; ack |
| H19 | Discussion/attachments/reaction OFF → история/download/delete/unlike доступны | Q,I; off |
| H20 | Actor/target/revoke при чтении → чужой текст/вложения не перенесены | Q,W; scope |

## Снимки и проектные копии

| ID | Действие → проверяемый результат | Условия и варианты |
|---|---|---|
| S01 | `project?tab=snapshots`: список/refresh → empty/error/прежние данные | Q; empty,error,refresh |
| S02 | Нет/offline/неверная binding → create закрыт с причиной и следующим действием | Q,D; error |
| S03 | Создать снимок с QA-компьютера → upload/verify/manifest/signature | Q,D,S |
| S04 | Pending cancel/ACK/reload/OFF → точное намерение и разрешённая отмена | Q,D,W,I; cancel,ack,reload,off |
| S05 | Activate/rollback → confirm/head CAS; локальная база не переключена | Q,D,S; conflict,cancel |
| S06 | Delete → current/pinned защищены; обычный снимок/grace/physical-state честны | Q,D,S; error,cancel |
| S07 | Release profile → snapshot+tool pins, active/head различимы; скачать подпись | Q,D,S |
| S08 | Роль/проект/OFF при snapshot action → старое подтверждение/ответ закрыты | U,Q,D,I,W; scope,off |
| S09 | `project?tab=backups`: список/refresh → empty/error/прежние копии | Q; empty,error,refresh |
| S10 | Создать/скачать QA-копию → подтверждённый PG dump выбранного проекта | Q,B |
| S11 | Отказ/warning/неизвестный create ACK → без ложного успеха, refresh перед retry | Q,B,W; error,ack |
| S12 | Retention пяти копий/role/OFF → прежние копии/чтение/download сохранены | U,Q,B,I; off,scope |

## Подключение компьютеров, проекты, RAG и обучение

Входы: **Start0/1/2** = `/start?step=0|1|2`, выбор проекта через `p`; **Project(tab)** = `/projects/<QA-id>?tab=<tab>`; **Agents** = Project(store)+`catalogTab=agents`; **Team** = шапка «Чат» → «Команда проекта». Native-предпосылка не считается подтверждённой одним браузерным кликом.

| ID | Действие → проверяемый результат | Условия и варианты |
|---|---|---|
| B01 | Start шаги/URL/проект/hash/Back/неизвестный step → согласованное состояние | reload |
| B02 | Скопировать OpenCode-команду → правильные площадка/OS/TLS bootstrap | POSIX/Windows, без исполнения |
| B03 | Clipboard отказ → команда видна и доступно ручное копирование | W; error |
| B04 | Start2 выбрать проект → доступный список и сохранённый `p` | Q; empty,error |
| B05 | Список компьютеров → loading/empty/unconfirmed/error/retry различимы | U,D,W; empty,error |
| B06 | Мост уже установлен → connect-команда без ненужной переустановки | D; POSIX/Windows/unknown platform |
| B07 | Переподключить → reconnect и подтверждённые роль/heartbeat | D,U; error |
| B08 | Подтвердить свой pairing → показанное устройство без дубликата | D,U; ack |
| B09 | Ручной pairing code → правильный/неверный/expired без подбора чужого | D; error |
| B10 | Pair до heartbeat → явное ожидание, не выдуманная версия/готовность | D,W |
| B11 | Выбрать другой компьютер → его папки/version/jobs, старый ответ не перенесён | D×2; reload,scope |
| B12 | Отменить отзыв компьютера → файлы/задания/регистрация сохранены | D; cancel |
| B13 | Отозвать QA-компьютер → исчезновение/отмена ожидающего, локальные файлы сохранены | D,U; error |
| B14 | Источник/версии → installed/available/dev/target различимы | D; error,refresh |
| B15 | Подготовить поставку → принятый запрос/прогресс/подтверждённый результат | U,I,S,W |
| B16 | Stop/retry поставки → partial не ready, прежнее намерение/reload | I,S,W; cancel,ack,reload |
| B17 | Установка из архива: команда → корректные OS/path quoting | S; empty,error |
| B18 | Установить QA-архив → SHA/target/version; corrupt не заменяет прежний runtime | D,S; native prerequisite |
| B19 | Выбрать QA-root → только после результата native-job; системная отмена безопасна | D; cancel |
| B20 | Отменить queued folder choice → прежний root и состояние очереди | D,W; cancel,reload |
| B21 | Мастер binding → проверить/подтвердить новую папку отдельно | D,Q |
| B22 | Нет root/подпапок → перейти к выбору/обновлению | D; empty |
| B23 | Создать отдельную копию → новый instance, исходный сохранён | D,Q,S |
| B24 | Перенести экземпляр → прежний instance и новая current folder | D,Q,S |
| B25 | Legacy/resume → отдельная проверка identity/history, recovery при OFF | D,Q,S,I; off |
| B26 | ACK/истёкший preparation/смена файла → старое намерение не применено новому target | D,W; ack,scope |
| B27 | Кэш комплектов → размер/time/target/capabilities/путь обновления | D; error |
| B28 | Сохранить cache MiB → bounds и подтверждение компьютера | D,W; error,ack,reload |
| B29 | Хранение предыдущих копий → минимум один rollback, не ложная очистка cache | D,I; off |
| B30 | Agents → Файлы проекта → точный device/binding/instance/local editor | D,Q,U; error |
| B31 | Preview/apply обычного QA-файла → before/after/посторонний текст/копия восстановления | D,Q,S |
| B32 | Локальный file CAS → запись остановлена, текст сохранён | D,W; conflict |
| B33 | Managed/RAG files → managed защищены, разрешённые поля/unknown JSONC сохранены | D,S |
| B34 | Editor OFF/expired/revoked → новый write закрыт, cancel/history/close доступны | D,U,I,W; off,scope,error |
| P01 | Проекты → empty/error/read/retry различимы | U,Q,W; empty,error |
| P02 | Поиск/paging → правильный проект и согласованный список | Q |
| P03 | Project tab/deep-link → разрешённая вкладка/Back/reload, неизвестная нормализована | U,Q; reload |
| P04 | Локальный размер/серверная копия → выбранный device, fresh/stale/0/offline/capability различимы | Q,D,W; error,refresh |
| P05 | Создать QA-проект → канонический ID/карточка/начальная квота | U,Q |
| P06 | Неверное имя → пусто/slash/длина отклонены без записи | error |
| P07 | Create error/неполный ACK/двойной клик → ввод и достоверный ID без дубля | W; error,ack |
| P08 | Отменить delete → QA-проект и данные сохранены | Q; cancel |
| P09 | Подтвердить delete → точный Q; active-job blocker/ошибка с продолжением | U,Q,J,W; error |
| P10 | Добавить QA-участника → разрешённая роль/email | U,Q |
| P11 | Member validation/duplicate/server failure → введённое сохранено | U,Q,W; error |
| P12 | Изменить роль → confirmed role/expectedRole conflict и ограничения project-admin | U,Q; conflict |
| P13 | Удалить QA-участника → cancel/confirm/ошибка не ложный успех | U,Q,W; cancel,error |
| P14 | Role/revoke при открытом проекте → поздние данные/успех старого scope закрыты | U,Q,W; scope |
| P15 | `projects` OFF → read/history/разрешённое delete сохранены, create закрыт | Q,I; off |
| P16 | Team human-only send → одно сообщение без model call; Enter/ShiftEnter/IME | U,Q |
| P17 | Reply/cancel quote → правильный parent, текст не стёрт | Q; cancel |
| P18 | Project/dialog switch/reload → раздельные draft/reply/recipients | Q×2; reload,scope |
| P19 | Приватный диалог → виден только создателю/выбранным, включая постороннего админа | U×3,Q |
| P20 | Dialog create ACK → прежний запрос без второго диалога | Q,W; ack |
| P21 | Dialog settings CAS → серверное сравнение и сохранённый ручной ввод | U,Q,W; conflict |
| P22 | Удалить участника диалога → доступ отозван, позднее чтение не возвращает его | U×3,Q; scope |
| P23 | Настроить агентов диалога → только назначенные, max8, без inference при открытии | U,Q,F |
| P24 | Валидные @mentions → приоритет/дедупликация/число model calls | Q,F |
| P25 | Неверный/отозванный @ → текст сохранён, нет dispatch другим; email/code обычный текст | Q,F; error,scope |
| P26 | Stop/retry missing agents → готовые ответы сохранены | Q,F,W; error |
| P27 | Send ACK/reload → прежний prompt/reply/recipients/key без дубля | Q,W; ack,reload |
| P28 | Chat/group/dialogs OFF → история/Stop; human-only и отдельные диалоги по контракту | Q,I; off |
| P29 | Presence/typing/read → hidden не read; отказ unknown; записанные отметки при OFF | U×2,Q,W,I; error,off |
| P30 | Project-agent pin/override → общий шаблон и соседний проект не изменены | U,Q,S |
| P31 | Agent editor CAS/dirty close → draft/compare/явное apply и cancel close | U,Q,W; conflict,cancel |
| P32 | Apply agent в QA-folder → только managed файлы текущего binding; offline queued | D,Q; reload,scope |
| P33 | Disable/remove project-agent → confirmation/cleanup OFF; другие папки не названы обновлёнными | D,Q,I; cancel,off |
| P34 | Испытать сохранённого агента → явный запуск/проверка unknown/Stop | Q,F,W; error,ack |
| P35 | Grant инструментов → выбранные источники/шаги/model pin/согласие | Q,F,D |
| P36 | Открыть tools без send → нет вызова, причины неготовых источников и настройка | Q,F,W; empty,error |
| P37 | Tool dispatch error/ACK → receipts исходного запроса без скрытого повтора | Q,F,D,W; error,ack,reload,scope |
| P38 | Public-chat search → исключены приватные/соседние/revoked QA-маркеры | U,Q,F |
| P39 | Ранняя история+pending → без дублей, pending продолжает обновляться | Q,J,W |
| P40 | Подготовить system task из Team → draft сохранён, нет публикации без подтверждения | Q,F,I |
| R01 | Project RAG summary → empty/syncing/legacy/ready подтверждены, строки не равны ready | Q,S; empty |
| R02 | Summary update failure/403/404 → stale или очистка закрытых данных | Q,U,W; error,refresh,scope |
| R03 | Нет binding/capability → write закрыт, причина/путь подготовки | Q,D; error |
| R04 | Подготовка RAG → каталог получает точный project/OpenCodeRAG и возврат | Q,D |
| R05 | Embedding selection → только назначенные подходящие, сохранённый pin не подменён | U,Q,F |
| R06 | Нет модели/catalog error → путь к моделям, прежний выбор не затёрт | Q,W; empty,error |
| R07 | Подключить embedding пустому Q → plan/result точной модели без ложного rebuild | U,Q,F |
| R08 | Смена модели непустого Q → count/допместо/последствия до запуска | Q,F,S |
| R09 | Rebuild/connect → один plan/progress, reload без второго запуска | Q,F,W; reload |
| R10 | Cancel rebuild до/во время → старое active поколение сохранено | Q,F,S; cancel |
| R11 | Reindex failed/stale retry → проверенный план, актуальные source/pin | Q,F,W; error |
| R12 | Подключить к установке → точные device/install, согласие на код, separate server-only | Q,F,D |
| R13 | Изменение модели/install/binding во время отправки → поздний ACK не применён | Q,D,W; scope,ack |
| R14 | Ошибка native rebuild → прежний локальный индекс, не ложный verified+synced | Q,F,D,W; error; native proof |
| R15 | Offline принятый connect → очередь; после reconnect свежие права/target | Q,D,W; reload |
| R16 | Sync server → complete seal/snapshot, профиль/байты согласованы | Q,D,S |
| R17 | Partial sync/retry → нет дублей и потери baseline | Q,D,S,W; error |
| R18 | Sync unknown ACK → прежний key/direction, новая область не повторяет старое | Q,D,W; ack,reload,scope |
| R19 | Cancel local restore confirmation → локальные данные не изменены | Q,D,S; cancel |
| R20 | Restore → точные Q/device/folder и замена, не merge | Q,D,S |
| R21 | Restore locked/OpenCode open → отказ без изменения индекса/чужого lock | Q,D,S; error |
| R22 | Bad seal/hash/profile → нет замены, понятное восстановление | Q,D,S,W; error |
| R23 | RAG Dashboard → current install/одноразовая сессия, без автоиндексации | Q,D; error |
| R24 | Dashboard index/stop/ACK → unknown status/reload без второго POST | Q,F,D,W; ack,reload |
| R25 | Project quota → integer/bounds/save/CAS и draft | U,Q,W; error,conflict |
| R26 | Достигнуть маленькой QA-квоты → write отклонён, read/download/delete доступны | Q,D,S |
| R27 | `rag_sync` OFF → запрет нового, history/Stop/restore/accepted replay сохранены | Q,D,I,W; off,ack |
| R28 | Роли RAG → observer read-only; developer не меняет admin model/quota | U,Q |
| R29 | Отключить модель → явное действие, прежние данные не объявлены удалёнными | U,Q,S |
| R30 | `/rag`: поиск/list/project → доступные проекты/названия/empty/retry | U,Q,W; empty,error |
| L01 | Learning empty → первый опыт/следующий шаг, не ошибка | Q; empty |
| L02 | Поиск/tabs/ещё/history → область загруженных данных, корректные counts | Q,S |
| L03 | Добавить опыт → итог/основания, агентское наблюдение не human-proof | U,Q |
| L04 | Validation опыта/SHA/оснований/длины → ввод сохранён | Q; error |
| L05 | Ручная гипотеза → направление/основания/план; знания не применены | Q,S |
| L06 | Нет модели/опыта → анализ закрыт, понятный следующий шаг | Q; empty,error |
| L07 | Анализ выбранного опыта → одна pending-операция Q/точная модель | U,Q,F |
| L08 | Reload/закрытие анализа → восстановление без второго model call | Q,F,W; reload |
| L09 | Failed/unknown analysis → read/replay прежнего ключа только явно | Q,F,W; error,ack |
| L10 | Успешная human-review → факты/основания/подтверждение, путь к кандидату | U,Q,S |
| L11 | Failed/inconclusive human-review → сохранённый исход/зависимые знания не применяются | Q,S |
| L12 | Кандидат знания/инструкции → успешная human-review, key/agent/version | Q,S |
| L13 | Одобрить → admin/основание/checkbox, current только после ACK | U,Q; ack |
| L14 | Отклонить → история без включения в контекст | U,Q |
| L15 | Отозвать → сразу вне контекста, прошлое не активируется само | U,Q,I; off |
| L16 | Новая версия ключа → current новый, прежняя в истории | U,Q,S |
| L17 | Вернуть версию → свежие основания/агент/явная запись | U,Q,S |
| L18 | Learning CAS → draft и явная актуальная ревизия | U,Q,W; conflict |
| L19 | Learning write ACK → прежний key/body; новое действие ждёт разрешения unknown | Q,W; ack,reload |
| L20 | Смена role/project → нет чужого успеха/данных, observer только читает | U,Q,W; scope |
| L21 | Learning OFF → история/revoke/reject сохранены, новое закрыто | Q,I; off |
| L22 | Quirks import → default OFF; ON выбирает точные device/install | Q,D,I |
| L23 | Quirks partial/repeat → RAG сохранён, imported skipped, опыт не auto-approved | Q,D,S,W; error |
| L24 | Quirks stop/recovery → partial counts/история/прежний request target | Q,D,I,W; reload,off,scope |
| L25 | Approved knowledge → Memory → только Q; личная память/ручные связи сохранены | U,Q,D,I,S |
| L26 | Memory cleanup revoked → только свои наблюдения, доступно при OFF | U,Q,D,I,S; off |
| L27 | Memory partial/ACK/reload/cancel → прежний plan/key, без дублей/нового instance | Q,D,W; error,ack,reload,cancel,scope |
| L28 | Quirks/Memory capability/install/offline/stale → конкретный blocker без dispatch | Q,D; error |

Отдельного UI изменения имени/state/externalResourceId существующего проекта не найдено: не объявляем API UPDATE пройденным браузером. Вкладки snapshot/backup покрывает группа S, project audit — A80–A89. Swagger `/api/docs` проверяется как ссылка/доступ/описание; операторские CLI не подменяют браузерный сценарий.

## Порядок и критерии результата

1. Зафиксировать данный реестр и развёрнутый ledger до открытия браузера.
2. Начать с входа/оболочки/чтения всех экранов; затем собственные QA-сущности, роли/флаги, длинные workflow и восстановления.
3. На воспроизводимом отказе: точные шаги → снимок/сеть/console → назначенный агент с владельцем файлов → проверка diff/целевых тестов → повтор того же браузерного сценария. Ошибки локатора не считать дефектами приложения.
4. Статусы: planned/running/pass/fail/fixing/retest/blocked/deferred/alias. `blocked` требует конкретной отсутствующей предпосылки, `deferred` — явного ограничения объёма. Частично пройденная строка не получает PASS за непройденные варианты.
5. Реестр можно дополнять только явно обнаруженным новым входом/веткой поведения с новым ID; уже пройденные доказательства не переписываются.

Уточнение инвентаризации до выполнения локальных установок: независимое чтение вложенного блока «На этом компьютере → Показать установки» добавило C45–C54. Эти сценарии не считались пройденными установкой C15; прежние ID и результаты сохраняются.
