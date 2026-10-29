# Присутствие моста при повреждённом локальном отчёте

Дата: 29 октября 2026. Версия исходников моста: 0.9.27.

## Исправление

Воспроизведён отдельный дефект архива 0.9.26: настоящий worker с повреждённым workspace.json оставался жив, но за 17 секунд не отправлял heartbeat. Исправный отдельный профиль передавал heartbeat и версию. Проверки выполнялись на darwin-arm64 в двух собственных профилях с loopback API; это не диагноз Linux-сервера пользователя.

При отказе полного локального отчёта новый authenticated presence endpoint передаёт только runtime identity и помечает отчёт недоступным. Сохранённые привязки, installations и capabilities остаются в JSONB. Новые admissions/claims приостановлены; уже принятые задания, MCP-сессии и квитанции сохраняют штатную проверку актуальных прав и lease. Следующий успешный полный heartbeat снимает ограничение. Исходные локальные файлы не переписываются, исходная ошибка и секреты не попадают в public diagnostic.

## Проверки

- Native: 32 целевых теста, TypeScript и официальная сборка PASS.
- Catalog: 132 целевых теста, TypeScript и сборка PASS. Один собственный unit-fixture отказ сохранён отдельно; после исправления fixture затронутые 19 тестов повторены успешно.
- Gateway: 35 тестов, TypeScript PASS.
- OpenAPI: 29 тестов PASS; authenticated presence включён в 311 paths / 381 operations.
- Root: два настоящих PostgreSQL-сценария PASS без пропусков — активная MCP-сессия сохраняет authorize/dispatch/complete, следующее принятие блокируется; running installation сохраняет authorize, queued peer ждёт полного отчёта. Использован отдельный временный PostgreSQL16.15 на случайном loopback-порту; Main DB не использовалась. Проверочная группа и контейнер отсутствуют после завершения.
- Независимое source review исправления: CLEAR. Первоначальное замечание об очистке capabilities исправлено до коммита и проверено реальным PostgreSQL.

Квитанции: .run/bridge-presence-recovery-20261029/verification-receipt.json (SHA f8bb803324ac3c4185a5fceaae4ccc58b4e75d893794dc0bfc57dc8c06c34ebc), .run/bridge-presence-actual-pg-20261029/{vitest.raw.log,result.json,root-reviewed-result.json}. Первичный wrapper остался ok:false: он ошибочно считал автоматически созданную начальную БД presence_qa утечкой fixture. Raw product tests — 2/2 PASS; отдельный review сохраняет это различие и подтверждает отсутствие контейнера.

## Границы

Архив 0.9.27 ещё не упакован и не опубликован. Установленный Primary не обновлялся. Linux/Windows, CI, сервер пользователя и браузерная приёмка нового endpoint не подтверждены. На последнем фото пользователя мост 0.9.26 уже online и OpenCode1.14.48 обнаружен; прежний offline-симптом нельзя выдавать за его текущее состояние.
