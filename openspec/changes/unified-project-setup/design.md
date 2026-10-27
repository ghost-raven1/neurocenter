# Design

## Context

См. proposal.md. Start уже использует публичный Gateway installer config, отдельные OpenCode/bridge bootstrap, проверяемую project binding и project query. Store, AgentCatalog и локальные конфигурационные мастера имеют собственные полномочия, exact plans и очередь; их повторное изобретение нарушило бы принятые контракты.

## Goals / Non-Goals

**Goals:** одна видимая точка входа, общая установка двух native компонентов и последующая настройка конкретного проекта без ухода по страницам.

**Non-Goals:** запуск shell из браузера без установленного локального компонента; автоматическая покупка/подстановка модели; установка всех глобальных ассетов; отмена согласований существующих package/runtime планов; обещание готовности по downloaded flag.

## Decisions

1. Новый bootstrap сохраняет существующих владельцев `install_opencode.*` и `install.*`: скачивает оба с одного разрешённого Gateway, закрепляет supply версию моста и запускает по порядку. Bridge-only продолжение не повторяет установку OpenCode. Temporary files принадлежат wrapper и очищаются. Ошибка не откатывает успешный предыдущий этап и не маскирует exit code.
2. `unified_project_setup` default true, depends computer_connections, управляет новыми общими действиями и public bootstrap endpoints. `/start` по умолчанию открывает основной master; прежний режим — legacy по явным step1/step2/addComputer/legacy ссылкам. OFF оставляет состояние и recovery в основном режиме, а старые install/connect остаются самостоятельными действующими путями. Каждый project stage сохраняет собственные feature/ACL gates.
3. `/start` открывает единый owner с устойчивыми query project/stage. Выбор компьютера и fresh bridge report передаются вложенным действиям. Папка настраивается существующим native root picker и WorkspaceBindingWizard; credentials — существующим ProjectProviderSetup; агенты — embedded AgentCatalog.
4. Малый StartProjectAssets адаптер читает только project catalog и exact snapshots, передаёт их в существующий useInstallPlan/InstallPlanModal и LocalInstallations. Missing pin не заменяется current head. Нет нового batch executor или автоматической глобальной регистрации ассетов.
5. Статус выводится из актуальных devices/jobs/installations, verified binding и действующих owners readiness. Отсутствующая модель или runtime probe отражаются отдельным следующим действием. «Продолжить» меняет навигацию, а не подтверждает native installation.
6. До выхода моста на связь UI честно не видит ход локального bootstrap: он показывает ожидание подключения и указывает на вывод терминала. После подключения подтверждаются конкретные факты. CLI пользовательского OpenCode не выводится из наличия bundled probe; отсутствие его автоматического измерения показано явно. Steps не делает finish посещённым этапам. Enter/Space работает на навигации; явный переход переносит фокус в открытый шаг.

## Risks / Trade-offs

- Первичная native установка требует явного локального действия → одна копируемая команда и пояснение, без обещания браузерного shell.
- Несколько компьютеров/папок → явный выбранный device, exact binding/instance; другой scope не наследует pending UI.
- Устаревший или неполный project catalog → отказ загрузки виден, установка не использует глобальный head.
- Локальные credentials/платные модели → прежние локальные формы, без автозаполнения или скрытого inference.
- Wrapper fixture ≠ реальная native установка → область unit/shell/browser/ОС/installed runtime фиксируется отдельно.

## Migration Plan

Поставка Gateway static scripts/endpoints, flags и frontend без миграции БД. Новая установка использует включённый по умолчанию основной режим; существующий explicit override флага сохраняется. OFF запрещает новые общие действия, сохраняя project/stage query, состояние, установленные данные и существующие legacy recovery owners.
