---
title: 'Neurocenter — DESIGN.md (как продукт выглядит)'
status: draft
created: '2026-11-09'
owner: UX (Sally)
sources:
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md (NFR-1, NFR-3, FR-901)
  - _bmad-output/initiative-architecture/tickets/epic-pilot/epic-pilot.md (entry UI-polish + UX-спека)
  - frontend/src/ (аудит по факту кода, 2026-11-09)
---

# DESIGN.md — дизайн-система по факту + план полировки

Спека для entry «UI-polish + UX-спека» (первый entry epic-pilot). Всё ниже описано **по факту текущего кода**
`frontend/src/` (панель за nginx, React 18 + Ant Design 4.24), а не по идеалу. Контрактные ссылки:
PRD NFR-1 «Простота», NFR-3 «Нет тупиковых сценариев», FR-901 (4 роли, менее привилегированная ограничивает
интерфейс), Success Metrics «Удобство и отзывы».

## 1. Технологическая база (что реально есть)

| Слой | Факт | Где |
|---|---|---|
| UI-кит | Ant Design **4.24** (`antd/dist/antd.less`), локаль `ru_RU` | `frontend/src/App.tsx:6`, `frontend/src/main.tsx:10-28` |
| Темизация | Только через LESS: `modifyVars` antd в vite-конфиге (`primary-color: @brand-primary` и т.д.) + `additionalData` с brand.less во все .less. **Нет** объекта `theme` у `ConfigProvider`, тёмной темы и runtime-переключения нет | `frontend/vite.config.ts:74-104`, `frontend/src/main.tsx:28` |
| Маркировка | BEM через `bem-cn`; классы вида `.app__*`, `.user-info__*` | `frontend/src/App.tsx:1`, `frontend/src/modules/Core/Core.tsx:146-153` |
| Состояние | Redux Toolkit (userBlock, projects, operations, skills, rag, maintenance, audit, access) | `frontend/src/store.ts:12-21` |
| Реалтайм | socket.io client; события «будят» перечитывание REST (`useSectionUpdates`) | `frontend/src/core/socket/socketClient.ts`, `frontend/src/core/socket/hooks/useSectionUpdates.ts` |
| Ленивые разделы | каждый модуль — `lazySection()` (React.lazy + Suspense + ErrorBoundary на секцию) | `frontend/src/common/components/LazySection/LazySection.tsx:41-74`, модули: `frontend/src/modules/*/​*Module.tsx` |
| Ошибки API | axios-инстанс, 401 → `unauthorizedHandler` → `signOut`; `errorMessage()` — единый читатель server-message | `frontend/src/core/api/base.ts:46-61`, `frontend/src/common/utils/errorMessage.ts` |
| Флаги возможностей | feature flags с причиной отключения (`FeatureButton` — disabled + tooltip; `FeatureAvailabilityNotice` — Alert + «Проверить») | `frontend/src/features/FeatureFlags/FeatureAvailability.tsx:65-118` |
| Права | три механизма: ABAC `Permission` (render null), RBAC `RoleRoute`/`roleCan` (redirect в `/not-allowed`), `routePermissions` (фильтр навигации) | `frontend/src/common/components/Permission/Permission.tsx:13-26`, `frontend/src/common/components/RoleRoute/RoleRoute.tsx:18-34`, `frontend/src/features/UserBlock/permissions.ts`, `frontend/src/features/UserBlock/roles.ts` |

## 2. Инвентарь текущей дизайн-системы (по факту)

### 2.1 Палитра

**Brand-токены** (единственный официальный источник, 11 переменных) — `frontend/src/common/styles/brand.less`:

| Токен | Значение | Назначение по факту |
|---|---|---|
| `@brand-primary` | `#3f5f7f` | primary-кнопки, ссылки, акценты (маппинг `primary-color`) |
| `@brand-hover` / `@brand-active` | `#5d768c` / `#283f59` | hover/active primary |
| `@brand-focus` | `#547699` | outline `:focus-visible` (3px) — `frontend/src/common/styles/app.less:23-26` |
| `@brand-tint..tint-3` | `#eef3f8 / #dce6f0 / #c0d0e0` | фоны-подсветки, info-алерты |
| `@brand-border(-hover)` | `#d3dfea / #9db5cb` | границы |
| `@brand-on-dark` / `@brand-selected` | `#c0d2e4 / #2d4660` | текст/выделение на тёмном сайдбаре |
| `@brand-surface` | `#f6f8fb` | поверхности |

