# Аудит и границы проверки, 30.10.2026

## Основание

Код main b81cd2aa; начало работы — 5 чужих untracked-файлов без изменений tracked. Локальный origin/main совпадал, сеть Git не обновлялась. Изменения текущего прохода находятся на feature/catalog-actionable-workflows.

MCP workspace_status подтвердил Node24, bridge package 0.9.28. services_health: Catalog /health 200, /ready 503; прочие проверенные порты не слушают. Текущая локальная среда не подтверждает состояние компьютера и площадки пользователя на фотографиях. Серверы не перезапускались.

## Фото пользователя

Исходные HEIC находятся в Downloads; для просмотра созданы только локальные JPEG в .run/catalog-actionable-workflows/photos. Фотографии не включаются в Git: содержат сведения рабочего окружения, не нужные для тестовых fixtures.

| Файл | Наблюдение | Следствие |
| --- | --- | --- |
| IMG_1262 | Совпадение OpenCodeRAG заканчивается ошибкой и советом уйти в другую карточку | Нужен выбор новой версии в текущем диалоге |
| IMG_1263 | 0 из 11 готовы, строки «Требует внимания» без конкретных действий | Действие рядом с каждой строкой, раскрытая ошибка |
| IMG_1264 | Исходники обновились, пакет не опубликован, кнопка предлагает переустановку прежнего | Не смешивать source update и готовое обновление |
| IMG_1265 | OpenCode 2.2.2, прежние файлы, частичное чтение и недоступная настройка | Реальный version gate V1; отдельная причина partial неизвестна по фото |
| IMG_1266 | Большой блок выбора проекта, повторные статусы, ошибка назначения плагина | Единый контекст шапки; действия восстановления должны вести к точному объекту |
| IMG_1259 | Архив отклонён по 1 МиБ/5 МиБ, тип MCP при имени плагина | Нужна проверка типа и понятный путь рецепта/готовой поставки; содержимое самого архива не предоставлено |

## Подтверждённые владельцы проблем

- frontend/src/features/AssetSources/BundledCatalogSources.tsx: исходно обновление выбиралось только из plan.imported. services/catalog-service/src/package-build/publication-target.ts: assertBuildCreateName отклоняет дубликат; существующий preview/CAS уже пригоден для явного обновления.
- frontend/src/features/AssetSources/CatalogRebuildStatus.tsx: исходно строки результата без действий, общая ссылка /operations. Legacy redirect сохраняет query, но исходный drawer не выбирал operation по query.
- Дополнительный блокер квитанций: rebuild coordinator сохраняет raw UUID сборки, тогда как operations использует tool-build-UUID. UI совместимо нормализует старый id. Inline-import не создаёт запись operations: точная ссылка для него не показывается, нужен отдельный серверный путь восстановления (tasks 1.4).
- Независимое review: переход к failed build теперь открывает точную диагностику, но существующий operationPackagingRecovery ведёт в общий /store?packaging=open. Полный повтор нужного bundled-рецепта остаётся задачей 1.5, а не объявляется исправленным.
- ModelCatalog/ModelCard.tsx: настройка API спрятана в «Другие действия» и ограничена canHost. ModelDetails.tsx: личный ключ в RemoteProviderAccess; общий endpoint — другой диалог. Эти права должны остаться раздельными.
- services/shared/opencode-local-providers.cjs: AUTH_VERSION=1.14.48; LocalOpenCodeProvidersStep/useLocalProviders и native computer-setup/auth-owner.ts повторяют gate. editor.ts работает с V1 конфигами/auth.json. Отчёт docs/reports/opencode-version-detection-2026-10-30.md подтверждает только detection V2, не credential editing. В нём есть ссылка на отсутствующий раздел 6 tasks bridge-first-local-setup.
- services/catalog-service/src/package-build/source-archive.ts: лимиты 1 МиБ одного файла, 5 МиБ исходников, включая пропущенные. Повышение одной константы не согласует публикацию и transport.
- services/catalog-service/src/devices/device-jobs.ts: claim блокируется любым живым running на устройстве; mcp/neurocenter-asset-sync/src/bridge/worker.ts последовательно await-ит job. Нужно менять обе стороны.
- PackageBuildService: singleton child/activeBuild и глобальный advisory worker lock; package-build.repository.ts recovery прерывает все RUNNING. AssetImportWorker последователен на схему. Это блокеры простого увеличения concurrency.
- Уже отдельные system-role server/device полосы и две локальные MCP-сессии должны сохраниться. Project chat dispatch имеет отдельные ограничения на проект.

