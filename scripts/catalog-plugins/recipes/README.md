# Автономные комплекты OpenCodeRAG и snip

Сборка выполняется на площадке под Node 24. Мост получает готовый архив с SHA-256,
обычными файлами и закреплённым entrypoint. На компьютере пользователя npm,
curl-install и изменение PATH не требуются.

`prepareOpenCodeRag({target,directory})` и `prepareOpenCodeSnip({target,directory})`
возвращают `{entrypoint,executables?,kind,mode,config,upstream}`. Архивирует и проверяет
комплект общий `../pack.mjs`.

## Закреплённые источники

- [OpenCodeRAG 2.4.4](https://registry.npmjs.org/opencode-rag-plugin/2.4.4), SHA-256 npm tgz:
  `6a21f4e39748394e56400364990f90ae0c9518cf6d16f62623fe664a951358af`.
- [opencode-snip 2.0.0](https://registry.npmjs.org/opencode-snip/2.0.0), SHA-256 npm tgz:
  `d6cf0ccb34bb2edd4641ac4180c502974189c46d656c06847cb19b6b5500b960`.
- [snip CLI 0.25.2](https://github.com/edouard-claude/snip/releases/tag/v0.25.2),
  [официальные SHA-256](https://github.com/edouard-claude/snip/releases/download/v0.25.2/checksums.txt).
  Шесть native архивов покрывают восемь целей: Linux musl использует тот же
  статический Go CLI, собранный upstream с `CGO_ENABLED=0`.
- Зависимости RAG закреплены в `../locks/opencode-rag.json` (MCP) и
  `../locks/opencode-rag-plugin.json` (плагин), npm запускается через
  `ci --ignore-scripts --no-bin-links`; транзитивные integrity проверяет npm.

## Режим OpenCodeRAG

Это MCP с инструментами `search_semantic`, `get_file_skeleton`, `find_usages`,
`index_project`, `get_index_status`. Upstream default plugin требует
[OpenCode V2](https://github.com/MrDoe/OpenCodeRAG/blob/main/doc/plugin.md), а мост
поставляет OpenCode 1.14.48. TUI и автоматические hooks V2 не регистрируются.

URL, модель, протокол Ollama/OpenAI и ключ задаются локальным мастером MCP.
Значения приходят в launcher через `NEUROCENTER_RAG_EMBEDDING_*`; конфиг проекта
и профиль пользователя не переписываются. Код отправляется настроенному
провайдеру только при явном поиске или индексировании. Установка и `listTools`
не запускают индексирование. Индекс создаётся в папке проекта.

Текущая поставка — `2.4.4-mcp.pack.4`. Для [локальной модели проекта](../../../docs/local-embedding.md)
адаптер ограничивает embedding до одного фрагмента и одного запроса одновременно,
с таймаутом 120 секунд. Другие подключения сохраняют прежние параметры.

Для Intel Mac готового комплекта нет: upstream `@lancedb/lancedb@0.29.0` не
публикует `darwin-x64` native пакет. Остальные семь целей комплектуются отдельно.
Отсутствующая платформа должна блокировать установку, без подмены архитектуры.

## Родной плагин OpenCodeRAG

Отдельный рецепт `opencode-rag-plugin` создаёт карточку **OpenCodeRAG (плагин)**,
не заменяя MCP. Источник — [MrDoe/OpenCodeRAG, commit 4fb269c6](https://github.com/MrDoe/OpenCodeRAG/tree/4fb269c6f23a99701c7ac70fcc3f3e483c9f13ff).
Опубликованный npm `2.4.4` имеет тот же `gitHead`; архив и транзитивные зависимости
проверяются по закреплённым SHA/integrity. В provenance записаны полный commit,
версия SDK `@opencode-ai/plugin@1.14.48` и применённая совместимость.

Это upstream-фабрика `dist/plugin.js`: инструменты, память и hooks работают внутри
OpenCode 1.14.48. Точка входа V2 `dist/plugin-entry.js` и TUI не загружаются.
Поддерживаются те же семь платформ, что у MCP. GitHub-источник с этим точным commit
и `src/plugin.ts` использует тот же подготовленный адаптер общего builder.

Для проекта без `opencode-rag.json` настройки применяются в памяти: локальная
`qwen3-embedding:4b` через `http://127.0.0.1:11435/api`, таймаут 120 секунд,
размерность 2560, один фрагмент и один запрос одновременно, автоиндексация включена.
Известная размерность исключает запрос к модели при инициализации пустого проекта;
индексирование и поиск обращаются к настроенному провайдеру.
Description, image, decision и reranking отключены до явной настройки моделей.
Существующий конфиг и его ключи сохраняются, включая выбор модели и автоиндексации;
для указанной локальной CPU-модели применяется ограничение нагрузки.
Автообновление upstream отключено всегда: обновления идут закреплёнными версиями
каталога. Адаптер не создаёт конфиг и запрещает upstream сохранять в него
автоматически определённую размерность. Проверки размера и типов upstream-файла
останавливают сборку, если известные точки адаптации изменились.

Текущая ревизия `2.4.4-plugin.pack.3` также отличает HTTP-отказ эмбеддингов и несовместимую
размерность индекса от пустого результата поиска. Ответ провайдера и локальные
пути не включаются в сообщение инструмента; upstream HTTP-журнал отключён, чтобы
не записывать содержимое ответа с чувствительными данными.

```sh
node scripts/catalog-plugins/prepare.mjs --output .run/rag-plugin-ready --only opencode-rag-plugin
node --test scripts/catalog-plugins/recipes/test/rag-plugin.test.mjs
```

## Проверка

```sh
node --test scripts/catalog-plugins/recipes/test/recipes.test.mjs
node --test scripts/catalog-plugins/recipes/test/rag-local-runtime.test.mjs
node scripts/catalog-plugins/recipes/test/native-smoke.mjs <rag-directory> <snip-directory> <evidence.json>
node scripts/embedding/smoke-rag.mjs --package <rag-directory>
```

Native smoke использует временный HOME и loopback fixture эмбеддингов. Он
проверяет настоящий LanceDB, WASM, MCP handshake, создание и повторное обновление
индекса, поиск, границы папки и native snip hook. Это проверка на платформе запуска,
а не свидетельство нативной проверки всех восьми клиентских платформ.
