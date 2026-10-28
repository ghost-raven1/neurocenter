# Стабилизация и компактный системный чат — 28 октября 2026

Проверка продолжает [обновление main и моста](main-ui-bridge-2026-10-28.md). Приоритет пользователя — стабильный, удобный и визуально цельный релиз. Новые CLI/provider/reset/quota функции остаются отдельным WIP до своих проверок.

## Воспроизводимый тестовый запуск

Полный preflight reviewed unit-safe inventory обнаружил2 устаревших SHA среди53: `device-job-requests.test.ts` и `installation-set.test.ts`. Запуск остановлен до тестов. Root и независимый reviewer прочитали точный diff и фактические runtime imports/helpers: новые проверки используют in-memory query/build/rollback mocks, `pg` остаётся type-only, сеть/реальные Pool/Client/файловые операции не запускаются.

Обновлены только2 exact hashes после ревью; helpers остались `{}`. Исключения не добавлялись, assertions и guards не ослаблялись, автоматического обновления SHA нет. Повторный полный preflight прошёл. RED и основания ревью: `.run/release-stabilization-20261028/{unit-safe-audit-preflight-red.json,unit-safe-pin-review.md}`.

Затем Node24.22.0 выполнил `scripts/workspace/check.mjs --tooling`: генерация Agent Kit актуальна, **836/836 PASS**,0failed/skipped/cancelled/todo, exit0. До/после4295 source files совпали, snapshot `6cae8b5d2bc6d4f36f2957ad0293b69618d7102e124c1fa3d057b509ebbcbdea`; оба process leader завершены, живых descendants нет. Same-chat MCP подтвердил retained report; текущую эквивалентность любых последующих изменений он не удостоверяет.

Отчёт: `.run/check/ed3987b8-02f8-4f1c-b6b4-5acea4ea8a34/report.json`. Это отдельный tooling-набор, без утверждения о всех продуктовых тестах или покрытии100%.

Первый общий unit-safe запуск остановился на frontend: **4758 PASS /12 FAIL /0 skipped**,390/390 файлов в inventory, source до/после не менялся, дочерние процессы завершены. Ошибки оказались в3 устаревших тестах: ожидание прежней ссылки на мастер, неполный mock соседнего method-workflow и отсутствующий `Space` в mock модели. Production-код этим исправлением не менялся.

Исправления сохраняют проверку текущего/legacy маршрута, ownership/stale callbacks и отсутствие автоматического применения. Provider entry теперь проверяет настоящий ModelCard в jsdom: открывает закрытый native details и нажимает DOM-кнопку с учётом disabled. Ollama chat/vision разделены на2 независимых `it.each` случая; существующие проверки не удалены. Targeted **35/35 PASS** в3 файлах,0skipped, Node24.22; независимый source/receipt review CLEAR. RED остаётся в `.run/release-stabilization-20261028/unit-safe-all8/`; GREEN и точные hashes — в `provider-test-fixes/`. Новый общий прогон учитывается отдельно.

### Проверка helpers и отдельный PostgreSQL

Прежний отбор не замечал PostgreSQL за импортом тестовой фикстуры. Добавлен ограниченный обход только verification imports: до64 файлов,256 рёбер и2МиБ, без обхода production-графа или выполнения проверяемых файлов. Синтаксис разбирает уже установленный Catalog TypeScript5.9.3; parser загружается лениво, `--help` остаётся Node-only. Отсутствие parser даёт явный отказ допуска.53 вручную проверенных SHA-pin сохранены.

Независимое ревью отвергло промежуточный handwritten lexer: деление после `of`, `.return`, postfix и TS non-null могло скрыть dynamic import. Причинный RED сохранён, AST даёт GREEN. Первый AST-прогон87/88 обнаружил только неверный argv нового help-теста: fixture добавляла execution options к `--help`. После исправления только fixture повторные **88/88 PASS**,0failed/skipped/cancelled/todo; исходники до/после совпали, обе внешние группы процессов закрыты. Новая metadata-опись добавляет ровно3 PG-набора и1 действительно opaque dynamic-import набор; прежние10 ложных исключений исчезли. Старые RED/промежуточные описи не переписаны. Квитанции: `.run/release-stabilization-20261028/coverage-fixture-classification/ast-follow-up/{verified-report.md,qa/,qa-retry1/}`.

