# Coverage-аудит волны 2 — PRD/инициатива ↔ 9 эпиков (инициатива Architecture)

**Дата:** 2026-11-09 · **Автор:** PO (Sofia) · **Статус:** read-only аудит + 1 выходной файл
**Охват:** PRD (FR-1xx..10xx, NFR, UJ, C1..C5, Success Metrics) + инициатива (R1..R12, P0-матрица) ↔ 9 эпиков волны 2 (id 2,3,4,5,6,7,8,9,10). Эпик 1 (release-baseline) — волна 1, 12/13, учтён как базис (REL-01).

**Метод:** для каждого элемента требований — вердикт `COVERED` / `PARTIAL` / `GAP` / `OUT-OF-SCOPE` + владелец (эпик + entry) + рекомендация для GAP/PARTIAL. PARTIAL типизированы: **(a) не нарезан** — в done-when/description, но явного entry в in-progress breakdown нет (разрешается дослисингом); **(b) дыра скоупа** — реально нет владельца, нужен новый entry/микро-эпик; **(c) напряжение/OQ** — расхождение документов или открытый вопрос.

**Источники:** `prd-neurocenter/prd-neurocenter.md`, `initiative-architecture.md`, `tickets/tickets.toml` + 6 breakdown'ов (ep1:13, ep2:14, ep4:6, ep5:14, ep6:15, ep8:16), `docs/implementation-readiness.md` (P0-матрица + 5 сквозных), `ux/{DESIGN,EXPERIENCE,REVIEW-2}.md` (55 UX-пунктов), 4 architecture spine (AD-1..19, AD-OP-1..9, AD-O1..8, AD-D1..5), `docs/features/agent-method-workflows.md`, `docs/user-scenario-regression-2026-10-24.md` (§5-проверок), `.memlog.md` (решения 2026-11-09).

**Легенда-сводка:** COVERED — есть явный entry или эпику-скоуп с done-when; PARTIAL — см. типы (a/b/c); GAP — нет владельца ни в одном эпику; OOS — осознанно вне контракта (с решением).

---

## §1. Матрица R × эпики волны 2

R1..R12 (инициатива) — кто закрывает, статус.

| R | Суть (коротко) | Основной владелец | Соучастники | Статус |
|---|---|---|---|---|
| **R1** (C1) | Закрытый пилот = GO: 6 P0 + REL-01 | ep10 pilot (приёмка) + ep4 (S3/MNT/UPD) + ep6 (RES) + ep7 (NAT) + ep3 (SSO) | ep1 (REL-01) | **PARTIAL (c)** — P0-SSO (ep3) перенесён после пилота (решение 2026-11-06); PRD R1/C1 пишет «6 P0 = GO», эпики пишут «5 P0 = GO + P0-SSO после». 5 P0 имеют владельцев; напряжение задокументировано, но в PRD не отражено. |
| **R2** (C2) | Новый участник (человек/агент) самонастраивается за минуты, без оператора | ep7 (устройство) + ep9 (агент FR-307) | ep3 (человек FR-902) | **COVERED** |
| **R3** (C3) | Cross-host restore + RPO/RTO измерены и задокументированы | ep4 (P0-S3 e4, RPO/RTO e2) | ep5 (per-project data в DR-бандл) | **COVERED** |
| **R4** (C4) | Проект создаётся из шаблона (каталог/знания/роли/права) | ep8 e5 (schema+API) + e6 (создание+UI) | — | **COVERED** |
| **R5** (C5) | Реальный проект агент-командой end-to-end с провенансом (BMAD→OpenSpec) | ep9 (done-when 1) | ep8 (проектный чат) | **PARTIAL (b)** — done-when не фиксирует отказоустойчивость серверного background-агента (FR-305): crash/retry/idempotency не явны (см. §4 G-7). |
| **R6** (NFR-1) | Простота: ядро без документации; completion-rate, число шагов | ep10 pilot UI-polish entry (первый entry) + ep8 (проект без доков) | UX DESIGN §4 | **PARTIAL (b)** — a11y (A1/A2) и mobility (M1, 29 модалок) не названы явно в заявленном скоупе UI-polish; метрики baseline = Q7. |
| **R7** (NFR-2) | Надёжность: crash-политика + запись ошибки, fail-closed, видимость админу | ep6 (e10/e11 crash+error-store, e12/e13 алерты, e14 аудит) | ep10 (инциденты) | **COVERED** (агент-рантайм — см. R5/FR-305) |
| **R8** (NFR-3) | Нет тупиковых сценариев: каждая ошибка actionable + recovery-путь | ep10 pilot UI-polish entry + ep8/ep9 (recovery-пути) | UX EXPERIENCE §5 (D1..D16) | **PARTIAL (b)** — 16 тупиковых D1..D16 + NFR-3 actionable-ошибки требуют явного закрытия в UI-polish entry (см. §4 G-4). |
| **R9** (NFR-4) | Провенанс: 100% артефактов с SHA/версией/квитанцией; 100% admin-мутаций в аудите | ep2 e12 (провенанс-карточка) + ep6 e14 (аудит FR-903) | ep8 (провенанс знаний/опыта) | **COVERED** |
| **R10** (NFR-5) | Эксплуатируемость: single-host compose, самодиагностика, опер. действия по runbook | ep6 (/ready e9, error-visibility, алерты) + ep4 (DR-репетиции) | AD-OP-4/OP-7 | **PARTIAL (b)** — rotation-секретов (FR-1004/AD-OP-4) и edge-сертификата (AD-OP-7.3) **runbook без владельца** (см. §4 G-1). |
| **R11** (NFR-6) | Лимиты реально работают: у каждого лимита enforcement-точка | ep6 e3 (quota AD-D4) + e4 (двухуровневые AD-1/9/12) | ep5 (квотная модель) | **COVERED** |
| **R12** (UJ-1..5) | 5 journeys работают как записаны | см. §3 (UJ-1→ep3, UJ-2→ep2 e12, UJ-3→ep7, UJ-4→ep8, UJ-5→ep4) | — | **PARTIAL (c)** — UJ-1 (вход через Blitz) отложен после пилота; пилот на локальном auth (interim), открытый вопрос AD-OP-5. |

