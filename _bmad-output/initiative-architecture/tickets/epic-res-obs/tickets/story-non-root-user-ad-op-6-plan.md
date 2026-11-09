---
title: 'Hardening: non-root USER во всех 7 app-образах (AD-OP-6)'
type: 'feature'
ticket: '1'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
  - docs/capacity-admission.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-OP-6 «Prevents: root во всех 7 контейнерах (H3)». В main ни один из 7 app-Dockerfile (services/{api-gateway,catalog-service,feature-flags-service,oauth2-bridge,rag-sync-service,skills-service}/Dockerfile, frontend/Dockerfile) не содержит `USER` — все app-контейнеры работают как root. Компрометация любого сервиса (RCE через обработчик) даёт root внутри контейнера с writable-томом (projects, skills, backups, model-weights) и секретами в /run/secrets.

**Approach:** (1) `USER` с выделенным non-root uid в 7 app-Dockerfile (uid = единая константа, один и тот же для всех сервисов — упрощает совместные тома; имя/uid — OQ-1); (2) writable-пути принадлежат service-user: chown в Dockerfile для image-owned путей (/app/data/skills, /app/backups, /app/runtime-artifacts, /app/bridge-dist — read) + для volume-монтированных путей (/data/projects, /data/models, skills, backups) — volume пересоздаётся при смене uid, фикс = init-обработка в setup (production-init) либо document «первый старт после изменения uid — volumes пересоздаются» (OQ-2); (3) frontend/nginx: порты 8080/8443 > 1024 (template :7,:10) — master может быть non-root, привилегированных портов нет; (4) cap-audit: cap_drop [ALL] (model, catalog, capacity-collector) и no-new-privileges (x-service anchor :6) — сверить, что non-root не ломает bwrap-упаковку catalog (bwrap работает без host-caps — комментарий compose :122); (5) внешние образы (ollama/ollama, pgvector) — вне скоупа (не app-образы; зафиксировано в плане и в доке).

## Boundaries & Constraints