## Проверки текущего среза

Реализованы 1.1/1.2 и frontend-часть терминологии 3.1. Независимое read-only review не нашло блокирующих дефектов новых lookup/preview/CAS и переходов; ограничения inline import и recipe recovery сохранены в 1.4/1.5.

- Frontend: 239/239, 16 существующих наборов лексики/источников/импорта/навигации. Отдельный набор переходов и bundled UI: 52/52 до добавления двух тестов платформы/retained draft. Финальный conflict-файл 12/12, с соседними packaging файлами 31/31. Эти перекрывающиеся прогоны не складываются в общий счётчик покрытия.
- Реальный BuildTargetChoice + AntD Select проверен через DOM: darwin-arm64 сохраняется после конфликта и подтверждения. Prepare-link при уже восстановленном чужом draft открывает прежний draft без lookup/submit. Это не проверка IndexedDB/reload в реальном браузере.
- Catalog: 20/20 targeted lookup/publication/name-admission tests; npm run typecheck после изменения PASS.
- Gateway: 15/15 proxy-binary-http, включая реальную HTTP fixture нового lookup с query/ACL. OpenAPI: 32/32, включая nullable result и новый защищённый маршрут.
- OpenSpec strict validation PASS; git diff --check PASS.
- Frontend typecheck проходил на срезе исправлений. Финальный повтор в общей рабочей папке FAIL: параллельный чужой рефакторинг frontend/src/common/components/AsyncButton/AsyncButton.tsx оставил ReactNode неиспользованным и IAsyncButtonProps без импорта. Его три файла не принадлежат этому изменению и не исправлялись. Это текущий незакрытый gate общей сборки, а не зелёная финальная проверка.

Общая реализация плана, desktop на реальном backend, установленный мост, CI и deployment не приняты. Коммит/merge/deploy в этом проходе не выполнялись; чужие исходные untracked и параллельная работа сохранены.

## Повторная локальная интеграция, 31.10.2026

По запросу пользователя проверены и включены последние локальные изменения common/components. Поведение и карты статусов сохранены; восстановлены прежние default RoleRoute и type exports CodeBlock/ConfirmCasModal после выделения интерфейсов. Независимое read-only review обоих срезов: CLEAR_SCOPED.

Проверка на изолированной копии origin/main b81cd2aa с переносом 80 изменённых/новых файлов; исходная папка сверена по SHA256 перед фиксацией. На Node24.22.0: frontend 321/321 (25 файлов), Catalog 20/20 (3 файла), Gateway 15/15 (реальный HTTP fixture), OpenAPI 32/32; всего 388/388, без пропусков. Frontend/Catalog TypeScript PASS; отдельная временная TS-проба прежних экспортов PASS. Прежний блокер AsyncButton больше не воспроизводится.

Официальная isolated-сборка frontend: receipt 92046eae-521d-49ac-be44-7a0dbd73ab63; Catalog: receipt 218993d4-c187-4dfe-9790-33f5c58f1869. Обе built-current-snapshot, primaryFailure=null. Квитанции находятся в .run/isolated-build изолированного worktree catalog-actionable-integration. Strict OpenSpec и git diff --check PASS.

Подготовлена локальная интеграция двух срезов в main без push. Начальные opencode.json, .opencode/package-lock.json и три QA-отчёта сохраняются вне коммитов. Рабочая площадка, установленный мост, browser/CI/deployment в этом проходе не проверялись и не обновлялись. Открытые пункты плана остаются открытыми.

## Восстановление встроенного импорта, 01.11.2026

