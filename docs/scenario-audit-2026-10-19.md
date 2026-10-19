# Сквозная проверка сценариев — 19 октября 2026

Проверены все строки **S01–S29**: для каждой ниже указаны успех, отказ, повтор и границы свидетельства. Исправлены девять проблем, включая ранее открытый P1-DUR. Это локальная проверка реализации, а не промышленный допуск: настоящий IdP, независимый cross-host DR, семь других ОС и целевая нагрузка остаются открытыми.

Прогон начат 18 октября, завершён после полуночи 19 октября по Asia/Tomsk; каталог свидетельств сохраняет исходное имя `output/scenario-audit-20261018`.

## Подтверждённые проблемы и исправления

| ID | Что ломалось | Результат |
| --- | --- | --- |
| A01 | Standalone `restore_rag_db` принимал несовпадающий projectKey: чужие строки записывались, старые строки зеркально удалялись | Подтверждённые project/instance/binding проверяются до HTTP и каждой мутации, запись защищена короткой identity-lock. Rebind прерывает продолжение. Временная настоящая LanceDB доказала исходную ошибку. |
| A02 | Standalone restore/sync мог использовать `vectorStore.path` вне проекта, включая symlink; upload отправлял чужие локальные строки под выбранным projectKey | Общая проверка store boundary до чтения/HTTP и на следующих шагах. Config/symlink swap останавливает передачу, 503 не удаляет прежний индекс; успешный повтор проверен. |
| A03 | MCP повторно сериализовал уже готовый JSON: один `JSON.parse(content.text)` возвращал строку | `ok()` сохраняет строку как текст, объект сериализует один раз. Настоящий SDK initialize/list/call и CLI проверены на собранном кандидате. |
| A04 | Принималась публикация `A2 → B1 → A1` или двух ветвей с разными версиями одной зависимости; последующая установка давала 409 | Create/update/activate проверяют замкнутый граф по точным версиям/SHA до записи. Циклы, конфликт pins и общий budget отвергаются, совместимый ромб не дублирует leaf. История pins продолжает защищать удаление. |
| A05 | npm metadata с HTTP 200 и оборванным телом давал необработанный TypeError/500; ошибка cancel скрывала превышение размера | Понятный ограниченный отказ с возможностью повтора; сохраняются собственные ошибки размера/JSON, reader освобождается. Следующий здоровый запрос проходит. |
| A06 | P1-DUR: видимый commit при EIO directory-fsync объявлялся успехом; failed rollback мог вернуть готовность преждевременно; неоднозначный rename оставлял вечный 503 до reinit | Явный `503/SKILL_DURABILITY_UNCERTAIN`, общий root gate для чтения/записи/ready, fsync proof до HTTP-аудита. Prepared rollback удерживает gate до устойчивого отката и очистки. Exact UUID/checksum/owner позволяют согласовать marker и audit-file; обычный flush восстанавливает готовность без повторной мутации. |
| A07 | Позднее сохранение платформенного пользователя закрывало форму/уведомляло уже другую сессию | Проверяется владелец до запроса, после await, при обновлении конфликтующей формы и в finally. Старый callback не запускает новые чтения/auth refresh. |
| A08 | Поздний ответ создания копии проекта показывал успех и перечитывал данные после смены владельца | Проверки владельца при чтении/создании и обработке ответа; повторное нажатие не создаёт вторую копию. |
| A09 | Назначение отсутствующего/удалённого скилла оставалось в БД, но исчезало из витрины вместе с действием удаления | В проекте виден список недоступных ссылок. Администратор явно убирает назначение; локальные файлы не удаляются. Проверка существования перед POST сама по себе не обеспечивает атомарность SQL/FS, такая гарантия не заявляется. |

## Матрица успеха, отказа и повтора

«Локально» ниже не означает реальный IdP/другой хост/другую ОС. Backend/FS/SQL, native-host, browser fixture и исходники отмечены отдельно. Сценарий с намеренным 501 проверен как отказ, а не как реализованная функция.

