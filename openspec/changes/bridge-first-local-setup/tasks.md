# Tasks

## 1. Компактный основной интерфейс

- [x] 1.1 Убрать пустые summary и повторные legacy-footer, оставить truthful computer/version/status и единую помощь; проверить focused Start UI tests и TypeScript.
- [x] 1.2 Свести folder/readiness navigation к одному основному действию без ложного выполнения; проверить unbound/bound/OFF сценарии и сохранение recovery.
- [x] 1.3 Проверить desktop Playwright empty/selected/stale/error/help, сохранить скриншоты и документировать фактические границы этого UI среза.
- [x] 1.4 По уточнению «Старый мастер не нужен» удалить прежний UI и fallback; перевести исторические step/pair/add-computer/help ссылки в основной мастер с сохранением контекста. Проверить URL и основной UI, OFF, сворачивание/возобновление и отсутствие импорта удалённых компонентов; выполнить отдельную desktop-приёмку.

Приёмка 1.4: 7 frontend-файлов, 79/79 PASS и production TypeScript `--noEmit` PASS; после правки статьи отдельно `extension-instruction` 8/8 PASS. Root подтвердил desktop 1440×1000 на собственной площадке: `output/playwright/release-ui-full-20261028/setup-{legacy-start,legacy-project-step,legacy-pairing,add-computer,help-primary,collapsed,resumed,help-article,pairing-recovery-final,context-resume-final}-green.json`. Read-only source/doc review исправленного diff не оставил подтверждённых замечаний. Это удаление старого UI и принятие навигации; новый bridge-first порядок 5.1, native установка, CI и production этим не приняты.

Поставка первого UI-среза: PR39, main `9dc32efc`; свидетельства и отдельные непроверенные границы — `docs/reports/setup-catalog-ui-2026-10-28.md`. Новый порядок этапов относится к 5.1.

## 2. Пользовательский OpenCode через мост

- [x] 2.1 Добавить shared DTO/capability/flag и device-global fixed probe admission/claim/completion без project; проверить owner/role/OFF/unsupported capability и exact request replay на unit/SQL границах.

Историческое свидетельство исходного WIP; выделение на Main4ce и проверки текущего среза ещё выполняются. Backend исходного среза: Catalog 231/231, собственный PostgreSQL 52/52 без пропусков, policy 108 и OpenAPI 28/28. Квитанции: `.run/bridge-first-local-setup-20261027/cli-backend-source.md`. Это не приёмка native worker или браузерного вызова.
- [x] 2.2 Реализовать bounded owned-process `opencode --version` и безопасный public result; проверить installed/missing/hang/failure, закрытие child и отсутствие stdout/secret в completion.

Текущий выделенный срез на Main4ce проверен отдельно: Catalog231/231, policy108/108; после согласования канонических UUID — причинный RED85/90→GREEN90/90, schema1/1 и TypeScript PASS при том же60s лимите после сохранённого timeout. Собственный PostgreSQL52/52 принят независимой проверкой Root7afea175…, ресурсы удалены. После объединения Main281 (f88f76cf) полный OpenAPI-набор28/28 проходит; браузерная цепочка пока не принята. Native на Darwin: CLI98/98 + связанные MCP21/21, TypeScript и production-сборка с258артефактами; причинные FAIL IPC и uppercase сохранены. Квитанция Nativee6ca7d77… фиксирует точные версии DTO и границы: без изменения моста0.9.25, установки из архива, реального пользовательского CLI и Linux/Windows.

- [x] 2.3 Подключить автоматическое observation в Start с async owner и повтором; проверить смену компьютера, lost ACK, stale result и ошибки в frontend tests.

Frontend2.3:77/77, TypeScript/Vite PASS. Дополнительно приняты две реальные desktop цепочки UI→Catalog queue→candidate Native→физический --version fixture: автоматический запуск без проекта и real201/lost-delivery/reload с тем же job/key и без лишнего POST/процесса. Профили подключены обычным UI, ресурсы закрыты, независимое review41bf1a5d… CLEAR_SCOPED. Это не установленный архив/пользовательский CLI: поставка остаётся открытой. Код версии0.9.26 проверен98/98 и официальной сборкой;254JS-файла совпадают с UI-кандидатом. См. docs/reports/opencode-cli-observation-2026-10-29.md.

- [ ] 2.4 Реализовать bridge-managed CLI install из проверенной платформенной поставки с атомарной публикацией и post-install version; проверить реальный архив, ручную/более новую установку, отказ SHA и сохранение config/auth.

Source-кандидат 29.10: strict DTO, approved-supply port, Native copy/owned-stage journal, fixed worker и UI-контроллер реализованы. Изолированный PostgreSQL: 16/16 PASS, включая Linux namespace и same-ID bearer rotation; первый RED 6/9 нашёл пропущенный global allowlist, cleanup ownUUID PASS (`.run/bridge-first-setup-20261029/install-pg-receipt.json`). Итоговые проверки собственного среза: Native 9 файлов 87/87 (68 ComputerSetup и 19 metadata-sync), frontend 12 файлов 145/145, Catalog 4 файла 100/100, отдельный model-sync PostgreSQL 24/24. Production TypeScript Native/frontend/Catalog проходит; Catalog использует явно закреплённый vendor1.2.1 через контролируемый tsconfig. Сырой stdout и границы сохранены в `.run/bridge-first-setup-20261029/`. Это не приёмка нового runtime-архива, его реальной установки, CI или работающего компьютера; 2.4 остаётся открытой.

