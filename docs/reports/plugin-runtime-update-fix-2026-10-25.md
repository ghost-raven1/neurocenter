# Готовые runtime-плагины: исправление автообновления

В ветке от интеграционного кандидата `7ed6df3` воспроизведено: valid schemaVersion5 plugin v1→v2 с разными настоящими архивами `artifactFixture` не получал задание, хотя настройки и контракт запуска совпадали. Причина — полное сравнение `config.extra.runtimeArtifacts`, включающее SHA и опись каждой новой поставки.

Для сравнения пользовательских настроек исключены только четыре поля descriptor: `sha256`, `compressedBytes`, `unpackedBytes`, `filesCount`. Сохраняются `target`, `entrypoint`, `executable`, остальные extra, requirements и схема настройки. Неизвестные поля не отбрасываются: действует общая строгая runtime-валидация, rest descriptor сохраняется в сравнении. Исходные package/config/descriptor не мутируются.

Изменение касается только проверки совместимости настроек. Точные project pin, package manifest, одобрение плана и обычный DeviceJobs admission остаются обязательными. Global catalog latest и автоматическое продвижение pin не добавлены. Управляемый Codex supply по-прежнему исключён.

Проверки:

- RED: valid v5 runtime update не создал job. После исправления 22/22 в `plugin-auto-updates.test.ts`: новый exact manifest принят; смены settings/schema/requirements и target/entrypoint/executable блокируются, исходные пакеты сохраняют целостность.
- Расширен существующий PostgreSQL fixture public→pin→approve→queue→claim→authorize→completion для text и runtime. Runtime передаёт package-v5 и registry metadata, разрешает exact новый artifact SHA и отвергает старый SHA. Прогон: **13/13**, собственная UUID-база на owned PostgreSQL16/59820, полный текущий ledger0..41/readiness; база удалена в afterAll. Рабочий PostgreSQL5432 не использовался.
- Catalog `tsc --noEmit`: код 0.

Локальные JSON-квитанции: `.run/plugin-runtime-learning-red.json`, `.run/plugin-runtime-learning-green.json`, `.run/plugin-runtime-pg-green.json` внутри этого worktree.

Проверки не обновляют пользовательские плагины или мост, не скачивают архивы и не запускают inference. Установка из рабочего архива, installed bridge, браузер, CI и production не проверены. Historical DDL, UI и source supply не менялись.
