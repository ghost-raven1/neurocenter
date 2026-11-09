---
title: 'prometheus + alertmanager: compose-сервисы 12→14 + модель + manifest (AD-O6/OP-2)'
type: 'feature'
ticket: '12'
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
  - _bmad-output/initiative-architecture/architecture-observability/architecture-observability.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
  - compose.production.yml
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-O6: мониторинг — часть стека. В main: prometheus.yml + neurocenter-alerts.yml существуют (deploy/production/monitoring/), НО: (1) prometheus/alertmanager — не compose-сервисы (12 сервисов, ни одного мониторинг-контейнера) — scrape-конфиг «висит в воздухе» (кому его раздавать?); (2) alertmanager.yml отсутствует; (3) state-волюмы (tsdb, alertmanager-data) не заданы; (4) release-manifest (AD-OP-2) не покрывает monitoring-образы (images = 7 applicationServices + postgresImage — compose-client.mjs:11-19, release-manifest.mjs:125-131); (5) environment-model (12 сервисов, structuralDrift :258) не знает мониторинг-состав. known-defect entry 8 (ff:4400 в targets) — принимается этой story как consumer.

**Approach:** (1) compose.production.yml: +2 сервиса (12→14): prometheus (образ prom/prometheus pinned, backend-сеть, порты наружу НЕ публикуются; конфиг = deploy/production/monitoring/ volume; state volume prometheus-data; секреты: metrics_token (file /run/secrets/metrics_token — x-runtime-паттерн :17); mem/cpus/pids-лимиты) + alertmanager (prom/alertmanager pinned, backend-сеть, config alertmanager.yml (entry 13), state volume alertmanager-data, лимиты) + шапка: осознанный состав dev 9 / prod 14 (комментарий в compose.production.yml + docker-compose.yml — паттерн D2 эпика 1.12); (2) environment-model.json: +2 сервиса (image, networks, memLimit/cpus/pidsLimit, volumes, env) + drift-тесты: structuralDrift (14) + compose-drift.test.mjs (12→14) + сверка dev↔prod состава (документ: мониторинг только production — dev 9 без prometheus); (3) release manifest (AD-OP-2): новое поле monitoringImages {prometheus, alertmanager} — digest-pinned (паттерн postgresImage: release-manifest.mjs:125-131,416-429) + verify (пересчёт) + preflight; (4) dev-состав: prometheus в dev НЕ добавляется (dev 9 — OQ-1, рекомендация: нет; мониторинг принимается на production-стеке).

## Boundaries & Constraints

**Always:**
- Мониторинг-сервисы — backend-сеть, порты наружу НЕ публикуются (scrape через metrics_token, AD-O3; :1-2 prometheus.yml ратификация).
- Digest-pinned образы (AD-OP-2): monitoringImages — sha256, не :tag (latest запрещён, ратификация AD-OP-5).
- State-волюмы (prometheus-data, alertmanager-data) — named volumes (не bind — DR-бандл, AD-OP-2).
- Лимиты (mem/cpus/pids) у обоих (entry 2 ресурсная таблица — единый источник; значения OQ-2).
- Dev/prod-состав задокументирован (шапки compose — паттерн D2).

