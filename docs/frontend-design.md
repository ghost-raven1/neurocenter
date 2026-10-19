# Фронтенд — дизайн-спецификация

Дата: 13 октября 2026. Панель администратора проекта LanceDB-хранилища.

## 1. Стек (зафиксировано)

| Компонент | Версия | Примечание |
| --- | --- | --- |
| React | 18 | Vite-совместимо с Node 16 |
| Vite | 4.x | Node 16.19 совместимость; Vite 5+ требует Node 18 |
| TypeScript | 5.x (strict) | strict, noImplicitAny |
| Redux Toolkit (RTK) | 2.x | createSlice + createAsyncThunk с `extraArgument({ api, socket })` |
| Ant Design | 4.18+ | Без перехода на 5/6 |
| Socket.io-client | 4.x | Live-операции, прогресс |
| axios | 0.26+ | HTTP-клиент, interceptors |
| bem-cn | 1.x | BEM-имена для стилей |
| less | — | Стили |
| react-router-dom | 6.x | SPA роутинг |

Приложение: **отдельное Vite SPA** с проверкой сессии и прав доступа.

## 2. Принципы и конвенции

1. **ABAC**: каждая фича имеет `permissions.ts` с объектом `politics` + ключи вида `key#subkey#action`.
2. **ProtectedRoute**: проверяет `routePermissions` (массив имён маршрутов) из `UserBlock.userInfo`.
3. **Permission**: обёртка, проверяет `permissionKey` в списке прав политики (redux-slice фичи).
4. **UserBlock**: единый redux-slice auth (isAuth, user, roles, routePermissions, per-policy permissions).
5. **BEM**: `bem-cn`, классы `app-header`, `projects-list__item` и т.д.
6. **Импорт**: только относительные пути (`./`, `../`).
7. **Типизация**: `I...` (интерфейсы), `T...` (тип-алиасы), `E...` (enum). Без `any`.
8. **JSDoc**: на русском у каждого компонента и функции.

## 3. Сценарий авторизации (Blitz via BFF)

Бэкенд (NestJS BFF) — OAuth/OIDC resource server для Blitz.
Фронт **не** ходит в Blitz напрямую; BFF инициализирует Authorization Code + PKCE.

| Состояние | Что делает фронт |
| --- | --- |
| Сессия жива (cookie) | `loginWithDomain()` → подгрузка policies + routePermissions → shell |
| Нет сессии | Экран входа: кнопка «Войти через Blitz» → `POST /auth/login/blitz` → 302 на Blitz |
| Callback | Blitz → BFF callback → cookie установлен → `GET /auth/me` → shell |
| 401 от API | `clearState()` → экран входа (или auto-login при доменной сессии) |
| 403 | `NotAllowedPage` |
| Logout | `POST /auth/logout` → `clearState()` → редирект на Blitz-logout / origin |

Header: GlobalSearch + UserBlock (имя, RoleSwitcher = `changeActiveRole`, выход).

## 4. Info Architecture (меню / роуты)

```
Каталог
 ├─ Проекты         (/projects, /projects/:id)
 ├─ Скиллы          (/skills)
 ├─ MCP-пакеты      (/packages)
Операции
 ├─ Передачи/проверки (/operations)
Обслуживание
 ├─ Версии и head   (/versions)
 ├─ Профили релиза  (/profiles)
 ├─ Квоты/retention (/maintenance/quotas)
 ├─ Бэкап/restore   (/maintenance/backup)
 ├─ Аудит          (/audit)
Доступ
 ├─ Мои права       (/access)
```

Каждый модуль — класс с `getRoute()` (массив `<Route>` или `<ProtectedRoute>`) и `getStructure()` (entry для меню: `name`, `route`, `title`, `isHidden`).

## 5. BFF API контракт (предлагаемый — бэкенд не реализован)