**Базовые цвета** (hardcoded, дублируют/расширяют токены):

- Текст: `#24344a` (body, `app.less:14` + `text-color` в modifyVars), заголовки `#14283d` (`heading-color`).
- Фон приложения: `#f4f7fa` (body и workspace, `app.less:15`, `Core.less:3,76`).
- Сайдбар: `#14283d` (тёмный), текст меню `#b9c9d9`, hover `#fff`, выделение `@brand-selected` (`Core.less:8,53-65`).
- Шапка: `rgba(255,255,255,.96)`, граница `#e5ebf0`, высота 76px (64px <992px, `Core.less:78-91`).
- Карточки: border `#e3eaf0`, radius 12px, лёгкая тень; modal radius 14px (`app.less:32-40,84-87`).
- Таблицы: thead `#f6f8fa`/`#546577` 12px/600, таблица 13px (`app.less:51-60`).

**Проблема: вторая, «серая» палитра из hardcoded hex.** По коду — 30+ разных hex-значений, много близких
дублей (полный список: `grep -rhoE '#[0-9a-fA-F]{6}' frontend/src | sort | uniq -c`):

- Поверхности: `#f4f7fa`, `#f5f7fa`, `#f4f6f9`, `#f4f8fc`, `#f6f8fb`, `#fbfcfe`, `#f7f9fc`, `#f6f9fc`.
- Границы: `#e5ebf0`, `#e5eaf0`, `#e2e8f0`, `#e3eaf0`, `#dce5ed`, `#e8eef4`, `#dce4ec`.
- Серый вторичный текст: `#617387` — **51 вхождение** по коду; официально закреплён только как `!important`-
  переопределение `.ant-typography-secondary` (`app.less:75-77`), токена в brand.less нет.
- `#1677ff` (синий по умолчанию AntD v5) — 5 вхождений **вместо** `@brand-primary` (см. §3, п.2).

### 2.2 Типографика

- Шрифт: **не задан явно** — дефолтный стек AntD (system-ui/PingFang/Microsoft YaHei); только
  `-webkit-font-smoothing: antialiased` (`app.less:13-17`). Кастомного font-stack нет ни в index.html, ни в less.
- Заголовок страницы: 28px / 1.25 / letter-spacing −0.7px, 24px на <575px — единый `PageHeading`
  (`app.less:93-113`, `frontend/src/common/components/PageHeading.tsx`) — H1 + secondary-описание (max 680px) + actions.
- Таблицы 13px, thead 12px/600; secondary-текст 12–13px в местах вручную.
- Monospace — **4 разных стека** (см. §3, п.4): `ui-monospace, SFMono-Regular, Menlo` (AgentDefinitionFields,
  ProjectLearning), `'SF Mono', 'Consolas'` (Store.less:279), `ui-monospace, SFMono-Regular, Consolas` (Help,
  Operations), `monospace` (RetiredRagDatabases.less:150).
- Код: две готовые темы CodeBlock — `codeblock-dark.css` / `codeblock-light.css`
  (`frontend/src/common/styles/`).

### 2.3 Layout (оболочка Core)

- Сайдбар 248px, sticky, тёмный: бренд (BrandMark 43px + «Нейроцентр» 20px + подзаголовок 10px), меню,
  нижняя нота «Инструменты, знания и проекты…» + опциональная ссылка «Мониторинг моделей»
  (только если задан `VITE_MODEL_MONITOR_URL`, `Core.tsx:46-57,175-184`).
- Шапка 76px sticky: хлебные крошки «Рабочее пространство / <раздел>» слева; справа 5 контролов:
  `ComputerHeader`, `ProjectTargetSelect` (скрыт, пока нет проектов), `OperationsButton` (badge + прогресс),
  `ChatLauncher` (Чат), `UserInfo` (dropdown: роль-переключатель, уведомления, выход) — `Core.tsx:188-213`.
- Контент: padding 32px (20px <992px, 16/12px <575px), max-width 1500px по центру (`Core.less:133-140`).
- Мобильный (<992px): сайдбар → drawer 280px (тёмный), бургер в шапке (`Core.tsx:190-198,241-255`).
- Доступность каркаса: skip-link «Перейти к содержимому» (`Core.tsx:168-170`), `#main-content` с
  `tabIndex={-1}`, `:focus-visible` 3px outline, aria-label на иконочных кнопках, возврат фокуса после
  закрытия drawer/menus через `queueMicrotask` (`Core.tsx:80-89,261-267`).