**Never:**
- Не публиковать 9090/9093 наружу (только backend-сеть; OQ-3 — доступ оператора).
- Не вносить prometheus в dev-состав (dev 9 — фиксированный; OQ-1).
- Не менять prometheus.yml/neurocenter-alerts.yml в этой story (entry 8 — targets, entry 13 — rules/alertmanager.yml).
- Не вносить monitoring в applicationServices (applicationServices = 7 app — deploy/update-flow; monitoring = отдельное поле manifest, не application-сервис).
- Не менять x-service anchor (мониторинг-сервисы — не app, anchor не обязателен; OQ-4: использовать anchor или нет).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | compose up (production) | 14 сервисов | prometheus+alertmanager healthy (healthcheck), backend-сеть |
| 2 | Порты наружу | docker port | 9090/9093 не опубликованы (только internal) |
| 3 | Scrape | prometheus → 6 сервисов | up=1 (entry 8 targets) |
| 4 | structuralDrift | model↔compose (14) | 0 drift |
| 5 | compose-drift | счёт сервисов | 14 (was 12) |
| 6 | manifest verify | build | monitoringImages {prometheus, alertmanager} — sha256, verify OK |
| 7 | Deploy с manifest | pinned overlay | prometheus/AM = image ID манифеста |
| 8 | Dev-стек | docker compose up (dev) | 9 сервисов (без prometheus/AM) — документ |
| 9 | Restart prometheus | docker restart | state volume сохраняется (tsdb не теряется) |
| 10 | Оператор-доступ | curl 9090 | не снаружи (OQ-3: ssh-tunnel / docker exec) |

## Code Map

- `compose.production.yml:2-10` — x-service anchor; :12-17 — x-runtime (secrets-паттерн); 12 сервисов (:19-316)
- `docker-compose.yml` — dev-состав (9 сервисов; шапка D2)
- `deploy/production/monitoring/prometheus.yml:1-22` — scrape-конфиг (consumer: volume /etc/prometheus)
- `deploy/production/monitoring/neurocenter-alerts.yml` — rules (consumer: rule_files :8)
- `deploy/production/environment-model.json` — 12 сервисов (model)
- `scripts/production/environment-model.mjs:258` — structuralDrift (12 → 14)
- `scripts/test/compose-drift.test.mjs:78` — assert count 12 → 14
- `scripts/production/compose-client.mjs:11-19` — applicationServices (7, НЕ менять — monitoring отдельно)
- `scripts/production/release-manifest.mjs:125-131` (build: images+postgresImage), `:173-179` (verify), `:416-429` (image-ID из docker) — паттерн monitoringImages
- `scripts/production/setup.mjs` — up/seed (monitoring-сервисы поднимаются вместе со стеком)
- `scripts/test/workspace-check-tooling.test.mjs` + `scripts/workspace/check-tooling-tests.json` — регистрация новых тестов

## Tasks & Acceptance

### Execution
- [ ] compose.production.yml: + prometheus (image pinned — OQ-2 digest, /etc/prometheus volume из deploy/production/monitoring/, state volume prometheus-data, secrets [metrics_token], mem/cpus/pids, healthcheck promtool/wget /-/healthy, backend-сеть, no ports)
- [ ] compose.production.yml: + alertmanager (image pinned, /etc/alertmanager volume, state volume alertmanager-data, mem/cpus/pids, healthcheck wget /-/healthy, backend-сеть, no ports; config = entry 13 — placeholder-конфиг до entry 13)
- [ ] Шапки: compose.production.yml + docker-compose.yml — «dev 9 / prod 14: мониторинг только production» (паттерн D2)
- [ ] environment-model.json: +2 сервиса (image, networks:[backend], memLimit/cpus/pidsLimit, volumes, env, secrets) — schema модели
- [ ] Drift-тесты: structuralDrift 14 (environment-model.mjs), compose-drift.test.mjs 12→14, dev↔prod сверка (документ: мониторинг только prod)
- [ ] release-manifest.mjs: monitoringImages {prometheus, alertmanager} (build :416-429 паттерн postgresImage; verify :173-179; validate :105-108 imagePattern)
- [ ] Preflight/setup: мониторинг-образы в supply-описи (pull из локального registry — OQ-5)
- [ ] Тесты: manifest-monitoring.test.mjs (schema monitoringImages, verify), compose 14-сервисов (regression), healthcheck-тест (live: prometheus /-/healthy)
- [ ] Регистрация: check-tooling-tests.json + expectedFiles (новые тесты)

