# P0: внешний Blitz и восемь клиентских платформ

Этот документ задаёт сбор свидетельств. Он не утверждает, что проверки настоящего IdP или семи отсутствующих нативных целей выполнены. Текущая версия моста в исходниках — **0.9.3**; [точный darwin-arm64 архив](../output/playwright/neurocenter-add-methods/bridge-0.9.3/release.md) прошёл 5 installer и 5 runtime/stdio сценариев. Это не полный P0-чеклист всех платформ. [Реестр готовности](implementation-readiness.md) отделяет реализованный механизм от внешней приёмки.

Машинная [матрица 0.9.0](native-platform-matrix-2026-10-17.json) сохранена как историческое свидетельство: её `checkedAt`, build ID, SHA и результаты не изменяются и не принимают 0.9.3. Для нового кандидата создаётся отдельный отчёт точного архива, а не переименование старого.

## Настоящий Blitz

Процедура настройки: [production-setup.md](production-setup.md). Нужны доступные HTTPS-площадка/IdP, зарегистрированный callback/logout return, тестовые корпоративные учётные записи, разрешённый оператору bootstrap и запасной главный администратор. Секреты не передаются через аргументы процесса и не записываются в evidence.

Существующие автоматические команды проверяют локальную реализацию:

~~~bash
node --test scripts/test/blitz-flow.test.mjs scripts/test/auth-security.mjs scripts/test/production-runtime.test.cjs
node scripts/test/production-stack.mjs
~~~

Первая команда использует уже собранные dist. Вторая поднимает отдельный стек с blitz-fixture и записывает realBlitz:false. Эти результаты не принимают корпоративный IdP.

На настоящем IdP зафиксируйте отдельные результаты:

| Проверка | Ожидаемое свидетельство |
| --- | --- |
| Первый вход | Пустая БД, операторский bootstrap без dev-auth, корпоративная почта и роль «Главный админ» после callback |
| Authorize/callback | Точные зарегистрированные HTTPS URL, state, PKCE S256; code_verifier только при обмене кода |
| State/повтор | Ошибочный, отсутствующий, просроченный и повторный state не создают сессию и не повторяют обмен |
| Отказы IdP | access_denied, недоступность token/userinfo и некорректный профиль не создают сессию и не дают права |
| Истечение | После заданного серверного TTL сохранённый cookie получает отказ; фронт показывает выход |
| Выход | Локальная сессия отозвана до redirect, зарегистрированный Blitz logout завершён, старый cookie не открывает API |
| Отзыв прав | Сессия A открыта; администратор B отзывает main/project роль или отключает A; следующий запрос A закрыт без повторного входа |
| Возврат в интерфейс | Исходный раздел/подключение сохраняется, внешний returnTo не допускается |
| Production guard | Реальный production-процесс отказывается запускаться с SSO_DISABLE=true или RAG_AUTH_DISABLED=true |

Платформенные назначения читаются на каждом HTTP-запросе; Socket.IO перепроверяет вход каждые 25 секунд. Принятие отзыва платформенных прав не означает поддержку back-channel logout IdP: он пока не реализован. Полная проверка id_token также не реализована; идентификация идёт через защищённый userinfo endpoint.

В отчёте укажите checkedAt, версию Blitz, identity конфигурации клиента без secret, релиз/image IDs, браузер/ОС, время сценариев и отдельные passed/failed/not_run. Cookie, authorization code, access token, client secret и полные сетевые дампы в открытом отчёте запрещены. Матрица получает realBlitz:true только после этого прогона.

## Нативная матрица