### 2.4 Навигация

- Группы: «Начало работы» (top-level), «Работа» (Проекты, Базы знаний), «Ресурсы» (Каталог, Поставка),
  «Управление» (Обслуживание, История действий, Использование моделей, Участники и доступ, Настройки),
  «Справка» (Помощь + внешний «Swagger API» `/api/docs`) — `frontend/src/features/AppNavigation/model.ts:3-41`.
- Пункт виден, только если роль имеет routePermission (`Core.tsx:129-132`); один раскрытый раздел за раз
  (аккордеон) — `AppNavigation.tsx:33-36`.
- Маршруты: `/`, `/start`, `/projects`, `/projects/:id`, `/store`, `/assets`, `/rag`, `/maintenance`,
  `/audit`, `/model-usage`, `/access`, `/settings`, `/help`, 403 `/not-allowed`, 404 `*` —
  `frontend/src/core/baseRoutes.ts`. `/` → redirect в `/start` (`routes.tsx:43-45`).

### 2.5 Компоненты (репертуар по факту)

| Паттерн | Где | Поведение |
|---|---|---|
| `PageHeading` | common | H1 + описание + actions; единая иерархия страниц |
| `StatusTag` | `common/components/StatusTag/` | **единственная объявленная карта статусов** — 16 статусов → цвет/подпись AntD Tag (`constants.ts`): VERIFYING/VERIFIED/REJECTED, QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED/CONFLICT, ACTIVE/ARCHIVED/LOCKED, PUBLISHED/DEPRECATED, DELETING/DELETED |
| Alert + action | 102 файла с `type="error"` | канонический pattern: message + description + Button «Повторить»/ссылка (пример: `Projects.tsx:320-343`, `OperationsQueue.tsx:186-203`) |
| Result | `NotFoundPage` (404), `NotAllowedPage` (403), `ProjectDetail` (404/403/ошибка загрузки) | status + title + subTitle + extra-кнопки; в 403/404 кнопки «К проектам» (в NotAllowedPage — hardcoded `'/projects'`, не `baseRoutes`) |
| Empty + CTA | Store (`Store.tsx:1186-1210`), OperationsQueue (`:103-128`), Help, ProjectLearning, CatalogRequests… | описание ситуации + действие («Сбросить фильтры», «Показать все операции») |
| Spin / Skeleton | 58 файлов с `<Spin>`; Skeleton в ProjectSnapshots | лоадинг секций; fallback lazy-секции: «Загружаем раздел «X»…» (`LazySection.tsx:60-65`) |
| Steps | `UnifiedProjectSetup` (6 шагов мастера) | Мост → OpenCode → Провайдеры → Папка проекта → Агенты и инструменты → Проверка; шаг сохраняется в URL (`?setup&step=N`) |
| Drawer | `AccessibleDrawer` (мобильное меню, операции, детали операции) | возврат фокуса на триггер после закрытия |
| Modal | AntD 4; критичные — с `closable=false` в процессе (BridgePairing, picker-модалка Store) | подтверждение удаления — `Modal.confirm` (ProjectDetail.tsx:262-295, отказ onOk держит модалку открытой для повтора) |
| `AsyncButton` | common | кнопка с loading для асинхронных действий |
| Toasts | `message.success/error` — 20 вхождений | только короткие подтверждения/ошибки действий (создание/удаление проекта и т.п.) |
| `LazySectionBoundary` | common | ошибка загрузки/рендера **секции**: «Не удалось открыть раздел… Перезагрузить страницу» (`LazySection.tsx:21-38`) |
| Feature-уведомления | `FeatureAvailabilityNotice` / `FeatureButton` | отключённое действие с причиной + «Проверить» |

### 2.6 Паттерны состояний (законодательство de facto)

1. **Ошибка чтения** → inline Alert (error/warning) + «Повторить»; при устаревших данных — «показаны
   предыдущие данные» (`Projects.tsx:325-331`).
2. **401** → глобальный `signOut()` (интерцептор, только если владелец запроса = текущий пользователь,
   `base.ts:49-56`) → LoginScreen. **Без объяснения причины** (state сбрасывается в initialState с `error: ''`,
   `reducers.ts:26,50-57`).