### Auth
| Метод | Эндпоинт | Ответ |
| --- | --- | --- |
| POST | /auth/login/blitz | 302 → Blitz authorize URL |
| GET | /auth/callback?code&state | 200 + Set-Cookie (session) |
| GET | /auth/me | `{ user: IUserInfo, routePermissions: string[], policies: Record<string, string[]> }` |
| POST | /auth/logout | `{ redirectUrl?: string }` |
| POST | /auth/switch-role | body `{ role }` → `{ user, routePermissions, policies }` |

### Projects
| Метод | Эндпоинт | Ответ |
| --- | --- | --- |
| GET | /api/projects?page&size&q | `{ items: IProjectSummary[], total, page, size }` |
| GET | /api/projects/:id | `IProjectDetail` |
| POST | /api/projects | body `{ name, externalResourceId, retention, quotas }` → `IProjectDetail` |
| PATCH | /api/projects/:id | body `{ state?, retention?, quotas? }` → `IProjectDetail` |

### Image Versions
| Метод | Эндпоинт | Тело | Ответ |
| --- | --- | --- | --- |
| GET | /api/projects/:id/versions?status | — | `IImageVersion[]` |
| GET | /api/projects/:id/versions/:sid/manifest | — | `ISnapshotManifest` |
| POST | /api/projects/:id/versions/:sid/activate | `{ expectedHeadId, expectedHeadRevision }` | `IHeadUpdateResult` |
| POST | /api/projects/:id/versions/:sid/rollback | `{ expectedHeadId, expectedHeadRevision }` | `IHeadUpdateResult` |
| DELETE | /api/projects/:id/versions/:sid | `{ gracePeriodHours? }` | `{ operationId }` |
| POST | /api/projects/:id/release-profile | `{ snapshotId, skillPins[], expectedProfileId?, expectedProfileRevision?, moveHead? }` | `IProfileReleaseResult` |
| GET | /api/projects/:id/profiles | — | `IProjectProfile[]` |

### Skills
| Метод | Эндпоинт | Примечание |
| --- | --- | --- |
| GET | /api/skills/collections?scope=common\|project&projectId | список коллекций |
| GET | /api/skills?collectionId&q | `ISkill[]` |
| GET | /api/skills/:skillId | `ISkillDetail` (versions, metadata) |
| POST | /api/skills/publish | `{ collectionId, slug, contentHashRef, metadata, expectedVersionId?, expectedVersionRevision? }` |
| POST | /api/skills/collections/:cid/head | `{ skillId, expectedVersionId, expectedVersionRevision }` |
| GET | /api/skills/:skillId/download | `{ downloadUrl, expiresAt }` |

### Operations (transfers/verifications)
| Метод | Эндпоинт | Примечание |
| --- | --- | --- |
| GET | /api/operations?projectId&type&state&page | `IOperation[]` |
| GET | /api/operations/:id | `IOperationDetail` (log, retries, progress) |
| POST | /api/operations/:id/retry | `{}` → `IOperation` |
| POST | /api/operations/:id/cancel | `{}` → `IOperation` |

### Audit
| Метод | Эндпоинт | Примечание |
| --- | --- | --- |
| GET | /api/audit?actor&action&resourceType&from&to&outcome&page | `IAuditEvent[]` |

### Maintenance
| Метод | Эндпоинт | Примечание |
| --- | --- | --- |
| GET | /api/maintenance/storage | summary (used/limit, per-bucket) |
| GET | /api/maintenance/backup | `{ lastBackupAt, backupLag, restoreDrills[] }` |
| POST | /api/maintenance/restore | `{ checkpointId }` → `{ operationId }` |
| PATCH | /api/projects/:id/quotas | `{ currentBytesLimit, retentionBytesLimit, stagingBytesLimit }` |
| PATCH | /api/projects/:id/retention | `{ retentionCount, gracePeriodHours }` |

