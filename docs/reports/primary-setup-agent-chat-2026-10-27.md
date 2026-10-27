# Основная установка проекта и задачи агентов из чата

27 октября 2026. Ветка `feature/agent-workflow-chat` поверх `feature/project-agent-full-cycle` / PR35 (`f132387fafff89a33c87994d09c080430a329ae3`). Это локальная реализация и приёмка двух связанных сценариев; работающая площадка, установленный мост и реальная модель этим отчётом не принимаются.

## Пользовательский результат

**`/start` — основной режим.** Кнопка «Установить OpenCode» открывает общий мастер. Установщик получает оба существующих сценария с одного Gateway, закрепляет OpenCode1.14.48 и выбранную поставку моста, выполняет OpenCode → мост/подключение. Ошибка сохраняет исход предыдущего шага и даёт продолжить только мост. Существующие установщики и их правила сохранения конфигурации не переписывались.

В том же мастере выбираются компьютер, проект, проверенная папка, агенты/модель и назначенные скиллы/plugins/MCP. Используются прежние owners привязки, планов установки, одобрений, локальной конфигурации и проверок. Глобальный каталог автоматически не устанавливается; unresolved pin остаётся видимым и блокирует отправку.

Открытый шаг показан отдельно от измеренных фактов. Посещение последнего шага не отмечает предыдущие успешными. Статус требует свежего online-компьютера и одной verified binding/instance. До подключения моста детальный ход bootstrap виден в терминале; сайт не подтверждает пользовательский CLI по bundled probe. Проверки инструментов и ответ модели различаются. Enter/Space открывает шаг и переносит фокус без его перехвата при polling.

`unified_project_setup` включён по умолчанию, зависит от `computer_connections`. OFF сохраняет notice, состояние и вход в master для чтения; новые общие действия блокируются. Legacy доступен по явным старым step1/step2/addComputer и `legacy=1`; `setup=1` всегда открывает основной мастер. Новые public bootstrap endpoints проверяют флаг непосредственно в Gateway, поскольку этот контроллер не проходит общий ProxyService gate.

**Сообщение → выбранный агент → результат в том же чате.** У сохранённой пользовательской реплики открывается существующий BMAD/OpenSpec workflow. Выбор агента, компьютера, папки и проверок явный; обычный composer сохраняет собственный черновик. Origin остаётся server-only связью и фиксируется атомарно с заданием и request receipt, без изменения native bridge protocol или второго inference.

Под сообщением сохраняются pinned исполнитель, статус и безопасный результат. Последний запуск виден сразу, предыдущие читаются страницами до8 с scoped cursor. Личная очередь, provider mapping и raw logs не раскрываются. После отзыва доступа к исходной комнате публикация становится `withheld`, сохраняя учёт локального исхода и ACK. Для общей задачи разрешены только UI presets `npm test`, `npm run typecheck`, `npm run check`; приватный legacy argv-контракт сохранён.

`project_agent_chat_workflows` по умолчанию выключен, зависит от `project_agent_workflows` и `project_chat`. OFF сохраняет чтение, exact accepted replay, восстановление и разрешённую владельцу отмену. Queued/running/reconciling method jobs отменяются через существующий poll-stop; поздний success не перезаписывает cancelled. Сохраняется отмена владельцем с действующим правом чтения после потери права новых запусков. Один исполнитель не создаёт дополнительную модельную сводку.

## Проверки и их границы

| Область | Фактический результат |
| --- | --- |
| Shared policy | 106/106 PASS, включая primary default, новые admissions и прежние installer/recovery routes. |
| Backend unit | 134/134 PASS в12 файлах;77 opt-in PostgreSQL cases явно пропущены. |
| Собственный PostgreSQL | 21/21 PASS,0skipped: real DeviceJobs→claim→completion→ProjectChatService read/history/reload, origin mismatch, private ACL/withheld/ACK, OFF, downgrade cancellation/late success, controlled room concurrency, cursor и schema45. Дополнительные2 targeted PASS пересекаются с этим набором и не суммируются как уникальное покрытие. |
| Frontend | 131/131 PASS в11 файлах до позднего уточнения primary/progress; после него68/68 focused Start PASS. OFF landing regression: RED1FAIL/1PASS → GREEN2/2; второй тест также проверяет keyboard focus. Наборы пересекаются и не складываются. |
| Bootstrap | 10/10 выбранных Bash/TLS/source checks PASS: harmless child scripts в собственном HOME/temp и проверки исходных контрактов. Реальные пользовательские установщики не запускались. |
| Gateway | 60/60 PASS против изолированно скомпилированного контроллера; настоящий Nest HTTP и свой flag service подтверждают403OFF/503unavailable/200ON, сохранность прежних installer routes, version/trusted-origin/abort. |
| PowerShell | Targeted1/1 source-contract PASS после исправления child exit propagation; нативного PowerShell/Windows прогона нет. |
| Типы и сборки | Frontend/Catalog typecheck PASS. Изолированно собраны frontend, Catalog, Gateway и flags:4/4 exit0, все процессы очищены. |
| Chromium desktop | Два сценарных набора PASS,1440×1000, по8 screenshots. Настоящие React/AntD/Chromium, business API контролировались fixtures; реальные backend/model/installer вызовы не выполнялись. |

