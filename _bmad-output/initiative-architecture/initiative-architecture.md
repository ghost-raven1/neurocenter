---
type: initiative
title: Architecture
parent: none
sources:
  - _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md
companions:
  - _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md
  - _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md
  - _bmad-output/initiative-architecture/architecture-observability/architecture-observability.md
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - docs/implementation-readiness.md
  - docs/features/agent-method-workflows.md
after: []
risk: high
---

# Architecture

## Description

Когда инициатива закрыта, Neurocenter работает как проектная среда в закрытом контуре: 6 P0-блокеров закрыты приёмками (C1), новый участник — человек или агент — подключается сам за минуты (C2), данные проекта восстанавливаются на другом хосте с измеренными RPO/RTO (C3), проекты создаются из шаблона (C4), а реальный проект проведён агент-командой от анализа до подготовки выпуска с провенансом (C5). Бизнес-обязательства и success-метрики — PRD (source); требования эпиков — FR PRD (секции A–J, поднимаются в epic-линии при слайсинге); техническая основа — 4 architecture spine (companions).

## Outcome

Для нашей команды (фаза 1, single-tenant, один оператор) Neurocenter становится рабочей проектной средой в закрытом контуре; success-сигнал — приёмка пилота: 6 P0 + 5 приоритетных сквозных проверок, статус NO-GO → GO (PRD C1, Success Metrics «Приёмки»).

## Requirements

1. **R1 (prd C1).** Закрытый пилот = GO: 6 P0-блокеров закрыты приёмками — P0-SSO (IdP = Blitz), P0-NAT (матрица установщиков), P0-S3 (cross-host DR), P0-UPD (обновление/восстановление), P0-RES (ресурсы/наблюдаемость), P0-MNT (maintenance); предпосылка — замороженный кандидат релиза (REL-01). Counter: провал повторной приёмки.
2. **R2 (prd C2).** Новый участник (человек или агент) самонастраивается и начинает работать за минуты без оператора; добавление человека админом — не вмешательство оператора. Counter: onboarding с вмешательством оператора.
3. **R3 (prd C3).** Cross-host restore состояния проекта (quiesced backup) пройден на живых данных; RPO/RTO измерены репетицией и задокументированы. Counter: восстановление дольше заявленного RTO.
4. **R4 (prd C4).** Проект создаётся из шаблона: предзаполненный каталог (агенты/скиллы/модели), знания, роли и права.
5. **R5 (prd C5).** Реальный проект проведён агент-командой end-to-end (анализ → требования → архитектура → задачи → код → тесты → ревью → подготовка выпуска) с провенансом: следующий исполнитель получает принятые решения и исходные артефакты, а не пересказ. Counter: пересказанные артефакты (без провенанса) = 0.
6. **R6 (prd NFR-1).** Простота: ядро сценариев доступно без чтения документации; сложность опциональна (прогрессивное раскрытие). Метрики: completion-rate задач пилота без помощи; число шагов ядра сценариев.
7. **R7 (prd NFR-2).** Надёжность: нет молчаливых падений (crash-политика + запись ошибки); контролируемые отказы (fail-closed); видимость ошибки главному админу. Метрики: инциденты с потерей данных = 0; MTTR.
8. **R8 (prd NFR-3).** Нет тупиковых сценариев: каждая ошибка actionable (указан следующий шаг); для каждого failure mode — recovery-путь (re-pairing, re-fetch, restore). Метрика: тупики, найденные в пилоте, = 0 незакрытых.
9. **R9 (prd NFR-4).** Провенанс: 100% артефактов каталога с версией + SHA + квитанцией; 100% admin-мутаций в транзакционном аудите. Counter: артефакт без провенанса = 0.
10. **R10 (prd NFR-5).** Эксплуатируемость: single-host compose; самодиагностика (health/readiness); операционные действия (update/DR/ротация) — по runbook.
11. **R11 (prd NFR-6).** Лимиты реально работают: у каждого заявленного лимита (квота/бюджет) есть enforcement-точка; «лимит, который не работает» — дефект.
12. **R12 (prd UJ-1–UJ-5).** Пять подтверждённых (2026-11-05) journeys работают как записаны: UJ-1 вход (Blitz; неверный state/отказ IdP не создают сессию), UJ-2 публикация (карточка + immutable-версия + SHA + одобрение комплекта), UJ-3 устройство (квитанция, повтор idempotent, полезный MCP-вызов), UJ-4 обучение (только одобренная версия знания в контексте), UJ-5 восстановление (restore чистого стека на другом хосте).

## Constraints

1. Закрытый контур и импортозамещение: внешних зарубежных сервисов в рантайме нет в принципе; внешние экосистемы недопустимы как поставка (supply chain). (prd Vision «Проблема», FR-201)
2. IdP = Blitz — настоящий, единственный в контракте; неверный state/отказ IdP не создают сессию (fail-closed). (prd FR-901, C1)
3. Single-host compose; без HA/multi-replica, Kubernetes, Redis, микрофронтов, отдельного build-сервиса; без multi-tenant SaaS и мобильного клиента. (prd Out of Scope, NFR-5)
4. Расширения для агентов (плагины/скиллы/MCP opencode) — только из одобренного каталога проекта; локальные подключения — строго для тестирования возможностей (экспериментальный режим, запись в аудит). (prd FR-202, FR-306)
5. Вся работа исполняющих агентов — через методику BMAD + OpenSpec закреплённых версий (bmad-6.12.4 + openspec-1.15.0), без скрытых обновлений/установки при отправке задачи; обязательный режим — BMAD → OpenSpec. (prd FR-308; docs/features/agent-method-workflows.md)
6. Фаза 1 — single-tenant, один оператор; модель поставки (self-hosted) не меняется в фазе 2. (prd Vision «Для кого»; пользователь 2026-11-05)