**Итог §1:** R COVERED = 6 (R2,R3,R4,R7,R9,R11); R PARTIAL = 6 (R1,R5,R6,R8,R10,R12); GAP = 0 (на уровне R — все требования подняты в эпики; дыры проявляются на уровне FR/runbook, см. §4).

---

## §2. FR × эпики/entry (52 FR, 10 групп A–J)

| FR | Требование (коротко) | Вердикт | Владелец (эпик + entry) | Рекомендация |
|---|---|---|---|---|
| **A. Проект (FR-1xx)** | | | | |
| FR-101 | Проект = единица работы (участники/каталог/знания/чаты/устройства) | COVERED | ep8 e5/e6 (проект из шаблона) + ep5 (per-project data AD-D3/D4) | — |
| FR-102 | Проект из шаблона (каталог/знания/роли/права) | COVERED | ep8 e5 (schema+API) + e6 (создание+UI) | — |
| FR-103 | Lifecycle проекта + удаление полным каскадом + защищённый RAG-purge | COVERED | ep8 e7 (lifecycle+RAG-purge) + ep5 e11 (каскад+квитанция) | — |
| FR-104 | Snapshot с SHA + restore в новый проект + activate/rollback (CAS) | **PARTIAL (a)** | ep8 e8 (restore в новый проект); activate/rollback — в done-when, явного entry нет | Entry в ep8: snapshot activate/rollback (CAS-смена head). |
| **B. Каталог (FR-2xx)** | | | | |
| FR-201 | Упаковка из доверенных источников (npm/GitHub/архив/ready-runtime) + SHA-опись | COVERED | ep2 e12 (UJ-2) | — |
| FR-202 | Версии immutable; назначение — только одобренный точный комплект | COVERED | ep2 e12 + e7 (retire) | — |
| FR-203 | Провенанс артефакта: версия/SHA/источник/время/издатель, из карточки | COVERED | ep2 e12 | — |
| FR-204 | Retire версии необратим (все kinds: mcp/plugin/skill/model/agent/bridge) | **PARTIAL (b)** | ep2 e7 (scope = mcp/plugin); расширение на skill/model/agent/bridge = OQ | Уточнить scope e7 на all kinds или отдельный entry (пилот использует все kinds). |
| **C. Агенты (FR-3xx)** | | | | |
| FR-301 | Агент = участник проекта (роль/контекст/инструменты/публичные чаты) | COVERED | ep9 (description + done-when) | — |
| FR-302 | Агент-команда закрывает цепочку; последовательный контекст; подключение агента агентом | COVERED | ep9 done-when 5 (C5) | — |
| FR-303 | Системные роли (настройка/диагностика/модели/мосты/доступы/данные) | COVERED | ep9 done-when | — |
| FR-304 | Результат проверяем: верификация, а не «сделано» | COVERED | ep9 done-when 8 | — |
| FR-305 | [P1] Фоновый агент в полной opencode-среде (сервер) + доступ к компьютеру через мост | **PARTIAL (b)** | ep9 done-when 2 (есть); crash/retry/idempotency серверного агента не явны (brownfield — только device method jobs, `agent-method-workflows.md` §«Отмена и восстановление») | Entry в ep9: отказоустойчивость background-агента (crash-политика, retry, идемпотентность) — симметрия с NFR-2. |
| FR-306 | [P1] Расширения только из одобренного каталога; локальные — строго для тестов (аудит) | COVERED | ep9 done-when 3 | — |
| FR-307 | [P1] Добавление агента без оператора; первая операция — за минуты (C2) | COVERED | ep9 done-when 4 | — |
| FR-308 | [P1] BMAD + OpenSpec, закреплённые версии; режим BMAD → OpenSpec | COVERED | ep9 done-when 1 | — |
| FR-309 | [P1] Деление контекста (агенты/пользователь/команда) с провенансом | COVERED | ep9 done-when 6 | — |
| FR-310 | [P1] Вызов системного агента при проблеме/уточнении; recovery-путь | COVERED | ep9 done-when 7 | — |
| FR-311 | [P1] Семантический поиск агента по 4 корпусам (код/чаты/знания/опыт) + провенанс + freshness | COVERED | ep8 e13 (корпуса) + e14 (единый поиск + freshness-guard) | — |
| **D. Чат (FR-4xx)** | | | | |
| FR-401 | Режимы диалога + автономные раунды (бюджет/пауза/остановка/вмешательство) | COVERED | ep8 e11 (режимы) + e12 (автономные раунды) | — |
| FR-402 | Чат изолирован по проекту; публичные/приватные комнаты | **PARTIAL (a)** | в done-when ep8 п.5; явного entry нет (breakdown in-progress) | Entry в ep8: комнаты (публичные/приватные). |
| FR-403 | Приватный диалог не читается никем, включая главного админа | **PARTIAL (a)** | в done-when ep8 п.5; явного entry нет | Entry в ep8: приватность чата (ACL от главного админа). |
| FR-404 | Вложения: 10MiB/файл, 5/сообщение, 50MiB/диалог; не в каталог/RAG | **PARTIAL (a)** | в done-when ep8 п.5; явного entry нет | Entry в ep8: вложения с лимитами. |
| **E. Обучение (FR-5xx)** | | | | |
| FR-501 | Цикл опыта→гипотезы→проверка→кандидат→одобрение; порог независимых подтверждений | COVERED | ep8 e9 (политика подтверждений 1..N + независимость) | — |
| FR-502 | Только одобренная версия знания в контексте | **PARTIAL (a)** | в done-when ep8 п.3/8 (UJ-4); явного entry нет | Entry в ep8: гейт «только одобренная версия в контексте» (можно в e9). |
| FR-503 | Версии знания отзываемы/откатываемы с записью в аудит | **PARTIAL (a)** | в done-when ep8 п.3; явного entry нет | Entry в ep8: retire/rollback версии знания + аудит. |
| FR-504 | Точечный перенос опыта между проектами с провенансом | COVERED | ep8 e10 | — |
| **F. Модели (FR-6xx)** | | | | |
| FR-601 | Веса вручную из GGUF/архива (SHA, проверка, prepare/activate отдельно) | COVERED | ep8 e3 (GGUF-импорт + фикс E1 nginx 413) | — |
| FR-602 | Lifecycle модели: prepare/start/check/stop/cancel/recovery + лимиты | COVERED | ep8 e4 (action cancel) | — |
| FR-603 | Remote-модели (OpenAI/Ollama API) с личными шифрованными credentials + pin-верификация | **PARTIAL (a)** | в done-when ep8 п.4; явного entry нет; brownfield есть (`docs/remote-models.md`, `opencode-model-sync.md`); OQ Q6 (переходная?) | Entry в ep8: личные ключи remote-моделей + pin-ре-верификация. |
| FR-604 | Точный project model set + in-use guard (живой чат/агент/embedding) | COVERED | ep8 e2 (in-use guard) | — |
| FR-605 | Rate-limits/CAS/admission/queue/cancel = enforced model budget; usage own/project/all | **PARTIAL (a)** | в done-when ep8 п.4; в breakdown только budget-учёт e12 (раунды), отдельного entry enforced budget нет | Entry в ep8: enforced model budget (NFR-6 enforcement-точка) + usage-факты. |
| FR-606 | Проектная embedding-модель + reindex/sync; смена = миграция/новый проект | **PARTIAL (a)** | в done-when ep8 п.4; e13/e14 — freshness индекса, но отдельного entry embedding+reindex нет | Entry в ep8: embedding-модель + reindex/sync + миграция. |
| FR-607 | [P2] Контекст-окно локальной модели; история/откат системного промпта | **OUT-OF-SCOPE** | явно отложен: «[P2], решение при планировании эпика» (Addendum: agent-capability-audit) | Не gap — осознанно открытый приоритет P2. |
| FR-608 | Capability модели — открытое множество; содержательная проба capability | COVERED | ep8 e1 | — |
| **G. Устройства (FR-7xx)** | | | | |
| FR-701 | Подключение устройства: установщик/pairing/привязка папки/one-click; устройство = личный opencode-агент «одетый» проектом | COVERED | ep7 (description) | — |
| FR-702 | Каждая установка — с квитанцией; повтор idempotent | COVERED | ep7 done-when 3 | — |
| FR-703 | Lifecycle устройства pairing→активен→отзыв; доступ отклоняется ≤1 мин (AD-4 TTL 60s) | COVERED | ep7 (lifecycle) + ep2 e6 (отзыв билетов ≤60s) | — |
| FR-704 | Устройство offline (кэш) + переподключение без потери данных | COVERED | ep7 done-when 4 | — |
| FR-705 | [P1] Вызовы через билет (HMAC/TTL 24h/re-issue); авторизация на соединение+операцию; отзыв ≤ TTL | COVERED | ep2 e5 (verify) + e6 (retire/re-issue/пул-квоты) | — |
| FR-706 | [P1] Комплект декларирует версии opencode; несовместимость = явная ошибка + следующий шаг | COVERED | ep7 done-when 5 | — |
| **H. Данные/DR (FR-8xx)** | | | | |
| FR-801 | Данные проекта snapshot-ируются с SHA | COVERED | ep5 e12 (crash-consistency + artifact SHA) + ep4 (DR-бандл) | — |
| FR-802 | Полный offline-бэкап (quiesced) по расписанию + независимый S3 + readback (C1) | COVERED | ep4 (P0-S3 e4) | — |
| FR-803 | Restore на другом хосте; бандл самодостаточен; секреты/веса вне бандла (residual); RPO/RTO | COVERED | ep4 e1 (бандл) + e2 (RPO/RTO) + e4 (cross-host); веса = задокументированный residual | — |
| FR-804 | Обновление: репетиция на копии; rollback = restore из pre-update копии (C1) | COVERED | ep4 e5 (P0-UPD) | — |
| **I. Доступ (FR-9xx)** | | | | |
| FR-901 | SSO (Blitz, единственный) + 4 роли; fail-closed; ограничивает UI и API (C1) | COVERED | ep3 (P0-SSO; done-when 1/5) | — |
| FR-902 | Пользователи добавляются главным админом по почте | COVERED | ep3 done-when 6 | — |
| FR-903 | Каждая admin-мутация — в транзакционном аудите (NFR-4) | COVERED | ep6 e14 (AD-O7) | — |
| **J. Обслуживание (FR-10xx)** | | | | |
| FR-1001 | Модуль обслуживания: feature flags, журнал операций, capacity, статус бэкапов | COVERED | ep4 done-when 2 | — |
| FR-1002 | Runtime-лимиты настраиваются и реально исполняются (enforcement-точка) | COVERED | ep6 e3 (quota AD-D4) + e4 (двухуровневые) | — |
| FR-1003 | Самодиагностика: health/readiness, видимость ошибок, алерты; каждая ошибка actionable | COVERED | ep6 e9 (/ready) + e10/e11 (error-store+UI) + e12/e13 (алерты) | — |
| FR-1004 | Секреты ротируемы с задокументированными последствиями | **GAP** | нет entry ни в одном breakdown. Генерация секретов — ep2 e4 (host-secret/internal_token/postgres_password) и ep1 (environment-model), но **ротация (операционное действие) без владельца**. AD-OP-4 (DR-бандл+секреты) — ep4 e1 (бандл, не ротация) | **Новый entry в ep4 (dr):** rotation-секретов (internal_token, metrics_token, sso_client_secret, model_credential_key, postgres_password) — runbook на каждый + запись последствий + дни-до-истечения. ~1 story. |