### Acceptance
- **Given** compose up (production) **when** 14 сервисов **then** prometheus+alertmanager healthy, backend-сеть, порты наружу не опубликованы
- **Given** environment-model **when** structuralDrift **then** 14 сервисов, 0 drift; compose-drift: 14 (was 12)
- **Given** build **when** manifest **then** monitoringImages {prometheus, alertmanager} — sha256; verify OK
- **Given** dev-стек **when** up **then** 9 сервисов (без мониторинга) — документ D2
- **Given** restart prometheus **when** state volume **then** tsdb сохранён

## Design Notes

- **Мониторинг = compose-сервисы, а не host-daemon'ы:** единый lifecycle (up/down/DR-бандл), secrets-механизм (metrics_token), сети (backend). Host-daemon'ы = отдельный механизм деплоя (systemd) — дублирование supply/DR.
- **applicationServices НЕ расширяется:** applicationServices = 7 app (deploy/update-flow, assertLive, topology). Мониторинг — не application-сервис (не деплоится через update-flow как app, не в assertLive-семантике). Отдельное поле manifest (monitoringImages) — паттерн postgresImage (тоже не applicationService).
- **Digest-pinned (AD-OP-2):** prometheus/alertmanager — внешние образы (не собирается из Dockerfile'а). Pin = digest из локального registry (OQ-5: доступность в контуре). latest запрещён (AD-OP-5 ратификация).
- **State-волюмы (named):** tsdb + alertmanager-data — named volumes (docker-managed, DR-бандл AD-OP-2: docker save/load + volume). Bind-mount'ы — нет (host-зависимость).
- **Healthcheck:** prometheus /-/healthy (liveness) + (опционально) /-/ready; alertmanager /-/healthy. Simple wget (в образе есть? — OQ: curl vs wget vs promtool; рекомендация — wget, в prom-образах есть).

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/compose-drift.test.mjs        # 14 сервисов
node --test scripts/test/manifest-monitoring.test.mjs  # monitoringImages schema/verify
node --test scripts/test/environment-model.test.mjs    # structuralDrift 14
# Live (production-стек):
docker compose -f compose.production.yml up -d
docker compose -f compose.production.yml ps   # prometheus+alertmanager healthy
docker compose -f compose.production.yml port api-gateway   # 9090/9093 отсутствуют
```
Ожидаемо: 14 сервисов, 0 drift, monitoringImages в manifest, healthy, порты наружу нет; корневой сьют — без деградации.

## Open Questions (с рекомендациями)

1. **Prometheus в dev?** Рекомендация: нет (dev 9 фиксирован; мониторинг принимается на production-стеке; dev-мониторинг = расширение, не P0-RES). Документ D2: «мониторинг только production».
2. **Лимиты prometheus/AM (mem/cpus/pids)**: prometheus 1g/2/512, alertmanager 256m/0.5/128 (рекомендация — tsdb 15s-скрейп, 6 сервисов, ~7 дней retention в 1g). OQ: retention-период (OQ-5) влияет на mem. Рекомендация: prometheus 1g/2/512, AM 256m/0.5/128; retention 7d (OQ-5).
3. **Доступ оператора к 9090/9093**: наружу не публикуем (backend-сеть). Рекомендация: ssh-port-forward / docker exec (документ в production-setup.md). OQ: если оператор требует UI — отдельный reverse-proxy (не в P0).
4. **x-service anchor для мониторинга**: anchor = no-new-privileges/init/restart/logging (app-политика). Рекомендация: использовать anchor (единая политика security_opt/init/logging) + per-service overrides (image/limits) — консистентно.
5. **Доступность образов в закрытом контуре**: prom/prometheus + prom/alertmanager — в локальном registry? Рекомендация: пин digest'ов на impl + provisioning оператором (pull в локальный registry) + проверка pull'а на приёмке entry 15 (HITL). Если registry нет — DR-бандл (docker save/load, AD-OP-2).
6. **Retention-период tsdb**: 7d (рекомендация — 1g, 15s-скрейп, 6×~50 series ≈ поместится) vs 15d (нужно 2g). Рекомендация: 7d (P0-RES; 15d = расширение).
