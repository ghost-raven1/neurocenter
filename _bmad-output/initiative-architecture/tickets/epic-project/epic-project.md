---
type: epic
title: "Проект как единица: шаблон, знания, модели, чат (C4)"
parent: initiative-architecture
covers: [R4, R6, R9, R12]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-data/architecture-data.md]
after: [epic-trust-device-catalog, epic-data]
refined: false
risk: high
---

# Проект как единица: шаблон, знания, модели, чат (C4)

## Description

Ядро сценария доступно без чтения документации (R6): проект создаётся из шаблона: предзаполненный каталог, знания, роли (FR-102); lifecycle проекта и защищённый RAG-purge (FR-103), snapshot/restore/rollback (FR-104); цикл знаний: опыт → гипотезы → проверка → кандидат → одобрение (FR-501..503) и точечный перенос опыта между проектами с провенансом (FR-504); проектный model set: capability — открытое множество (FR-608), личные ключи моделей (FR-603), in-use guard (FR-604), импорт весов вручную (GGUF/архив, SHA, prepare/activate — FR-601), lifecycle модели (FR-602), enforced model budget (FR-605), проектная embedding-модель + reindex/sync (FR-606); контекст-окно и системный промпт (FR-607) — [P2], решение при планировании эпика; чат: режимы диалога и автономные раунды (FR-401), публичные/приватные комнаты (FR-402), приватность от главного админа (FR-403), вложения с лимитами (FR-404); семантический поиск агентов по четырём корпусам — актуальный код, публичные чаты, одобренные знания, опыт (FR-311; sync индекса — FR-606). Включает спайк: colibri как второй inference-бэкенд для frontier MoE (Q9). Проектный чат — базис для агент-команды (эпик 9).

## Outcome

Для команды: проект — единица работы: создаётся из шаблона за минуты, со знаниями, моделями и чатом; следующий исполнитель получает артефакты с провенансом, а не пересказ (сигнал: PRD C4, UJ-4).

## Done when

1. Проект создаётся из шаблона: каталог, знания, роли, права (FR-102) — без чтения документации (R6).
2. Lifecycle проекта + защищённый RAG-purge (FR-103); snapshot/restore/rollback (FR-104).
3. Цикл знаний: опыт → гипотезы → проверка → кандидат → одобрение (FR-501..503); точечный перенос опыта с провенансом (FR-504).
4. Model set: capability — открытое множество (FR-608), личные ключи (FR-603), in-use guard (FR-604), импорт весов (FR-601), lifecycle (FR-602), enforced budget (FR-605), embedding + reindex/sync (FR-606).
5. Чат: режимы диалога и автономные раунды (FR-401), публичные/приватные комнаты (FR-402), приватность от главного админа (FR-403), вложения с лимитами (FR-404).
6. Семантический поиск агентов по четырём корпусам: актуальный индекс, провенанс результатов (FR-311).
7. Спайк colibri (Q9): 1–2 модели на аппаратной пилота, замер против Ollama, решение (второй бэкенд/замена/отказ) зафиксировано.
8. UJ-4 работает как записан: только одобренная версия знания в контексте.

## Boundaries

- Механика каталога/билетов/retire — эпик epic-trust-device-catalog; data-модель (RAG-БД, retention) — эпик epic-data (этот эпик потребляет).
- Агент-команда (FR-3xx) — эпик epic-agent-team; проектный чат этот эпик отдаёт ей.
- Enforcement квотной инфраструктуры — эпик epic-res-obs; лимиты вложений (FR-404) — в рамках эпика.
- Модель поставки (Ollama-runtime, colibri-спайк) — архитектурное решение data-spine (AD-D2); решение по colibri — после спайка.

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R4, R6, R9, R12)
- prd — _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md (FR-102..104, FR-401..404, FR-501..504, FR-601..608, FR-311, C4, UJ-4)
- architecture — _bmad-output/initiative-architecture/architecture-data/architecture-data.md (AD-D3: per-project RAG-БД)

## Notes

- Assumption: FR-607 [P2] — решение о включении принимается при планировании эпика.
- Open question: Q9 — colibri как второй inference-бэкенд; unknown: аппаратная пилот-хоста (RAM/NVMe/GPU).
- Waits on epic-trust-device-catalog because: каталог: одобренные комплекты и версии (FR-202, AD-16).
- Waits on epic-data because: per-project data-модель: RAG-БД, retention (AD-D3).
