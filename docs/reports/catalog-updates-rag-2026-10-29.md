# Предложения обновления и OpenCodeRAG 2.12.2

## Реализованное поведение

Каталог проекта показывает отдельно общую редакцию, project pin и квитанцию выбранной папки. Сводки инструментов и агентов раскрывают новые редакции; фильтр сохраняет pending/error/recovery и неподтверждённое удаление. Неизвестный каталог или legacy/другая binding не выдаются за подтверждённую текущую версию. Установка закреплённой редакции сохраняет нейтральное название при локальной редакции выше pin. Обновления по-прежнему требуют явных действующих прав/флагов, CAS, плана и выбранного моста.

RAG recipes закреплены на npm2.12.2 с Git commit `5f71c3ef708ba0c632b40be53b7c07ec2b8ba843`, archive SHA-256 `a92207b01fa04df1ac4df45ead1f8bbca3e556b38f002e6dd94902ec09d609ee`, MCP/plugin `2.12.2-*.pack.1`. Добавлены только достижимые static dependencies `@clickhouse/client@1.24.1` и `fflate@0.8.3`; остальные locked entries не менялись.

Управляемая фабрика адаптирована для нового live config/embedder/store и обеих promotion веток. Whole-source guard проверяет Quirk JSONL до native startup, pipeline и upstream reader. Повреждённые bytes не переписываются и не пропускаются. Валидный `deletedAt` входит в общий хеш, но не становится опытом и не удаляет уже утверждённые серверные знания. Старый проверенный2.4.4 source marker разрешён для истории. Retained producer closure включает новый guard и shared parser (135 точных файлов).

## Проверено на 2026-10-29

- Frontend full TypeScript `tsc --noEmit`:PASS на Node24.22.0 (heap1536MiB); scope — весь текущий shared frontend.
- Frontend: 184/184 tests, 12 targeted/affected files, Node24.15.0, single worker. Включены rendered AgentCatalog, pending removal, unknown/current binding, несовпадение manifest, scope/ownership и карточки.
- RAG helper/hosted/profile/plugin/UI/Quirk Node contracts:118/118 PASS на Node24.22.0.
- Prepared source/recipe contracts:25/25 PASS, включая изолированное восстановление producer, closure и неизменность corrupt journal. Первый проход24/25 выявил отсутствующий Quirk-reader fixture; после дополнения реальной новой границы повторный проход25/25.
- Catalog Quirk/publication contracts:39/39 PASS, single worker.
- Настоящий npm2.12.2 tarball получен с официального registry; exact patch contracts применены к его dist bytes, syntax пяти изменённых actual modules PASS.

## Native и реальный host archive

На macOS ARM64, Node24.22.0 и точном OpenCode1.14.48 пройдены:

- Настоящий OpenCode:6hooks/9tools, WASM skeleton, system transform, real LanceDB auto-index/reindex/search, HTTP401/503/dimension errors без повторов/утечки, пустой проект2560 без startup model call, byte-preserved JSON, registry0/external0.
- Native profile:смена модели той же размерности, partial-failure с побайтно прежними LanceDB/manifest, безопасный повтор и presence при autoIndex=false/reload/close —5checks PASS.
- Настоящий Web UI/API и реально выдаваемый Dashboard:auth, no inference on status, progress/conflict, complete/failed status, config redaction/preservation и actual rendered component —10checks PASS, process exit0.
- Настоящий MCP:initialize/listTools без модели, WASM, path/symlink boundary, index/search/repeat/error/config —11checks PASS.
- Actual upstream Quirk/StateSync:corrupt late line/invalid candidate/central hydrate/flush/tombstone —4cases PASS, model/store/keyword/central writes0.
- Actual factory/native index:global provider + project overrides, live keyone→keytwo без рестарта, сохранённые JSON и corrupt late Quirk startup со всеми прежними index file SHA неизменными —5checks PASS.

Official builder создал два host envelopes со стабильными external IDs и retained producer135files. Их настоящие архивы проверены и извлечены в собственную папку; MCP и plugin/OpenCode сценарии повторены на извлечённых bytes с PASS. Никакого изменения пользовательского профиля, Primary, main DB или публикации в серверный каталог этими проверками не было.

| ID | Поставка | Host archive SHA-256 | Compressed bytes |
| --- | --- | --- | ---: |
| mcp-opencode-rag |2.12.2-mcp.pack.1|5d38b1bf53c928464f67c0df5561c458e1d62c102c98216f9ac9504ba752f851|102778009|
| plugin-opencode-rag-plugin |2.12.2-plugin.pack.1|b6f7446904fc688b5d330e455ed41c5ac70b39623664b64bcd0b9ae855322ff8|112552125|

Исходные evidence находятся в `.run/rag-2.12.2-native-8c9a4586-2b7f-46e6-affc-72b409a821fc/`:plugin-native.json,profile-native.json,ui-native.log,mcp-native.json,quirks-native.json,packed-mcp-native.json,packed-plugin-native.json,packed-live-config-native.json. Полные собственные profiles удалены harness после проверок; производные host archives остаются в current-host для следующей приёмки.

## Открытые ворота

Проверена только macOS ARM64. Новая версия рецепта и успешный host archive не означают, что текущий серверный каталог, установленный пользовательский bridge или plugin runtime уже обновлены. Общая сборка frontend, desktop proposals→план→обновление через мост, реальный импорт/публикация, CI и deployment требуют отдельных свидетельств.

Current-only перенос source/metadata из основного Git ещё реализуется. Запрет обязательного старого asset repository/GitHub Releases и автоматических model weights остаётся условием приёмки; прежнее внешнее хранилище этим срезом не удалялось.