### Packages (extension)
| Метод | Эндпоинт | Примечание |
| --- | --- | --- |
| GET | /api/packages/collections | list |
| GET | /api/packages?collectionId | `IPackage[]` |
| GET | /api/packages/:id | `IPackageDetail` (variants, manifest) |
| POST | /api/packages/publish | candidate upload |
| POST | /api/packages/collections/:cid/head | head CAS |
| POST | /api/packages/:id/revoke | revoke current |
| GET | /api/packages/:id/download | per platform variant |

### Access / Decisions
| Метод | Эндпоинт | Примечание |
| --- | --- | --- |
| GET | /api/me/decisions?scope=project\|collection\|skill\|package | resolved decisions from external ACL |
| GET | /api/me/external-service-url | URL for deep-link into external ACL admin |

## 6. Socket.io события

| Событие | Payload |
| --- | --- |
| `operation:progress` | `{ operationId, percent, bytesDone, bytesTotal }` |
| `operation:state` | `{ operationId, state }` |
| `version:verified` | `{ projectId, snapshotId }` |
| `version:rejected` | `{ projectId, snapshotId, reason }` |
| `head:moved` | `{ projectId, headId, headRevision, actor }` |
| `profile:published` | `{ projectId, profileId, profileRevision }` |
| `skill:changed` | `{ skillId, collectionId, newHeadVersionId }` |
| `package:changed` | `{ packageId, collectionId, newHeadVersionId }` |

Подключение: cookie-session (same-origin) или short-lived token.
Reconnect → full refetch из API (истина = каталог PG).

## 7. Redux-модули (RTK slices)

| Slice | Что хранит |
| --- | --- |
| `UserBlock` | isAuth, user, userRoles, activeRole, routePermissions, errors, per-policy permissions |
| `Core` | version, config, api error handlers |
| `Projects` | list (pagination/filter), selected project, detail |
| `ProjectsVersions` | versions list, selected version, manifest, loading |
| `ProjectsProfiles` | profiles list, selected profile |
| `Skills` | collections, current collection, skills list, selected skill, versions |
| `Packages` | collections, packages, selected package, variants |
| `Operations` | list (filter by type/state/projectId), selected, progress cache |
| `Audit` | list, filters |
| `Maintenance` | storage summary, backup state, quotas per project |
| `Access` | decisions, external service URL |

Каждый slice: `createSlice` + `createAsyncThunk` c `extraArgument({ api, socket })`.
API-клиент и socket-клиент инжектятся через `configureStore({ middleware: gDM => gDM().concat(thunk.withExtraArgument({ api, socket })) })`.

## 8. ABAC → UI mapping

| UI-элемент | ABAC-действие (contract) |
| --- | --- |
| Просмотр проекта | `project.read` |
| Скачать снимок | `image.download` |
| Опубликовать кандидата (upload) | `image.publish` |
| Активировать / rollback | `image.head.update` |
| Удалить снимок | `image.delete` |
| Скачать скилл | `skill.read` |
| Опубликовать версию скилла | `skill.publish` |
| Управлять коллекцией скиллов | `skill.collection.manage` |
| Создать/изменить профиль релиза | `project.profile.manage` |
| Управление квотами | `quota.manage` |
| Просмотр аудита | `audit.read` |
| Админ-функции (retention, backup, create project) | `platform.admin` |
| Скачать/пакеты | `package.download`, `package.publish`, `package.head.update`, `package.install` |

Permission-ключи в фронтенде (пример): `projects#image-head-update`, `skills#collection-manage`, `maintenance#quota-manage`.

## 9. Экраны: формы и действия

### 9.1 Проекты (list)
- **Таблица**: имя, extResourceId, state, head (snapshotId + date), size, retention, quota (used/limit), active operations, active profile.
- **Тулбар**: поиск, «Создать проект» (`platform.admin`).
- **Форма создания**: name*, externalResourceId*, retention (default 30), quotas (current/retention/staging).
- **Drill-in** (/projects/:id) — Tabs: `Обзор | Версии | Профили | Скиллы | Передачи | Квоты | Аудит`.