3. **403 на `authInit`** → LoginScreen с «Доступ к рабочему пространству не подтверждён. Обратитесь к
   администратору.» (`reducers.ts:55`).
4. **Сессия не подтверждена (сервер недоступен при авторизованном пользователе)** → banner над контентом:
   «Не удалось проверить доступ» + «Повторить проверку доступа» (`Core.tsx:218-235`, `reducers.ts:61-64`).
5. **Empty** → `Empty`/`Table.locale.emptyText` с текстом ситуации (в лучших местах — с CTA, не везде).
6. **Долгие операции** → глобальная «Операции» (drawer + очередь): badge с числом/процентом в шапке, таблица
   с прогрессом, retry/cancel через CAS (`requestKey` + `expectedDigest`, `bff.ts:153-174`), deep-link
   `?operations=open` (`Core.tsx:78-89`).
7. **Отказ в доступе** → три разных механизма (ABAC/RBAC/routePermissions), три разных визуальных результата:
   скрытие (null), redirect 403, disabled+tooltip.

## 3. Противоречия и нестыковки (по факту кода)

**Топ-5 противоречий дизайн-системы** (конкретика для фикса):

1. **Две параллельные палитры.** Brand-токены (11 переменных) vs 30+ hardcoded hex с близкими дублями
   (поверхности `#f4f7fa/#f5f7fa/#f4f6f9/#f4f8fc/#f6f8fb/#fbfcfe`; границы `#e5ebf0/#e5eaf0/#e2e8f0/#e3eaf0`).
   Вторичный серый `#617387` — 51 вхождение, токена нет (закреплен `!important` в `app.less:75-77`). Итог:
   «один и тот же» серый фон на разных страницах отличается на 1–2 пункта, новые цвета добавляются мимо токенов.
2. **Чужой accent-цвет `#1677ff`** (default AntD v5, не brand-палитра `#3f5f7f`) на видных элементах:
   `features/FeatureFlags/FeatureFlags.less:50` (фон), `modules/Store/Store.less:290,293` (ссылки/статусы на
   главной витрине), `modules/Projects/components/SemanticRag.tsx:170,191` (inline-стили статусов RAG:
   `#1677ff/#64748b/#faad14`). На одной странице Store соседствуют brand-синие ссылки (modifyVars
   `link-color: @brand-primary`) и `#1677ff`.
3. **Статусы показаны не через StatusTag.** В `StatusTag/constants.ts` объявлена «единая карта статусов всего
   приложения», но модули рисуют собственные цвета: `RagSyncStatus.tsx:23-28` (hardcoded `#3d6082`/`#ad6800`),
   `SemanticRag.tsx:170-191` (hardcoded), `Access.tsx` (прямой `Tag` со своими цветами), `LocalInstallations`
   и `BridgeDevicesManager` — свои стили статуса. Один и тот же «ошибка/внимание» — три-четыре разных цвета.
4. **Monospace: 4 разных стека** для одного сémантического роли (ID, команды, хэши):
   `AgentDefinitionFields.less:3` и `ProjectLearning.less:247` (`ui-monospace, SFMono-Regular, Menlo`),
   `Store.less:279` (`'SF Mono', 'Consolas'`), `Help.less:54` и `Operations.less:54`
   (`ui-monospace, SFMono-Regular, Consolas`), `RetiredRagDatabases.less:150` (`monospace`). На разных экранах
   SHA/команды выглядят по-разному.
5. **Разный уровень защиты от падения рендера (NFR-3).** Boundary есть только на ленивых секциях
   (`LazySectionBoundary`); **глобального ErrorBoundary нет** — ошибка рендера в оболочке Core (шапка,
   навигация, socket, UserInfo) = белый экран без единого actionable-сообщения. При этом у секций и у
   модулей recovery-тексты разные («Не удалось открыть раздел…» vs «Не удалось загрузить проект…» vs Alert с
   «Повторить») — нарушение единообразия actionable-ошибок.

**Дополнительные нестыковки** (для бэклога полировки):

6. «Нет доступа» выражено тремя способами: `Permission` рендерит `null` (акция просто исчезает,
   `Permission.tsx:21-23`), `RoleRoute`/`ProtectedRoute` → `/not-allowed` (общий текст без указания, какое
   право нужно), `FeatureButton` → disabled + tooltip с причиной. FR-901 требует, чтобы менее привилегированная
   роль ограничивала интерфейс — сейчас ограничение есть, но **непоследовательно объяснённое**.