Raw локальные свидетельства: `.run/project-agent-chat-workflows-20261027/backend-report.md`, `.run/agent-workflow-chat-20261027/frontend-report.md`, `.run/unified-project-setup-20261027/{bootstrap-report,frontend-review-report}.md`. Финальные браузерные отчёты: `output/playwright/{agent-workflow-chat,unified-project-setup}-20261027/report.md` и `result.json`. Первые automation попытки с ошибками fixture/locator/HMR сохранены; PASS относится к финальным прогонам. Последующая правка одной направляющей подписи и legacy help link не меняла поведение сценариев.

В чате зафиксированы ровно два явных POST `run-agent-method-workflow` для двух задач, keys `4f01de35-f0cd-45a2-9aa7-394f9c4dd85b` и `65f6ecf6-9db7-4705-88bc-b3e39bffbb28`; восстановление после accepted503 не добавляло POST. В основном setup один explicit approve создал один fixture install-job, key `49d0f528-1df7-48e0-adbe-59b6457e3d16`. Это контролируемые API данные, не реальная установка.

Сборка: `.run/isolated-build/3e0493b0-a91f-425a-b179-eae592087e53/receipt.json`. Входной HEAD `f97aa13b48808a062694a00526b141f18e93cf8c` с dirty/new inputs; SHA снимка `0df9cd17741fb02e7325cb83765f3ab4f3d9d65af9f1c540c9a622275f81728d`. MCP подтвердил recorded complete, processClean и source/candidate/live-output/dependency guards true. `currentSourceEquivalent` остаётся unknown: это не утверждение о любых последующих изменениях.

`bridge-dist` намеренно исключён из стандартного build snapshot. Шесть installer templates отдельно сверены до/после сборки: `.run/agent-workflow-chat-20261027/bootstrap-source-manifest.json`, unchanged=true. Новый Bash SHA `084a1aaeea2a7181d83e20b31502b52f9d8e029ff66dc638f1ca34ef6efc0d95`, PowerShell SHA `3fb742b93a4f00e05b6259f174f44f00e0b9d74261f5ebbe30eff1543e730c41`. Dockerfile копирует эти sources, но container/release/archive delivery в этом этапе не проверялись.

## Ревью, схема и очистка

Независимые source reviews распределены между авторами других частей: backend проверен bridge worker, frontend — backend worker, основной master — frontend/bridge workers, bootstrap — root. Финальная OpenSpec сверка сопоставила7requirements/17scenarios с реализацией и свидетельствами, без новых существенных findings. Самоавторство backend reviewer отдельно раскрыто; его серверную часть независимо проверил другой участник.

Закрыты подтверждённые дефекты: room SHARE→UPDATE lock-upgrade race, публикация секретных произвольных argv, null-check500, отсутствие feature guard в прямом public controller, потеря PowerShell child exit, отсутствие OFF входа со стартового landing и обновления квитанции source из ранней истории. Старая exact mock arity expectation обновлена после нового optional enqueue hook; failures и причинные RED сохранены в raw logs.

Миграция45 аддитивна: связь с сообщением, immutable publication и20 измеряемых facts; прежние43/44 не переписывались. Собственная QA PostgreSQL база/контейнер и приватные URL/env удалены с проверкой владельца. Обе собственные Chromium sessions закрыты. Профиль пользователя, его индекс Quirk, основные данные и установленный мост не использовались как QA; ручного restart/apply live сборок не выполнялось. Три исходных untracked пользовательских отчёта сохранены.

## Оставшиеся направления

- AP01 реализован в локально проверенном контракте; новая сквозная native/model сессия из browser к работающей площадке не запускалась. Существующий выбранный executor переиспользован без изменения bridge protocol.
- [AP02: персональный профиль навыков и инструментов](../project-agent-tool-profiles-design-2026-10-27.md) остаётся следующим срезом: точные refs/pins, versioned private proof и native permission checks. Project plugins пока общие.
- SR01/SR02, командные зависимости/бюджеты/пауза и адаптеры системных операций остаются открытыми. Автоматическое наблюдение пользовательского CLI и раннего bootstrap progress требует отдельного bridge/installer контракта.
- [Четыре изученных внешних проекта](external-agent-methods-review-2026-10-27.md): UX-приёмы применены в основном master, structured review зафиксирован; сторонний plugin OpenCodeReview не установлен и его совместимость не принята.
- Настоящие installer/provider, установленный bridge, native Windows/другие ОС, CI и production требуют отдельных свидетельств. Пассивная диагностика существующих сервисов показывала readiness503; это не превращалось в QA на основной БД.