### 9.2 Версии (вкладка inside Project + /versions)
- **Таблица**: snapshotId, parent, status, author, created, size, compatibility, is-head, pinned.
- **Действия**: «Манифест» (drawer), «Активировать» / «Rollback» (CAS-диалог), «Скачать», «Удалить».
- **CAS-диалог**: показывает текущий headId/revision, поля expectedHeadId + expectedHeadRevision (pre-filled), confirm.
- **Диалог релизного профиля**: select VERIFIED snapshot + skill pins (table with version selects) + expected profile id/revision + checkbox "move head".

### 9.3 Скиллы (/skills)
- **Tabs**: «Общая коллекция» | «Проектная коллекция» (select project if project scope).
- **Таблица**: slug, owner, state, current version, versions count, size, pinned-in, conflict flag.
- **Действия**: «Скачать», «Управление коллекцией» (head CAS), «Override in profile», «Удалить».
- **Detail (drawer/modal)**: versions timeline (immutable), Markdown preview, metadata.
- **Форма публикации**: collection, slug*, version content (file upload or text), metadata, expectedVersionId/revision.

### 9.4 MCP-пакеты (/packages)
- **Таблица**: name, kind (local/remote/plugin), current version, compatibility, platform variants count, origin, pinned-in.
- **Действия**: «Скачать» (per variant), «Публикация» (candidate), «Head update / rollback», «Revoke», «Управление коллекцией».
- **Detail**: variants table (OS/arch/runtime), manifest hash, size.

### 9.5 Операции (/operations)
- **Таблица**: operationId, type, resource, actor, state, progress %, bytes, started, error.
- **Фильтры**: type, state, projectId.
- **Действия**: «Подробнее» (drawer: log, retries, progress bar), «Retry», «Cancel».
- **Live**: socket updates progress % and state in real-time.

### 9.6 Обслуживание (/maintenance/quotas, /maintenance/backup)
- **Квоты**: per-project table (current/retention/staging used vs limit), form to edit.
- **Retention**: form (retentionCount, gracePeriodHours) + GC candidates preview.
- **Бэкап**: status card (last backup, lag, restore drill date), «Восстановить» (select checkpoint → CAS confirm).
- **Storage**: summary (total used, per-bucket, staging budget).

### 9.7 Аудит (/audit)
- **Таблица** (read-only): time, actor, action, resource type+id, outcome, decision ID, correlation ID.
- **Фильтры**: actor, action type, resource, date range, outcome.

### 9.8 Доступ (/access)
- **Таблица**: scope (project/collection/skill/package), allowed actions, decision ID, policy revision, TTL.
- **Кнопка**: «Открыть во внешнем сервисе» (deep-link).

## 10. Cross-cutting компоненты

| Компонент | Назначение |
| --- | --- |
| `Permission` | Обёртка ABAC |
| `ProtectedRoute` | Проверка routePermissions + Redirect to /not-allowed |
| `NotAllowedPage` | 403 page |
| `NotFoundPage` | 404 page |
| `StatusTag` | Цветной Tag для status (VERIFYING/VERIFIED/REJECTED/RUNNING/SUCCEEDED/...) |
| `AsyncButton` | Кнопка с loading + dispatch thunks |
| `ConfirmCasModal` | Модальное окно для CAS-операций (head update, profile release, rollback) |
| `OperationsProgressDrawer` | Drawer с live-прогрессом операции (socket) |
| `QuotaWarningModal` | Предупреждение при публикации близко к квоте |
| `LoadingManager` / `AsyncLoadManager` | Управление состоянием загрузки |

## 11. Структура кода