| ID | Успех / отказ / повтор этого прогона | Уровень и оставшаяся граница |
| --- | --- | --- |
| S01 | Bootstrap первого Main, запрет выдачи другому адресу/повторной эскалации, откат при отказе аудита | 8 own-PG checks и production guards; настоящий первый вход Blitz не принят |
| S02 | Code/state/PKCE/callback/logout/TTL; неверный state, IdP fixture отказ, replay | Изолированный HTTP-provider и auth tests; настоящий IdP не принят |
| S03 | CAS/отзыв/недоступная роль, неверная почта; late success/error после смены владельца | Own SQL, frontend regressions и UI-валидация; реальная смена корпоративных прав отдельно |
| S04 | Ссылка Start с проектом/hash переживает reload; пустые/ошибочные выборки имеют повтор | Настоящий UI одного доступного проекта + frontend query/error tests; 101 проект — fixture |
| S05 | Собранный CLI регистрируется в собственном XDG JSONC, повтор побайтно совпадает; SDK понимает результат | Текущий macOS arm64/candidate, не новая полная installer/native-матрица |
| S06 | Binding/instance/copy/rebind и capability отказ; повтор сохраняет identity | Worker/contract/FS fixtures; пользовательские папки не привязывались, системные диалоги других ОС не приняты |
| S07 | Закреплённые npm fixtures; обрыв тела/размер/ошибочный specifier; здоровый retry | Реальные Response streams, packaging и UI ошибок; не гарантия любого npm-пакета |
| S08 | GitHub commit/подпапка/entrypoint; неверный URL/ref; повтор после исправления | Resolver/packaging fixtures, настоящий UI неподдерживаемого URL; private Git вне контракта |
| S09 | JS/TS files/folder/entrypoint; неверные UTF-8/пути; смена выбора | Настоящие filesystem/subprocess fixtures и UI File objects |
| S10 | ZIP/TAR/TAR.GZ/TGZ; ссылки/лимиты/повреждение; исправление выбора | Packaging fixtures; настоящий HTTP corrupt ZIP 400 и возврат к валидному JS в UI |
| S11 | Подготовленные non-JS recipes, SHA/platform gates и повтор | Fixture launchers/бинарники; настоящий runtime каждого языка и другие ОС не приняты |
| S12 | Release/runtime archive lifecycle и SHA refusal/retry | Изолированные готовые артефакты/host cache; публичная доставка каждого upstream asset не принята |
| S13 | Queue/requestKey, повтор, восстановление queued/running после рестарта и конфликт | 12 own-PG build scenarios + frontend recovery tests |
| S14 | Create/update/activate, точные deps, history/delete; CAS и несовместимый closure, EIO/recovery | 10 новых own-PG publication scenarios, прежние SQL/FS suites, skills EIO. Общий FS-skill+dependency budget до записи пока не принимается как атомарный |
| S15 | Add/repeat/remove/reapprove; missing/deleted skill; видимая недоступная ссылка и явное снятие | Настоящие own SQL/FS/projection, UI GET/DELETE fixtures и 390 px; серверные ссылки не являются атомарным реестром файлов |
| S16 | Install/receipt/idempotence/rollback; потеря ACK и повтор | Worker tests, 5 ready-пакетов install/inspect/uninstall в own-temp на host; не все клиентские ОС |
| S17 | Inspect/prepare/apply recovery, конфликт версии/снимка, rebind и повтор | Worker/FS/identity fixtures; рабочие пользовательские файлы не восстанавливались |
| S18 | Local config и probe refusal/retry; чужая среда/секреты/отсутствующая npm dependency | Настоящий pinned OpenCode 1.14.48 в изоляции + unit; hooks/model/OAuth всех сторонних инструментов не приняты |
| S19 | Uninstall/ownership/личный JSONC/повтор | Ready install/uninstall own-temp и worker tests; не общая гарантия внешних uninstall hooks |
| S20 | Restore/sync native LanceDB; wrongproject/outside/symlink/config swap/503 и retry | Настоящая own-temp LanceDB, loopback HTTP, собранные CLI/SDK. Согласованный снимок при конкурентной записи сервера не заявлен; production model/embeddings отдельно |
| S21 | Очередь/фильтр/подробности, свежие права, cancel/retry/lost ACK, capacity reclamation | Own-PG и настоящий UI; generic executor retry/cancel остаётся 501 |
| S22 | File/directory outbox, UUID, actor, ACK loss, prepared/committed fsync/restart/retry | Настоящие FS/HTTP/SQL, fresh processes, независимый ambiguous-rename review. Powercut/network FS/нагрузка отдельно |
| S23 | Policy CAS, локальные расписание/окна/runner; отказ и сохранённый черновик | 7 own-PG maintenance checks, Node tests и UI fixture 409; целевой timer/RPO/RTO отдельно |
| S24 | Manifest/SHA/полнота/retention/refusal/retry; загрузка списка копий после 507 | Local recovery/S3 fixtures и UI; нового реального cross-host восстановления этим прогоном не выполнено |
| S25 | Preflight/backup/compatibility/idempotence, отказ/повтор обновления | Изолированные orchestration fixtures; новая Docker-репетиция точного production-релиза не выполнялась |
| S26 | Capacity unknown/полный диск/сервисы/очередь/копии, повтор после освобождения | Node/SQL/UI fixtures; реальная доставка alerts и OS enforcement не приняты |
| S27 | Activate/rollback/delete snapshot/release-profile возвращают 501 без изменения данных | 4 настоящих HTTP-отказа + unit; функции не реализованы |
| S28 | Web restore возвращает 501; интерфейс сообщает отсутствие | Настоящий HTTP-отказ + unit; рабочий путь полного восстановления — операторский CLI, см. S24 |
| S29 | Удаление проекта/защита и оставшаяся отдельная БД/lifecycle | Code/unit и сохранённые границы; safe purge/retention проектных БД ещё не реализован, нового destructive UI удаления не было |

