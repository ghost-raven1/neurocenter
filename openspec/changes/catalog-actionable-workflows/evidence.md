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
