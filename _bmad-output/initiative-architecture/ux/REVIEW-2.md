# REVIEW-2 — UX-аудит Neurocenter (2-й независимый проход)

Аудитор: независимый второй ревьюер (read-only). База: `/home/region.cbr.ru/69starodubtsevae/projects/neurocenter` (frontend: React 18 + AntD 4.24 + Less; nginx-шлюз prod).
Метод: статический анализ по 6 линзам + точечные grep + ручной расчёт контраста (WCAG 1.4.3 relative luminance). **Каждое file:line проверено открытием файла на момент написания**; контрасты посчитаны вручную по hex (точность ±0.1).

## Сводка

| Линза | P0 | P1 | P2 | Итого |
|---|---|---|---|---|
| A11y (контраст/скринридеры/адаптив) | 0 | 2 | 0 | 2 |
| Мобайл и планшет (360–1023px) | 0 | 0 | 1 | 1 |
| Строки / i18n / консистентность | 0 | 0 | 4 | 4 |
| UI-безопасность | 0 | 0 | 0 | 0 (чисто) |
| Производительность | 0 | 0 | 2 | 2 |
| Ошибки и границы | 1 | 2 | 1 | 4 |
| **Итого** | **1** | **4** | **7** | **12** |

---

## 1. A11y (контраст / скринридеры / адаптив)

