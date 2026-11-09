---
title: 'Artifact cache gateway: персистентный volume + LRU + per-project квота (AD-D2)'
type: 'feature'
ticket: '2'
created: '2026-11-09'
status: done
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'high'
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

**Problem:** MCP artifact cache api-gateway живёт в `tmpdir()` (artifact-cache.ts:14-15: `NEUROCENTER_MCP_HOST_DIR || tmpdir`), а env в compose не задан — кэш не персистентен (сгорает при рестарте gateway), не ограничен (рост без bound → переполнение tmp/диска), и у него нет per-project квоты (один host может съесть место всех). AD-D2: volume с квотой, eviction, один write-owner.

**Approach:** (1) новый volume `artifact-cache` (compose + environment-model.json) + env `NEUROCENTER_MCP_HOST_DIR=/data/gateway/mcp-host` у gateway (requiredEnv map: env → reason; env-локация — часть config-схемы gateway по AD-D2); (2) LRU-эвиктор в `build()` по **oldest-access** (механизм AD-D2): после записи, если used-bytes проекта (accounting story 1, измерение `current`) > limit → удалять `.ready`-файлы проекта с самым старым доступом до limit; last-access = записанный в sidecar-мап (touch при materialize-чтении и build), atime ФС не используется (noatime — ненадёжен); кэш content-addressed → эвикция безопасна (файл детерминированно достроится из того же контента); (3) global cap — OQ-2. Паттерн записи tmp+rename+fsync (AD-D5 pattern 1, artifact-cache.ts:39-120) не трогается.

## Boundaries & Constraints

**Always:**
- Content-addressing (sha256-путь) и протокол записи (.tmp → rename → .ready, fsync) — из artifact-cache.ts:19-120, не меняется.
- Атрибуция проекта через `claim.session.projectId` (ticket.ts:24-30): каждый записываемый файл знает проект.
- Эвикция только `.ready`-файлов проекта, чей used > limit; никогда не удалять чужой проект и не-`.ready` (чужие tmp-файлы — чужой writer).
- used-bytes — из accounting story 1 (таблица project_quota_usage), не отдельный счётчик; эвикция (дельта минус) — через тот же accounting API (единая точка).
- LRU по oldest-access (AD-D2): last-access = запись в sidecar-мапе (update при materialize и build), не atime/mtime ФС.

**Never:**
- Не менять протокол materialize (client API) — отсутствующий файл = тот же ответ, что сейчас.
- Не полагаться на atime/mtime ФС (noatime/relatime — семантика нестабильна).
- Не хранить в кэше то, что не content-addressed.

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Рестарт gateway | данные в volume + sidecar-мап | кэш жив (materialize находит файлы); last-access сохранён в мапе |
| 2 | Запись в пределах лимита | build (projectId, content) | файл записан, last-access обновлён, eviction нет |
| 3 | Запись сверх лимита | used > limit после build | файлы с самым старым доступом удалены до limit; новый файл на месте |
| 4 | limit=0 (unlimited) | любой build | eviction нет (по AD-D4 семантике) |
| 5 | materialize существующего | sha + файл | чтение + last-access touch (влияет на порядок eviction) |
| 6 | materialize отсутствующего | sha без файла | текущее поведение (ошибка ENOENT-класса) без изменения; мап-запись удаляется (stale) |
| 7 | Конкурентный build | один gateway = один процесс (host.ts:40 MAX_HOSTS=4) | протокол tmp+rename без изменений, дублей нет |
| 8 | Эвикция во время чтения materialize | rm во время read | читатель: EBUSY/ESTALE = та же ошибка, что при отсутствии (кэш — оптимизация, не источник истины) |
| 9 | Одинаковый контент, 2 проекта | build с тем же sha из 2 проектов | один физический файл (content-addressed), used-дельта на каждый проект (OQ-1) |

## Code Map