**Итог §2 (52 FR):** COVERED = 39 · PARTIAL = 11 (×8 не нарезан (a), ×2 дыра (b): FR-204, FR-305; ×1 OQ) · GAP = 1 (FR-1004) · OUT-OF-SCOPE = 1 (FR-607).

---

## §3. UJ / C / P0 / NFR / Success Metrics

### UJ (5 journeys, R12)
| UJ | Journey | Владелец | Статус |
|---|---|---|---|
| UJ-1 | Вход (Blitz; неверный state/отказ IdP не создают сессию) | ep3 (P0-SSO) | **PARTIAL (c)** — отложен после пилота; пилот на локальном auth (interim), OQ AD-OP-5 |
| UJ-2 | Публикация (карточка + immutable-версия + SHA + одобрение комплекта) | ep2 e12 | **COVERED** |
| UJ-3 | Устройство (квитанция, повтор idempotent, полезный MCP-вызов) | ep7 | **COVERED** |
| UJ-4 | Обучение (только одобренная версия знания в контексте) | ep8 (done-when 8) | **COVERED** (гейт FR-502 — PARTIAL (a)) |
| UJ-5 | Восстановление (restore чистого стека на другом хосте) | ep4 | **COVERED** |

### C1..C5 (обязательства → R1..R5)
| C | Обязательство | = R | Статус |
|---|---|---|---|
| C1 | 6 P0-блокеров закрыты приёмками | R1 | **PARTIAL (c)** — P0-SSO после пилота |
| C2 | Новый участник самонастраивается за минуты | R2 | **COVERED** |
| C3 | Cross-host restore + RPO/RTO измерены | R3 | **COVERED** |
| C4 | Проект из шаблона | R4 | **COVERED** |
| C5 | Реальный проект агент-командой с провенансом | R5 | **PARTIAL (b)** — FR-305 crash/retry |