- [ ] 2.5 Обновить описание шага OpenCode и API/feature документацию; проверить, что normal path не требует ручного `--version` или системного npm.

## 3. Локальные провайдеры до проекта

- [ ] 3.1 Закрепить pinned OpenCode1.14.48 auth owner на изолированном native fixture API/OAuth/unknown fields/invalid file/external change; сохранить выбранный adapter и свидетельства.
- [x] 3.2 Добавить полный device-global provider inventory без model pin/project и без секретов; проверить auth-only/OAuth/multiple providers и границу XDG_DATA_HOME.
- [x] 3.3 Подключить защищённую локальную форму адресного сохранения API-key; проверить stale session/revoked role/CSRF и точную сохранность остальных auth entries.
- [ ] 3.4 Встроить provider step с локальным inheritance и отдельной явной model check; проверить отсутствие server-key-transfer/автоматического платного вызова и описать handoff на выбранный компьютер.

По отдельному решению отключён прежний экспорт ключей автоматической синхронизацией моделей: context всегда false, новый Native не читает auth и отправляет пустые credentials, endpoint отклоняет непустой снимок до repository/storage. Переключатель экспорта удалён; сохранённое прежнее разрешение и encrypted history не переписываются настройкой метаданных. Native19/frontend7 и реальный собственный PostgreSQL24 проходят. Последующая совместимость автоматически созданных remote connections с personal-auth51 и их auth_mode принимается отдельно после слияния51; этого ещё нет в данном baseline50.

Source-срез C 29.10: точные форматы auth/config закреплены исходниками OpenCode1.14.48 commit `4d8ac17c263c0e58fb99c25cc636684dffb45a50`; Context7 текущей V2 не использован как контракт1.14.48. Shared DTO/schema, global admission adapter, Native metadata/editor/private intent/outbox и AntD step до папки реализованы. Перед OPEN и каждым SAVE проверяется обычная PATH-команда точной поддержанной версии; каждый publish повторно проверяет executable и полномочия. Проверки: 26 Native FS/loopback/worker/outbox, 13 frontend controller/presentation/private-page, 5 Catalog unit и 4 shared Node. Private-loopback проверки выполнялись только с own HOME, синтетическими ключами и stub открытия браузера. Native/frontend TypeScript проходят. Catalog production noEmit проходит с контролируемым `.run/bridge-first-setup-20261029/tsconfig.catalog.json`, привязывающим asset-contract к vendor1.2.1 текущего дерева; исходный noEmit через Catalog-only dependency-link на Original vendor1.2.0 дал шесть TS7006 в asset-sources. Это граница разрешения деклараций, а не доказанный прежний дефект этих исходников. Квитанция и source pins: `.run/opencode-local-providers-20261029/`. Потерянный ACK, частичная двухфайловая запись, внешняя ротация auth, accepted404 без replayOPEN, history403 admission fence, OFF read, CSRF/Origin/expiry, остановка с ожиданием уже принятой записи и отменой permit, same-ID token rotation после async permit и архивирование завершённых квитанций проверены. Известная неподдержанная версия даёт только чтение прежних файлов и явный переход к настройке OpenCode без заявления о готовности авторизации. Этот мастер не отправляет ключи на сервер; поведение сторонних плагинов этим не подтверждается. Это не запуск реального пользовательского OpenCode, не актуальный установленный Native-архив и не desktop-приёмка встроенного Start; 3.1 и 3.4 остаются открытыми до этих отдельных проверок.

## 4. Наблюдаемое обновление моста

- [ ] 4.1 Показать installed report против проверенной совместимой install supply; проверить newer/older/same build/offline/stale/unsupported target в UI/contract tests.
- [ ] 4.2 Реализовать fenced update handoff в существующих jobs/device lock и внешний supervisor; проверить actual SQL race с claim/MCP/отзывом прав и запрет остановки чужой работы.
- [ ] 4.3 Подключить installer adapter точного handoff permit, durable progress/recovery и heartbeat completion; проверить native update/failed publish/rollback/lost ACK с сохранением ключей и конфигов.
- [ ] 4.4 Добавить кнопку обновления/ход/итог и единый fallback для старого моста; проверить, что запуск helper не отображается завершённой установкой, и актуализировать help.

## 5. Последовательный мастер и интеграция

- [x] 5.0 Перенести компьютер/версию моста/OpenCode в компактную постоянную шапку с общим владельцем состояния, убрать индикатор автообновления и дубли Start; проверить desktop отступы, fixed inspection, навигацию/reload и клавиатуру. Границы: `docs/reports/computer-header-2026-10-29.md`; настоящий установленный мост этим не обновлён.
- [ ] 5.1 Переставить основной путь bridge→CLI→providers→folder→assets→check с сохранением безопасных старых ссылок; проверить URL/stage ownership, keyboard/focus и OFF recovery.
- [ ] 5.2 Пройти desktop сценарий с пустым компьютером и отдельный existing CLI/multiple providers путь; сохранить реальные результаты native/браузера отдельно от fixtures и не запускать платную модель.
- [ ] 5.3 Независимо сверить реализацию с тремя specs, выполнить strict OpenSpec validation, обновить бэклог и подготовить отдельные проверенные feature-коммиты/PR без reset WIP и без изменения кандидата0.9.25.

## Workflow follow-up

- После проверенной поставки синхронизировать specs и архивировать завершённое изменение; незавершённые этапы не помечать выполненными.