**Always:**
- Один non-root uid для всех 7 app-образов (единая константа в Dockerfile'ах + модель entry 2).
- Все текущие writable-пути продолжают работать (projects, skills, backups, runtime-artifacts, model-weights у catalog, tmp).
- no-new-privileges + cap_drop — не ослабляются.
- Volume-смена uid = задокументированное действие (OQ-2).

**Never:**
- Не менять uid внешних образов (ollama, pgvector) — это не app-образы.
- Не добавлять cap_add ради non-root (DAC_OVERRIDE у capacity-collector не трогать).
- Не менять структуру образов/пути /app (только USER + chown).
- Не трогать pids/mem-лимиты (entry 2).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Production-старт | docker compose up (production) | все 7 app-контейнеров green, healthchecks /ready 200 |
| 2 | Проверка uid | docker exec <container> id | UID ≠ 0 во всех 7 |
| 3 | Запись в volume | RAG-запись/skill-save/backup | запись успешна (владельство volume ок) |
| 4 | Старый volume (root-owned) | стек стартует поверх старых томов | явная ошибка/действие: volumes пересоздаются или chown через setup (OQ-2) — без молчаливого read-only-состояния |
| 5 | bwrap-упаковка (catalog) | package-build (bwrap sandbox) | работает как до (bwrap без host-caps) |
| 6 | nginx master | frontend старт | master non-root, 8080/8443 слушают |
| 7 | setup-профили | database-init/bootstrap-admin (catalog-образ) | работают non-root (CLI-пути: /app, secrets) |

## Code Map

- `services/api-gateway/Dockerfile` — без USER (grep USER: только NPM_CONFIG_USERCONFIG :21); WORKDIR /app
- `services/catalog-service/Dockerfile` — без USER; writable: /data/projects (PROJECTS_ROOT), /app/backups (BACKUP_DIR), /app/runtime-artifacts (RUNTIME_ARTIFACT_DIR), /data/models (MODEL_STORAGE_PATH) — compose.production.yml:142-152, :155
- `services/feature-flags-service/Dockerfile` — без USER; writable: только tmp (no volumes, compose :166-187)
- `services/oauth2-bridge/Dockerfile` — без USER; writable: tmp
- `services/rag-sync-service/Dockerfile` — без USER; volumes: projects:/data/projects (rw, compose :231 — до :ro-фикса epic-data entry 4), capacity :ro
- `services/skills-service/Dockerfile` — без USER; writable: /app/data/skills (compose :199, :203)
- `frontend/Dockerfile` — без USER; nginx master; template :7 (8080), :10 (8443) — порты > 1024
- `compose.production.yml:2-10` — x-service anchor: no-new-privileges, init, restart (не менять)
- `compose.production.yml:120-126` — catalog: cap_drop [ALL] + seccomp + bwrap-комментарий (:122)
- `compose.production.yml:63-90` — capacity-collector: cap_add [DAC_OVERRIDE] (не app-сервис, но тот же образ — non-root должен работать и здесь; DAC_OVERRIDE покрывает чтение чужих statfs)
- `deploy/production/environment-model.json` — поле user добавляет entry 2 (здесь — только Dockerfile)

## Tasks & Acceptance

### Execution
- [ ] Выбрать uid (OQ-1; рекомендация 1000) + имя; константа в каждом Dockerfile (ARG SERVICE_UID, дефолт = константа)
- [ ] 7 Dockerfile: `USER ${SERVICE_UID}` после WORKDIR + chown image-owned writable-путей (RUN chown -R)
- [ ] frontend: USER в Dockerfile (nginx: master non-root — проверить, что envsubst/command работает non-root; template :303)
- [ ] Volume-владельство: задокументировать (docs) + решение по старым toмам (OQ-2; рекомендация: setup/production-init CLI проверяет владельство mount-точек и даёт явную ошибку с действием — не тихий fail)
- [ ] cap-audit: сверить cap_drop/no-new-privileges/seccomp — non-root не требует cap_add (тест: стек стартует без добавления cap_add)
- [ ] bwrap-regression: package-build smoke (тест catalog, sandbox-упаковка)
- [ ] Live-проверка (dev-стек): `docker compose exec <svc> id` — UID ≠ 0 во всех 7
- [ ] Задокументировать: внешние образы (ollama/pgvector) вне non-root-скоупа (docs/capacity-admission.md или док эпика)

### Acceptance
- **Given** production-стек (или dev-стек как прокси) **when** `docker compose exec` id в каждом app-контейнере **then** UID ≠ 0 в 7/7
- **Given** RAG-запись/skill-save/backup-операция **when** после non-root-смены **then** записи успешны (regression)
- **Given** bwrap-упаковка (catalog package-build) **when** non-root **then** sandbox работает (regression-тест)
- **Given** frontend **when** старт **then** nginx master non-root, 8080/8443 слушают, /ready 200

## Design Notes

- Единый uid для всех сервисов — осознанное решение: shared volumes (projects/skills/backups) монтируются несколькими сервисами; разные uid = постоянные конфликты владельства. Риск (общий uid между доверенными сервисами) принимается: backend-сеть closed, сервисы одного trust-domain (AD-OP-7(5) residual).
- `init: true` (anchor :4) остаётся: non-root PID 1 с tini — ok.
- model-runtime (ollama) и postgres (pgvector) — внешние образы: ollama работает root'ом (свой выбор), postgres — от пользователя postgres внутри образа; AD-OP-6 говорит «7 app-образах» — это 6 Node + frontend.
- database-init/bootstrap-admin используют catalog-образ — non-root наследуется автоматически.
- seccomp-профиль catalog (docker/seccomp/catalog-packager.json) — проверить совместимость с non-root (bwrap-системные вызовы); если seccomp блокирует — править профиль (в скоупе).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
# Сборка + dev-стек:
docker compose build && docker compose up -d
for s in api-gateway catalog-service feature-flags-service oauth2-bridge rag-sync-service skills-service frontend; do
  docker compose exec -T $s id
done
# Ожидаемо: uid=1000 во всех 7; healthchecks:
docker compose ps
```
Ожидаемо: 7/7 UID ≠ 0, стек green; корневой сьют — без деградации против baseline (npm test в сервис + scripts/test/).

## Open Questions

1. **uid/имя**: 1000 (рекомендация) vs 10001+ (избежать конфликтов с host-uid при bind-mount'ах)? Рекомендация: 1000 — volumes docker-managed (не bind), конфликтов нет; зафиксировать в доке.
2. **Старые (root-owned) volumes при миграции**: (a) setup-CLI проверяет владельство и даёт явную ошибку + инструкцию (пересоздание/backup-restore), (b) автоматический chown через privileged-один раз, (c) document «volumes пересоздаются». Рекомендация: (a) — fail-closed, без privileged-обходов.
3. **nginx non-root master vs worker-only non-root**: template слушает 8080/8443 (>1024) — полный non-root возможен; если будущий edge потребует 80/443 — revert-план: cap_add NET_BIND_SERVICE (зафиксировать как residual в доке).