Catalog16 ошибок предыдущего общего прогона исправлены только в7 тестовых файлах: optional callback arity, полноценный harmless plugin entrypoint, актуальная current-only cleanup capability и правило singleton legacy без summary. Двухответный сценарий дополнен отдельно; assertions прав, MCP producer guard, запрета enqueue и прежние golden/pins сохранены. Focused **76/76 PASS**, без пропусков, production/helper hashes неизменны. Свидетельства: `catalog-focused-green/` в том же release-каталоге.

Три SQL-набора выполнены отдельно на собственном PostgreSQL: `catalog-requests-http`10, `chat-learning-context`27, `project-rag-authorization`14 — **51/51 PASS**,0failed/skipped. Новый tmpfs-контейнер использовал отдельный loopback-порт, без рабочей БД, `.env` и host volumes. Собственные базы, соединения, процессы и контейнер очищены;17 source/helper hashes совпали. Это отдельное SQL-свидетельство, не замена полной интеграционной приёмке. Отчёт: `.run/release-stabilization-20261028/catalog-pg51/report.md`.

### Общий прогон на кандидате273d468a

`unit-safe-all8-retry2/manifest.json` сохранил **FAIL**, не полный GREEN. Семь пакетов завершились без ошибок/пропусков/TODO: frontend4771, Catalog3833, Gateway745, flags68, OAuth136, RAG130, skills301. Bridge:1624PASS/7FAIL/18SKIP. Все8 внешних process leaders reaped, живых descendants/zombies не осталось; sourceChangedDuringRun=false.

Все7 Bridge-ошибок относятся к одному standalone CLI fixture: его ручная copy-list не включала уже поставляемые production build файлы `agent-method-workflow.cjs` и `bridge-update-lock.cjs`. Добавлены только эти2 entries без изменения assertions или production. Targeted Bridge CLI14 + provider profile7 — **21/21 PASS**,0skip. Первая внешняя обёртка ошибочно ожидала14 суммарных случаев и вернула FAIL при raw21PASS; её отказ сохранён, независимая сверка исходных14+7 и JSON оформлена отдельной derived-квитанцией без повторного запуска.10 source/helper hashes не менялись, группы процессов закрыты, собственные профили удалены. Свидетельства: `bridge-profile-closure/`.

18 Bridge-пропусков разделены:10 требуют native OpenCode runtime,3 — agent/learning/queue engine,4 — RAG plugin runtime,1 — ready manifest каталога. Ещё6 watcher native cases без env вообще не регистрировались. Их нельзя считать выполненными по exit0 или скрыть заменой счётчиков; дополнительный native-план остаётся отдельным gate. Готовый кандидат опубликован в draft PR40; слияние ещё не выполнено.

### Настоящий CLI и RAG в изолированных профилях

Дополнительный native-прогон71 случаев завершился **67PASS/4FAIL/0skip**. Canonical catalog test адаптирован к настоящему ROOT asset-contract и полному опубликованному asset с7 descriptors; реальная установка проверяет только host darwin-arm64 archive, с сохранением JSONC, repeat/inspect/uninstall и readiness `unverified`. Это не полная multi-OS поставка. ROOT provider соответствует фактическому producer; отличающийся Catalog provider не подменяет его.

Использованы существующий OpenCode1.14.48 SHAa29407b3… и настоящий RAG pack.11 archive SHA0e9b4fd1…, предварительно перенесённый в собственный stage после full SHA/official archive inspection. Operator unpacked tree не загружался. Native71 source40 и внешняя группа оставались неизменны; исходный FAIL и stage сохранены. Свидетельства: `native-targeted/`.

Два RAG-отказа вызваны test-helper overlay: cached pack.11 ещё не содержит новый `rag-index-corpus.mjs`. Helper допускает только ENOENT этого файла перед наложением актуального producer, остальные ошибки не подавляются. Отдельный affected whole-file **RAG15:15/15 PASS,0skip**, native22.501с;43 пина, public archive/asset/binary и собственный индекс/11223 файлов совпали до/после, внешняя группа закрыта и свежие профили удалены. Предыдущий native71 FAIL не переписан. Свидетельства: `rag-native-overlay-compat/`.