| Цель | Нынешнее свидетельство | Что требуется |
| --- | --- | --- |
| darwin-arm64 | 0.9.3: 5 installer + 5 runtime/stdio, [SHA/build ID и границы](../output/playwright/neurocenter-add-methods/bridge-0.9.3/release.md); дополнительные [download fault/retry](../output/playwright/neurocenter-add-methods/bridge/download-crash-recovery.json) | Сопоставить все восемь пунктов ниже с точным кандидатом; недостающие случаи папок/параметров/обновления/процессов выполнить отдельно |
| darwin-x64 | pending | Intel Mac; локальная RAG сейчас unsupported, указать ограничение явно |
| linux-arm64 | pending | ARM64 Linux glibc с графической сессией |
| linux-arm64-musl | pending | ARM64 Linux musl с графической сессией |
| linux-x64 | pending | x64 Linux glibc с графической сессией |
| linux-x64-musl | pending | x64 Linux musl с графической сессией |
| windows-arm64 | pending | Нативная Windows ARM64, штатная политика PowerShell, helper нужной архитектуры |
| windows-x64 | pending | Нативная Windows x64, штатная политика PowerShell, helper нужной архитектуры |

Сборка выполняется на каждой целевой ОС/архитектуре/libc с Node.js 24. Подмена uname/ldd, cross-build, контейнер другой архитектуры и синтетический PE не являются нативной приёмкой. Фиксируйте ОС, архитектуру, libc, shell, versions, buildId и SHA всех исполняемых компонентов.

На macOS/Linux:

~~~bash
npm --prefix mcp/neurocenter-asset-sync ci --include=optional
npm --prefix mcp/neurocenter-asset-sync run build
node scripts/package-bridge-runtime.mjs
node scripts/test/bridge-native-installer.mjs
node scripts/test/bridge-runtime-smoke.mjs
~~~

На Windows, в Native Tools for Visual Studio нужной архитектуры, при стандартной разрешающей доверенный скрипт политике:

~~~powershell
npm --prefix mcp/neurocenter-asset-sync ci --include=optional
npm --prefix mcp/neurocenter-asset-sync run build
.\\scripts\\build-windows-job-helper.ps1 -OutputDirectory .\\private-helper
node scripts/package-bridge-runtime.mjs --windows-job-helper=.\\private-helper\\neurocenter-job.exe
node scripts/test/bridge-runtime-smoke.mjs
~~~

bridge-native-installer.mjs поддерживает только Bash/macOS/Linux. Эквивалентный нативный PowerShell-runner пока отсутствует; проверять реальный install.ps1 вручную на изолированном профиле и сохранять отдельные журналы. Подписанный скрипт/издатель и политика доставки должны позволять установку без bypass. Отсутствие соответствующего runner/подписи нельзя выдавать за успешную автоматическую приёмку.

Для каждой цели нужны отдельные случаи:

1. Чистая установка без системных Node/npm; правильная архитектура; SHA/доверие издателю; отказ повреждённого архива без замены программы.
2. Регистрация существующего JSON/JSONC, комментарии и другие MCP сохраняются; второй запуск ничего не дублирует.
3. Подключение через реальную площадку, выбор/отмена папки, Unicode/пробелы, запреты чужих каталогов, восстановление привязок после restart.
4. Обновление принятого предыдущего архива до нового; настройки/привязки/учётные данные сохранены, повтор идемпотентен.
5. Сбой обновления/регистрации и восстановление согласованного локального комплекта; несовместимый downgrade отклонён.
6. Мастер параметров MCP: секрет остаётся локально, корректная ревизия, отмена/ошибка не портят прежнее состояние.
7. Реальный stdio MCP, skill/plugin/remote-runtime по заявленному набору; ограничения LanceDB и внешних сервисов записаны отдельно.
8. Timeout, закрытие окна/родителя, отмена и авария worker завершают все созданные дочерние процессы; на Windows проверяются Job Objects.

Каждый отчёт привязан к точному архиву и содержит cases с результатами, failure reason, журналы без секретов и явные признаки native:true, OS security unchanged:true. Заявление allEightAccepted возможно только при восьми отдельных полных свидетельствах; старые частичные/фикстурные результаты не суммируются с новым прогоном.

Имена целей моста в этой таблице отличаются от runtime-assets (`win32-*`, `linux-*-glibc`): это два контракта, а не автоматически совместимые архивы. При сборе evidence сохраняйте исходный target дескриптора и явно указывайте соответствующую строку матрицы.