Срез 1.4 реализован поверх текущего рефакторинга. Координатор разделяет канонический `tool-build-UUID` и `importId`; прежние UUID-квитанции остаются совместимыми. Ссылка импорта читает принятое задание и открывает существующие действия retry/resolve/cancel. Открытие не отправляет POST, другой локальный запрос не заменяется. Смена владельца, ссылки или удаление query отбрасывают позднее чтение.

- Backend: 14 поведенческих тестов coordinator/state; общий прогон с backend 1.5 — 27/27 в пяти наборах. Проверены потерянный ACK и повторный lookup без второго create, запрет admission после неизвестной ошибки lookup, новые/старые/некорректные идентификаторы. TypeScript и ESLint PASS. Последнее уточнение текста очереди импорта проверено отдельно: 6/6.
- Frontend: 14/14 в `catalogRebuildActions` и реальном `useAssetImports` с замокированным API/владельцем. Проверены старые/новые ссылки, read-only открытие, явный retry того же задания, чужой unresolved intent, неверный id, отказ чтения и повтор, смена владельца/ссылки и поздний ответ. Проверка типов production и ESLint без ошибок прошли перед последним узким изменением отмены чтения; финальная общая проверка будет указана отдельно.
- Независимое read-only review backend/frontend не выявило конкретных дефектов. Backend snapshot совпал с проверенным; первый mount страницы проверен по порядку effects, но маршрутизация всей страницы в браузере не доказана этими hook-тестами.
- Локальные raw результаты: `.run/refactor-20261101/p0-14-15-backend-tests.log`, `p0-14-backend-typecheck.log`, `p0-14-backend-lint.log`, `p0-14-copy-tests.log`.

Реальные PostgreSQL/HTTP/IdP, desktop, CI и deployment этим срезом не подтверждены. Пункты 1.3 и 6.2 остаются открытыми.

## Восстановление bundled-сборки, 01.11.2026

Срез 1.5 связывает операцию с точным bundled-рецептом и build id. Backend выдаёт whitelist-проекцию сохранённого запроса без исходных файлов, execution config и старого publication CAS; id цели обновления сохраняется. Frontend восстанавливает pin, имя, описание, tags и платформы, сохраняет чужой/неопределённый журнал, а terminal retry отделён от повтора неизвестного ACK. Перед новой отправкой состояние перечитывается; смена владельца, контекста или флага запрещает поздний submit. Обновление карточки требует нового preview и явного согласия.

- Backend: 13/13 в трёх наборах; TypeScript/ESLint PASS. Проверены safe projection, actor/scope при обогащении операций, fresh role до/после GET и отсутствие записи. Старые/nonbundled операции сохраняют fallback. Право любого действующего главного администратора читать сборку не изменено.
- Frontend: 13/13 в трёх наборах переходов и recovery/retry hooks. Реальные `useToolBuild`, publication/retry hooks и сериализация durable draft, внешние API/IndexedDB замокированы. Проверены source pin/targets, другой журнал, свежий preview/consent, неизвестный ACK с тем же ключом и OFF во время чтения. Финальный TypeScript production PASS; перед последней узкой привязкой draft к контексту source+tests проверка охватила 794 файла без диагностик. ESLint: 0 ошибок, 2 прежних warnings в затронутых файлах.
- Независимое read-only review backend/frontend, включая последнюю привязку retry draft к контексту, не выявило actionable-дефектов. Frontend receipt: `/tmp/neurocenter-recovery-tests.log`; backend: `.run/refactor-20261101/p0-15-backend-tests.log` и общий 27/27 `p0-14-15-backend-tests.log`.

Это локальная приёмка реализации. Интеграция реального маршрута с кнопками в desktop, реальный PostgreSQL/HTTP, CI и deployment остаются отдельными открытыми проверками.

## Явная настройка провайдера, 01.11.2026

Срез 2.1: карточка удалённой модели показывает «Провайдер и API-ключ» вне скрытых действий. Открывается существующий диалог сведений с выделенным блоком личного доступа и отдельной кнопкой общих настроек для главного администратора. Дублирующее действие настройки удалено из вторичного списка и блока хостинга в этом диалоге. Используются прежние редакторы, их права и флаги; новый credential transport не добавлен.

