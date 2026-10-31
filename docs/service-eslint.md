# ESLint и форматирование серверных сервисов и моста

Используйте проектный Node 24 и установленные зависимости каждого пакета (`npm ci`).

```sh
# Все восемь пакетов, включая существующий frontend:
npm run lint

# Один сервис через workspace runner с отчётом .run/check:
npm run check -- --package catalog-service --step lint

# Из папки конкретного сервиса или mcp/neurocenter-asset-sync:
npm run lint
npm run lint:fix
npm run format
npm run format:check
```

Обычный `npm run check` теперь выполняет lint и format:check перед typecheck, build и test. Селектор `--step lint` доступен и в контрактах dev-MCP; чтение старых отчётов сохраняется. Уже открытый MCP-клиент сам по себе новую схему инструментов не получает.

Каждый из шести сервисов в `services/` и мост имеет собственные devDependencies и `eslint.config.mjs`. Версии согласованы с frontend: ESLint 10.13.0, `@eslint/js` 10.0.1, `typescript-eslint` 8.72.0. Конфиги импортируют общую политику из `scripts/lint/service-rules.mjs`; запуск предполагает checkout репозитория, как существующие сборки сервисов. Старый конфиг Airbnb/ESLint 7 моста удалён. Изменений версий runtime-зависимостей для настройки lint не требуется.

Область backend-проверки — `src/**/*.ts`, включая объявления типов. Сгенерированный `dist`, зависимости, тесты и общие `services/shared/*.cjs` в этот lint не входят; их прежние отдельные проверки сохраняются. Список явно проверяемых исходников не зависит от текущего каталога shell при использовании package scripts.

Используются рекомендованные правила JavaScript и TypeScript без правил форматирования и без type-aware lint. TypeScript продолжает отдельно проверять типы и имена. Backend lint завершается ошибкой при любом предупреждении (`--max-warnings=0`). Frontend сохраняет прежний режим, включая предупреждения зависимостей React hooks.

Исключения общей политики:

- `no-undef` выключен только в TypeScript-конфигурации: разрешением имён занимается tsc.
- `no-control-regex` выключен для валидаторов запрещённых управляющих байтов.
- `preserve-caught-error` выключен: публичная ошибка намеренно не включает потенциально чувствительную причину.
- Пустой `catch` допустим для best-effort очистки; пустые обычные блоки запрещены.
- `no-require-imports` выключен для поддерживаемых Node CommonJS/optional зависимостей.
- Неиспользуемые параметры с `_` и исключаемые rest-свойства допустимы. Обычные неиспользуемые переменные, явный `any` и ненужные suppressions остаются ошибками.

Критичные существующие `throw` в `finally` сохраняются с точечным подавлением и причиной рядом с кодом: сбой очистки или durable receipt может намеренно отменять успешный результат. Эти исключения не отключают правило для других функций.

`scripts/test/service-eslint.test.mjs` загружает реальный конфиг каждого пакета и проверяет допустимый NestJS/TypeScript, отклонение `any`, unused variable, unsafe finally и лишнего suppression, а также исключение generated output.

Документация: [typescript-eslint quickstart](https://typescript-eslint.io/getting-started/), [no-undef для TypeScript](https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors).

## Форматирование

Prettier 3.9.10 закреплён в каждом backend-пакете. Общий `.prettierrc.json`: 4 пробела, одинарные кавычки, ширина 120, точки с запятой, trailing commas и LF. Область — те же `src/**/*.ts`; frontend и тесты массово не форматируются.

Из корня `npm run format` форматирует все семь backend-пакетов, `npm run format:check` только проверяет их и сохраняет отчёт. Проверка frontend пропускается, поскольку там нет этого script. Обычный `check` и dev-MCP выполняют только read-only `format:check`; изменяющий файлы `format` запускается явно.

Форматирование проверяется через Prettier `--debug-check` (устойчивость и эквивалентность AST). Для проверки BigInt используется временный JSON serializer только в процессе debug-check; в код приложения он не входит. Две цепочки вызовов требуют второго прохода Prettier для стабильной раскладки. ESLint отвечает за корректность, Prettier — за стиль; плагины, запускающие форматтер внутри ESLint, не нужны.
