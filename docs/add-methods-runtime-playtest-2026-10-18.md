# Плейтест runtime и release — 18 октября 2026

Проверены **8/8 изолированных сценариев** через общий `buildRecipe` и настоящий жизненный цикл моста. Использовались подготовленные stdio MCP fixtures, реальные интерпретаторы и скомпилированные программы. Сводка с SHA, descriptors и путями готовых комплектов: [summary.json](../output/playwright/neurocenter-add-methods/runtime/summary.json).

| Вариант | Target | Где выполнялся MCP | Результат |
| --- | --- | --- | --- |
| Python | `linux-arm64-glibc` | Linux arm64, Docker | PASS |
| Java, исправленный launcher | `linux-arm64-glibc` | Linux arm64, Docker | PASS |
| .NET | `linux-arm64-glibc` | Linux arm64, Docker | PASS |
| Native C | `darwin-arm64` | Нативно на macOS arm64 | PASS |
| Go | `darwin-arm64` | Нативно на macOS arm64 | PASS |
| Rust | `darwin-arm64` | Нативно на macOS arm64 | PASS |
| Release TAR.GZ | `darwin-arm64` | Нативно на macOS arm64 | PASS |
| Release ZIP | `darwin-arm64` | Нативно на macOS arm64 | PASS |

Для каждого варианта выполнены `initialize`, `tools/list` и `tools/call` командой из фактически установленного `opencode.jsonc`. Проверены установка, состояние `checked`, повторная установка без изменений, однократная загрузка архива с повторным использованием кэша, удаление и повторное удаление, сохранность личного JSONC и завершение дочерних процессов. Во время этих проверок сеть была отключена. Свидетельства: [macOS, 5/5](../output/playwright/neurocenter-add-methods/runtime/lifecycle-host.json), [Linux-контейнер, 3/3](../output/playwright/neurocenter-add-methods/runtime/lifecycle-container.json).

Go 1.24.0 и rustc 1.88.0 действительно скомпилировали отдельные Mach-O arm64 программы. Это не алиасы C fixture. Закреплённые официальные архивы компиляторов проверены по SHA до выполнения; системная установка и изменение PATH не требовались: [компиляция](../output/playwright/neurocenter-add-methods/runtime/native-compilation.json), [происхождение компиляторов](../output/playwright/neurocenter-add-methods/runtime/official-toolchains.json).

## Исправления с RED/GREEN

- **Java UTF-8.** Настоящий Java MCP при ASCII locale возвращал `?` вместо кириллицы: [RED](../output/playwright/neurocenter-add-methods/runtime/managed-lifecycle-java-encoding-red.log), [диагностика JVM](../output/playwright/neurocenter-add-methods/runtime/java-charset-settings.log). Launcher теперь задаёт `file.encoding`, `stdout.encoding` и `stderr.encoding` в UTF-8. Повторный реальный вызов вернул `Java: автономный MCP add-methods`: [GREEN](../output/playwright/neurocenter-add-methods/runtime/lifecycle-container.json).
- **Описание release.** Настоящий native release ошибочно получал подпись JavaScript/Node: [RED](../output/playwright/neurocenter-add-methods/runtime/release-metadata-red.log). Метаданные теперь определяются явным типом источника: «Готовая поставка релиза для целевой платформы». Исправленные TAR.GZ и ZIP прошли общий builder и MCP lifecycle: [GREEN](../output/playwright/neurocenter-add-methods/runtime/summary.json).

Регрессионные проверки `build.test.mjs` и `runtime-source.test.mjs`: **26/26, без пропусков** — [лог](../output/playwright/neurocenter-add-methods/runtime/builder-tests-final.log). Исторические RED комплекты сохранены; актуальные случаи имеют суффикс `-fixed`. Неудачный unit RED Java был перекрыт ошибкой cleanup, поэтому первичным доказательством дефекта служит реальный MCP ответ выше.

## Отказ при повреждении SHA

В настоящем закреплённом native TAR.GZ изменён один байт. Общий builder отклонил SHA-256 до создания готового комплекта. `ready.json`, staging, кэш и build lock после отказа отсутствуют: [negative-sha.json](../output/playwright/neurocenter-add-methods/runtime/negative-sha.json).

## Границы проверки

- `runtime` и `release` упаковывают подготовленное приложение и, при необходимости, runtime выбранной платформы. Произвольный ZIP с исходниками не становится готовым MCP автоматически. Для репозитория другого языка нужен поддерживаемый manifest/recipe с подготовленными app/runtime assets; компиляция выполнялась отдельно до общего builder.
- Managed runtime и release assets поступали из локального закреплённого кэша. Настоящий downloader повторно проверял SHA и размер, но **публичная HTTPS доставка этих assets не проверялась**. Отдельная загрузка официальных компиляторов этого покрытия не заменяет.
- Linux-контейнер подтверждает только исполнение Linux arm64. Нативные Windows, x64, Linux musl и managed macOS в эту матрицу не входят.
- .NET fixture использует `InvariantGlobalization`; ICU, globalization и SSL функции приложения не проверялись. Наличие bundled runtime не доказывает наличие всех системных библиотек для произвольного приложения.
- Это простые настоящие MCP fixtures, а не проверка всех функций сторонних расширений. Публичный каталог, глобальный профиль и рабочие проекты не изменялись. Дополнительные подсказки для интерфейса: [ui-notes.json](../output/playwright/neurocenter-add-methods/runtime/ui-notes.json).

## Очистка

Удалены только временные компиляторы, их кэш, архивы и части загрузок этого прогона: **1 537 558 498 логических байт, около 1,43 GiB**. Готовые комплекты, descriptors, provenance, fixtures, официальные метаданные и историческая QA сохранены. После проверки не осталось собственных контейнеров и временных профилей. Повторный MCP lifecycle использует сохранённые комплекты; для повторной компиляции Go/Rust потребуется загрузка по сохранённым SHA: [toolchain-cleanup.json](../output/playwright/neurocenter-add-methods/runtime/toolchain-cleanup.json).
