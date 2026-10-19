# MCP-плагины: хранение, сборка, one-click

## Текущая модель

Каталог хранит: `files: [{path, content}]` (исходники или dist).
`install` → копирование в `.opencode/plugins/<slug>/` + запись `opencode.json`:

```json
{ "mcp": { "<name>": { "command": ["node", "path/to/entry.js"] } } }
```

`opencode` спавнит stdio MCP-процесс локально. Сборки при установке **НЕТ**.

## Предлагаемая модель (source-in-archive + backend)

Каталог хранит: исходники (`package.json`, `src/`, `tsconfig`).

При установке/обновлении:

1. Скачать source из каталога → `/opt/plugins/<slug>/`
2. `npm install && npm run build` (tsc/esbuild) → `dist/`
3. Запустить как backend-сервис (`node dist/index.js`, порт N)
4. api-gateway проксирует: `/mcp/<slug>/* → localhost:N`

### Проблема one-click

Сборка (`npm install` + `build`) = 10–60 сек (зависимости, сеть, registry).
Это **НЕ one-click** — пользователь ждёт.

## Решение: сборка при publish, не при install

### Публикация (admin)

1. Admin загружает source в каталог
2. Каталог запускает сборку (CI/онлайн-build): `npm i && npm run build`
3. В каталог сохраняется: `dist/` (pre-built) + `source/` (для ревью)
4. В meta: `{ buildId, nodeVersion, deps, bundleSize }`

### Установка (one-click)

1. Скачать `dist/` из каталога → `/opt/plugins/<slug>/dist/`
2. Зарегистрировать в `opencode.json` (`command = [node, dist/index.js]`)
3. (Опц.) Запустить как сервис + зарегистрировать в api-gateway
4. Готово за **1–2 сек** (просто копия файлов)

### Обновление версии

1. Admin публикует v2 → сборка в каталоге
2. В проекте: `activate_bundle_version(plugin, v2)`
3. Подхватывается новая `dist/` (или рестарт процесса)

## Где запускать MCP

| Вариант              | Когда подходит                    | One-click |
|----------------------|-----------------------------------|-----------|
| stdio (локально)     | dev, single-user                  | да        |
| backend-сервис       | prod, multi-user, shared          | да (dist) |
| proxy через gateway  | prod, единая точка входа          | да (dist) |

- **Для dev**: stdio (текущая модель, работает).
- **Для prod**: backend + gateway (pre-built dist в каталоге).

## Вывод

- Хранить в каталоге: **source** (для версионирования/ревью) + **dist** (для запуска).
- Сбирать **при publish**, не при install.
- **One-click** = копирование pre-built dist + регистрация конфига.
- api-gateway проксирование — опциональный слой для prod, не влияет на one-click.
- Текущий `installPluginBundle` уже близок к этому — нужно добавить поле `dist/` в бандл.
