# Tasks

## 1. Общая установка

- [x] 1.1 Добавить общий bootstrap OpenCode→bridge с закреплением Gateway/supply, сохранением exit и bridge-only продолжением; проверить causal shell fixtures, Gateway routes и совместимость прежних installers, обновить справку.
- [x] 1.2 Добавить флаг и команду новой точки входа; проверить OFF и сохранность старых installer/recovery routes через shared-policy regression.

## 2. Проектный мастер

- [x] 2.1 Добавить единый `/start` сценарий с project/stage query и существующими bridge/folder/provider/agent owners; проверить отсутствие auto dispatch и stale scope, сохранность выбора после reload и отказов.
- [x] 2.2 Подключить только назначенные проекту assets через exact plan/install owners и историю текущей папки; проверить empty/error/unresolved-pin/permission/OFF и пройти desktop browser, обновить справку.
- [x] 2.3 Сделать проверки /start автоматическими (флаг `start_auto_checks`, platform, default on, зависит от `unified_project_setup`): чистый предикат `startAutoInspectNeeded` (нет наблюдения / неподтверждённый terminal-результат / подтверждённое старше 15 мин → нужна свежая проверка; busy/reading/denied/storageError, неподтверждённая сохранённая отправка — `pendingStartIntent` (без jobId, с чужим jobId или незавершённым job), незавершённый job и явная отмена → нет; подтверждённая отправка не блокирует повторную проверку) + хук `useStartAutoInspect` — ровно одна авто-проверка OpenCode на выбранный компьютер после settle загрузки; при входе в шаг проверки авто `bridge.reload()` (только если снимок моста уже не свежий) + refresh каталога без дублей на re-render. Мост (socket/15 с fallback/freshness) и квитанции провайдеров (READ при mount шага) зафиксированы как уже автоматические. Проверены: 9 юнит-кейсов предиката (включая границу 15 мин, невалидную дату и регрессию «устаревшее подтверждённое состояние с сохранённым intent → да») и 6 кейсов хука (flag off, fresh, busy→stale ровно 1, повторный re-render без дубля, смена компьютера, canStart, неподтверждённый intent); OFF — ручные «Проверить» без изменений; tsc 0, scoped eslint 0, targeted 15/15, feature-flags-service 8/8. Принятые ограничения (ревью, все — по стоимости/краевым кейсам): проваленная автопроверка повторно уходит в той же сессии максимум один раз (правило «неподтверждённый terminal → свежая проверка», ограничено `tried`); на deep-link в шаг 5 один разовый идемпотентный дубль bridge/catalog-чтений при mount; на скрытой вкладке по экспирации снимка возможен один фоновый bridge-read.

## 3. Поставка

- [x] 3.1 Пройти затронутые typecheck/изолированные сборки и независимое ревью, исправить подтверждённые дефекты, выполнить strict OpenSpec verification и записать фактические границы приёмки.
- [x] 3.2 Сохранить отдельный feature commit/push/draft PR, обновить backlog и очистить собственные QA-ресурсы; не выдавать fixtures за установленную площадку.
