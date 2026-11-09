---
title: 'rag-sync: projects-volume read-only (AD-D2)'
type: 'feature'
ticket: '4'
created: '2026-11-09'
status: done
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/tickets/epic-data/epic-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** rag-sync-service монтирует `projects:/data/projects` с правами **rw** (compose.production.yml:231) — но это dead mount: весь код rag-sync-service не имеет ни одного обращения к файловой системе проектов (данные = Postgres-БД `nc_rag_<sha>` + template-БД; env-инвентарь сервиса — только Postgres/HTTP-переменные, ни одной FS-переменной). По AD-D2 (readers ≤ ro, один write-owner) rw-монтирование у не-write-owner'а — нарушение, зафиксированное в Known Defects.

**Approach:** (1) grep-аудит: подтвердить, что в rag-sync-service нет записи на /data/projects (и вообще нет FS-доступа к проектам); (2) compose: `projects:/data/projects:ro`; (3) зафиксировать: если аудит найдёт запись — рефакторинг записи (не :ro над записью). Drift-тест story 6 закрепит результат.

## Boundaries & Constraints

**Always:**
- Aудит = grep + ревью кода путей (fs-модули: writeFile/mkdir/rm/rename/unlink + /data/projects + process.env.*FS*).
- RAG-операции (embeddings, quota, previews) — через Postgres, не меняются.

**Never:**
- Не удалять монтирование без решения: если сервису реально нужны файлы проектов (например, future: source-документы) — :ro, а не «убрать». Решение: :ro (архитектура: rag-sync = reader проектов, write-ownership данных проектов не у него).
- Не менять env-модель rag-sync (rag-sync-env.ts инвариантен).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Aудит: записи на /data/projects нет | grep | 0 hits → :ro безопасно |
| 2 | Aудит: найдена запись | grep | рефакторинг записи до :ro-совместимости (не «пропустить») |
| 3 | Старт rag-sync с :ro | docker compose up | сервис стартует, health ok |
| 4 | RAG-операция (upsert/quota) | API | работает (Postgres), без изменений |
| 5 | Попытка записи (regression) | тест | EACCES (защита работает) — покрывается drift-тестом story 6 |

## Code Map

- `compose.production.yml:227-232` — rag-sync volumes (`projects:/data/projects` rw — :231), :332-340 — volumes list
- `services/rag-sync-service/src/rag/project-database-name.ts:5` — `nc_rag_<sha256(projectId)[:32]>` (данные в Postgres)
- `services/rag-sync-service/src/rag/project-databases.ts:187-198` — template-БД (Postgres)
- `services/rag-sync-service/src/rag/rag-sync-env.ts` — env-инвентарь (ни одной FS-переменной)
- `deploy/production/environment-model.json:97-101` — rag-sync env (без FS)
- `scripts/production/environment-model.mjs:268-290` — structuralDrift

## Tasks & Acceptance

### Execution
- [ ] Aудит: grep по rag-sync-service на fs-writes (writeFile/mkdirSync/rm/rename/unlink/open with 'w') и на `/data/projects` / `data/projects` / env-переменные с FS-путьми; зафиксировать результат (0 hits — baseline)
- [ ] compose.production.yml: `projects:/data/projects:ro` (стр. 231)
- [ ] (при hits) рефакторинг: перенос записи в owning-сервис или пересмотреть write-owner
- [ ] Тест: compose-конфиг валиден (docker compose config при наличии docker; иначе парсер-тест), rag-sync стартует (integration-тест, если harness позволяет)

### Acceptance
- **Given** rag-sync с :ro-монтированием **when** старт + RAG-операции **then** работает без изменений
- **Given** grep-audit **when** re-run **then** 0 fs-write hits в rag-sync-service
- **Given** drift-тест volume map (story 6) **when** run **then** rag-sync = reader (ro), write-owner projects-volume = catalog (или владелец по story 6)

## Design Notes

- Dead mount — классический случай «правильно по архитектуре, случайно rw по compose». Риск низкий: код не лезет в FS, поэтому :ro не сломает ничего работающего.
- Аудит — защита от «а вдруг я проглядел»: grep + ревью. Если grep находит `open(..., 'w')` — остановиться и разобрать (не «закомментировать»).
- После этой story rag-sync = чистый Postgres-сервис с ro-читалками; это упрощает story 6 (volume map).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/rag-sync-service && npm test
# compose-валидация:
docker compose -f compose.production.yml config --quiet  # если docker доступен
# аудит (повторяемый):
grep -rn "writeFile\|mkdirSync\|rm(\|rename(\|unlink(" services/rag-sync-service/src/ | grep -v test
```
Ожидаемо: rag-sync-тесты зелёные; 0 fs-write hits; compose-конфиг валиден.

## Open Questions

1. **Аудит-формат**: фиксировать результат grep в tickets/epic-data/ (артефакт) или достаточно коммита? Рекомендация: артефакт в tickets (проверка на приёмке).
2. **Future: source-документы**: если rag-sync в будущем начнёт читать файлы проектов — :ro уже даёт это; write-ownership останется у catalog. Подтвердить, что :ro (а не unmount) — правильное решение.