Проверки: 9/9 в двух наборах карточки и реального `ModelProviderSettings` с `RemoteProviderAccess`, personal hook/controller и замокированными внешними API/auth. Участник и администратор открывают нужное действие; наблюдатель не получает личную форму; отсутствующие endpoint/хранилище дают объяснение и чтение повторяется; отказ записи сохраняет ввод и не пишет secret в localStorage; OFF сохраняет сведения и запрещает запись. Открытие формы не вызывает API записи. Независимое read-only review не выявило actionable-дефектов.

Общий frontend прогон P0 1.4/1.5/2.1: 35/35 в шести наборах, `.run/refactor-20261101/p0-frontend-tests.log`; отдельный buildDraftStore тест входит в прежние 13/13 среза 1.5 и не включён в эти 35. Финальный production TypeScript после всех трёх срезов PASS. Desktop/реальный API/платная модель не вызывались.

Пассивная повторная проверка стенда: Catalog `/health` 200, `/ready` 503; его журнал сообщает недоступность PostgreSQL. Docker CLI не подключается: отсутствует socket `.docker/run/docker.sock`; остальные обязательные сервисы и мост недоступны. Работающий Catalog не перезапускался. Это блокирует живую приёмку 1.3/6.2, но не подменяет локальные результаты выше.

## Причины неполного чтения OpenCode, 01.11.2026

Срез 2.2 уточняет контракт в `bridge-first-local-setup` по закреплённым первичным источникам. Локальный CLI наблюдался как 1.19.5; строгий guard редактора 1.14.48 не ослаблен. V2 credential storage отличается от V1-файлов, поэтому чтение прежних файлов не объявляется эффективной авторизацией V2. Полноценный адаптер и его native-проверка остаются в 2.3.

В интерфейсе все 11 известных issue codes получают фиксированные безопасные объяснения. Пустой частичный список не называется отсутствием настроенных провайдеров; описание ручного продолжения соответствует фактическому `canContinue`. Произвольные issue strings не интерполируются.

Проверки: 19/19; production TypeScript PASS; ESLint изменённых файлов и тестов PASS, форматирование и strict OpenSpec PASS. Полный lint этой фичи с `--max-warnings=0` завершился exit1 из-за трёх прежних предупреждений hooks в неизменённых файлах; это не зелёный прогон всей фичи. Независимое read-only review не выявило новых actionable-дефектов. Существующий отдельный controller errorMessage может отображать текст HTTP-ошибки: отсутствие raw messages доказано для нового issue mapping, не для всего экрана. Фактическая утечка секретов не установлена.

Raw результаты: `.run/refactor-20261101/p0-22-tests.log`, `p0-22-typecheck.log`, `p0-22-scoped-lint.log`, `p0-22-openspec.log`; семь source hashes сохранены отдельно. Пользовательские auth/config не читались, глобальный CLI не изменялся.

## Выбор конфигурации и preview, 01.11.2026

Срез 2.4 переиспользует существующий `OpenCodeImportModal`: выбор компьютера, global/project и конкретной записи provider/model. Добавлен отсутствовавший безопасный endpoint preview до импорта. Отображение вынесено в `OpenCodeCandidatePreview`, основной компонент теперь меньше 500 строк. Прежнее обещание настроенного переноса ключей заменено фактическим описанием отдельного личного доступа на сервере; новый transport ключей остаётся задачей 2.5.

Проверки: 7/7 новых frontend сценариев с реальными import/remote connection диалогами и mocked API/bridge; открытие и чтение не вызывают импорт, явная кнопка отправляет выбранный candidate, чужой/устаревший снимок не применяется, failed scan не вызывает callback, failed save сохраняет ручной адрес. 54/54 существующих bridge scanner тестов включают global/project precedence и порядок слоёв V1. Source+tests TypeScript: 806 файлов, 0 диагностик; lint изменённых файлов, форматирование и независимое read-only review PASS.