Детальные матрицы: [S07–S15](../output/scenario-audit-20261018/catalog/coverage.md), [S05/S06/S16–S20](../output/scenario-audit-20261018/bridge/coverage.md), [S14/S22 и fsync](../output/scenario-audit-20261018/skills/coverage-s14-s22.json).

## Проверки и артефакты

[Итоговая машинная квитанция](../output/scenario-audit-20261018/report.json) сверяет результаты, SHA применённых skills-модулей и сохранность данных. [Проверка документации](../output/scenario-audit-20261018/documentation.json) подтверждает доступность локальных ссылок; [сессия](../output/scenario-audit-20261018/session.json) фиксирует завершение собственного UI-прохода и расхождение версии моста.

- Catalog **941/941** и [65 packaging fixtures](../output/scenario-audit-20261018/catalog/pack-fixtures.tap); [TypeScript/SHA](../output/scenario-audit-20261018/catalog/validation.json).
- Skills **264/264**, [Vitest](../output/scenario-audit-20261018/skills/tests.json), [fresh-process committed](../output/scenario-audit-20261018/skills/restart-evidence.json), [независимый GREEN 4/4](../output/scenario-audit-20261018/catalog/skill-durability-review-green.json). Powercut не симулировался.
- Frontend **916/916**, [Vitest](../output/scenario-audit-20261018/frontend-tests.json), [TypeScript](../output/scenario-audit-20261018/frontend-typecheck.log), [production build](../output/scenario-audit-20261018/frontend-build.log). [Изначальные 4 red owner-cases](../output/scenario-audit-20261018/frontend-owner-red.log), [green](../output/scenario-audit-20261018/frontend-targeted.log).
- MCP **550/550, без skipped**: [полный прогон](../output/scenario-audit-20261018/bridge/vitest-complete.json). Исходные 11 skips закрыты явным подключением pinned OpenCode и пяти существующих ready manifests. Проверки выполнялись в own-temp, личный профиль не использовался. Это не все функции пяти upstream tools: ready lifecycle проверяет install/inspect/repeat/uninstall.
- RAG service **60/60**, [Vitest](../output/scenario-audit-20261018/rag-tests.json), [TypeScript](../output/scenario-audit-20261018/rag-typecheck.log).
- [175 auth/operations Node tests](../output/scenario-audit-20261018/auth-ops-node.json), [38 gateway tests](../output/scenario-audit-20261018/gateway-node.log). Дополнительные 147 catalog contract checks входят в соответствующий каталоговый набор и не складываются с ним повторно.
- Повторены [109 PostgreSQL/HTTP/FS сценариев](../output/scenario-audit-20261018/integration.json) на конечных catalog/skills candidates; отдельно [10 publication](../output/scenario-audit-20261018/catalog/publication-db.json), [12 durable build](../output/scenario-audit-20261018/catalog/tool-build-db.json), [8 bootstrap](../output/scenario-audit-20261018/auth/bootstrap.json), [7 maintenance](../output/scenario-audit-20261018/maintenance/maintenance-database.json) и [S15 missing/delete/repeat](../output/scenario-audit-20261018/catalog/skill-assignment-gap.json). Собственные БД/папки удалены.

