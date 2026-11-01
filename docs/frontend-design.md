# Фронтенд: структура и владельцы

Фронтенд — Vite SPA на React и TypeScript. Текущие зависимости и команды определены в [package.json](../frontend/package.json): Ant Design, Redux Toolkit, React Router 5, Socket.IO и Less. Общая смена библиотеки компонентов или хранилища состояния не входит в рефакторинг модулей.

## Структура

- [core/routes.tsx](../frontend/src/core/routes.tsx) связывает страницы и маршруты.
- [core/api](../frontend/src/core/api) содержит HTTP-клиент и контракты общего BFF; API конкретной фичи остаётся в её каталоге.
- [core/socket](../frontend/src/core/socket) отвечает за общий транспорт событий.
- [store.ts](../frontend/src/store.ts) собирает Redux slices. Локальные черновики и состояние компонентов остаются у своего владельца.
- [common/components](../frontend/src/common/components) содержит переиспользуемые элементы интерфейса, [features](../frontend/src/features) — функциональные модули, [modules](../frontend/src/modules) — страницы и их текущую композицию.

Для изменяемого компонента используется структура:

```text
AgentCard/
  AgentCard.tsx
  interfaces.ts
  constants.ts
  AgentCard.less
  tests/
    AgentCard.test.tsx
```

`utils.ts` добавляется, когда есть собственная вспомогательная логика; пустые файлы ради шаблона не создаются. Типы и интерфейсы с одним владельцем находятся у него. Общие контракты остаются на уровне фичи. `interfaces.ts` не выполняет runtime-логику: значения вынесены в `constants.ts`, функции — в `utils.ts` или существующий модуль по смыслу. Для отдельных модулей используются имена `api.interfaces.ts`, `controller.interfaces.ts` и подобные.

[AgentCard](../frontend/src/features/AgentCatalog/AgentCard/AgentCard.tsx) показывает эту структуру. Общие стили редакторов агентов находятся в [agentEditor.less](../frontend/src/features/AgentCatalog/agentEditor.less), а стили карточки — в [AgentCard.less](../frontend/src/features/AgentCatalog/AgentCard/AgentCard.less). Less группирует элементы и состояния внутри блока; перенос не должен менять specificity и порядок перекрывающихся правил. Глобальные токены и общие стили находятся в [common/styles](../frontend/src/common/styles).

## Поведение

Права и флаги проверяются отдельно. [FeatureAvailability](../frontend/src/features/FeatureFlags/FeatureAvailability.tsx) ограничивает новые действия при выключенной или неизвестной функции; история, отмена и восстановление сохраняют свои правила доступа. Сервер остаётся владельцем окончательного решения.

Асинхронные формы используют текущего владельца запроса через [useAuthRequestOwner](../frontend/src/features/UserBlock/hooks/useAuthRequestOwner.ts). После смены пользователя, роли или проекта поздний ответ не должен менять чужое состояние. Ошибка сохраняет введённое и даёт явный повтор; неизвестное состояние не отображается как успешное.

Перед созданием общего компонента или helper проверьте существующие реализации. Совпадающее поведение переиспользуется; похожие названия с разными правилами доступа, нормализации или восстановления не объединяются автоматически.

## Проверка

Команды lint/format, соглашения `tests/` и `integration/test/`, политика mocks и критерии поведенческих тестов определены в [единой инструкции](service-eslint.md). Проверки DOM подтверждают доступные действия, блокировки и callbacks нашего компонента; они не заменяют браузерную приёмку.

[Спецификация 13 октября 2026 года](history/frontend-design-2026-10-13.md) сохранена как история проектирования. Её версии стека, предлагаемые API и статус скаффолда не являются текущей инструкцией.