| # | Severity | file:line | Что | Почему бьёт | Fix / e2e-ассерт |
|---|---|---|---|---|---|
| A1 | P1 | `frontend/src/features/UserBlock/LoginScreen.less:110-115, 134-138, 139-146, 156-160` (+ `68-73`) | Мелкий текст экрана входа не проходит WCAG AA 4.5:1 на карточке `fade(#fff,88%)` над `#f4f7fa` (≈#FDFDFE): карточный параграф 13px `#728195` ≈**3.9:1** (110-115); kicker 11px `#7c8b9b` ≈**3.4:1** (134-138); hint «Вы перейдёте на страницу входа организации» 11px `#8794a2` ≈**3.1:1** (139-146); футер 11px `#8a98a6` ≈**2.9:1** (156-160); hero-параграф 15px `#687b8f` на `#f4f7fa` ≈**4.1:1** (68-73) | Это объясняющие строки экрана входа — именно по ним пользователь понимает, что происходит при ошибке SSO/429, и что вход ведёт через организацию. Слабовидящие и пожилые пользователи их не читают; при rate-limit (см. E3) это единственная человеческая строка до raw-страницы nginx | Поднять цвета: body-текст ≥ `#5a6b7d`, микро-текст ≥ `#5f7183` (≈4.8:1 на карточке) для всех 5 мест. E2e: axe `color-contrast` на `/auth/login` = 0 нарушений |
| A2 | P1 | `frontend/src/features/ComputerSetup/ComputerHeader.less:43-49` + `frontend/src/modules/Store/ProjectTargetSelect.less:23-26` | Мелкий текст шапки приложения: статус компьютера и время CLI **10px** `#758697` на чипе `#f8fafc` = **3.58:1** (ComputerHeader.less:45-46); плейсхолдер селектора проекта **12px** `#758697` на `#f8fafc` = **3.58:1** (ProjectTargetSelect.less:25). Порог AA для ≤18pt — 4.5:1 | Статус «в сети / был в …» — основная информация чипа «Компьютер» в шапке, 10px; плейсхолдер «выберите проект» виден до первого выбора. Оба — постоянный UI, не редкие состояния | Заменить `#758697` в обоих местах на ≥ `#5f7183` (4.8:1 на `#f8fafc`). E2e: axe `color-contrast` на главной = 0 |

### Что чисто (a11y)
- Skip-link `Core.tsx:168-170` (`<a className="app__skip" href="#main-content">`) + off-screen-до-фокус стили `Core.less:144-156` — работает.
- **95** `role="status"` live-регионов (grep по `src/`) — статусы операций/загрузок читаются скринридером.
- **474** `aria-` атрибута; иконки-кнопки подписаны (например, `Core.tsx:195` `aria-label="Открыть меню"`, `ProjectChatMessages.tsx:126,272,286`).
- `prefers-reduced-motion`: `ChatPresentation.less:89`, `OperationsButton.less:89`, `NeuralBackdrop.less:94`; hover-анимации гейтятся `CardDepth.less:1` (`hover:hover` + `no-preference`).
- Контраст sidebar (тёмный `#14283d`): бренд-подпись 10px `#a8bacd` ≈**7.5:1**, пункты меню `#b9c9d9` ≈**6.7:1**, ноты `#9db0c3` ≈**5.9:1** — все OK.
- Login hero h1 `span` `#6b849c` ≈3.6:1 — но это крупный текст (38–54px, weight 600), порог AA large text 3:1 — проходит.
- `@brand-primary` в `#f4f7fa`/белом — ≥6:1 (OK).

---

## 2. Мобайл и планшет (360–1023px)

| # | Severity | file:line | Что | Почему бьёт | Fix / e2e-ассерт |
|---|---|---|---|---|---|
| M1 | P2 | **29 модальных окон/drawers с фиксированной шириной 600–1000px без `max-width` у корня класса**. Проверено: глобальный clamp `app.less:157-159` (`.ant-modal { max-width: calc(100vw - 24px) }`) действует **только ≤575px**, а корневые `max-width` есть лишь у `.model-chat` (ModelChat.less:1-2), `.model-chat-preview` (:865-866), `.model-details` (ModelCatalog.less:318-319), `.store-details` (StoreDetailsModal.less:1-2), `.project-chat-panel` (ProjectChat.less:524-525), `.learning-editor` (ProjectLearning.less:204-205), `.agent-editor` (agentEditor.less:1-2), `.agent-trial` (AgentTrialModal.less:1-2), `.provider-setup` (ProviderSetup.less:1-2), `.bridge-computers` (BridgeDevicesManager.less:1-2), `.learning-details` drawer (ProjectLearning.less:190-193). Не закрыты: `SystemRoleModal.tsx:171` (1000), `SystemRoleOperation.tsx:90` (1000), `HelpEditor.tsx:121` (980), `ChatSemanticSearchPanel.tsx:226` (860), `StoreEditModal.tsx:261` (860), `ProjectChatWorkflowDialog.tsx:30` (860), `AttachmentPreview.tsx:36` (800), `RepairInstallationModal.tsx:125` (780), `LocalVariantsModal.tsx:264` (780), `StoreCreateModal.tsx:129` (760), `AdoptInstallationModal.tsx:197` (760), `InstallPlanModal.tsx:272` (720), `InstallPlanFailureModal.tsx:22` (720), `SkillEditorModal.tsx:125` (720), `LearningAnalysisModal.tsx:39` (720), `RuntimeProbeModal.tsx:174` (720), `AccessGrantModal.tsx:312` (700), `ToolPackagingModal.tsx:784` (680), `OpenCodeImportModal.tsx:242` (680), `LearningQuirksImportModal.tsx:185` (680), `RequestFormModal.tsx:247` (640), `OpenCodeModelSyncSettings.tsx:161` (640), `ProviderAccessModal.tsx:32` (640), `WorkspaceBindingWizard.tsx:49` (640), `McpConfigurationModal.tsx:186` (640), `RemoteConnectionModal.tsx:146` (620), `RequestActions.tsx:249` (600), `ModelEditModal.tsx:76` (600), `GgufImportModal.tsx:67` (600) | На tablet-portrait (576–1023px) окно шире viewport: на 768px переливаются все модальки 760–1000px (10 из списка), на 576–639px — почти все. AntD-модалька центрируется, правый край уезжает за экран — футерные кнопки (у AntD right-aligned) и правая часть формы невидимы/недоступны | Глобально: добавить в `app.less` блок `@media (min-width: 576px) and (max-width: 1023px) { .ant-modal { max-width: calc(100vw - 24px); } }` (аналог существующего ≤575px), либо добавить `max-width: calc(100vw - 24px)` в 29 классов. E2e: `SystemRoleModal` (1000px) на 768px-viewport — модалка ≤ viewport, футер кликабелен |

### Что чисто (мобайл/планшет)
- Шапка на телефоне обработана: `.app__location` — `min-width:0` + ellipsis (Core.less:92-104), вторичная строка/разделитель скрываются ≤991px (Core.less:192-195), `user-info__name` скрыт ≤575px (Core.less:246-248).
- Чипы шапки адаптивны: селектор проекта 220→180→**96px** (ProjectTargetSelect.less:28-41, с комментарием «На телефоне имя проекта сжимается»); чип «Компьютер» — ellipsis + `max-width` (ComputerHeader.less:7,29,31-37), детали — модалка 420px с `max-width: calc(100vw - 48px)` (ComputerHeader.less:64-65).
- Таблицы на телефоне — осознанный паттерн: `min-width: 620px` **только ≤575px** (app.less:149-151) + `overflow-x: auto` на `.ant-table-wrapper` (app.less:62-65) — горизонтальный скролл вместо раздавливания колонок.
- Operations → карточки ≤575px (Operations.less:244 + `&__cards`/`&__card` :74-80); Audit → мобильный вид ≤767px (Audit.less:69, `&__mobile` :36-38).
- Operations-drawer адаптивен: `width={compact ? '100%' : 960}` (Core.tsx:258); мобильное меню 280px (Core.tsx:249).
- Learning-drawers (720/660px) закрыты `max-width: 100vw` через `.learning-details` (ProjectLearning.less:190-193) — на телефоне становятся на всю ширину экрана.
- Лимиты вложений согласованы с nginx 50m: discussion-файлы 10MB (`features/Discussions/model.ts:4` + `services/shared/discussion-attachment-route.cjs:3`), chat-файлы 10MB (`features/ModelChat/files.ts:1`).

---

## 3. Строки / i18n / консистентность

| # | Severity | file:line | Что | Почему бьёт | Fix / e2e-ассерт |
|---|---|---|---|---|---|
| S1 | P2 | `frontend/src/modules/Store/StoreModule.tsx:19` (+ комментарий :13) vs `frontend/src/modules/Store/Store.tsx:954` (+ `StoreModule.tsx:10`) | Nav-имя модуля — «**Магазин**», h1 страницы — «**Каталог**» (lazySection title «Каталог») | Терминологический разрыв: пользователь заходит в «Магазин», внутри видит «Каталог»; для нового пользователя непонятно, что это одно | Унифицировать на «Каталог» (совпадает с описанием :955 «в общих и проектных каталогах»). E2e: nav-имя == h1 страницы |
| S2 | P2 | `frontend/src/modules/Operations/operationPresentation.ts:49-57, 70-76` vs `frontend/src/common/utils/format.ts:33-44` | Разное время в разных частях UI: операции форматируются **с секундами** (`Intl.DateTimeFormat` с `second: '2-digit'`, `dateTime` :49-56 и `clock` :57), остальной UI — через `formatDate` = `toLocaleDateString('ru-RU')` — **только дата, без времени** | «Запущено 12.03.2026, 14:23:45» в операциях, а та же операция в истории обучения/каталоге — «12.03.2026». Непоследуемость: в UI-списках секунды почти никогда не нужны | Убрать `second` из `dateTime`/`clock` (оставить в tooltip-полном формате). E2e: строка операции — ЧЧ:ММ без секунд |
| S3 | P2 | `frontend/index.html:7` + `frontend/src/features/TabNotifications/hooks/tabBadge.ts:27` | `document.title` статичен (`<title>Нейроцентр</title>`); единственный писатель — таб-бейдж `(${count}) Нейроцентр` (grep `document.title` — только 3 строки в tabBadge.ts) | Все вкладки браузера названы одинаково «Нейроцентр» независимо от раздела; в 5 открытых вкладках невозможно отличить «Операции» от «Каталога» | Ставить `document.title` по роуту (например, в `useEffect` в `Core` от `selected?.title`, `Core.tsx:199-201` уже держит название раздела). E2e: `/operations` → title содержит «Операции» |
| S4 | P2 | вся `frontend/src` (~296 .tsx, строки захардкожены на русском) | Нет i18n-фреймворка и механизма экстракции строк | RU-only — нормально для текущего продукта, но любой локализационный запрос = ручная перекачка тысяч строк; риск рассинхрона строк при рефакторе | P2-ноут: зафиксировать в ADR решение «RU-only, без i18n» (или завести i18n при появлении второго языка) |

### Что чисто (строки/i18n)
- «Нейроцентр» — единый регистр: 31 вхождение, **0** вариантов «нейроцентр» (grep по .ts/.tsx).
- Все UI-строки на русском, смешанных языков в проверенных файлах не найдено.
- Ошибочные сообщения — конкретные и с действием («Повторить проверку доступа» Core.tsx:224-233, «Сначала отмените сохранённую загрузку…» useSourceUpload.ts:169).

---

## 4. UI-безопасность — чисто

- `dangerouslySetInnerHTML` — **0** вхождений в `src/` (grep); `postMessage` — **0**.
- `CodeBlock.tsx:44` — `node.innerHTML = highlighted.value : escapeHtml(code)`: hljs.highlight экранирует вход сам, fallback — `escapeHtml` (CodeBlock.tsx:22-24). Безопасно.
- Все 4 markdown-рендера: `skipHtml` + `urlTransform` — `SafeMarkdown.tsx:82-84`, `ChatAnswer.tsx:83-84`, `ProjectChatMessages.tsx:175-176`, `StoreInstruction.tsx:116-117`. Raw HTML из контента не рендерится.
- Все **15** `target="_blank"` в `src/` имеют `rel="noopener noreferrer"` (или `rel="noreferrer"`, что по спецификации включает noopener) — таб-наббинга нет.
- Nginx prod: HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, жёсткий CSP (`template:20-24`).
- Rate-limit на логин: `limit_req_zone 10r/m`, `burst=10 nodelay`, `429` (template:3, 32-34) — защита от brute-force.
- Токены только в session-cookie через nginx; в URL query и localStorage токены не кладутся (проверено по ключевым путям входа/выхода).

---

## 5. Производительность

| # | Severity | file:line | Что | Почему бьёт | Fix / e2e-ассерт |
|---|---|---|---|---|---|
| PF1 | P2 | `frontend/src/modules/Core/Core.tsx:68-70` | `useSelector((state) => state.userBlock)` — селектор на **весь слайц** | Любое изменение в `state.userBlock` (auth-рефреш при `connect`/`auth:changed`, :108-123; processing; error) перерендеривает `Core` → всю app-shell (шапка, сайдбар, контент) | Селектор по полям: `useSelector(s => s.userBlock.isAuth)` и т.д. (в 5 переменных). E2e: React Profiler — Core не рендерится при heartbeat-событиях сокета |
| PF2 | P2 | `frontend/src/features/ProjectChat/observeVisibleMessages.ts:21, 26, 40, 41` | `scroll`-обработчик без rAF вызывает `document.elementFromPoint` для каждого видимого сообщения (стр. 21, вызов через `check` :26, слушатель :41); плюс `setInterval(check, 750)` (:40) — `getBoundingClientRect`+`elementFromPoint` по видимым сообщениям каждые 750мс | `elementFromPoint` форсирует layout: при touch-скролле 60fps — до 60 layout-принудений/с; интервал — фоновая работа даже без скролла (митигируется `chatWindowActive()`, :11, — проверяется только когда чат активно не в фокусе) | rAF-throttle на scroll-колбэк (коалесировать в один `check` на кадр); интервал увеличить до 1–2с. E2e: perf-trace на mobile-эмуляторе — forced reflow ≤2/кадр |

### Что чисто (производительность)
- **13** lazy-секций через `lazySection` (`grep -rl 'lazySection(' modules/`) — код модулей не в основном бандле.
- История чатов: cursor-based `useModelChat.ts:350-364` (`history.nextCursor`); окно `useProjectChat.ts:141` — `slice(0, 50)`.
- Сокет — singleton: `export default new SocketClient()` (`core/socket/socketClient.ts:114`), `reconnection: true` (:65), повтор подключённого namespace каждые 5с (:14, :32-46).
- Presence — не «heartbeat PUT каждую секунду»: `useChatPresence` шлёт PUT `/api/chat-presence/session` **только при смене состояния** (active/inactive; `useChatPresence.ts:24`), интервал 10с лишь опрашивает (:30).
- Пагинация/cursor в Operations, Audit, GGUF, Store (проверено по ключевым спискам).

---

## 6. Ошибки и границы

| # | Severity | file:line | Что | Почему бьёт | Fix / e2e-ассерт |
|---|---|---|---|---|---|
| E1 | **P0** | `frontend/src/features/GgufImport/api.ts:13-22` + `services/shared/gguf-import-policy.cjs:4` + `frontend/nginx.production.conf.template:18, 46-47, 65-71` | Загрузка GGUF — PUT raw-файла на `/api/models/gguf-imports/:id/content` без чанкинга (api.ts:13-22); серверная политика разрешает до **64GB** (policy:4), а nginx: `client_max_body_size 50m` (template:18), `location /api/` (:65-71) её наследует; исключение 8g есть **только** для `/api/asset-sources/archive` (:46-47) | Любая GGUF-модель >50MB (типичные 1–70GB) → **nginx 413 до прихода в приложение**. Главная фича модуля «Импорт моделей» в проде не работает ни для одной реальной модели | В nginx prod: `location /api/models/gguf-imports/ { client_max_body_size 8g; proxy_request_buffering off; ... }` (по образцу :46-56). E2e: upload 60MB-файла → 200, не 413 |
| E2 | P1 | `frontend/src/modules/Store/packaging/hooks/sourceUploadApi.ts:21-29` + `frontend/src/modules/Store/packaging/uploadConstants.ts:1` + `frontend/src/modules/Store/packaging/hooks/useSourceUpload.ts:23` | Загрузка source-узла — PUT raw-файла на `/api/tool-builds/uploads/:id/content` (sourceUploadApi.ts:21-29); лимит UI **256MiB** (uploadConstants.ts:1, проверка useSourceUpload.ts:23 «до 256 МиБ»); nginx 50m (template:18,65-71), исключения для `/api/tool-builds/` нет | Архив исходников 50–256MiB → **413**. Ключевая фича Store (упаковка инструмента из своего файла) не работает для архивов >~50MB; в UI это «Передача прервана…» без объяснения причины (useSourceUpload.ts:207-215) | В nginx prod: `location /api/tool-builds/uploads/ { client_max_body_size 256m; }`. E2e: upload 100MB → 200 |
| E3 | P1 | `frontend/nginx.production.conf.template` (0 `error_page` в файле — прочитан целиком, 80 строк) + `frontend/src/features/UserBlock/redux/actions.ts:79-82` | Логин — **full-page navigation**: кнопка «Войти» → `window.location.assign('/auth/login?returnTo=…')` (actions.ts:81-82). Rate-limit на `/auth/login` 10r/m burst=10 (template:3,32-34) → 429, а при down'е oauth2-bridge — 502/504. `error_page` не объявлен → браузер показывает **raw HTML nginx** («429 Too Many Requests» / «502 Bad Gateway») | Пользователь, нажавший «Войти» 11-й раз за минуту (или при инциденте), видит сырую nginx-страницу вместо объяснения. XHR-пути деградируют мягко (`common/utils/errorMessage.ts`), но full-page redirect — нет | В nginx: `error_page 429 /429.html; error_page 502 503 504 /50x.html;` + дружелюбные страницы (или inline `return` с HTML-фолбэком). A2 (контраст логина) усиливает проблему: человек не понимает, почему «вход не работает» | E2e: 11 быстрых GET `/auth/login` → 429 с HTML, содержащим «Слишком много запросов», не raw nginx |
| E4 | P2 | `frontend/src/common/components/LazySection/LazySection.tsx:12-38` (единственные брандеры: :15 и `StoreDetailsModal.tsx:47`) | App-уровневого Error Boundary **нет**: есть только boundary lazy-секций и модалки StoreDetails. Рендер-ошибка в app-shell (шапка/навигация) или в компоненте вне lazy-секции → **white screen** | Редкий, но фатальный сценарий: одна необработанная ошибка в ядре = пустая страница без возможности recover без F5 | Обёрнуть `<Core>` в `LazySectionBoundary`-подобный корневой брандер в `main.tsx`/App. E2e: форс-ошибка рендера в header → fallback, не белый экран |

### Что чисто (ошибки/границы)
- `errorMessage.ts` нормализует axios/nginx-ошибки в читаемые RU-строки для XHR-пути.
- У скачивания поставки явные сообщения по статусам 401/403/404/409/413/503 (`packaging/api.ts:69-76`).
- Обрыв сокета обрабатывается: `useProjectChatActivity.ts:226-241` (disconnect/connect_error → UI-состояние, не crash); `socketClient` сам восстанавливает (:32-46).
- `LazySectionBoundary` — понятный fallback «Не удалось открыть раздел» + кнопка перезагрузки (LazySection.tsx:26-35).
- Загрузка истории с ошибкой → fallback на пустой список, не crash (useProjectChat/useModelChat).

---

## Top-5 (по критичности)

1. **E1 (P0)** — GGUF upload 413: фича «Импорт моделей» не работает в проде для файлов >50MB (nginx 50m против серверных 64GB). Fix: `client_max_body_size 8g` на `location /api/models/gguf-imports/`.
2. **E3 (P1)** — Raw nginx 429/502 на full-page redirect логина: при rate-limit или сбое oauth2-bridge пользователь видит сырую nginx-страницу. Fix: `error_page` + фолбэк-страницы.
3. **E2 (P1)** — Source upload 413 для 50–256MB: упаковка инструмента из своего файла не работает для крупных архивов. Fix: `client_max_body_size 256m` на `location /api/tool-builds/uploads/`.
4. **A1 (P1)** — Контраст экрана входа 2.9–4.1:1 (5 мест): пользователь не читает объяснения при ошибке входа/429. Fix: затемнить цвета до ≥4.5:1.
5. **A2 (P1)** — Контраст микро-текста шапки 3.58:1 (10px статус компьютера, плейсхолдер проекта): постоянный UI, не проходит AA. Fix: `#758697` → ≥`#5f7183`.

## Подозрительное runtime-поведение (не UX-баг, но стоит отметить)

- `Core.tsx:68-70` — `useSelector(state.userBlock)` (весь слайц): рефреш auth при каждом `connect` сокета (:108-123) → лишний ререндер app-shell. См. PF1.
- `observeVisibleMessages.ts:40` — `setInterval(check, 750)` + `elementFromPoint` в scroll-колбэке без rAF: фоновые forced-reflow в открытом чате. См. PF2.
- `LazySection.tsx:57` — `key` секции зависит от `authDataScope(user, policies)`: при живой смене политик/роли (socket `auth:changed` → `authInit`) **все** открытые lazy-секции перемонтируются → потеря UI-состояния и refetch. Осознанно (комментарий :40), но при частых изменениях политик будет выглядеть как «приложение сбрасывается».
- `useChatPresence` — проверено, **не** проблема: PUT только при смене active/inactive (:24), не по таймеру.

## Методология

- Статический анализ + точечные grep + ручной расчёт контраста (WCAG 1.4.3). Каждый file:line в таблице открыт и сверен.
- Не запускал dev-server/браузер (backend недоступен); nginx-лимиты читаны из `nginx.production.conf.template` целиком (80 строк, `error_page` отсутствует — проверено).
- REVIEW-1.md не читался (независимость).
- Контрасты: ручной расчёт relative luminance по hex; точность ±0.1.
- Источники цифр: `grep -rEo 'aria-[a-z]+'` → 474; `role="status"` → 95; `Нейроцентр` → 31 (0 строчных); `target="_blank"` → 15 (все с rel); `dangerouslySetInnerHTML`/`postMessage` → 0; `document.title` → только tabBadge.ts (3 строки); `lazySection(` в modules → 13.
