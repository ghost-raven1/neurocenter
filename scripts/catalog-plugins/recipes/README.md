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
- Зависимости RAG закреплены в `../locks/opencode-rag.json`, npm запускается через
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

Для Intel Mac готового комплекта нет: upstream `@lancedb/lancedb@0.29.0` не
публикует `darwin-x64` native пакет. Остальные семь целей комплектуются отдельно.
Отсутствующая платформа должна блокировать установку, без подмены архитектуры.

## Проверка

```sh
node --test scripts/catalog-plugins/recipes/test/recipes.test.mjs
node scripts/catalog-plugins/recipes/test/native-smoke.mjs <rag-directory> <snip-directory> <evidence.json>
```

Native smoke использует временный HOME и loopback fixture эмбеддингов. Он
проверяет настоящий LanceDB, WASM, MCP handshake, создание и повторное обновление
индекса, поиск, границы папки и native snip hook. Это проверка на платформе запуска,
а не свидетельство нативной проверки всех восьми клиентских платформ.