Два оставшихся отказа — truncated diagnostic JSON при exit0 настоящего pinned OpenCode. Чистый внешний профиль воспроизвёл PIPE65536invalid → regularFD132441valid → PIPE65536invalid, все exit0 и byte-exact prefix; в конфигурации ровно3 собственных агента, providers[]. Первоначальный scratch внутри repo обнаруживал64 ancestor agents и не принимается за изоляцию: correction receipt сохранён отдельно. Объяснение через незавершённый stdout write перед process.exit согласуется с pinned upstream source, но внутренний механизм не выдаётся за инструментированное доказательство.

Исправлены только4 тестовых файла: ограниченный regular-FD capture для `debug config`, точный полный UTF-8 JSON, прежний2MiB budget/30с deadline, owned cancellation/descendant drain и retention при unknown ownership. Настоящие native callers сохраняют exact prompts/settings/modes, collector PRIVATE/queue и disable/reenable/remove assertions; суммарный JSON специально больше64KiB при допустимом размере каждого prompt. Actual **unit4/4 +native2/2 PASS**,0skip, Node24.22/OpenCode1.14.48,12.459с native.23 source/binary hashes совпали, оба process group пусты, внешний HOME/TMPDIR удалён. Свидетельства: `native-config-capture-external/`, `native-config-fix/verified-report.md`, `native-config-fix/qa-initial/`.

Полный canonical unit-safe Bridge-прогон на `3fed141c` завершился **1659/1659 PASS**,142/142 файлов,0failed/skipped/TODO,509.362с. Включены четыре native opt-in families: настоящие CLI/agent/learning/RAG/host-catalog,6 прежде условно нерегистрируемых watcher cases и4 новых capture cases. Canonical manifest complete/suiteCompletion=true, sourceChangedDuringRun=false;483 source/helper pins, public asset/archive/binary и собственные11223 runtime-файла совпали до/после.30 metadata-only ancestor checks подтвердили отсутствие посторонних config/instructions. Группы процессов закрыты, сигналов/zombies нет.

Внешняя сверка точных имён вернула FAIL для одного run-specific параметра: `global-config-lock.test.ts:37` использует `it.each({pid:process.pid})` и `%j`, поэтому имя меняется с PID25168 на89758. Остальные1658 имён совпали. Root независимо прочитал исходный case и raw отчёт; отдельная `derived-acceptance.json` принимает только эту одну привязанную к case разницу, без общей нормализации или повторного запуска. Исходный wrapper FAIL и прежний all8 FAIL сохранены, canonical manifest не переписан.

Отдельный opaque `device-codex-diagnostics.test.ts`: **10/10 PASS**,0failed/skipped/TODO,2.380с,21 source/helper pins неизменны. Pinned auth-provider компилировался в собственный fixture с fake auth reader/fetch, без настоящих credentials/Codex/model/API; внешняя группа закрыта и собственный профиль удалён.

Свидетельства: `bridge-final-coverage/{verified-report.md,run/coverage/manifest.json,run/derived-acceptance.json,opaque-run/result.json}`. Это разные завершённые gates, а не искусственный общий all8 GREEN. Между общим прогоном семи пакетов и этим Bridge-кандидатом менялись только7 Bridge-тестовых файлов; код этих семи пакетов сохранился. Измерение Bridge показывает69.03% lines/55.76% branches в данном частичном знаменателе, без заявления100% или полного инфраструктурного покрытия.

## Панель системной роли

Существующее browser-свидетельство показало проблему: при desktop1440×1000 длинный unknown-ACK сценарий оставлял истории80px, composer занимал380px. Панель получила компактную строку модели, textarea1–3rows и свёрнутые дополнительные параметры. Подготовленный контекст раскрывается отдельно; согласие и отправка остаются за пределами disclosures. Полный текст длинной ошибки сохраняется, чтение исходного запроса и exact replay доступны в одном уведомлении.

Изменение ограничено fixed-role nonembedded presentation. API, intent/draft storage, разрешения, подготовка контекста и исполнительные handlers не менялись; встроенный чат сохранил своё поле ввода. Root независимо прочитал исходники, обработчики восстановления и тесты, существенных замечаний не осталось.

Targeted frontend: **47/47 PASS** в7 файлах и production TypeScript exit0. Node24.22, один worker, без file parallelism. Source hashes совпали до/после, фоновых процессов не осталось. Это проверка source-кандидата, не замена desktop-приёмке. Квитанция в отдельном worktree: `.run/bridge-first-local-setup-20261028/role-composer/result.json`.

