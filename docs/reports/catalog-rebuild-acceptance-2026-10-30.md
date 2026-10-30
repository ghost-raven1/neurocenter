# Пересборка текущих пакетов — приёмка 30.10.2026

Готов ограниченный срез: основной профиль `dev.sh` подготавливает текущий мост,
создаёт стабильный локальный запрос пересборки каталога, а Catalog принимает его
через существующие очереди с правами реального администратора. Необязательный
Snapshot verifier при отказе не блокирует основной запуск и не объявляется готовым.
`fast` остаётся явным сокращённым режимом без автоматического нового запроса.
Весовые модели автоматически не скачиваются; ручные карточки, pins и история
сохраняются. UI различает доступные исходники, ход операции и опубликованный пакет.

## Свидетельства

Наборы ниже перекрываются. Их количества не складываются и не означают процент
покрытия всего проекта. Проверки выполнены локально с Node 24.22.0.

| Граница | Результат и предел доказательства | Квитанция в `.run/` |
| --- | --- | --- |
| CLI и файловый запрос | Причинные RED→GREEN для актуального моста/запроса и отказа необязательного Snapshot; affected 133/133, финальный срез 71/71. Docker/npm/сервисы — управляемые fixture-границы, без изменения работающего моста. | `rebuild-cli-current-packages-20261030/cli-related-final.log`, `cli-slice-final.log` |
| Реальные собственные группы процессов macOS | Исправлено ошибочное `WATCH_PID_REUSED` при завершившемся дочернем процессе; 27/27 dev-start, 75/75 ownership, 8/8 native-watch. Проверены отказ от сигнала чужому PID и сохранение защиты живых потомков. | `rebuild-cli-current-packages-20261030/launch-gate/acceptance.json` |
| Coordinator/state и shutdown unit | 19/19: повтор/смена запроса, потеря ACK, отказ записи статуса, ожидание приёма, повреждённый статус; producer получает отмену до ожидания остановки coordinator. Это не общий deadline для навсегда зависшего SQL drain. | `catalog-rebuild-20261030/waiting-shutdown-final.log` |
| Настоящий PostgreSQL: публикация | 12/12: coherent source/native receipt, manual-head CAS, архивированные/чужие/отсутствующие/повреждённые связи отклоняются без изменения истории. | `catalog-rebuild-20261030/ownPG-receipt.json` |
| Настоящий PostgreSQL: свежие права и флаги | 17/17, включая 12 существующих transaction cases. Флаг OFF после source-read и во время наблюдаемого advisory-lock wait даёт 403, без job/audit/wake. | `catalog-rebuild-20261030/inline-admission/sql-wait-frozen-result.json` |
| Настоящий PostgreSQL и compiled admission | Причинный старый RED→GREEN 3/3: два Main-актора получают одну job и 409; replay сохраняет ID; потеря lease во время реального lock wait даёт 503 и ноль эффектов. Инвалидация lease управляемая, сетевой разрыв не имитировался как реальный. | `rebuild-inline-fence-20261030/frozen-result.json` |
| Compiled wiring и очереди | 2/2: реальный `onModuleInit` читает FS intent; потеря ACK после COMMIT и restart сохраняют operation IDs; revoke/другой владелец/stale source не создают дубликаты. Приняты девять executable jobs и один inline batch; их автоматический запуск удержан. | `catalog-rebuild-20261030/integration/frozen-result.json` |
| Один настоящий producer | Отдельный 1/1: `plugin-git-context` проходит production supervisor/guardian, текущий build script, source attestation, enforced macOS Seatbelt runtime verification и атомарную публикацию native/source/build результата. Ручная следующая версия переживает новую пересборку. Проверены factory/hook registration на darwin-arm64; Git hook против пользовательского проекта не запускался. | `catalog-rebuild-20261030/integration/producer-latest.json` |
| Frontend | Первичный affected 157/157; после исправления ожидания — 21/21 в трёх affected файлах и TypeScript PASS. Старый build receipt предшествует последней правке; окончательный UI проверен отдельно в браузере. | `catalog-source-ui-20261030/acceptance.json`, `waiting-acceptance.json` |
| Независимое review | `CLEAR_SCOPED` после исправления потери финального статуса, stale admission/lease, порядка shutdown и начального промежутка без статуса. | `rebuildbackend-review/REVIEW.md` |

Финальный compiled Catalog digest:
`60da04b3f0330930751a3c49edacb34af2b01cb383f27b6784cb054583e4d2ae`.
В integration receipt сохранены исходные SHA и полный source-tree digest.
Producer pin не менялся: 158 файлов, SHA-256
`a36fc68f922e8009d5cf492b38c4011b4a4535e70ae5b431a95ea1f303f0b2e4`.

## Реальный desktop UI

Первая браузерная попытка выявила отказ: новый intent до появления matching status
мог навсегда скрыть панель до reload. `browser-first-result.json` сохранён как
`NEEDS_WAITING_STATE_FIX`. Backend теперь возвращает явно неподтверждённое ожидание,
а UI продолжает polling и не показывает бессмысленные `0/0`.

Повторная фактическая проверка Root через Playwright при 1440×1000:
`PASS_SCOPED`, девять наблюдаемых условий. Старые RAG 2.4.4 catalog/project edition2
сохранены, исходники 2.12.2 показаны отдельно, фильтр обновлений удерживает карточку,
pending/attention раскрываются компактно. Тот же UUID запроса переходит из ожидания
в настоящую очередь через polling без reload и навигации. Developer видит разрешённую
старую карточку и делает ноль source GET; возврат Main восстанавливает данные,
диалог операций открывается, горизонтального переполнения нет.

Квитанция: `.run/catalog-rebuild-20261030/status-browser/browser-final-result.json`.
Frontend digest:
`daad2502458a4790884ecc04ff55504c86ce9f9d7a8b4699c362f8d719b248c0`;
Catalog совпадает с compiled digest выше, входные pins неизменны.
В браузерном стенде worker wakeups удержаны; историческая публикационная квитанция
явно создана как fixture metadata, старый архив и runtime не устанавливались.
Реальные локальные Nest-сервисы работают на собственной БД; SSO/flags и часть
зависимостей представлены контролируемыми ответами. Ноль model/external calls и
заблокированных пользовательских записей. Root независимо подтвердил отсутствие
трёх собственных БД, их сессий и PID после нормального завершения стенда.

## Границы готового среза

Приёмка всех рецептов каталога, полный RAG/OpenCode 2, Linux/Windows, установка
нового архива на пользовательский компьютер, CI и удалённый сервер этим отчётом
не подтверждаются. Работающий Main после слияния требует отдельного свидетельства.
Native 1/2 WIP, `bridge-first-local-setup` follow-up и `node_modules` исключены из
готового списка. Четыре обновлённых документа `managed-catalog-updates` включены.
Точный список для узкого staging хранится в
`.run/rebuild-delivery-20261030/ready-files.json`; Git-операции выполняет Root.