### P0-матрица (+REL-01)
| P0 | Приёмный блóкер | Владелец | Статус |
|---|---|---|---|
| P0-S3 | Cross-host DR (независимый S3, restore другого хоста) | ep4 e4 | **COVERED** |
| P0-MNT | Maintenance-таймер (успех/отказ/повтор, пауза/RPO/RTO) | ep4 e3 | **COVERED** |
| P0-UPD | Обновление/восстановление (репетиция точных образов) | ep4 e5 | **COVERED** |
| P0-RES | Ресурсы и наблюдаемость (лимиты, метрики, алерты, аудит) | ep6 (15 entries) | **COVERED** |
| P0-NAT | Матрица 8 клиентских установщиков | ep7 | **COVERED** |
| P0-SSO | Настоящий Blitz (вход/отказы/истечение/выход, первый админ, отзыв) | ep3 (после пилота) | **PARTIAL (c)** |
| REL-01 | Замороженный кандидат релиза | ep1 e13 (12/13) | **COVERED** (волна 1) |

### NFR (6, = R6..R11)
| NFR | Суть | = R | Статус |
|---|---|---|---|
| NFR-1 | Простота (ядро без доков) | R6 | **PARTIAL (b)** — a11y/mobility не явны в UI-polish |
| NFR-2 | Надёжность (crash-политика, fail-closed, видимость) | R7 | **COVERED** |
| NFR-3 | Нет тупиковых сценариев (actionable + recovery) | R8 | **PARTIAL (b)** — 16 тупиков D1..D16 |
| NFR-4 | Провенанс (SHA/версия/квитанция, аудит) | R9 | **COVERED** |
| NFR-5 | Эксплуатируемость (single-host, runbook) | R10 | **PARTIAL (b)** — rotation runbook GAP |
| NFR-6 | Лимиты реально работают (enforcement-точка) | R11 | **COVERED** |