Fresh desktop Chromium1440×1000 сравнил одинаковые истории/fixtures на точных BEFORE/AFTER исходниках. Обычная панель уменьшилась302→162px, длинный ввод368→206px, prepared380→260px. Первый lost-ACK вариант дал истории лишь+111.148px при критерии≥120; он сохранён как непрошедший геометрический gate.

После одной CSS-поправки pending cap220→200px повторены только затронутые сценарии и фактическая компиляция стилей. История80→211.148px, прирост**131.148px**, полный1377-символьный текст ошибки доступен, native keyboard/exact key+body replay/OFF read/history/cancel работают. Outer710px без clipping и прокрутки страницы; исходники до/после совпали. Предыдущие47/TypeScript не выдаются за повтор после CSS; новая браузерная квитанция отмечена отдельно. QA contexts закрыты, собственный Vite5175 остановлен, реальная MainAdmin-сессия сохранена.

Свидетельства в worktree `bridge-first-local-setup`: `.run/bridge-first-local-setup-20261028/role-composer/independent-desktop-report.md`, `output/playwright/bridge-first-local-setup-20261028/role-footer/{comparison-result,after-affected-result,final-result}.json`. Реальные модели, рабочие бизнес-API и основная БД в контролируемых браузерных сценариях не вызывались.

## Финальная Linux-оболочка

Сам Linux runtime25/inner archive ранее прошёл отдельную native offline проверку. Первый запуск из финальной внешней оболочки остановился до extract/install: macOS bsdtar добавил7 AppleDouble `._*` entries сверх ожидаемых7 записей. Строгая сверка описи GNU tar в Linux-контейнере корректно отклонила лишние записи. Failed outer SHA `81b8dab2e76afddc92d5bc120effd2a20c86229487788253ec97ee889e1ca616` сохранён отдельно в `private-reconnect/failed-delivery/`; исходные FAIL JSON не переписаны, перенос подтверждён `failed-delivery-relocation.json`.

Исправлена только внешняя delivery-оболочка тех же6 payload files. Малый raw-контроль и проверка новой оболочки подтвердили `COPYFILE_DISABLE=1 --no-xattrs --no-mac-metadata`; inner archive, installer, manifest, README и build не менялись. Обычный macOS `tar -tf` скрывал AppleDouble, поэтому он не используется как closure proof. Принятый комплект: `.run/bridge-maintenance-stop-20261027/delivery/neurocenter-bridge-linux-x64-0.9.25-offline-portable.tgz`, SHA256 `4b4ee6a0c76ed24f8672fb4f1743e35e475182cd1871c0bf73dbe3ee14da0f09`,215874196bytes, с `.sha256`.

Actual smoke готового portable tar прошёл в изолированном Linux x64-контейнере под ARM-эмуляцией:7 записей/права/размеры/SHA, распаковка, неизменённый Gateway installer с его default localhost origins, `--archive`, сохранение ручного provider/отключённого чужого MCP/comment и bundled Node24.22.0/bridge0.9.25/probe1.14.48. Smoke53.102с, установщик38.619с при прежнем LAB120; product stop grace10с не менялся. Network none, main mounts0, credentials/worker/model0, system Node/npm/curl tripwires0. Собственный профиль удалён, exact container CID отсутствует.

Свидетельства: `.run/bridge-maintenance-stop-20261027/private-reconnect/{linux-offline-delivery-portable,finalbundle-smoke-portable-transform,finalbundle-smoke-portable-host}.json`, `delivery/finalbundle-smoke-portable-output/{finalbundle-smoke.json,final-tar-list.txt}`. Во втором smoke изменены только4 input pins новой оболочки; все assertions остались прежними. Это не новая гипотеза причины первого Linux build failure: его причина по-прежнему неизвестна.

## Открытые проверки

- Проверенное слияние прошедшей desktop-приёмку компактной панели.
- Локальные gates семи пакетов, scoped Bridge и отдельного Codex10 закрыты; исключённые инфраструктурные наборы остаются явно непроверенными.
- Итоговый read-only smoke работающей площадки и синхронизация документации/веток.

Реальные платные модели, основная БД как QA-fixture, фактический reset, native Windows, CI и внешняя production-площадка в этом проходе не используются и не выдаются за проверенные.