Raw логи: `/tmp/neurocenter-import-preview-tests.log`, `/tmp/neurocenter-scanner-precedence-tests.log`. Это приёмка поддержанного V1 пути; schemaVersion 2 снимка не означает поддержку CLI V2. Адаптер и реальная V2-приёмка остаются в 2.3. Browser/установленный мост не проверялись.

### 2026-11-01 — P0 2.3: separate V2 stored accounts

- Exact adapter `opencode-v2-accounts`, capability `opencode-v2-accounts-2.2.2`, default-OFF flag; legacy V1 remains separate. Server completion requires the requested adapter and strict metadata-only inventory. READ/history survives write flag OFF.
- Private managed registration is bounded, regular/no-symlink and permission checked. Direct loopback HTTP bypasses environment proxies and redirects; authenticated version/PID plus OS UID/birth and unchanged registration are checked. No borrowed server is started or stopped. Credential values stay inside the native private session.
- Supported mutation is adding an Anthropic API-key account with fixed-ID durable intent. Existing accounts are retained; first-account activation is explicitly explained. Lost ACK reconciles the same ID. A changed registration blocks the old intent; cross-process CAS and effective project/model readiness are not claimed.
- Official CLI2.2.2 archive SHA256 `c1c901a6379d667b7a30a3eea5a8f6e93416dba43e889e834771f6fb174f35c9`: owned HOME/XDG/DB/cwd/stdio fixture, synthetic keys, authenticated401/200, create/duplicate409, preserved active account, unknown ACK and cleanup. Actual production client/editor tested against this CLI. User CLI1.19.5 was not changed.
- Native/scoped57 tests plus actual-page stale-prepare behavioral regression1 PASS; frontend31 PASS; shared contract6 PASS; Catalog8 PASS. Scoped lint/format/typecheck pass. Evidence `.run/opencode-v2-20261101/` including18 source hashes; frontend `/tmp/neurocenter-v2-frontend-tests.log`.
- Independent review found a stale prepare ACK could re-enable saving an old key after input changed. Generation fence fixed it; final read-only delta review has no remaining actionable findings. No real user managed server, browser, deployment or CI acceptance is claimed.

### 2026-11-01 — P0 2.5: explicit personal OpenAI key transfer

- Separate default-OFF `opencode_personal_key_transfer`, capability `opencode-personal-key-v1`, and OPEN job. First supported source: stored OpenAI API key from exact ordinary CLI1.14.48; recipient: selected personal `remote-openai` connection at exact `https://api.openai.com/v1`. OAuth/V2/external references are not reinterpreted. Automatic sync remains credential-free.
- Central UI opens a private window only. Recipient site/API origin, owner/model/endpoint/revisions are shown before explicit confirmation; the key never enters website state, DOM, public job or outbox. Native checks CLI/source/owner again, writes a metadata-only intent, and sends through bounded direct HTTP(S), with remote plaintext/redirect/proxy rejection and fixed errors.
- Catalog reuses personal encryption, CAS and idempotency. Transfer provenance prevents a manual receipt collision and is hidden alongside its internal hash. Device/job locks precede current personal authority; browser `canStartNew` is computed after exclusive job lock and database clock, allowing explicit recovery after expiry without racing an admitted save. Receipt reads remain possible at OFF.
- Gateway forwards only the three exact private routes with TLS checks, no environment proxy, no redirects, and sanitized non-2xx bodies/headers. Actual Nest HTTP fixture confirms200 success and403 refusal using a mocked service, without a database.
- Final focused evidence: Catalog24 PASS, Gateway18 PASS, shared5 PASS in `.run/opencode-personal-key-20261101/`; frontend23 PASS focused and full116/116 across22 files (`.run/refactor-20261101/p0-25-frontend-full.log`); native41 PASS across8 files, including real private journal/outbox, HTTP transport and actual-page behavior (`p0-25-native-tests.log`). Inclusive native test TypeScript and scoped lint pass. Separate V2 pinned native/discovery regression9 PASS (`p0-25-v2-native-regression.log`). Counts overlap and are not summed into coverage.
- Independent review found and fixed two real completion defects: missing V2 adapter identity and an optional expiry being treated as mandatory. Actual journal→outbox regressions reproduced both failures before passing. Gateway review also found resolved non-2xx error-body forwarding and implicit environment proxy; both fixed with behavioral tests. Final review has no remaining actionable findings in this slice.
- PostgreSQL lock scheduling was exercised through controlled DB boundaries, not a real PG server. Native transfer service boundaries were mocked; user CLI and auth were not touched. No actual user key, model call, installed bridge, desktop browser, CI or deployment acceptance is claimed. Tasks1.3/6.2 and external readiness gates remain open.