7. **Login-screen flash при каждом перезаходе.** `isAuth` начинается с `false`, `authInit` стартует в
   `useEffect` после первого рендера (`Core.tsx:95-97`) — авторизованный пользователь при каждом F5 сначала
   видит экран входа («Войти в Нейроцентр»), и лишь после `GET /auth/me` — приложение. Выглядит как logout;
   лишний шаг в каждом core-сценарии (NFR-1).
8. **Месседжинг без политики**: 20 `message.error` (toasts) против канона «inline Alert с action». Тост
   «Не удалось удалить проект» (`Projects.tsx:135`) — без причины и без следующего шага (NFR-3: actionable).
9. `!important` — 21 вхождение в less (ProjectLearning ×4, Discussions ×2, Core ×2, Maintenance ×2 и др.).
10. Шапка: 5 контролов правее (компьютер, проект, операции, чат, пользователь) + хлебные крошки — плотная
    композиция; на <575px подписи скрываются (`Core.less:200-215`), остаётся иконки без видимой подсказки
    (есть только aria-label/tooltip).
11. `NotAllowedPage` использует hardcoded `'/projects'` (`NotAllowedPage.tsx:20`), а `NotFoundPage` —
    `baseRoutes.projects` — мелкая, но реальная рассинхронизация маршрутов.
12. Навигация для главного админа = 11 пунктов + 4 группы; «Управление» (5 пунктов) для пилотного
    разработчика неприменима, но механизм показа/скрытия — только routePermissions (фильтр), без
    ролевого «прогрессивного раскрытия» (см. EXPERIENCE.md §4).

## 4. Цели полировки (приоритизованный список; каждый пункт = задача для разработчика)

**P0 — контракт пилота (NFR-1/NFR-3, до приёмки):**

1. **Глобальный ErrorBoundary** в `App.tsx` (поверх Core): «Что-то пошло не так» + идентификатор ошибки +
   «Перезагрузить страницу» (+ опц. «Скопировать для оператора»). Критерий: любой render-error не даёт
   белого экрана (закрывает §3.5; e2e — EXPERIENCE.md, сценарий D13).
2. **Убрать login-screen flash**: пока `authInit` pending — показывать нейтральный splash «Проверяем
   сессию…» (Skeleton шапки/содержимого), а не LoginScreen. LoginScreen — только при подтверждённом 401/403
   (закрывает §3.7; e2e — D10).
3. **Повод на LoginScreen после вылета 401**: при `signOut` по 401 (интерцептор `base.ts`) сохранять причину
   («Сессия завершилась — войдите снова» / «Доступ отозван») и показывать её в Alert на LoginScreen (закрывает
   §2.6 п.2; e2e — D3).
4. **Единый actionable-топ ошибок**: аудит 20 `message.error` — в контексте экрана переводить в inline Alert
   с причиной + «Повторить» (канон уже есть: `Projects.tsx:320-343`); toast оставлять только для коротких
   подтверждений успеха/неуспеха действия. Критерий: ни одна error-строка не без следующего шага (NFR-3).
5. **403-страница с причиной**: `NotAllowedPage` и `Result 403` в ProjectDetail добавлять, какое право/роль
   нужно и куда идти («Попросите у администратора проекта право «Управление проектом»»); заменить
   hardcoded `'/projects'` на `baseRoutes` (§3.6, §3.11; FR-901).

**P1 — консистентность системы (закрепить перед приёмкой, не блокирует):**

6. **Токенизация палитры**: добавить в `brand.less` токены для вторичного текста (`@brand-text-secondary:
   #617387`), поверхностей и границ (выбрать из дублей: `#f4f7fa`, `#e5ebf0`, `#e3eaf0`); заменить все
   hardcoded hex в less/tsx на токены; убрать `!important` из `app.less:75-77`. Добавить lint-правило
   (eslint/no-restricted-syntax для hex в .tsx) — критерий: `grep hex` в src = 0 вне brand.less/codeblock-тем.
7. **Убрать `#1677ff`** (5 мест, §3.2): заменить на `@brand-primary`/`@brand-tint`/`@brand-border-hover`;
   inline-стили в `SemanticRag.tsx` вынести в less с токенами.
