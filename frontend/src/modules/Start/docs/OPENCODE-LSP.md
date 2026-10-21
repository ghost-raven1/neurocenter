# LSP в OpenCode

LSP (Language Server Protocol) передаёт агенту диагностику языкового сервера. Это встроенная возможность OpenCode; отдельный MCP для неё не нужен. Поддержка языка зависит от версии OpenCode, зависимостей проекта и установленного сервера. [Официальная справка LSP](https://opencode.ai/docs/lsp/).

## Подготовка TypeScript-проекта

В папке `example-project` установите зависимости обычным для проекта способом. При наличии `package-lock.json`:

```sh
cd ~/projects/example-project
npm ci
```

Убедитесь, что проект содержит зависимость `typescript`. Проверьте требования языкового сервера к Node.js.

## Включение

Проверьте версию командой `opencode --version`. В [OpenCode 1.3.2](https://github.com/anomalyco/opencode/blob/v1.3.2/packages/opencode/src/lsp/index.ts#L74-L94) встроенные серверы включены по умолчанию, а в [1.14.48](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/lsp/lsp.ts#L148-L189) требуется явное включение. Пустой объект `lsp` поддерживают обе версии; значение `true` версия 1.3.2 не принимает. Контракты: [1.3.2](https://github.com/anomalyco/opencode/blob/v1.3.2/packages/opencode/src/config/config.ts#L1094-L1128), [1.14.48](https://github.com/anomalyco/opencode/blob/v1.14.48/packages/opencode/src/config/lsp.ts).

Добавьте в существующую конфигурацию `opencode.json` или `opencode.jsonc`, сохранив другие настройки:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "lsp": {}
}
```

Перезапустите OpenCode и откройте исходный файл. При выполненных требованиях соответствующий сервер активируется по расширению файла.

Для явного TypeScript-сервера можно настроить команду доступного вам исполняемого файла:

```json
{
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
    }
  }
}
```

Команда должна быть доступна среде, из которой запущен OpenCode. Параметры и способы установки сервера смотрите в [репозитории typescript-language-server](https://github.com/typescript-language-server/typescript-language-server).

## Навигационный инструмент агента

В OpenCode 1.3.2 диагностика и инструмент `lsp` включаются отдельно. Для перехода к определению, поиска ссылок и других операций агента запустите OpenCode с флагом:

```sh
OPENCODE_EXPERIMENTAL_LSP_TOOL=1 opencode
```

Для постоянного включения задайте эту переменную в среде своего способа запуска OpenCode. Сохраните существующие ограничения `permission.lsp`: они управляют доступом к инструменту. В более новой версии сначала проверьте её контракт; флаг выше относится к 1.3.2. [Реестр инструментов 1.3.2](https://github.com/anomalyco/opencode/blob/v1.3.2/packages/opencode/src/tool/registry.ts#L124).

## Проверка

Из папки проекта можно получить диагностику файла без вызова модели:

```sh
opencode debug lsp diagnostics /absolute/path/to/example.ts
```

Проверяйте сервер на отдельном тестовом файле с известной ошибкой. Пустой результат диагностики сам по себе не подтверждает запуск сервера. В OpenCode 1.3.2 отдельная команда `debug lsp document-symbols` не открывает документ перед запросом и может вернуть пустой список. Навигацию проверяйте инструментом `lsp` на известном символе: он открывает файл перед обращением к серверу. [Реализация команды 1.3.2](https://github.com/anomalyco/opencode/blob/v1.3.2/packages/opencode/src/cli/cmd/debug/lsp.ts#L38-L47), [инструмент агента](https://github.com/anomalyco/opencode/blob/v1.3.2/packages/opencode/src/tool/lsp.ts#L51-L66).

| Симптом | Что проверить |
| --- | --- |
| LSP отключён | Прочитана ли нужная конфигурация; перезапущена ли сессия |
| Сервер не запускается | Команда сервера, PATH и требования к Node.js |
| TypeScript не найден | Установлены ли зависимости в нужной папке проекта |
| Диагностики пока нет | Прочитан ли исходный файл; завершён ли анализ проекта |

Языковой сервер работает отдельным процессом. Некоторые встроенные интеграции скачивают серверы автоматически; это можно отключить через `OPENCODE_DISABLE_LSP_DOWNLOAD=true`. Сетевое поведение конкретного сервера проверяйте отдельно.

Для отключения задайте и перезапустите OpenCode:

```json
{
  "lsp": false
}
```

Для воспроизводимой проверки ошибок используйте также команды typecheck и lint самого проекта.