### Success Metrics (6 строк PRD)
| Метрика | Целевое | Статус / владелец |
|---|---|---|
| Приёмки | 6 P0 + 5 сквозных = NO-GO→GO | **PARTIAL** — P0-SSO после пилота (ep10 + ep3); 5 P0 COVERED |
| Использование | активные проекты/участники/устройства, baseline → рост к фазе 2 | **PARTIAL** — численный N (проекты/агенты) нигде не зафиксирован; Q1/Q7 (определяет пользователь) |
| Провенанс | 100% артефактов с SHA/версией/квитанцией; 100% admin-мутаций в аудите | **COVERED** — ep2 e12 + ep6 e14 |
| Надёжность | RPO/RTO измерены; инцидентов с потерей данных = 0 | **COVERED** — ep4 e2 |
| Скорость | onboarding за целевое время; restore ≤ RTO | **PARTIAL** — целевое время onboarding = Q7 (baseline при старте пилота) |
| Удобство и отзывы | пилот-опрос ≥ целевого балла; тупики закрыты | **PARTIAL** — UI-polish entry (ep10) + Q7/Q3 |

### 5 приоритетных сквозных проверок (`user-scenario-regression-2026-10-24.md`)
| # | Проверка | Владелец | Статус |
|---|---|---|---|
| 1 | Смена project/role/device/ACL после принятого плана во время ожидания bridge | ep7 + ep2 | **COVERED** |
| 2 | Обновление/архивация источника при активных consumers (pinned version/private scope) | ep5 + ep2 | **COVERED** |
| 3 | Цепь embedding→reindex→full sync→semantic chat→REPLACE на другом компьютере | ep8 + ep7 | **COVERED** |
| 4 | Чекпоинт→новый хост/стек/credentials→доступ к private attachments/RAG | ep4 | **COVERED** |
| 5 | Первый вход через настоящий IdP→installer→pairing→root binding→offline install→MCP-вызов | ep3 + ep7 | **PARTIAL (c)** — «настоящий IdP» = Blitz, отложен после пилота; пилот на локальном auth. Pilot breakdown должен явно адаптировать проверку 5 (локальный auth как interim). |

**Итог §3:** P0 COVERED = 5/6 (+REL-01) · P0-SSO PARTIAL (c) · UJ COVERED = 4/5 · NFR COVERED = 3/6 · C COVERED = 3/5 · Success Metrics COVERED = 2/6 · 5-проверок COVERED = 4/5.

---

## §4. Сводная таблица GAP/PARTIAL (типы b и c + GAP)

Сортировка по риску для пилот-гейта. (a)-типа (не нарезан) — ниже отдельным списком, т.к. разрешаются дослисингом in-progress breakdown'ов.

| # | Тип | Элемент | Проблема | Рекомендация (конкретный owner) |
|---|---|---|---|---|
| **G-1** | **GAP** | FR-1004 + AD-OP-4 + AD-OP-7.3 — rotation-секретов и edge-сертификата | Runbook на каждый секрет (internal_token, metrics_token, sso_client_secret, model_credential_key, postgres_password) + запись последствий + дни-до-истечения — **нет владельца**. grep «FR-1004» по `tickets/` = 0. Бьёт R10/NFR-5 («операционные действия — по runbook»). Алерт days-to-expiry есть в ep6 e13 (alerting), runbook — не у кого | **Новый entry в ep4 (dr):** «Rotation-секретов + edge-сертификат: runbook на каждый + запись последствий + алерт». ~1 story |
| **G-2** | **GAP** | AD-OP-8 stack-watchdog + node_exporter | ep6 e9 явно назначает «stack-watchdog (AD-OP-8, **эпик 4**)» consumer'ом `/ready/dependencies` + «удалить, если к концу эпика 4 не подключён»; в breakdown ep4 (6 entry) watchdog/node_exporter **не упоминаются** | **Новый entry в ep4 (dr):** «stack-watchdog (AD-OP-8) + node_exporter: consumer /ready/dependencies». ~0.5–1 story |
| **G-3** | **GAP** | REVIEW-2 **E2** (P1) — source upload 413 | Загрузка source-узла 50–256MiB → nginx `client_max_body_size 50m` → 413. `location /api/tool-builds/uploads/` без исключения 256m. E1 (GGUF 413, P0) уже зашит (ep8 e3, owner nginx-template); E2 — **без владельца** | nginx-блок `client_max_body_size 256m` на `/api/tool-builds/uploads/` — в **ep8 e3** (тот же nginx-template owner) или фикс-лист pilot UI-polish entry |
| **G-4** | **PARTIAL (b)** | a11y **A1/A2** (контраст 2.9–4.1:1, P1) + **M1** (29 модалок без max-width, 576–1023px, P2) | Нет явного владельца. pilot UI-polish entry — естественный owner, но в его заявленном скоупе (user paths, error/empty-states, Playwright-e2e, fix-list) a11y/контраст/мобайл **не названы явно** | Явно включить A1/A2 (WCAG AA 4.5:1) + M1 (global `@media 576–1023px .ant-modal max-width`) в скоуп **ep10 pilot UI-polish entry** |
| **G-5** | **PARTIAL (b)** | AD-11 capability-advisor | res-obs plan: «НЕ здесь — это UI-фича (epic-project)»; в breakdown ep8 нет; не упомянут в description ep8 | **Entry в ep8** (capability-advisor UI) или явный defer с записью |
| **G-6** | **PARTIAL (c)** | Локальный auth-режим пилота = supported-конфигурация, не dev-обход (AD-OP-5) | Открытый вопрос (memlog: «кандидат: микро-эпик id=11, after=[E1], блокирует E10»; owner: пользователь). ep1 e4 запрещает dev-обходы в production-конфиге. Риск для пилот-гейта: если требует отдельной работы — блокирует пилот | Решение с пользователем до старта пилота: либо микро-эпик id=11 (auth-as-supported-config), либо зафиксировать, что interim-конфигурация не требует отдельной работы |
| **G-7** | **PARTIAL (b)** | Отказоустойчивость серверного background-агента (FR-305) | crash/retry/idempotency не явны в done-when ep9; brownfield-семантика recovery есть только для **device method jobs** (`agent-method-workflows.md` §«Отмена и восстановление»), не для серверного агента | **Entry в ep9:** отказоустойчивость background-агента (crash-политика, retry, идемпотентность) |
| **G-8** | **PARTIAL (b)** | FR-204 all kinds | ep2 e7 scope = mcp/plugin; расширение на skill/model/agent/bridge = OQ; пилот использует все kinds | Уточнить scope e7 или отдельный entry (retire all kinds) |
| **G-9** | **PARTIAL (b)** | Seed-контент первого запуска | Механизм FR-102 в ep8 e5/e6; «первый шаблон + seed-каталог для пилота» — не у кого (пилот-подготовка/Q1) | Зафиксировать в **ep10 pilot** (Q1): первый проект-шаблон + seed-каталог как часть пилот-подготовки |
| **G-10** | **PARTIAL (b)** | Нагрузочные численные цели (N-проектов/агентов) | readiness: «нагрузочные цели не считаются достигнутыми измерениями», «параметры целевой площадки задаются отдельно»; N нигде не зафиксирован | Q1/Q7 (определяет пользователь): численный N для нагрузочной приёмки P0-RES |
| **G-11** | **PARTIAL (c)** | Тензия: сквозная проверка #5 («первый вход через настоящий IdP») vs пилот на локальном auth | Blitz после пилота; pilot breakdown должен явно адаптировать проверку 5 | В **ep10 pilot** breakdown: адаптация проверки 5 (локальный auth как interim, Blitz-часть — после GO) |
| **G-12** | **PARTIAL (c)** | Тензия доков: PRD C1/R1 = «6 P0 = GO» vs эпики = «5 P0 = GO пилота + P0-SSO после» | Решение пользователя 2026-11-06 зафиксировано в ep3/ep10, но в PRD R1/C1 не отражено | Обновить PRD R1/C1 (или Addendum) — зафиксировать «5 P0 = GO пилота, P0-SSO после пилота (решение 2026-11-06)» |
| **H-1** | hygiene | `deferred-work.md` устарел | production-setup.md / docker-build-ca.md доки build-режима фиксированы в 1.12 K2 (2026-11-09, main 82a5a3d6) | Обновить/удалить deferred-work.md (не блокирует, но вводит в заблуждение) |