### Final regression boundary before merging P0

The first full bridge run recorded1889 passed,19 skipped and one failed test in the test-only native JSON capture helper. Its cancellation check returned `NATIVE_CLI_OWNERSHIP_UNKNOWN`; an isolated retry passed, so the failure was investigated instead of being discarded. Controlled owned-process repetitions recorded successful SIGKILL followed by a transient group probe `EPERM`, then `ESRCH` a few milliseconds later. The helper had stopped observing at the first unknown state instead of using its existing drain deadline. The repair keeps observing within that same bound, never signals an unknown owner and never reports cleanup without confirmed absence; a persistent unknown state retains the capture. This is test-infrastructure behavior, not a relaxation of production process ownership.

Final tooling check `.run/check/7599643f-ad6e-498d-ac9a-940425f8425c/report.json`:887 passed,0 failed, source unchanged during the run. Product checks `.run/check/8b9c5356-48f2-43eb-bf7c-21a11b5ef395/report.json`:24/24 with unchanged source. Catalog/Gateway full selected suites85 passed (`8ecade20-7a5a-4f55-a61e-8b81df068f3e`). Eight isolated builds passed with all preservation checks true (`872219de-30fa-4a38-90c8-06649517a918`); subsequent OpenAPI expectation updates passed45 contract tests and do not change runtime artifacts. Test-only process-helper regression results are recorded separately at merge time.

The next full bridge run passed1891 tests with19 skips and exposed a separate test-order race in `agent-method-selected-agent`: the fixture edited its agent file while the check was still running, so production correctly cancelled it before a successful check receipt. The fixture now introduces the edit at the authorization boundary only after the real passed/exit0 receipt is durable. All9 tests and a focused repeat passed; independent review confirmed unchanged production behavior and assertions. The native capture repair separately passed6 tests and35/35 real cancellation repetitions, including4 transient EPERM observations.

A third bridge run passed1890 tests with19 skips and found two assertions in the same MCP cancellation fixture reading a newly created, still-empty PID marker. A controlled empty read reproduced the failure. The test reader now waits for a positive safe-integer PID within the original budget, retries only ENOENT/unfinished content, and preserves the real MCP process and cancellation checks. All5 focused tests, TypeScript, lint and format passed; independent review found no production changes or weakened completion assertions.

Final full bridge rerun completed successfully:161 test files passed,6 skipped;1892 tests passed,19 skipped,0 failed (`.run/refactor-20261101/p0-ready-bridge-all.log`). Skips remain explicit and are not counted as product acceptance. All three test-only race fixes were independently reviewed; production guards and time budgets remain unchanged.

### 2026-11-01 — P1 3.2: supplies inside the catalog

- Default-OFF `catalog_supplies_navigation` exposes the existing global supply UI inside the catalog. Rights remain the intersection of current main role, assets access and store access; project selection grants no additional publication authority. Existing write flags are unchanged.
- Legacy `/assets` redirects with replacement only when the integrated route is available, preserving query values and hash. OFF or assets-only access retains the legacy screen. Embedded project navigation uses `catalogTab`, and supplies suppress project selectors/actions and automatic last-project URL rewriting.
- Actual existing AssetSources is reused with an extracted heading and explicit global scope. Navigation does not submit imports or overwrite saved recovery. Independent review caught a hook below the auth early return; the hook is now unconditional and a real Core/Redux login/logout regression passes.
- 37 behavioral tests across8 files passed; inclusive TypeScript828 files,0 diagnostics; scoped ESLint0 errors,2 pre-existing warnings in unchanged effects; formatting passed. Shared feature-policy119 tests passed. Retained logs/source hashes: `.run/refactor-20261101/p1-32-*`.
- Isolated frontend build `e3e41aca-3d3d-4856-9df4-cc7a42718cfa` passed. Independent review has no remaining actionable findings. No desktop browser, deployment or CI acceptance is claimed; tasks1.3/6.2 remain open.

