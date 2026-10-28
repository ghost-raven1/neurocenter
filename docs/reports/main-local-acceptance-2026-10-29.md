# Локальная приёмка Main, 29.10.2026

Текущий срез: Main `4cecd755763b760b49b6a862e6f459c7f22448bf`. Объединены четыре проверенных исправления; **полная приёмка приложения не завершена**. Глобальный ledger содержит **60/273 PASS —21,98% плана**, а не процент готовности или покрытия кода.

| PR | Исправление | Наблюдаемая проверка |
| --- | --- | --- |
| [#46](https://github.com/ghost-raven1/neurocenter/pull/46) | Понятная причина отказа невыбранного MCP-инструмента | G: один planner,0MCP effects, причина в истории/trace после reload; независимый DB/UI mapping |
| [#47](https://github.com/ghost-raven1/neurocenter/pull/47) | Возврат фокуса после Escape в меню пользователя | G/H2 и отдельный settled Main smoke |
| [#48](https://github.com/ghost-raven1/neurocenter/pull/48) | Возврат фокуса к исходной кнопке модели | H2: Escape/footerEnter и trapTab/ShiftTab; отдельный Main smoke |
| [#49](https://github.com/ghost-raven1/neurocenter/pull/49) | Завершение начального чтения после «Нового диалога» | Причинный RED→48/48GREEN, frontendTSC/Vite; Main: задержаны реальные GET, загрузка завершается, модель сохранена, новый диалог пустой |

G и H2 — собственные изолированные кандидаты, их свидетельства явно сопоставлены Root с объединёнными исправлениями. Они не превращаются в полную приёмку Main backend runtime. Main smoke меню/модели —1440×1000; проверка NewDialog —1280×720. Полный четырёхчастный клавиатурный F62-02 выполнен на H2 при1440×1000. В Main NewDialog проверке нет POST, business writes, inference и page errors.

## Ledger и отдельная квота

После независимого Root review изменены только F42-03 `PARTIAL→PASS` и F62-02 `FAIL→PASS`; остальные271 объекта эквивалентны прежним. Текущие состояния:60PASS,168NOT_RUN,20PARTIAL,24blocked,1UNKNOWN,0FAIL. Полностью принято только семействоF24. Прежние F/GFAIL, частичные попытки и три исторических UNKNOWN сохранены.

План и полный отчёт хранятся в worktree `bridge-first-local-setup`: `output/playwright/full-functional-acceptance-20261028/case-plan.json`, `docs/reports/full-functional-case-plan-2026-10-28.md`. Контроль — `case-plan.gh2-update-receipt.json`, независимое принятие Root — `case-plan.gh2-root-independent-review.json`, SHA `a7f13302295fdadc9b55670c31aa23d35a63c87958caee4179069d1e5a456f67`. Неизменные preimages58 и текущий checkpoint60 сохранены в Original `.run/release-main-acceptance-20261028/acceptance60-checkpoint`.

**Семь GQ-сценариев квоты находятся вне исходных273.** На кандидате G `24634caa` проверены восстановление одного ключа после потери ACK, CAS, активный резерв с отказом второго проекта, финальное превышение и следующий отказ до dispatch, второй пользователь, отзыв прав с403 и выключение флага с сохранением истории/учёта. Это контролируемые локальные tokens/ответы, не биллинг или качество платного провайдера. Историческая tools-on попытка и реальные порядки recovery не удалены. LedgerSHA `4aaf66cb9ce9b7e44250d295d2b6cc94134cd49673fa062366001144abde62c5`,195файлов frozen manifest `746fa523…`. Эти7 не входят в60 и не означают наличие quota migration46 в текущем Main.

## Локальный runtime

Catalog обновлён отдельно с проверенной сборки Main `d74ad8a8`, поколение `63fd66e3-53df-4031-9373-2239e9d0ee3d`:1261файл/6 999 938байт. После merge4ce backend tree не изменился. На момент применения `/health` и `/ready` —200, миграции0…45; квоты schema46 здесь отсутствуют. Шесть счётчиков активных заданий были0; прежняя группа Catalog подтверждённо завершена. Остальные семь зарегистрированных владельцев процессов, защищённая конфигурация и персональный мост не менялись. Драйвер не делал business requests или платных вызовов; штатные идемпотентные записи запуска приложения этим не исключаются.

Свидетельство: Original `.run/release-main-acceptance-20261028/main-catalog-mcp-update/apply-final-proof.json`, SHA `a5bf0d29485c4e870d5964f7228bf6b9cbc75d1a1c30bccd7e271e3a1a6a8568`. Последнее наблюдение Root после4ce:7 HTTP200; готовность Catalog/Bridge/Flags/RAG подтверждена, Skills/Gateway readiness —SKIPPED, поэтому готовность всех сервисов не заявляется. Main UI: `main-d74-ui-smoke/smoke-receipt.json` SHA `b4f99918d8b63aa056137605dbc405463af53df1578a2517c26fb1e3bb0d7090`; [NewDialog и его границы](service-role-new-dialog-loading-2026-10-28.md).

## Оставшиеся gates

- **213 исходных сценариев без полного PASS**: обычные агенты, методы, часть RAG, поставка/ОС, recovery и другие точные границы перечислены в ledger. UNKNOWN требуется согласовать с фактическим серверным исходом до повтора.
- **Основной bridge-first `/start` ещё не принят; OpenSpec5.1 открыт.** Root на Main видит «Установите OpenCode…», «Установщик подготовит OpenCode и мост», кнопку «Установить OpenCode» и подключённый мост0.9.25. Raw — `main-d74-ui-smoke/start-current-snapshot.json`, SHA `14e645aa870f401400c8e574e3160f7841df81d91cf350dacf8575891bf13d02`. Main и WIP `frontend/src/modules/Start/UnifiedProjectSetup.tsx` совпадают и задают OpenCode→мост; флаг `computer_setup` отсутствует в Main, новая WIP-модель/storage не подключена и pipeline не завершён. Это не отказ флага или кэш. Источник Start и несогласованный WIP в этиPR не включались.
- **Quota-фича целиком ещё не принята и не объединена этимиPR.** Нужны оставшиеся OpenSpec-сценарии и каналы, корректная наблюдаемость причин отказа; отдельная RoleQuota-проверка показала запрет без dispatch и понятную UI-подсказку, но persisted `failure_code=internal_error` остаётся ограничением.
- Новый ComputerSetup, полный/частичный reset, реальные native/provider/IdP и платформенные проверки принимаются отдельно. Локальные fixtures и экспорт собственных стендов не доказывают внешнее disaster recovery, нагрузку, CI или production.