### PARTIAL типа (a) — «не нарезан» (разрешаются дослисингом in-progress breakdown'ов)
Эти FR в done-when/description эпику, но явного entry в breakdown нет (ep8 in-progress, 16 entry). Не дыры скоупа — ожидаются при завершении breakdown:

| FR | Эпик | Что нужно нарезать |
|---|---|---|
| FR-104 | ep8 | snapshot activate/rollback (CAS-смена head) — e8 покрывает только restore в новый проект |
| FR-402 | ep8 | комнаты (публичные/приватные) |
| FR-403 | ep8 | приватность чата (ACL от главного админа) |
| FR-404 | ep8 | вложения с лимитами (10MiB/5/50MiB) |
| FR-502 | ep8 | гейт «только одобренная версия знания в контексте» (можно в e9) |
| FR-503 | ep8 | retire/rollback версии знания + аудит |
| FR-603 | ep8 | личные ключи remote-моделей + pin-ре-верификация (brownfield есть) |
| FR-605 | ep8 | enforced model budget (NFR-6) + usage-факты own/project/all (e12 — только budget раундов) |
| FR-606 | ep8 | embedding-модель + reindex/sync + миграция |

**Итог §4:** GAP = 3 (G-1 rotation, G-2 watchdog, G-3 E2-upload) · PARTIAL(b) = 7 (G-4 a11y/mobility, G-5 AD-11, G-6 local-auth, G-7 agent-crash, G-8 FR-204, G-9 seed, G-10 load-N) · PARTIAL(c) = 2 (G-11 check-5, G-12 6-P0-тензия) · PARTIAL(a) = 9 (не нарезан) · hygiene = 1.

---

## §5. Проверка 12 гипотез «9 — мало?»

