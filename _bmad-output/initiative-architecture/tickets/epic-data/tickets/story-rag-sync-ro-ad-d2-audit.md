---
title: 'rag-sync: fs-audit projects-volume (AD-D2)'
type: 'audit'
created: '2026-11-09'
status: done
baseline_revision: 'dd79112146dfc923747b06c76d27f71c7450b371'
related_plan: 'story-rag-sync-ro-ad-d2-plan.md'
---

# FS-аудит rag-sync-service: доступ к projects-volume

Аудит по задаче entry 5.4 (AD-D2): подтвердить, что rag-sync-service **не пишет** (и вообще не обращается) к файловому хранению проектов, до перевода монтирования `projects:/data/projects` в `:ro`.

**Вердикт: 0 фактических fs-write; ни одного обращения к FS проектов. Перевод в `:ro` безопасен.**

## Метод

Гrep-аудит по `services/rag-sync-service/` (src + интеграционные тесты + конфиги) + ручной ревью env-инвентаря. Все команды исполнены в worktree `entry-5-4` (main `dd791121`).

### Формула плана (как есть)

```bash
grep -rn "writeFile\|mkdirSync\|rm(\|rename(\|unlink(" services/rag-sync-service/src/ | grep -v test
```

Сырой результат: **2 hits — оба ложные** (подстрока `rm(` внутри SQL-функции `vector_norm(`, не fs-вызов):

| Файл:строка | Совпадение | Природа |
|---|---|---|
| `src/rag/rag-search.ts:99` | `vector_dims(embedding)=… vector_norm(embedding)>0` | SQL-текст (pgvector), не fs |
| `src/rag/rag-index-state.ts:106` | `vector_norm(embedding)>0 AND vector_dims(embedding)=…` | SQL-текст (pgvector), не fs |

### Уточнённая формула (повторяемая, без ложных срабатываний)

```bash
grep -rnE "\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|unlink|unlinkSync|rename|renameSync|rm|rmSync|rmdir|rmdirSync|copyFile|createWriteStream|openSync|open)\s*\(" services/rag-sync-service/src/ --include="*.ts" | grep -v "\.test\."
```

Результат: **0 hits**.

### Дополнительные срезы

| Проверка | Команда (сокращённо) | Результат |
|---|---|---|
| Импорты FS-модулей | `grep -rn "from 'node:fs" services/rag-sync-service/src/` | **0** — в сервисе нет ни одного импорта `node:fs` / `fs/promises` (включая тесты) |
| Упоминания пути проектов | `grep -rn "data/projects" services/rag-sync-service/` | **0** — путь `/data/projects` в коде сервиса не фигурирует |
| FS-переменные в env-инвентаре | ревью env `rag-sync-service` в `deploy/production/environment-model.json` + `process.env.*` в src | **0** — см. инвентарь ниже |
| Dockerfile: volume/`/data` | `grep -n "projects\|VOLUME\|/data" services/rag-sync-service/Dockerfile` | **0** — образ сам каталог не создаёт и не использует |

### Env-инвентарь rag-sync-service (production)

Все env-переменные, читаемые кодом (src, вне тестов): `NEUROCENTER_INTERNAL_TOKEN`, `CATALOG_SERVICE_URL`, `RAG_PG_URL`, `RAG_PROVISION_PG_URL`, `RAG_PG_URL_FILE`, `RAG_PROVISION_PG_URL_FILE`, `RAG_AUTH_DISABLED`, `RAG_DEFAULT_QUOTA_BYTES`, `RAG_MAX_QUOTA_BYTES`, `RAG_WRITE_ROLE`, `NODE_ENV`, `PORT`, `BIND_HOST`, `PANEL_URL`, `NEUROCENTER_INTERNAL_TOKEN_FILE`, `NEUROCENTER_METRICS_TOKEN_FILE`, `CAPACITY_REQUIRED`, `FEATURE_FLAGS_SERVICE_URL`.

Классификация: token/HTTP/Postgres-URL/порт/runtime — **ни одной FS-переменной**. Данные RAG — в Postgres (`nc_rag_<sha256[:32]>`, template `nc_rag_template`; `src/rag/project-database-name.ts`, `src/rag/project-databases.ts`), не в файловой системе.

## Расхождение с Code Map плана

План ссылается на `services/rag-sync-service/src/rag/rag-sync-env.ts` («env-инвентарь») — **файл не существует** ни на baseline плана (`3433b1d1`), ни в истории git. Реальный env-инвентарь: `deploy/production/environment-model.json` (секция `rag-sync-service.env` + `requiredEnv`) и `services/shared/runtime.cjs` (`validateProduction`). Вывод аудита от этого не меняется: ни одной FS-переменной.

## Вывод

- Записи на `/data/projects` (и на файловую систему вообще) в rag-sync-service **нет** — монтирование dead (rw без обращения).
- `:ro` безопасно: сервис стартует и работает только через Postgres/HTTP.
- Regression (попытка записи) закреплён drift-тестом volume map (story 6).
- Повторный аудит: уточнённая формула выше — ожидается 0 hits.
