# Мост 0.9.4: обновление и устранение тупиков

На локальном компьютере выполнено штатное обновление **0.9.0 → 0.9.4**. Сервер через `/api/devices` видит прежнее устройство, новый build ID и статус online. Исправления RAG restore/sync и MCP JSON из [предыдущего аудита](scenario-audit-2026-10-19.md) доставлены в установленный клиент. Это локальная поставка darwin-arm64; внешняя P0-приёмка не завершена.

## Исправленные проблемы

| ID | Подтверждённая проблема | Исправление и проверка |
| --- | --- | --- |
| R01 | Совместимый мост 0.9.0 показывался как готовый, версия не отображалась; обновление скрывалось под подключением другого компьютера | Видна фактическая версия и кнопка «Обновить мост», открывающая текущую команду установщика. 4 regression tests RED → GREEN, настоящий UI до и после обновления, 390 px. Сравнение с несуществующим latest API не добавлялось. |
| R02 | Два установщика работали одновременно: второй объявлял успех, затем rollback первого возвращал старую версию | Mutex на каталог установки удерживается через регистрацию, подключение и rollback. Второй запуск объяснимо отказывает. Собственный subprocess воспроизвёл ошибку до правки; regression проходит. |
| R03 | Файлы заменялись до проверки выполняющихся заданий; новый OpenCode мог запустить worker между preflight и заменой | Staged CLI проверяет очередь и UID/SID/путь/PID, останавливает только простаивающий собственный worker до замены. Успех удерживает серверную паузу до `--finish-upgrade`, отказ снимает её. Даже профиль с ключом без worker ставится на паузу. Новый worker ждёт install-lock до чтения credentials и API. Проверены занятость/отказ/повтор/foreign PID, native CLI и порядок паузы до изменения inode. |
| R04 | Упаковщик мог объявить прежний dist новой версией; после проверки dist мог смениться при копировании; установщик не сверял внутренние версии/build ID | Перед упаковкой и после копирования проверяются версия и SHA всех dist-файлов. Скопированный manifest и build должны совпасть с исходным кандидатом. Установщики сверяют package/runtime/build, target и build ID до замены файлов. Тесты отвергают старый dist, последующее изменение файла, неверные version/build ID. |

## Точный артефакт

- Версия: **0.9.4**, target `darwin-arm64`, встроенный Node **24.22.0**.
- Build ID: `c657d94628d0d5348704d170d8846b13ce143c28a85efa2593801a71fb42f4e4`.
- Архив: `bridge-dist/runtime/neurocenter-asset-sync-darwin-arm64-0.9.4.tgz`, **123039022 байта**.
- SHA256: `89f9595fd5580e06f54e3279e50d44f0fdd6df6980ffe68448b67406b74822f8`.
- OpenCode probe **1.14.48**, SHA `a29407b32f28ff552539d6f4a1bbe6fafc5023472c7ff8ca2494525b9b0d921b`; LanceDB загружается нативно.
- [Фактическая HTTP-доставка через localhost:5173](../output/bridge-release-20261019/delivery.json) сверена по полному потоку архива; использован именно отданный сервером установщик. Прежний архив 0.9.3 не заменялся. Переносимый source-архив также пересобран.

## Проверки

[Машинная квитанция выпуска](../output/bridge-release-20261019/report.json) связывает SHA архива, build ID, установленный клиент, UI и исходники. [Проверка документации](../output/bridge-release-20261019/documentation.json) подтверждает доступность локальных ссылок.

| Уровень | Результат и свидетельство |
| --- | --- |
| MCP | [569/569, без пропусков](../output/bridge-release-20261019/mcp-tests.json), включая pinned OpenCode и ready lifecycle в собственных временных профилях |
| Frontend | [920/920](../output/bridge-release-20261019/frontend-tests.json), TypeScript и [production build](../output/bridge-release-20261019/frontend-build.log); установленный UI использует Vite source |
| Упаковка | [3/3 build guards](../output/bridge-release-20261019/build-tests.tap), [28/28 installer tests](../output/bridge-release-20261019/installer-final.tap) — Bash fixtures платформ не являются их native-приёмкой |
| Worker preflight | [26/26 targeted](../output/bridge-upgrade-20261019/worker-preflight-tests.json), входят в MCP; [11 native CLI checks](../output/bridge-upgrade-20261019/worker-preflight-smoke.json), отдельный loopback provider |
| Точный автономный архив | [5 runtime/SDK checks](../output/bridge-release-20261019/runtime-smoke.json) и [6 native installer checks](../output/bridge-release-20261019/native-installer-final.json), без Node/npm в PATH, с собственным pairing fixture |
| RAG и stdio | [5 compiled CLI/SDK/LanceDB сценариев](../output/bridge-release-20261019/compiled-smoke.json): wrong-project/outside-path refusal, matching restore, HTTP 503 и сохранение прежнего индекса |
| Настоящее обновление | [Глобальный установщик](../output/bridge-release-20261019/global-install.log), [до](../output/bridge-release-20261019/global-before.json), [после](../output/bridge-release-20261019/global-after.json): прежний device ID, credentials/workspace SHA и побайтно тот же OpenCode JSONC; старый клиент сохранён |
| UI и сохранность | [Настоящий UI](../output/bridge-release-20261019/ui.json), [мобильный экран](../output/bridge-release-20261019/update-ui-mobile.png), [исходные данные](../output/bridge-release-20261019/cleanup.json), [шесть здоровых сервисов](../output/bridge-release-20261019/health.json); своя сессия завершена, своя вкладка закрыта |

Frontend и MCP проверялись полностью; catalog/skills/RAG/auth не изменялись и в этом проходе повторно полностью не тестировались. Их последний полный результат — [S01–S29](scenario-audit-2026-10-19.md). Числа вложенных targeted и smoke не складываются с unit-наборами как независимые реализации сценария.

## Границы и восстановление

Пауза очереди сервера имеет TTL **1 минута**. Новый worker дополнительно ждёт install-lock, старые версии такого gate не знают: зависание критической секции дольше TTL не считается принятой атомарностью обновления. После SIGKILL/потери питания install-lock не удаляется автоматически; сообщение указывает `owner.pid`. Проверить завершение владельца и убрать только оставшуюся блокировку — операторский путь, без автоматического удаления чужой блокировки.

При отказе регистрации совместимый прежний клиент восстанавливается и очередь возобновляется, но прежний worker автоматически не запускается. Установщик завершает работу с ошибкой и предлагает повтор или перезапуск OpenCode. Успешная установка тоже требует перезапуска уже открытого OpenCode, чтобы его MCP stdio загрузил новые модули.

Остаются шесть внешних P0, семь других native-целей, функции S27/веб S28 с 501, общий executor retry/cancel и lifecycle/purge. Проверенные installer/runtime пункты darwin-arm64 не заменяют полный восьмипунктный P0-чеклист. Локальный HTTP не является проверкой промышленного HTTPS. `.git` отсутствует; commit/push, CI и production deployment не выполнялись. Production-допуск — **NO-GO**.