- `services/api-gateway/src/features/mcp-host/artifact-cache.ts:14-15` — `cacheRoot() = NEUROCENTER_MCP_HOST_DIR || tmpdir` (корень кэша), :19-37 — materialize (sha-путь → read), :39-120 — build (tmp + sha-верификация + .ready + rename)
- `services/api-gateway/src/features/mcp-host/ticket.ts:19-30` — `IHostedMcpSession {sessionKey, projectId, hostKey}`, claim
- `services/api-gateway/src/features/mcp-host/host.ts:40` — MAX_HOSTS=4 (один процесс gateway)
- `compose.production.yml:155-158` — gateway-монтирования (добавить artifact-cache volume), :332-340 — список volumes
- `deploy/production/environment-model.json` — volumes + requiredEnv map (добавить volume + `NEUROCENTER_MCP_HOST_DIR` с reason)
- `scripts/production/environment-model.mjs:268-290` — structuralDrift (сравнивает compose и model)
- `services/catalog-service/src/catalog/catalog.controller.ts:112-143,171-197` — quota API (источник limit) — story 1
- `scripts/test/check-tooling-tests.json` — реестр tooling-тестов

## Tasks & Acceptance

### Execution
- [ ] compose.production.yml: volume `artifact-cache`, gateway-монтирование `artifact-cache:/data/gateway/mcp-host`, env `NEUROCENTER_MCP_HOST_DIR`
- [ ] environment-model.json: volume + requiredEnv entry (reason: «per-project MCP-artifact cache с LRU-квотой (AD-D2)»)
- [ ] sidecar-мап `index.json` (или per-sha `.meta`): sha → {projectId, lastAccess, bytes}; update при build и materialize (touch)
- [ ] artifact-cache.ts: `evictProject(projectId, limit, usedBytes)` — `.ready`-файлы проекта из мапа, sort lastAccess asc, rm до limit + дельта минус в accounting (story 1); вызов в `build()` после успешной записи (только если limit > 0)
- [ ] Source limit/used: accounting story 1 (gateway → catalog quota API / internal quota-usage)
- [ ] Тесты: LRU эвикционирует файлы с самым старым доступом; materialize обновляет lastAccess и меняет порядок; limit=0 → нет eviction; content-addressed идентичность; рестарт-персистентность (fixture volume dir + мап)
- [ ] Drift-тест: environment-model + compose согласованы

### Acceptance
- **Given** проект с кэшем 100МБ при лимите 50МБ **when** build нового файла **then** `.ready`-файлы с самым старым доступом удалены, used ≤ 50МБ, новый файл доступен через materialize
- **Given** файл A (старый доступ) и B (свежий) **when** materialize B, затем build сверх лимита **then** эвикционируется A, B остаётся
- **Given** рестарт gateway **when** materialize известного sha **then** файл читается (volume персистентен), lastAccess восстановлен из мапа
- **Given** limit=0 **when** build **then** eviction не вызывается

## Design Notes

- Кэш — оптимизация, не источник истины: любой эвиктированный/утонувший файл детерминированно достроится. Это снимает риск «потеряли данные» и делает oldest-access LRU безопасным.
- **oldest-access, а не mtime/atime** — по AD-D2 («eviction по oldest-access при переполнении квоты»). atime/mtime ФС ненадёжны (noatime/relatime, mtime = время записи а не доступа), поэтому last-access ведётся в sidecar-мапе.
- Атрибуция файлов к проекту: путь = sha256(контент), проект нигде не записан. sidecar-мап решает и атрибуцию (projectId), и lastAccess. Content-addressing сохраняется (один физический файл), used-дельта учитывается на каждый проект, который его построил (OQ-1: дельта на каждый проект vs дедуп).
- Global cap (весь volume) — защита от «100 проектов × unlimited». Рекомендация: 10ГБ, OQ-2.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/api-gateway && npm test -- artifact-cache
# drift:
node scripts/test/check-tooling.test.mjs  # OQ-4: точное имя tooling-теста
```
Ожидаемо: LRU-тесты зелёные; drift compose↔model зелёный; `NEUROCENTER_MCP_HOST_DIR` в requiredEnv.

## Open Questions

1. **Used-дельта при дублировании контента**: файл построен 2 проектами (content-addressed) — дельта +N на каждый проект (рекомендация, честно отражает «занимает») vs дедуп (1/N)? Влияет на правдивость eviction per-project.
2. **Global cap**: нужен ли и сколько (рекомендация 10ГБ)?
3. **Формат sidecar-мапа**: единый `index.json` (проще, race при записи — один процесс gateway) vs per-sha `.meta` (проще конкурентность)? Рекомендация: per-sha `.meta` (паттерн .ready уже есть).
4. **Тестовая инфраструктура**: docker в test-окружении недоступен (OQ из эпика) — «рестарт-персистентность» проверяется как fixture-каталог + второй запуск процесса, docker-compose-конфиг — как `docker compose config`-валидация при наличии docker (иначе ручной чек-лист).