```
frontend/
  package.json
  vite.config.ts
  tsconfig.json
  tsconfig.node.json
  index.html
  .gitignore
  src/
    main.tsx
    App.tsx
    store.ts          # configureStore + rootReducer
    configureStore.ts
    vite-env.d.ts
    core/
      api/
        base.ts       # axios instance, interceptors, 401 handler
        bff.ts        # all BFF endpoints (typed)
        index.ts
      socket/
        socketClient.ts # socket.io connection, event registration
        interfaces.ts   # socket event types
      baseRoutes.ts     # route constants
      interfaces.ts     # IModule, shared types
      modules/
        index.ts      # IModule type + registry
    common/
      routes.tsx      # Router component (Switch + modules + not-allowed/not-found)
      components/
        Permission/
        ProtectedRoute/
        NotAllowedPage/
        NotFoundPage/
        StatusTag/
        AsyncButton/
        ConfirmCasModal/
      styles/
        app.less
    features/
      UserBlock/
        index.ts
        UserBlock.tsx
        permissions.ts
        interfaces.ts
        redux/
          actions.ts
          reducers.ts
        components/
          UserInfo/
          RoleSwitcher/
    modules/
      index.ts        # IModule list
      Core/
        index.ts
        Core.tsx      # Layout shell (Header + Sider + Content)
        interfaces.ts
        redux/
          actions.ts
          reducers.ts
      Projects/
        index.ts
        Projects.tsx
        ProjectDetail.tsx
        Permissions.ts
        interfaces.ts
        redux/
          actions.ts
          reducers.ts
      Operations/
        ...
      Skills/
        ...
      Packages/
        ...
      Maintenance/
        ...
      Audit/
        ...
      Access/
        ...
```

## 12. Открытые вопросы

1. Точные BFF-эндпоинты — сверить с реализацией NestJS (контракт выше — предложение).
2. Socket-авторизация: cookie-session vs JWT (зависит от NestJS WS-стратегии).
3. Нужен ли GlobalSearch на старте или отложить.
4. Страница `/profiles` — отдельная или только внутри `/projects/:id` (в текущем IA — вкладки).
5. Тестовая стратегия: использовать Vitest из текущей реализации.

---

## 13. Статус скаффолда — реализовано

Скаффолд `frontend/` создан и проходит `tsc --noEmit` (strict) и `vite build`. `npm install` выполнен.

### Структура (создано)
```
frontend/
├─ config: vite.config.ts (proxy /api /auth /socket.io → :4000), tsconfig*.json (strict), index.html, .gitignore
├─ src/
│  ├─ main.tsx · store.ts (RTK: 8 слайсов) · App.tsx · vite-env.d.ts
│  ├─ types/react-router-dom.d.ts (shim типов для RR v5)
│  ├─ core/
│  │  ├─ interfaces.ts (IRouteDef, IModuleDef, IContentModuleDef) · baseRoutes.ts
│  │  ├─ routes.tsx (routeList, buildMenu, getRouteMeta, findModuleByPath)
│  │  ├─ hooks.ts (useAppDispatch → TRootDispatch)
│  │  ├─ api/ (base axios + bffApi + interfaces: IAuthMe/ITicket/IAccessReview…)
│  │  └─ socket/ (socketClient.io + IOperationProgress/…)
│  ├─ common/components/ (Permission, ProtectedRoute, StatusTag, AsyncButton, ConfirmCasModal, NotAllowed, NotFound)
│  │  └─ utils/format.ts · styles/app.less
│  ├─ features/UserBlock/ (LoginScreen, UserInfo, RoleSwitcher, permissions.ts — единый ABAC, redux)
│  └─ modules/ (index реестр + Core, Projects(+ProjectDetail), Operations, Skills, Packages, Maintenance, Audit, Access; у каждого XxxModule → menu+route, redux слайс)
```

