# Добавление и установка инструментов — 18 октября 2026

Проверены настоящие публикации из npm, публичного GitHub, отдельного файла, папки и четырёх архивных форматов. Успешные ответы API не подменялись. Установки выполнялись выпущенными мостами **0.9.2** и **0.9.3**, Node **24.22.0** и настоящим OpenCode **1.14.48** в отдельном профиле и отдельном QA-проекте.

## Как пользоваться

1. Главный администратор открывает **Каталог инструментов → Упаковать инструмент**.
2. Вставляет npm/GitHub ссылку или выбирает файл, папку, ZIP, TAR, TAR.GZ либо TGZ. Версия/commit закрепляются; файл запуска и доступное описание определяются автоматически.
3. Нажимает **Упаковать и добавить**. Прогресс сохраняется при закрытии окна и перезагрузке страницы.
4. Добавляет карточку в проект и устанавливает через мост. Папку компьютера связывают один раз; первую установку конкретной поставки одобряет администратор проекта. Сверка файлов и проверка запуска доступны отдельно.

## Реальные сценарии

| Способ | Проверяемый инструмент | Свидетельства публикации |
| --- | --- | --- |
| npm MCP | Sequential Thinking 1.0.0 | [remote-ui/summary.json](../output/playwright/neurocenter-add-methods/remote-ui/summary.json) |
| npm plugin | opencode-snip 2.0.0, нативный CLI 0.25.2 | тот же отчёт |
| GitHub | Fetch, закреплённый commit `1ddb1a59…` | [исправленная публикация](../output/playwright/neurocenter-add-methods/remote-ui/fixed-publication.json) |
| Файл | ESM MCP `server.mjs` | [файловая матрица](../output/playwright/neurocenter-add-methods/files-ui/files-ui.json) |
| Папка | TypeScript plugin `src/index.ts` | тот же отчёт |
| ZIP | TypeScript MCP `server.mts` | тот же отчёт |
| TAR | CommonJS plugin `plugin.cjs` | тот же отчёт; отдельная нормализация CommonJS описана ниже |
| TAR.GZ | TypeScript MCP `src/index.ts` | тот же отчёт |
| TGZ | ESM plugin `src/index.mjs` | тот же отчёт |

У каждого исходного UI добавления — одна карточка, одна версия, одна сборка и одно событие создания. ZIP отдельно прошёл весь браузерный путь: добавление в проект → просмотр SHA → одобрение → установка → сверка → согласие на диагностику → настоящий OpenCode. Вызов `qa_echo` из установленного ZIP также проверен через MCP SDK. Файл, папка, TAR.GZ, TGZ и Snip проверялись командами из реально установленного JSONC; для плагинов вызывались хуки, у Snip запускался нативный CLI.

## Исправления

- **Очередь вместо ручного повтора.** Ранее параллельная сборка отклонялась с 409 даже во время завершающей очистки. Теперь PostgreSQL хранит до десяти ожидающих/выполняемых заданий, единственный владелец исполняет их последовательно. Два реальных одновременных запроса получили 201, один выполнялся, второй ждал; оба завершились без дублей. Повтор UUID возвращает прежнее задание. [Live receipt](../output/playwright/neurocenter-add-methods/queue-live.json).
- **Восстановление.** QUEUED задания продолжаются новым владельцем после перезапуска; прерванное RUNNING завершается явной ошибкой. Временная ошибка SQL без `client.error` не оставляет очередь без worker. Недоступный staging освобождает lock и повторяет восстановление. Ребёнок, появившийся после потери lease/shutdown, немедленно останавливается. [PostgreSQL, 12 сценариев](../output/playwright/neurocenter-add-methods/queue-db.json), [независимый review](../output/playwright/neurocenter-add-methods/review.json).
- **Совместимость до сборки.** npm-адаптер показывает поддерживаемые платформы. У OpenCodeRAG видны семь целей и предупреждение об Intel Mac; повторная полная RAG сборка в этом проходе не запускалась. Имя операции сохраняется после reload. [UI](../output/playwright/neurocenter-add-methods/files-ui/npm-compatibility.json).
- **План установки.** Дубли готовых платформ убраны из JSON подключения; отдельный блок артефактов, SHA и остальные параметры сохранены. План и его manifest не меняются. [До](../output/playwright/neurocenter-add-methods/files-ui/plan-polish-before.png), [после](../output/playwright/neurocenter-add-methods/files-ui/plan-polish-after.png).
- **CommonJS.** OpenCode возвращал код 0, но отвергал raw CJS namespace и не вызывал фабрику. Общий builder теперь добавляет ESM default facade для `.cjs` и `.js` с явным `type: commonjs`; MCP main guard сохранён. Тестовая TAR карточка обновлена через CAS с версии 1 до 2, затем прошла установку, повтор, строгую диагностику и настоящий hook уже выпущенным мостом 0.9.2. Подтверждён также прямой запуск фабрики/config-hook в настоящем OpenCode. [Доказательства](../output/playwright/neurocenter-add-methods/runtime/cjs-debug/facade-final.md). Именованные фабрики требуют явных ESM exports; неоднозначные `.js` не переписываются.
- **Fetch.** Upstream объявлял `resources`, но `resources/list` возвращал `-32601`. Общий repository builder исправляет только известный URL, commit и точный SHA исходника; исправление сохраняется в provenance. Проверка моста остаётся строгой. [Причина и RED/GREEN](../output/playwright/neurocenter-add-methods/runtime/fetch-debug/compatibility-fix.md).
- **Скачивание и восстановление.** Исправлены авария HTTP parser Node при потоковой загрузке и потеря результата до начала файловой транзакции. Подготовка теперь сохраняется на диске и после перезапуска даёт проверяемый отказ без повторного выполнения. [Контракт, 66 тестов и границы](download-recovery-2026-10-18.md).
- **Java и готовые релизы.** Исправлены кодировка stdout/stderr Java и ошибочное обозначение native release как JavaScript. [Отдельная матрица адаптеров, 8/8](add-methods-runtime-playtest-2026-10-18.md).