| # | Гипотеза | Подтверждено? | Факт |
|---|---|---|---|
| 1 | **UX/a11y/i18n/mobility (53 пункта)** | **ЧАСТИЧНО** | UX-база = 55 пунктов: 16 тупиков D1..D16 (EXPERIENCE §5) + 12 противоречий (DESIGN §3) + 13 polish-целей (DESIGN §4) + 14 находок (REVIEW-2: A1,A2,A11,E1..E4,M1,S1..S4,PF1,PF2). Владелец есть — **ep10 pilot UI-polish entry** (PO-решение 2026-11-09, зафиксировано в Notes epic-pilot.md). **НО**: a11y (A1/A2) и mobility (M1) не названы явно в заявленном скоупе entry. i18n (REVIEW-2 S4) — **решено** DESIGN §5.10 «Язык интерфейса: русский» → COVERED, не gap. → 9 не «мало» по наличию владельца, но UI-polish entry нужно **явно расширить** на A1/A2/M1 (G-4). |
| 2 | **Операторские доки / runbook'и** | **ДА (GAP)** | FR-1004/AD-OP-4 rotation-секретов + AD-OP-7.3 edge-сертификат + AD-OP-8 watchdog — **runbook'и без владельца** (G-1, G-2). Бьёт R10/NFR-5. |
| 3 | **Производительность / нагрузочные N** | **ЧАСТИЧНО** | Численный N (проекты/агенты) нигде не зафиксирован; readiness: «нагрузочные цели не считаются достигнутыми измерениями». Осознанно отложено в Q1/Q7 (определяет пользователь). Не дыра скоупа эпики, но **нет зафиксированного целевого N** для приёмки P0-RES (G-10). |
| 4 | **Секреты lifecycle** | **ДА (GAP на ротацию)** | Генерация секретов COVERED (ep2 e4 host-secret/internal_token/postgres_password, ep1 environment-model). **Ротация (FR-1004) — GAP** (G-1). |
| 5 | **Per-project DR** | **НЕТ (покрыто)** | RAG-БД в PG-дампе; model-weights = задокументированный residual (FR-803/AD-OP-4); L-8 (4→5 томов) — gate в ep5. Per-project data входит в DR-бандл ep4. COVERED. |
| 6 | **Seed-контент первого запуска** | **ЧАСТИЧНО** | Механизм FR-102 COVERED (ep8 e5/e6); «первый шаблон + seed-каталог для пилота» — без владельца (G-9, пилот-подготовка/Q1). |
| 7 | **Отказоустойчивость agent runtime** | **ЧАСТИЧНО (GAP)** | Серверный background-агент (FR-305): crash/retry/idempotency не явны в ep9 (G-7). Brownfield-semantic recovery есть только для device method jobs. |
| 8 | **correlation-id** | **НЕТ (покрыто)** | ep6 e6 «Единая лог-схема: shared/logging.cjs + correlation id (AD-O1/O2)». COVERED. |
| 9 | **Rolling / zero-downtime update** | **НЕТ (OOS)** | AD-OP-3: rollback = только restore-new-project; in-place rolling осознанно отсутствует. PRD не требует rolling (single-host compose, NFR-5). OOS. |
| 10 | **Multi-админ / делегирование** | **НЕТ (OOS)** | В PRD нет требования multi-админ/делегирования. 4 продуктовые роли + FR-902 + отзыв прав — ep3. Фаза 1 = single-tenant, один оператор (Constraint 6). OOS. |
| 11 | **Offline FR-704** | **НЕТ (покрыто)** | ep7 done-when 4: «Устройство работает offline (кэш) и переподключается без потери данных (FR-704)». COVERED. |
| 12 | **Content-migration** | **НЕТ (покрыто/OOS)** | AD-D1 (единое версионирование схемы) + P0-UPD rehearsal (ep4 e5) покрывают **schema**-миграцию. Content-миграция сверх schema — не требование PRD. OOS/COVERED. |

**Итог §5:** из 12 гипотез: подтверждены как реальные дыры = **4** (№2 runbook, №4 секреты-ротация, №7 agent-crash — GAP; №1 a11y/mobility — расширение скоупа); частично (осознанно отложено в Q1/Q7/решение) = **3** (№3 load-N, №6 seed, + a11y-часть №1); опровергнуты (покрыто/OOS) = **5** (№5, 8, 9, 10, 11, 12).

---

## §6. Вердикт: «9 — мало?»

### Счёт вердиктов (по всем элементам требований)

| Уровень | COVERED | PARTIAL | GAP | OOS | Всего |
|---|---|---|---|---|---|
| R1..R12 | 6 | 6 | 0 | 0 | 12 |
| FR (52) | 39 | 11 | 1 | 1 | 52 |
| UJ (5) | 4 | 1 | 0 | 0 | 5 |
| C1..C5 | 3 | 2 | 0 | 0 | 5 |
| NFR (6) | 3 | 3 | 0 | 0 | 6 |
| P0 (6) + REL-01 | 6 | 1 | 0 | 0 | 7 |
| 5-проверок | 4 | 1 | 0 | 0 | 5 |
| Success Metrics (6) | 2 | 4 | 0 | 0 | 6 |
| **ИТОГО** | **67** | **29** | **1** | **1** | **98** |

(98 = 12 R + 52 FR + 5 UJ + 5 C + 6 NFR + 7 P0/REL + 5 проверок + 6 Metrics. UX 55 пунктов учтены внутри R6/R8 и гипотезы №1, не дублируются в счётчике.)

**Структура 29 PARTIAL:** типа (a) «не нарезан» = 9 (разрешаются дослисингом ep8); типа (b) «дыра скоупа» = 13; типа (c) «напряжение/OQ» = 7.

**GAP:** в нумерованных категориях требований GAP = 1 — это FR-1004 (rotation-секретов). Помимо него в §4 выделены ещё 2 GAP на уровне AD/UX-находок, не входящие в нумерованные FR: **G-2** (AD-OP-8 stack-watchdog/node_exporter) и **G-3** (REVIEW-2 E2 source-upload 413). Итого реальных GAP-дыр без владельца — **3** (G-1, G-2, G-3).

### Топ-10 GAP/PARTIAL по риску для пилот-гейта

