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
- [ ] 2.5 Обновить описание шага OpenCode и API/feature документацию; проверить, что normal path не требует ручного `--version` или системного npm.

## 3. Локальные провайдеры до проекта

- [ ] 3.1 Закрепить pinned OpenCode1.14.48 auth owner на изолированном native fixture API/OAuth/unknown fields/invalid file/external change; сохранить выбранный adapter и свидетельства.
- [ ] 3.2 Добавить полный device-global provider inventory без model pin/project и без секретов; проверить auth-only/OAuth/multiple providers и границу XDG_DATA_HOME.
- [ ] 3.3 Подключить защищённую локальную форму адресного сохранения API-key; проверить stale session/revoked role/CSRF и точную сохранность остальных auth entries.
- [ ] 3.4 Встроить provider step с локальным inheritance и отдельной явной model check; проверить отсутствие server-key-transfer/автоматического платного вызова и описать handoff на выбранный компьютер.

## 4. Наблюдаемое обновление моста

- [ ] 4.1 Показать installed report против проверенной совместимой install supply; проверить newer/older/same build/offline/stale/unsupported target в UI/contract tests.
- [ ] 4.2 Реализовать fenced update handoff в существующих jobs/device lock и внешний supervisor; проверить actual SQL race с claim/MCP/отзывом прав и запрет остановки чужой работы.
- [ ] 4.3 Подключить installer adapter точного handoff permit, durable progress/recovery и heartbeat completion; проверить native update/failed publish/rollback/lost ACK с сохранением ключей и конфигов.
- [ ] 4.4 Добавить кнопку обновления/ход/итог и единый fallback для старого моста; проверить, что запуск helper не отображается завершённой установкой, и актуализировать help.

## 5. Последовательный мастер и интеграция

- [ ] 5.1 Переставить основной путь bridge→CLI→providers→folder→assets→check с сохранением безопасных старых ссылок; проверить URL/stage ownership, keyboard/focus и OFF recovery.
- [ ] 5.2 Пройти desktop сценарий с пустым компьютером и отдельный existing CLI/multiple providers путь; сохранить реальные результаты native/браузера отдельно от fixtures и не запускать платную модель.
- [ ] 5.3 Независимо сверить реализацию с тремя specs, выполнить strict OpenSpec validation, обновить бэклог и подготовить отдельные проверенные feature-коммиты/PR без reset WIP и без изменения кандидата0.9.25.

## Workflow follow-up

- После проверенной поставки синхронизировать specs и архивировать завершённое изменение; незавершённые этапы не помечать выполненными.
