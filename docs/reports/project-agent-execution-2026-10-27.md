# Выбранный проектный агент: реальный локальный цикл

Дата: 27 октября 2026. Поставка: [draft PR35](https://github.com/ghost-raven1/neurocenter/pull/35), ветка `feature/project-agent-full-cycle`, база `73c35ddee06446df127a60aa070ec4d99c573fb5` из [draft PR34](https://github.com/ghost-raven1/neurocenter/pull/34). Контракт: OpenSpec `project-agent-full-cycle`, локальные задачи8/8. Новый срез закрывает выбор исполнителя в AgentCatalog → BMAD/OpenSpec → native runtime → проверяемый результат. Автоматическое возвращение результата в исходный чат, персональные наборы ассетов и полный набор системных операций остаются отдельными работами.

## Изменение поведения

В задаче методики можно явно выбрать включённого проектного агента. Сервер закрепляет его effective assignment, ревизию, текущую модель, successful configure delivery и SHA native-файла для точных actor/device/project/binding/instance. Browser передаёт только agentId и expectedAgentsRevision. Отсутствующая настройка, архив, subagent mode или наследуемая модель дают понятный отказ; замена другим агентом или default model не выполняется.

Перед claim, authorize и успешной фиксацией сервер повторяет проверку. В final enqueue/completion транзакциях удерживаются соответствующие row locks. Мост независимо проверяет bridge-private committed proof, фактический файл, namespace и effective model mapping без чтения auth.json. Собственный OpenCode server проверяется до inference; затем получает явные agent/model. Финальный ответ должен принадлежать им же.

Draft/pending сохраняют выбор и прежний запрос. После reload и неизвестного ACK нет автоматического нового requestKey или исполнителя. Public job/result содержат восемь полей identity/hash, без prompt, endpoint и private model options. История, чтение квитанции и отмена сохраняются при OFF. Legacy payload без agent поддерживается отдельно; выбранный агент не превращается в generic автоматически.

Новый флаг `project_agent_workflows` выключен по умолчанию и зависит от `agent_method_workflows`; новая capability — `agent-method-selected-agent-v1`. Исходники моста — **0.9.23**. Текущий проектный набор skills/plugins/MCP общий для папки; отдельная sandbox каждого агента не заявляется.

## Свидетельства

| Граница | Результат |
| --- | --- |
| Shared contract/policy |107/107 PASS: legacy shape, canonical mapping, отсутствие private metadata в result, identity mismatch, malformed selection и независимость recovery от флага. |
| Backend |20/20 unit PASS;9/9 на собственном PostgreSQL16.15: выбранный agent/replay, profile edit before claim, model revoke, latest delivery shadow, final enqueue fence и настоящие row locks при completion. |
| Мост |25/25 PASS; затем1/1 новый poll-regression: изменение model URL во время работы останавливает own runtime и сохраняет файлы. Повтор режима all1/1 относится к существующему HTTP-кейсу и не считается дополнительным уникальным тестом. |
| Frontend |60/60 PASS в четырёх файлах: exact selected pending, no fallback, stale/off/reload, pinned identity и catalog wiring. Наборы до/после замечаний пересекаются, их суммы не являются покрытием проекта. |
| Компиляция |Frontend/catalog/bridge typecheck и пять изолированных сборок frontend/catalog/gateway/flags/bridge прошли. Никакие артефакты кандидата не копировались в установленный runtime. |
| Настоящий OpenCode |Текущий compiled bridge candidate запустил OpenCode1.14.48 + OpenSpec1.15.0: выбранный `nc-native-method`, реальное изменение app.js/tasks, strict validation и node check exit0. Модель — scripted loopback fixture. |

Native JSON: `.run/project-agent-full-cycle-20261027/bridge-selected-opencode-native.json`. Рабочая папка `Проекты 日本 мой проект`; default model намеренно `MUST_NOT_USE_DEFAULT`. Три model HTTP calls, обращений к registry0. Реальны tools/read/write, методика, команда проверки, committed configuration proof, exact public identity и durable replay/completion ACK. Повтор не вызвал новую модельную работу; принятые proposal/design/spec сохранились побайтно. Собственные HOME/project удалены.

Финальный build receipt: `.run/isolated-build/bf36b280-b959-4736-8f20-d6edaa316299/receipt.json`; входной digest `cd32f1272507f705f68cb69e84d6bbfd4c408d00c8e0a8309c1f58cd982bd091`, HEAD снимка `304ab24a6bb271be06d8f7564833b1d22ebbaa68` с dirty/new исходниками. Все пять compilers exit0, процессы закрыты; sourceCurrent/candidateInputsUnchanged/liveOutputsUnchanged/dependencyLinksUnchanged=true на конец сборки. Последующие commits, отчёты и checkboxes не являются новой компиляцией.

Первичные отчёты: `.run/project-agent-full-cycle-20261027/backend-report.md`, `bridge-selected-agent-report.md` и `bridge-selected-agent-metadata.json`; frontend — `.run/project-agent-workflows-20261027/frontend-report.md`. Root raw contract/typecheck/build logs сохранены рядом. Unit/PG tool outputs backend и frontend дополнительно находятся в истории соответствующих агентов; summary log не выдаётся за отдельный повторный запуск.

## Desktop browser

Настоящий Chromium/React, desktop1440×1000, controlled API routes. Артефакты: `output/playwright/project-agent-workflows-20261027/scenario-evidence.txt`, `result.json` с pass:true и шесть фактических POST bodies, семь page screenshots и семь полных снимков панели. Ключевые01/03/05 просмотрены визуально; собственная сессия `ap01-selected-agent-20261027` закрыта.

- Нет автоматического выбора первого агента. Архивный head блокирует POST и сохраняет текст.
- POST503 → reload сохраняет агента и задачу; receipt404 разрешает точный повтор. При OFF проверка отправки доступна, selected replay запрещён.
- Повтор отправляет идентичное полное тело, requestKey `1a054451-1616-4d5a-b41c-1eb6f186ffca`, agentId `agent-qa-selected` и revision3. Setup-agent показывает невыполненные проверки.
- Stale409 → receipt404 → явный возврат сохраняет задачу; новая отправка revision4 получает success с pinned identity и checks exit0.
- При OFF работающий job можно отменить. Сохранённый selected draft блокирует generic start до явного очищения выбора.

Результаты, auth, flags, catalog и errors здесь подставлены browser routes. Это UI evidence; backend/PostgreSQL/native подтверждены отдельно, единого live browser→backend→bridge→настоящая модель прогона нет. Предыдущие browser попытки завершались ошибками fixture/локаторов AntD loading prefix; production код для их обхода не менялся.

## Замечания и исправления

Независимое UI review обнаружило, что immutable pinned card имеет archivedAt:null, а актуальный архив находится в catalog head. Selector теперь использует head только для availability; pinned prompt/model/mode/version сохраняются. Новый real-shaped regression сначала упал, затем прошёл вместе с контролем, что headv2/subagent не подменяет назначенный primaryv1. Повторное независимое review закрыло замечание.

Первый catalog typecheck обнаружил несовместимый с lib-target Object.hasOwn и недостаточно суженный instanceId. Исправлены через существующий hasOwnProperty idiom и проверку typeof; unit20 повторены. Ранний isolated build `ca8e2450-6fc1-46f8-b136-a5d7371ad463` сохранил этот compile failure, затем финальный пятикомпонентный build прошёл. В существующих SSR fixtures изолирован вложенный workflow, которого не поддерживал прежний AntD mock; прежние setup/archive assertions сохранены, настоящий компонент проверен отдельно.

Bridge независимо проверен frontend worker; shared/server wiring и backend selection — bridge worker; frontend — backend worker. Собственные авторские проверки не выдаются за независимый review. OpenSpec verification сопоставляет четыре требования и семь сценариев; незавершённые проверки и доставка учитываются отдельно.

Финальный локальный verify: четыре требования и семь сценариев сопоставлены, все восемь задач завершены; новых существенных замечаний нет, archive-head finding закрыт. Browser/native/SQL/компиляция имеют указанные выше отдельные границы. Strict validation прошла. Изменение автоматически не архивировалось.

## Границы и продолжение

- Настоящий inference provider/качество модели, установленный архив0.9.23, полный native BMAD/combined, Linux, CI и production этим срезом не приняты.
- Файлы задачи читаются при фактическом старте. Guard закрепляет выбранный native profile; все внешние workflow-документы, другие subagents и общие project plugins не становятся отдельной неизменяемой sandbox.
- Main backend/БД не использовались как QA. Собственный контейнер на loopback63519 остановлен после сверки точных ID/name/label; disposable fixture database удалена. Пользовательские отчёты и установленные профили сохранены.
- AP01 закрыт в части выбранного native-исполнителя из каталога; квитанция в исходном чате ещё открыта. AP02 требует персонального профиля навыков/инструментов, SR01/SR02 — матрицы реальных системных действий и исполняемых адаптеров. Общая готовность всех командных сценариев не заявляется.

Настройка: [пользовательская справка](../help/agent-method-workflows.md), [контракт исполнителя](../features/agent-method-workflows.md), [командная очередь](../agent-discussions-tooling-backlog-2026-10-23.md).