### Ключевые решения
- **Стек:** React 18.3 + Vite 4 (Node 16 — Vite 5 требует Node 18) + **RTK** (не legacy) + AntD4 + react-router-dom **5.x** (`Switch`/`Route render`/`useHistory`).
- **ABAC:** единый источник ключей/политик/route-имён в `features/UserBlock/permissions.ts`; `<Permission>` (UI) и `<ProtectedRoute>` (route) читают `state.userBlock.routePermissions[politicName].routePermissions`; политики централизованы в `state.userBlock.policies`.
- **Типизация dispatch:** в react-redux v9 `Dispatch` приходит из `redux` → аугментация `react-redux` не работает. Ресолшено: `src/core/hooks.ts` — `useAppDispatch: () => TRootDispatch`, компоненты используют его (замена `useDispatch()`).
- **BFF-контракт = источник истины** (бэкенд не реализован): OAuth/PKCE через BFF, cookie-сессия, `GET /auth/me` (user + routePermissions + policies), REST `/api/*`, Socket.io события.
- **MCP:** панель создаёт/активирует/CAS-откат/отзывает; фактический upload/установка — локальный MCP-агент.
- **Конвенции:** без `any`, без spread-пропсов, только относительные импорты, `I`/`T`, JSDoc RU, сложность O(n)/O(log n).

### Ограничения / дальше
- Chunk-size warning (AntD — бандл >500 КБ): позже code-split `manualChunks`/динамические импорты.
- Не покрыто тестами; ESLint-style (import/order) — прогнать перед приёмкой (логика уже тип-безопасна).
- Экраны — рабочие каркасы: формы/диалоги/таблицы подключены к thunks; поведение на живом BFF не проверено.

## 14. Бэкенд-микросервисы (статус)
Архитектура: **NestJS (8.x в mirror, TS 4.9, Node 16)** microservices + docker-compose.

| сервис | порт | роль |
| --- | --- | --- |
| `services/oauth2-bridge` | 22222 | SSO/Blitz login: `/auth/{login,callback,me,logout,switch-role}`, `/health`. In-memory сессии (cookie `bridge_session`), code-flow (PKCE/SPNEGO — делает IdP). `SSO_DISABLE=true` — mock user + широкие policies (dev). |
| `services/api-gateway` | 4000 | Front-facing: `/api/*` → каталог (proxy, сохраняя method/query/body/headers/cookie), `/health`. Дальше: auth-guard, fan-out на микросервисы, WS. |
| `services/catalog-service` | 4100 | Каталог lancedb-storage: 28 mock-эндпоинтов `/api/*` (projects/versions/skills/packages/operations/audit/maintenance/decisions). |

- **Front прокси:** `/auth` → `VITE_AUTH_PROXY_TARGET`(:22222), `/api`+`/socket.io` → `VITE_API_PROXY_TARGET`(:4000).
- **E2E проверено:** bridge login (mock) → cookie → `/auth/me`; gateway→catalog отдаёт mock-данные (`/api/projects`, `/api/skills`, `/api/maintenance/storage`).
- **Auth-guard (сделан, authority=bridge):** решение — делегировать bridge `/auth/me` (200→профиль, 401→401), без short-circuit «нет cookie → 401». В SSO-off bridge всегда 200 → `/api` прозрачен и **после logout** (app не «запирает» на login-форму). Инжект identity: `x-bridge-user-id`/`x-bridge-roles`/`x-bridge-policies`.
- **skills-service (сделан, :4200):** отдельный microservice скиллов; gateway **fan-out**: `/api/skills/**` → skills-service, остальное → catalog-service. Проверено (через gateway 200).
- **WebSocket / real-time (сделан, socket.io на gateway :4000, путь `/socket.io`):** демо-генератор `operation:progress`/`operation:state`; фронт (`Operations.tsx`) получает live-события (подтверждено socket.io-client тестом).
- **Front: «Выйти» (сделан):** SPA `history.push('/')` + best-effort `fetch('/auth/logout')` — без full-reload; в dev остаётся на home (`/`)/проектах, не падает на login-форму (guard authority=bridge).
- **Дальше:** реальные микросервисы под задачи (packages/operations/MCP); реальный lancedb-storage вместо mock в catalog/skills; auth socket-соединений по cookie (prod); реальный Blitz-вход (client + redirect_uri); ESLint во фронте (сейчас нет `.eslintrc`).