### 2026-11-01 — P1 3.6: server-facing supply terminology

- User-facing errors, progress and new history notes now use supplies; GitHub release assets remain release files. No machine identifiers, routes, error codes, stored history or policy bounds changed. The source-management flag keeps its key and only changes its display name.
- Independent review of 26 production files and 3 existing tests found no actionable issues. AST comparison confirmed string-literal-only production changes. Gateway 38, skill import 11, runtime 3 and producer/bundled source 33 tests passed; Catalog/Skills TypeScript and scoped lint/format passed. Evidence: `.run/refactor-20261101/p1-supply-*`.
- The retained producer closure was repinned and verified after these reviewed public input changes. No service deployment, live database mutation or browser acceptance is claimed.

### 2026-11-01 — P1 3.3, reviewed source-card slice

- Extracted BundledSourceCard from the large preparation owner without changing its DOM, CSS classes, action order or fresh owner check. A single sourcePlanPreparation helper now supplies delivery eligibility, new/update wording and archived/unavailable handling to the card and rebuild recovery resolver.
- Callers retain their published-result, supported-kind, accepted import/operation and durable-journal priorities. Source revision, published catalog edition, project pin and installation receipt are not collapsed. LocalAssetCards was not forced into a shared wrapper: its metadata and action layout have different responsibilities, with no confirmed duplicate behavior to remove.
- 35 tests passed across 4 files, including the real card with controlled feature availability and callbacks. Inclusive TypeScript 833 files / 0 diagnostics, final production typecheck, formatting and scoped lint passed (2 existing effect warnings retained). Independent review found no actionable issues. Evidence `.run/refactor-20261101/p1-source-cards-*`.
- This closes the confirmed source-preparation duplication. The broader project/computer/manual-conflict/offline acceptance in 3.3 remains open; no browser or deployment claim is made.

### 2026-11-01 — P1 3.5: retain the source draft on archive failure

- The actual ToolPackagingModal regression first failed on the former code: replacing good source files with a rejected archive erased the prior selection. The extracted feature read hook now commits files, archive name and automatic kind/entrypoint reset only after a complete successful read. A failed replacement retains the previous files, manual command, name and kind.
- Read ownership rejects late results after owner/context/source changes, including OFF→ON and close→reopen. Read errors have their own state and are cleared for a new submission; Python handoff feedback belongs to the exact view. The existing upload owner takes over after explicit Python handoff, preserving its durable intent and unknown-ACK recovery. Cancel-on-close/OFF after that handoff is not newly promised or implemented.
- Help distinguishes source archives, standalone ready programs and supply archives with a verified index. It explains existing 1/5/8/10 MiB budgets and keeps the current form open when authorized recipe/import links are used. A user without global source access gets a retry path and an administrator explanation instead of forbidden links. No identity is guessed from a filename and no automatic build/import is sent.
- Targeted frontend 19 tests passed, including 7 actual-modal scenarios with external read/upload boundaries mocked. Full frontend 165/165 across 29 files passed; inclusive TypeScript 838 files / 0 diagnostics and scoped lint/format passed. Seven existing effect warnings remain. Separate 15 actual readSourceArchive tests cover TAR/gzip budget boundaries, ignored files, unsafe paths, links and duplicate paths; ZIP/CRC is not newly covered. Parser limits and production backend code are unchanged.
- Independent frontend and backend reviews are clear. Isolated frontend build `28fd479f-c557-4880-a3a8-b549a6bd6076` passed with all preservation checks. Source hashes/logs and the original RED are retained under `.run/refactor-20261101/p1-archive-*`. No browser, installed bridge, real database, CI or deployment acceptance is claimed.