| # | Пункт | Тип | Блокирует? |
|---|---|---|---|
| 1 | **G-1** FR-1004/AD-OP-4/OP-7.3 — rotation-секретов + edge-сертификат runbook | GAP | Нет (после пилота), но бьёт R10/NFR-5 — нужно в ep4 |
| 2 | **G-2** AD-OP-8 stack-watchdog + node_exporter | GAP | **Да для P0-RES** — ep6 e9 ждёт watchdog «к концу эпика 4»; нет в ep4 |
| 3 | **G-3** E2 source upload 413 (P1) | GAP | Да для Store-фичи — без владельца |
| 4 | **G-6** локальный auth пилота = supported-config, не dev-обход | PARTIAL(c) | **Да для пилот-гейта** — OQ, owner пользователь, кандидат микро-эпик id=11 |
| 5 | **G-4** a11y A1/A2 (P1) + M1 mobility (P2) | PARTIAL(b) | Да для NFR-1/NFR-3 — UI-polish entry нужно явно расширить |
| 6 | **G-7** отказоустойчивость серверного background-агента (FR-305) | PARTIAL(b) | Да для C5/R5 — entry в ep9 |
| 7 | **G-12** тензия «6 P0 = GO» (PRD) vs «5 P0 + SSO после» (эпики) | PARTIAL(c) | Нет (решение есть), но PRD не обновлён |
| 8 | **G-11** сквозная проверка #5 «настоящий IdP» vs локальный auth пилота | PARTIAL(c) | Да для адаптации pilot breakdown |
| 9 | **G-10** нагрузочные N (проекты/агенты) не зафиксированы | PARTIAL(b) | Да для приёмки P0-RES — Q1/Q7 |
| 10 | **G-8** FR-204 all kinds (retire skill/model/agent/bridge) | PARTIAL(b) | Частично — пилот использует все kinds |

### Ответ на вопрос «9 — мало?»

**Нет, 9 эпиков по числу и покрытию достаточны.** Все 12 R, 52 FR, 5 UJ, 5 C, 6 NFR, 6 P0 + REL-01, 5 сквозных проверок **подняты в скоуп** 9 эпиков волны 2 — ни одно требование не «висит» без epic-оболочки. 67/98 элементов = COVERED на уровне владельца.

Но **достаточность ≠ готовность к приёмке**. 9 эпиков закрывают *что делать*, но оставляют **3 реальные GAP-дыры** (G-1 rotation, G-2 watchdog, G-3 E2-upload) и **13 PARTIAL-дыр скоупа**, из которых **4 блокируют пилот-гейт**:
- **G-6** (локальный auth = supported-config) — OQ, кандидат микро-эпик id=11, блокирует E10;
- **G-2** (watchdog) — ep6 e9 явно ждёт его «к концу эпика 4»;
- **G-4** (a11y/mobility) — NFR-1/NFR-3, UI-polish entry нужно явно расширить;
- **G-7** (agent-crash) — C5/R5.

### Конкретные дополнения (не новые эпики — entry'ы в существующие)

| Дополнение | Куда | Объём |
|---|---|---|
| Rotation-секретов + edge-сертификат: runbook + запись последствий + алерт (FR-1004/AD-OP-4/OP-7.3) | **ep4 (dr)** новый entry | ~1 story |
| stack-watchdog (AD-OP-8) + node_exporter: consumer /ready/dependencies | **ep4 (dr)** новый entry | ~0.5–1 story |
| nginx `client_max_body_size 256m` на `/api/tool-builds/uploads/` (E2) | **ep8 e3** (nginx-template owner) или pilot fix-list | ~0.2 story |
| Явно включить a11y A1/A2 (WCAG AA) + M1 (576–1023px модалки) в скоуп | **ep10 pilot UI-polish entry** (расширение) | в рамках entry |
| Отказоустойчивость background-агента (crash/retry/idempotency, FR-305) | **ep9 (agent-team)** новый entry | ~1 story |
| capability-advisor (AD-11) UI | **ep8 (project)** entry или явный defer | ~1 story |
| Локальный auth = supported-config (не dev-обход, AD-OP-5) | **решение с пользователем** → либо **микро-эпик id=11** (after=[ep1], блокирует ep10), либо фикс «interim не требует отдельной работы» | OQ / ~1 story |
| FR-204 all kinds (retire skill/model/agent/bridge) | **ep2 e7** уточнить scope или отдельный entry | ~0.5 story |
| Seed-контент: первый шаблон + seed-каталог для пилота | **ep10 pilot** (Q1) | пилот-подготовка |
| Нагрузочный N (проекты/агенты) | **Q1/Q7** (определяет пользователь) → приёмка P0-RES | решение |
| 9 FR типа (a) (FR-104 activate/rollback, 402, 403, 404, 502, 503, 603, 605, 606) | **ep8 breakdown** дослисинг (in-progress) | в рамках ep8 |
| Адаптация сквозной проверки #5 (локальный auth interim) | **ep10 pilot breakdown** | в рамках ep10 |
| Обновить PRD R1/C1: «5 P0 = GO пилота, P0-SSO после (решение 2026-11-06)» | **PRD Addendum** | док-фикс |

**Вывод:** 9 эпиков — правильное разбиение по *объёму работы* (каждый эпик = самостоятельный результат с P0/UJ-якорем). Для *приёмки пилота* нужно (1) донарезать 2 entry в ep4 (rotation, watchdog), (2) закрыть G-6 решением/микро-эпиком id=11, (3) расширить pilot UI-polish entry на a11y/mobility, (4) донарезать entry в ep9 (agent-crash) и ep8 (E2 + capability-advisor + 9 FR типа (a)). Это **не требует 10-го или 11-го эпики по содержательным линиям** — всё ложится в существующие 9 + один возможный микро-эпик id=11 (local-auth-config) по OQ.

---

*Чтение: вердикты основаны на фактах из источников (FR-номера, AD-коды, epic slug, entry id). GAP/PARTIAL-типы (a/b/c) — для разграничения «дослисинг» vs «реальная дыра» vs «напряжение/OQ». Численные метрики N и целевые времена onboarding осознанно не фиксированы (Q1/Q7, owner пользователь) — это не дефект плана, а открытые вопросы пилот-подготовки.*