## Границы

JS/TS загружаются как исходники. Для Python, Java, .NET, Go, Rust и native нужен репозиторий с `neurocenter.tool.json` либо операторский рецепт и подготовленные app/runtime assets: произвольный архив другого языка автоматически не компилируется. Поддерживается публичный GitHub по HTTPS; приватный Git, SSH и другие Git-серверы пока не входят в контракт.

Нативно проверен macOS arm64; Python/Java/.NET проверены в Linux arm64 контейнере. Наличие восьми архивов не означает нативную приёмку Windows и остальных целей. Runtime/release assets проверялись из закреплённого кэша; публичная HTTPS доставка этих assets не покрыта этим проходом. Функции сторонних инструментов, требующие моделей, ключей или внешних аккаунтов, имеют собственную настройку.

Оба перезапуска каталога выполнены после двух снимков без активных заданий/операций/backup. Метрики вернули 403, поэтому снимки не подтверждают полноту мониторинга. Checkout не содержит `.git`: коммит, push и синхронизация с удалённым сервером не выполнялись.

## Итог и проверка

**8 способов, 9 сквозных сценариев — PASS:** все дошли до реальной установки, сверки, запуска и вызова MCP/хука. [Общая машинная матрица](../output/playwright/neurocenter-add-methods/report.json).

| Проверка | Результат |
| --- | --- |
| Frontend Vitest | 764 passed, 0 failed, 0 skipped |
| Catalog Vitest | 736 passed, 0 failed, 0 skipped |
| Bridge Vitest, общий source-прогон | 501 passed, 0 failed, 4 условных integration skips |
| Builder Node tests | 68 passed, 0 failed, 0 skipped |
| Изолированный PostgreSQL | 12 сценариев, своя БД удалена |
| Отдельный native/probe/CJS прогон | 17 passed |
| Готовый bridge 0.9.3: runtime + Bash installer | 10/10 native проверок |

Четыре пропуска общего source-прогона требуют явных ready manifests или пути OpenCode; они не посчитаны успешными. Реальная установка готовых комплектов и запуск OpenCode проверены отдельно. TypeScript и production-сборки frontend/catalog/bridge прошли.

Готовый архив **0.9.3 darwin-arm64** проверен по SHA и реальной регистрации/подключению, без Node/npm в PATH. [Release](../output/playwright/neurocenter-add-methods/bridge-0.9.3/release.md), [живой HTTP установщик и архив](../output/playwright/neurocenter-add-methods/bridge-0.9.3/live-delivery.json). После SIGKILL собственного worker во время подготовки новый процесс автоматически доставил failed/unchanged без записи проекта; штатный retry с идемпотентным UUID завершился успешно. Затем прошли strict probe, шесть tools и настоящий публичный fetch_txt. [Live fault/retry](../output/playwright/neurocenter-add-methods/bridge/download-crash-recovery.json), [проверка Fetch](../output/playwright/neurocenter-add-methods/bridge/verify-1792323032744.json).

Общая карточка **MCP Fetch** обновлена через CAS с версии 1 до 2, revision `git-1ddb1a59cb09a2d38e759f2d7a97829680cbe514-compat.1`. Старая версия сохранена; существующие пользовательские установки автоматически не менялись. [Квитанция](../output/playwright/neurocenter-add-methods/fetch-catalog-update.json).

## Очистка и получение обновления

Удалены **12 QA-карточек**, 10 собственных установок, тестовый проект и подключение. Рабочие проект и компьютер сохранены; в каталоге остались девять обычных инструментов. Личный тестовый JSONC полностью восстановлен, собственный worker остановлен, сессии отозваны и private credentials удалены. Временные копии runtime удалены, архивы и свидетельства сохранены. [Финальная проверка](../output/playwright/neurocenter-add-methods/final-state.json).

Рабочая глобальная установка моста не перезаписывалась. Живой установщик уже раздаёт 0.9.3; для получения исправлений загрузки существующий мост обновляется обычной командой:

```sh
curl -fsSL http://localhost:5173/api/bridge/install.sh | bash
```

После обновления OpenCode нужно перезапустить, как сообщает установщик. Нативно принята только macOS arm64; семь остальных целей остаются отдельной приёмкой.