8. **StatusTag — единственный способ показать статус**: мигрировать `RagSyncStatus`, `SemanticRag`,
   `Access`, `LocalInstallations`, `BridgeDevicesManager` на `StatusTag` (новые коды — только в
   `StatusTag/constants.ts`); запретить прямой `Tag color=...` для статусов (lint-правило + код-ревью).
9. **Один monospace-токен** `@font-mono` в `brand.less` (выбрать `ui-monospace, SFMono-Regular, Menlo,
   Consolas, monospace`), заменить 4 стека.
10. **Один recovery-текст lazy-секций**: `LazySectionBoundary` + модульные Result 404/403/ошибка — единый
    шаблон «что случилось → следующий шаг» (задать фразу в `common/utils` и переиспользовать).

**P2 — NFR-1 «Простота» (ядро без документации, меньше шагов):**

11. **Первый экран `/start`**: один primary-CTA со стабильным смыслом. Сейчас label зависит от флага и
    состояния: «Начать настройку» / «Проверить OpenCode» / «Посмотреть состояние и настройку»
    (`UnifiedProjectSetup.tsx:186-198`) — три разных primary. Закрепить: «Начать настройку» всегда;
    состояние-зависимая надпись — secondary-подпись под кнопкой.
12. **Progressive disclosure шапки**: на первом входе (нет проектов, нет компьютера) показать максимум 3
    контрола; `ComputerHeader` и `ProjectTargetSelect` раскрывать по мере готовности (детальнее —
    EXPERIENCE.md §4). Критерий NFR-1: число шагов «вход → первая полезная операция» ≤ 4 (см. EXPERIENCE.md §6).
13. **Empty-state с CTA для каждого роли**: «Создайте серверный проект или попросите администратора…»
    (`Projects.tsx:365`) и «В каталог проекта ещё не добавлены инструменты» (`Store.tsx:1196`) — добавить
    per-role CTA (ссылка на Помощь/чат с системным агентом) — критерий: ни один empty-state без следующего
    шага (NFR-3).

## 5. Правила (конвенции, которые закрепляем)

1. **Цвет**: новый цвет = новая переменная в `brand.less` с семантическим именем; hex в компонентах —
   запрещён (lint). Семантические статусы — только через `StatusTag`.
2. **Типографика**: страницы начинают с `PageHeading` (H1 28px); monospace — только `@font-mono`; размеры
   12/13/14/16/20/28 — не расширять без ревью.
3. **Ошибки**: каждое error-состояние = сообщение + причина + следующий шаг (кнопка/ссылка). Читатель
   server-message — только `errorMessage()` (`common/utils/errorMessage.ts`). Молчалиных `catch` в UI нет.
4. **Пустые состояния**: `Empty`/`emptyText` с объяснением ситуации и CTA; «нет данных» ≠ «ошибка
   загрузки» (разные формулировки, как в `Projects.tsx:361-366`).
5. **Новые разделы** — только через `lazySection()` (даёт boundary + loading-фолбэк) и регистрацию в
   `modules/index.ts` + `baseRoutes.ts` + `sections` в `AppNavigation/model.ts`.
6. **Права**: доступ к разделу — `RoleRoute`/`ProtectedRoute`; доступ к действию — `Permission`/RBAC
   `roleCan`/`FeatureButton`; скрытое из-за прав действие не должно появляться «наполовину» (disabled
   с причиной предпочтительнее полного исчезновения для ключевых действий — см. EXPERIENCE.md §5).
7. **Фидбек операций**: любая долгая мутация регистрируется в «Операции» (очередь в шапке); UI-действие
   без progress-индикатора допустимо только < ~2 c.
8. **Доступность**: skip-link и focus-management (возврат фокуса) — сохранить; новые модальные поверхности —
   через `AccessibleDrawer`/AntD с `aria-label`; иконные кнопки — с видимой подсказкой (tooltip) или подписью.
9. **Состояние в URL**: навигационные состояния (проект `?p`, вкладка `?tab`, мастер `?setup&step`, операции
   `?operations=open`, pairing `?connect`) — только в query-строке, чтобы survive перезагрузку/рестарт стека.
10. **Язык интерфейса**: русский (локаль ru_RU); новые строки — по канону существующих (глагол действия на
    кнопках, состояние в описаниях).
