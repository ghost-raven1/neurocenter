---
type: epic
title: "Данные проекта: согласованная модель"
parent: initiative-architecture
covers: [R3, R9, R11]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-data/architecture-data.md]
after: [epic-release-baseline]
refined: false
risk: medium
---

# Данные проекта: согласованная модель

## Description

Один write-owner на volume (AD-D2: model-weights — только через API inference-runtime, artifact-cache — persistent volume + LRU + per-project квота); retention — единая таблица, ~12 unbounded-таблиц → TTL, удаление проекта = полный каскад с квитанцией (AD-D3); quota-поля: модель и схема, удаление из API того, что не enforce'ится (AD-D4) — enforcement-точки сдаёт эпик 6 (P0-RES); crash consistency — 4 канонических паттерна (AD-D5); данные проекта (PG, per-project RAG-БД, model-weights, artifact-cache) входят в DR-бандл эпика 4 — write-owner и crash consistency гарантируют согласованность восстановленного состояния (часть R3). Версионирование схемы — базис из эпика 1 (AD-D1).

## Outcome

Для команды: данные проекта имеют единого владельца записи, единый retention и crash consistency — restore (эпик 4) восстанавливает согласованное состояние (сигнал: PRD C3, NFR-6).

## Done when

1. Один write-owner на каждый volume (AD-D2).
2. Retention — единая таблица; ~12 unbounded-таблиц имеют TTL (AD-D3).
3. Удаление проекта = полный каскад (БД + файлы + S3 + RAG-БД) с квитанцией (AD-D3).
4. Quota-поля: модель и схема; то, что не enforce'ится, удалено из API (AD-D4); enforcement-точки — эпик 6.
5. Crash consistency: 4 канонических паттерна (AD-D5).
6. Миграции идут через единое версионирование схемы (AD-D1, из эпика 1).

## Boundaries

- Enforcement-точки квот и лимитов — эпик epic-res-obs.
- DR-механика (backup/restore) — эпик epic-dr; этот эпик гарантирует, что данные консистентны для restore.
- RAG-purge/snapshot на уровне проекта (FR-103/104) — эпик epic-project.

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R3, R9, R11)
- architecture — _bmad-output/initiative-architecture/architecture-data/architecture-data.md (AD-D1..AD-D5)

## Notes

- Unknown: M-6 — путь GGUF→ollama в AD-D2 не зафиксирован (dual-writer в compose.production.yml); ждёт решение пользователя на точечный фикс spine; gate для model-weights части.
- Waits on epic-release-baseline because: единое версионирование схемы (AD-D1).