Настоящий UI проверил deep link/reload, ошибки источников, исправление ZIP, сброс поиска, семь вкладок проекта, недоступную ссылку, отказ копии, policy CAS, неверную почту, историю/очередь и возврат с неизвестного адреса: [квитанция](../output/playwright/neurocenter-scenario-audit-20261018/ui.json). Корректные 409/507 и удаление ghost-ссылки — явные browser fixtures; corrupt ZIP — настоящий read-only analysis POST. [390 px](../output/playwright/neurocenter-scenario-audit-20261018/unavailable-skill-mobile.png). Промежуточные ошибки тестового harness касались названий/вложенных tabs и не объявляются продуктовыми багами.

## Применение, сохранность и открытые тупики

Catalog/skills локально применены после idle/PID checks: [применение](../output/scenario-audit-20261018/restart.json), [idle](../output/scenario-audit-20261018/idle.json). Старые сборки сохранены в `.run/scenario-audit-previous`. [Все шесть сервисов готовы](../output/scenario-audit-20261018/health.json). [Baseline](../output/scenario-audit-20261018/baseline.json) и [cleanup](../output/scenario-audit-20261018/cleanup.json) подтверждают прежние файлы, карточки, registry, БД и хэши проектов/участников/назначений/пользователей. Рабочие проекты/пользователи/назначения не создавались. [Пять настоящих HTTP-команд 501](../output/scenario-audit-20261018/unsupported-http.json) не меняли данные. Своя сессия завершена (logout 200, `/auth/me` 401), закрыта только собственная вкладка.

**Расхождение поставки:** работающий `/api/devices` сообщает **bridgeVersion 0.9.0**, Node 24.22.0. Исходники/новый проверенный кандидат MCP имеют версию **0.9.3**, build ID `a9cd27a6ee1594aae415064d99be45427d00be9ded6509b0c7180eca7803b3dc`. Исправления A01–A03 находятся в этом кандидате; установленный глобальный мост и ранее собранные installer-архивы этим прогоном **не обновлялись**. Native-приёмка прежнего архива 0.9.3 не переносится на изменённый код. Следующая поставка требует нового идентификатора/SHA, сборки архивов, проверки установщика и развёртывания.

Остаются: S27/веб S28 с 501, общий executor retry/cancel, безопасный purge истории/резервов/оставшихся RAG-БД, согласованное FS/PG restore и snapshot-публикация всего RAG. В `maintenance` нет включённого runner и физического collector, что честно видно в UI. Независимые S3/DR, настоящий Blitz, семь нативных целей, точные production update/нагрузка/alerts остаются внешними P0. Сценарии arbitrary private Git/install hooks не входят в нынешний контракт.

`.git` по-прежнему отсутствует. Commit/push, CI и production deployment не выполнялись; допуск остаётся **NO-GO**.