## Done when

1. Приёмка пилота: 6 P0-блокеров + 5 приоритетных сквозных проверок пройдены (NO-GO → GO); провала повторной приёмки нет. (R1)
2. Restore на другом хосте пройден на живых данных; RPO/RTO измерены и не превышают задокументированных. (R3)
3. Onboarding участника/устройства — за целевое время, без вмешательства оператора. (R2)
4. 100% артефактов каталога с SHA/версией/квитанцией; 100% admin-мутаций в аудите. (R9)
5. Пилот-опрос ≥ целевого балла (5-pt); тупиков, найденных в пилоте и оставшихся незакрытыми, = 0. (R6, R8)
6. Один реальный проект проведён агент-командой от анализа до подготовки выпуска с провенансом (методика BMAD → OpenSpec). (R5)

## Boundaries

Не входит (prd Out of Scope, подтверждено пользователем 2026-11-05):

- приватные Git/SSH/другие хостинги; произвольные install/build hooks; автокомпиляция non-JS репозиториев;
- автоматические письма-приглашения;
- HA/multi-replica, Kubernetes, Redis, микрофронты, отдельный build-сервис;
- multi-tenant SaaS, мобильный клиент;
- «тонкое устройство» (мост + исполнители без локального opencode-агента) — устройство = личный агент пользователя (FR-701);
- корпоративные интеграции Jira/Confluence/GitLab (Q8; GitLab-коннектор — кандидат фазы 2);
- оператор — вне продукта: не одна из 4 продуктовых ролей, аккаунта не имеет, действует на хосте по runbook.

Must not change: поведение brownfield, принятое локальной приёмкой (сценарии S01–S29) — контракт расширяет продукт, а не переписывает.

Tracer: вход через Blitz (P0-SSO) → проект, созданный из шаблона с каталогом и знаниями (C4) → устройство с pairing и билетом (UJ-3) → агент-команда (BMAD → OpenSpec), закрывающая реальный проект (C5) → quiesced backup и cross-host restore (P0-S3).

Touch points без эпика (owner определяется при слайсинге):

- Runbook оператора (update/DR/ротация) — часть контракта (R10), вне UI продукта.
- P0-матрица приёмки (`docs/implementation-readiness.md`) — свидетельства для R1.

## References

- prd — `_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md` — обязательства C1–C5 (подняты в R1–R5), NFR-1…NFR-6 (R6–R11), UJ-1–UJ-5 (R12), требования A–J: FR-101…FR-1004 (вход эпиков; поднимаются в epic-линии при слайсинге), Success Metrics (Done when), Out of Scope (Boundaries), Open Questions (Notes)
- architecture — `_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md` — AD-1…AD-19: runtime и trust (IdP/сессии, каталог, комплект, устройства, mcp-host, билеты)
- architecture — `_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md` — AD-OP-1…AD-OP-9: обслуживание, бэкапы, тома, compose
- architecture — `_bmad-output/initiative-architecture/architecture-observability/architecture-observability.md` — AD-O-1…AD-O-8: наблюдаемость, error-store, алерты, capacity
- architecture — `_bmad-output/initiative-architecture/architecture-data/architecture-data.md` — AD-D-1…AD-D-5: данные проекта, per-project RAG-БД, веса моделей
- readiness — `docs/implementation-readiness.md` — P0-матрица приёмки (P0-MNT/S3/SSO/NAT/UPD/RES), REL-01
- feature — `docs/features/agent-method-workflows.md` — механика BMAD + OpenSpec, закреплённые версии, мостовая способность agent-method-workflow-v1

## Notes

- Open question: Q1 — состав пилота (какие проекты/команда, реальные данные, сколько людей и агентов); owner: пользователь; до старта пилота.
- Open question: Q3 — инструмент измерения удобства: 5-pt опрос + лог тупиков; owner: пользователь. [ASSUMPTION]
- Open question: Q6 — remote-модели (FR-603): постоянная часть контракта (гибридный контур) или переходная возможность; в напряжении с импортозамещением из Vision; ASSUMPTION: переходная; owner: пользователь.
- Open question: Q7 — baseline-цифры Success Metrics (время onboarding, балл опроса, число шагов ядра, рост к фазе 2) фиксируются при старте пилота; owner: старт пилота. [ASSUMPTION]
- Open question: Q8 — корпоративные интеграции (Jira/Confluence/GitLab): жёсткое орг-требование пилота или требование фазы 2; ASSUMPTION: вне фазы 1; owner: пользователь.
- Open question: Q9 — colibri (inference-движок frontier MoE, Apache-2.0) как второй локальный runtime наряду с Ollama: спайк в epic-project (1–2 модели на аппаратной пилота, замер против Ollama); решение после спайка: второй бэкенд (ASSUMPTION) / замена / отказ; unknown — аппаратная пилот-хоста (RAM/NVMe/GPU). [предложение пользователя, 2026-11-05]
- Unknown: M-6 — путь GGUF→ollama в AD-D2 не зафиксирован (dual-writer в `compose.production.yml`); ждёт решение пользователя на точечный фикс spine; gate для data-epic.
- Unknown: L-8 — число томов в AD-OP-4: 4 → 5 (artifact-cache); ждёт решение пользователя на точечный фикс spine; gate для operational-epic.
- Assumption: приоритет [P1] у FR-309/FR-310 — атрибуция PO (2026-11-05), явно пользователем не подтверждён.
