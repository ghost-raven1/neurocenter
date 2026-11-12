---
title: 'Stack-watchdog (AD-OP-8) + node_exporter: consumer /ready/dependencies'
type: 'feature'
ticket: '8'
created: '2026-11-09'
status: done
baseline_revision: '56f8c009cf0c9cb9d18091c5176c36831eb981cd'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-dr/epic-dr.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-res-obs/tickets/story-health-ready-ad-o4-plan.md'
  - '{project-root}/docs/implementation-readiness.md'
  - '{project-root}/compose.production.yml'
  - '{project-root}/deploy/production/environment-model.json'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-OP-8 (architecture-operational.md:81): «на хосте (systemd, `User=neurocenter-operator`): maintenance timer (есть — ратификация) + **stack-watchdog** (новый unit: периодическая проверка health всех compose-сервисов + самого мониторинга; сбой = алерт + attempt-restart по политике compose) + node_exporter (host-level); prometheus/alertmanager — **compose-сервисы** (AD-O6, не systemd — единая топология)». Состояние main: watchdog/node_exporter **отсутствуют** (deploy/maintenance/ = только neurocenter-maintenance.{service,timer}; compose = 12 сервисов без node_exporter; environment-model — 12). При этом **контракт уже дан**: ep6 entry 9 (health, `story-health-ready-ad-o4-plan.md:27,106`) фиксирует — `/ready/dependencies` (gateway app.controller.ts:15-32, 5 upstream'ов) ОСТАЁТСЯ, consumers: **stack-watchdog (AD-OP-8, эпик 4)** + admin UI; решение «**удалить, если к концу эпика 4 не подключён**» — «Ревизия = задача эпика 4». Без этого entry endpoint живёт без consumer'а и к концу эпика 4 подлежит удалению — теряется диагностика. Coverage-аудит G-2: GAP.

**Approach:** (1) **stack-watchdog**: `scripts/production/stack-watchdog.mjs` (подкоманда `check`: снимает health всех compose-сервисов + /ready/dependencies + мониторинг) + systemd-юниты `neurocenter-stack-watchdog.{service,timer}` (User=neurocenter-operator, OnCalendar ~5 min, Persistent, паттерн neurocenter-maintenance.timer :1-18). Список сервисов = **data-driven из environment-model.json** (не хардкод) — новые compose-сервисы (prometheus/alertmanager ep6 entry 12) подхватываются автоматически, без правки watchdog: на момент entry состав = 13 (12 + node_exporter), после ep6 entry 12 = 15. Логика сбоя (по AD-OP-8: «сбой = алерт + attempt-restart по политике compose»): сервис down → bounded attempt-restart (`docker compose restart <svc>`, максимум N попыток за окно, без infinite-loop) + алерт (alertmanager ep6 entry 13, если развёрнут; до — journal + файл alerts.jsonl, паттерн delivery ep6 e13); restart не помог → только алерт (эскалация оператору). /ready/dependencies (gateway) — **consumer** (контракт ep6 e9 закрыт: endpoint подключён, решение «удалить» не срабатывает). (2) **node_exporter**: compose.production.yml сервис (12→13; **целевой состав prod после ep6 entry 12 = 15** — синхронизация с ep6-планом, OQ-1): prom/node-exporter (digest-pinned, AD-OP-2), backend-сеть, порты наружу НЕ публикуются, read-only host-маунты (/proc:ro, /sys:ro, /:ro, /var/lib/docker:ro) + mem/cpus/pids + environment-model (13) + drift-тест (structuralDrift + compose-drift счёт 12→13) + release-manifest (паттерн postgresImage/monitoringImages) + scrape-target в prometheus.yml (9100, backend-сеть; доносит ep6 entry 8/12 — completeness «каждый сервис в scrape targets», AD-OP-8).

## Boundaries & Constraints

**Always:**
- Watchdog — systemd (host-level, User=neurocenter-operator), паттерн deployment = neurocenter-maintenance.{service,timer} (deploy/maintenance/).
- Список проверяемых сервисов — из environment-model.json (data-driven, AD-OP-1): изменение состава стека не требует правки watchdog.
- Проверки: /ready на каждый сервис (compose healthchecks = /ready — ратификация) + /ready/dependencies (gateway, 5 upstream'ов) + мониторинг (prometheus/alertmanager — absent-tolerant до ep6 entry 12).
- Сбой = алерт + attempt-restart по политике compose (AD-OP-8); restart bounded (максимум попыток + окно), повторный сбой = только алерт.
- Формат ответа /ready ({ok, checks}) — не менять (consumers: compose healthcheck, httpReady readiness.cjs, stack-watchdog — эп6 e9 Never).
- node_exporter — compose-сервис (единая топология, AD-OP-8: monitoring = compose, не systemd): backend-сеть, без публикуемых портов, digest-pinned (AD-OP-2/OP-5: latest запрещён), read-only host-маунты.
- environment-model.json + drift-тесты обновляются синхронно с compose (AD-OP-1, паттерн ep6 entry 12).
- release-manifest: digest node_exporter — верифицируется (паттерн postgresImage/monitoringImages).

**Never:**
- Не хардкодить список сервисов в watchdog (data-driven — иначе «новые сервисы не подхватываются»).
- Не публиковать 9100 (node_exporter) наружу — только backend-сеть (scrape prometheus'ом).
- Не вводить watchdog-логику в compose (не healthcheck, не depends_on) — host-level supervision, отдельный слой.
- Не дублировать alerting-механизм (ep6 entry 13) — watchdog только генерирует событие/сигнал; доставка — AD-O6.
- Не трогать compose healthchecks сервисов (уже /ready — regression-тест).
- Не удалять /ready/dependencies (контракт ep6 e9: consumer подключён этим entry — решение «удалить, если к концу эпика 4 не подключён» закрыто подключением).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Сервис down | catalog-service 503 | watchdog: детект ≤ интервала → attempt-restart → healthy (fixture-тест) |
| 2 | Restart не помог | 2 сбоя подряд | bounded: N попыток → только алерт (эскалация) |
| 3 | /ready/dependencies | rag down | 503 + checks — watchdog видит (consumer) |
| 4 | Мониторинг ещё нет (до ep6 e12) | prometheus absent | absent-tolerant: не сбой watchdog (OQ-4) |
| 5 | Новый сервис в модели | environment-model +1 | watchdog подхватывает (data-driven, тест) |
| 6 | node_exporter up | compose 13 | 9100 в backend-сети, наружу не опубликован |
| 7 | Drift | compose 13 vs model 13 | structuralDrift/compose-drift зелёные |
| 8 | Manifest | build | digest node_exporter верифицирован |
| 9 | Timer | OnCalendar 5min | Persistent (пропущенные тики после downtime догоняются) |

</frozen-after-approval>

## Code Map

**Существующее (паттерны):**
- `deploy/maintenance/neurocenter-maintenance.{service,timer}` — systemd-паттерн (User=neurocenter-operator, OnCalendar, Persistent, EnvironmentFile) — ОБРАЗЕЦ для watchdog-юнитов.
- `compose.production.yml:1-10` (x-service anchor), `:19-316` (12 сервисов), `:317-328` (secrets), `:329-331` (networks backend/edge).
- `docker-compose.yml:1-5` — шапка «осознанный состав dev 9 / prod 12» (паттерн D2 — обновить на prod 13→15).
- `deploy/production/environment-model.json` — 12 сервисов (model, AD-OP-1); `scripts/production/environment-model.mjs:258` — structuralDrift.
- `scripts/test/compose-drift.test.mjs:76-78` — `assert.equal(Object.keys(services).length, 12)` — обновить (12→13 здесь; 13→15 — ep6 e12, OQ-1).
- `services/api-gateway/src/app.controller.ts:15-32` — /ready/dependencies (5 upstream'ов: catalog/skills/rag/auth/featureFlags) — consumer-контракт.
- `services/shared/readiness.cjs` — checkReadiness/httpReady (бюджеты — ep6 entry 9, не трогать).

**Мониторинг-конфиг (существует, сервисы — ep6 e12):**
- `deploy/production/monitoring/prometheus.yml:1-22` — scrape-конфиг (+ node_exporter target 9100 — OQ-5: в этот entry или ep6 e12).
- `deploy/production/monitoring/neurocenter-alerts.yml` — 9 базовых правил (+ stack-down/cert-expiry — ep6 e13).

**Manifest (AD-OP-2):**
- `scripts/production/release-manifest.mjs:125-131,416-429` — build/verify image digests (паттерн postgresImage/monitoringImages для node_exporter).
- `scripts/production/compose-client.mjs:11-19` — applicationServices (7 app — node_exporter НЕ сюда, паттерн ep6 e12).

**Контракт:**
- `_bmad-output/.../architecture-operational/architecture-operational.md:81` (AD-OP-8), `:131` (structural seed: «новые: stack-watchdog.service … node_exporter.service» — см. OQ-2), `:105` (Consistency: «watchdog на стек и на мониторинг»).
- ep6 entry 9 (`tickets/epic-res-obs/tickets/story-health-ready-ad-o4-plan.md:27,34,39,106`) — /ready/dependencies consumer + решение «удалить, если к концу эпика 4 не подключён».
- ep6 entry 12 (`tickets/epic-res-obs/tickets/tickets.toml`) — prometheus+alertmanager 12→14 (sync: OQ-1).

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/production/stack-watchdog.mjs` (new) — подкоманда `check`: читает environment-model.json (список сервисов + healthcheck-порты), для каждого: `docker compose ps`/`/ready`; + /ready/dependencies (gateway); + мониторинг (absent-tolerant); bounded attempt-restart (максимум N за окно); вывод: structured-отчёт (JSON) + journal + файл alerts.jsonl (паттерн ep6 e13 delivery).
- [ ] `deploy/production/watchdog/neurocenter-stack-watchdog.{service,timer}` (new) — User=neurocenter-operator, OnCalendar ~5 min, Persistent=true (паттерн maintenance timer).
- [ ] Офлайн-тест логики: `scripts/test/stack-watchdog.test.mjs` (new) — fixture (сервис down → attempt-restart; 2 сбоя → только алерт; data-driven список из модели; /ready/dependencies consumer) — без живого стека.
- [ ] `systemd-analyze verify` на обоих unit'ах (офлайн, fixture-каталог).
- [ ] `compose.production.yml`: + node_exporter (prom/node-exporter pinned digest, backend-сеть, без портов наружу, read-only: /proc:ro /sys:ro /:ro /var/lib/docker:ro, mem/cpus/pids) + шапка состава (prod 13; целевой 15 после ep6 e12 — OQ-1).
- [ ] `environment-model.json`: + node_exporter (image, networks [backend], memLimit/cpus/pidsLimit, volumes/маунты, env) → structuralDrift 13.
- [ ] `scripts/test/compose-drift.test.mjs:78` — счёт 12→13 (здесь); 13→15 — ep6 e12 (OQ-1 sync).
- [ ] `docker-compose.yml` шапка — обновить «prod 12» → «prod 13 (+node_exporter; целевой 15 с мониторингом)».
- [ ] release-manifest: digest node_exporter (паттерн postgresImage/monitoringImages) + verify.
- [ ] prometheus.yml: + node_exporter scrape-target (9100, backend-сеть) — OQ-5 (здесь vs ep6 e12).
- [ ] Документ: `docs/implementation-readiness.md` (AD-OP-8-строка) + `docs/capacity-admission.md` или док эпика — /ready/dependencies consumer = stack-watchdog (закрытие решения ep6 e9).

**Acceptance Criteria:**
- Given упавший сервис (fixture), when watchdog check, then детект + attempt-restart по политике (bounded) — офлайн-тест.
- Given 2 сбоя подряд, when watchdog, then только алерт (эскалация, без infinite-restart).
- Given environment-model +1 сервис, when watchdog, then новый сервис в списке проверок (data-driven, тест).
- Given /ready/dependencies 503, when watchdog, then зафиксирован как сбой диагностики (consumer).
- Given compose production, then 13 сервисов, node_exporter в backend-сети, 9100 наружу не опубликован; drift-тесты зелёные (13).
- Given systemd-analyze verify, then оба unit'а валидны.
- Given manifest verify, then digest node_exporter верифицирован.
- Корневой сьют — без деградации.

## Design Notes

1. **Watchdog = consumer /ready/dependencies (закрытие контракта ep6 e9):** ep6 entry 9 зафиксировал решение «удалить /ready/dependencies, если к концу эпика 4 не подключён» + «Ревизия = задача эпика 4». Этот entry = подключение: watchdog читает /ready/dependencies как диагностику зависимости стека (5 upstream'ов). Решение «удалить» не срабатывает — endpoint живёт с consumer'ом. Формат ответа не меняется (ep6 e9 Never).
2. **Data-driven список сервисов (ключевое решение):** watchdog НЕ хардкодит сервисы — читает environment-model.json. Обоснование: (a) AD-OP-1 «окружение = данные» — watchdog-список как данные, не как код; (b) ep4 строится ДО ep6 (порядок сборки: эпик 4 → эпик 6) — на момент entry состав 13, после ep6 e12 = 15: data-driven = watchdog не правится при добавлении prometheus/alertmanager; (c) «каждый сервис в scrape targets» (AD-OP-8 completeness) — та же data-driven логика.
3. **node_exporter = compose-сервис (не systemd):** AD-OP-8 гласит «единая топология» (monitoring = compose, не systemd) + task-директива. Structural seed (:131) и operational .memlog («systemd = watchdog + node_exporter») — расхождение; решение: compose (единая топология, scrape targets в одном месте, DR-бандл подхватывает автоматически). Host-level-метрики — read-only-маунты (/proc:/sys:ro, /:ro, /var/lib/docker:ro) — node_exporter в контейнере видит host-метрики через маунты (стандартный паттерн node-exporter-in-compose). OQ-2 фиксирует расхождение.
4. **Bounded restart, не infinite-loop:** AD-OP-8 «attempt-restart по политике compose» — политика = compose `restart: unless-stopped` (x-service anchor :3) + watchdog-ограничение (N попыток за окно). Watchdog не отключает docker-политику, не вводит свою restart-логику поверх — только bounded attempt + эскалация в алерт.

## Verification

**Commands:** (Node 24: `~/.nvm/versions/node/v24.22.0/bin/node`)
- `node --test scripts/test/stack-watchdog.test.mjs` -- expected: офлайн зелёный (fixture: down→restart, 2 сбоя→алерт, data-driven, /ready/dependencies consumer)
- `node --test scripts/test/compose-drift.test.mjs` -- expected: 13 сервисов (was 12), drift зелёный
- `systemd-analyze verify <fixture>/neurocenter-stack-watchdog.{service,timer}` -- expected: валидно (офлайн, fixture-каталог)
- `docker compose -f compose.production.yml config --services | wc -l` -- expected: 13
- `docker compose -f compose.production.yml config` -- expected: node_exporter без published ports, read-only маунты
- Корневой сьют -- expected: без деградации против baseline.

## Open Questions (с рекомендациями)

- **OQ1 — Синхронизация node_exporter с ep6 entry 12 (12→14 vs целевой 15).** ep6 entry 12 фиксирует «12→14» (prometheus+alertmanager) + шапки «dev 9 / prod 14». Этот entry добавляет node_exporter ДО ep6 (эпик 4 строится раньше): на момент ep6 e12 состав уже 13, и e12 поднимает 13→15. Рекомендация: **целевой состав prod = 15** (12 + node_exporter + prometheus + alertmanager); ep6 e12 при impl обновляет шапки/счёт на 13→15 (sync-задача в ep6 e12 impl, не правка ep4). Обоснование: порядок сборки эпиков (4 → 6) фиксирован; двойной «+1» (12→14, потом →15) ломает drift-тесты на impl. Фиксация: целевая цифра **15** записана в шапку compose + environment-model (этот entry) + OQ здесь.
- **OQ2 — Расхождение AD-OP-8 structural seed (:131) и operational .memlog («systemd = watchdog + node_exporter»)?** Рекомендация: **node_exporter = compose-сервис** (единая топология, AD-OP-8 rule + task-директива); structural seed-комментарий (:131) — устаревший черновик (rule :81 — авторитетный). Watchdog — systemd (host-level supervision, не scrape-target). Обоснование: rule «prometheus/alertmanager — compose-сервисы, не systemd — единая топология» распространяется на node_exporter (monitoring-сервис).
- **OQ3 — Interval watchdog (5 min)?** Рекомендация: 5 min (OnCalendar) + Persistent=true (паттерн maintenance timer). Обоснование: detection ≤ 5 min приемлемо для host-supervision (compose healthcheck уже ловит down быстрее на уровне контейнера; watchdog — слой «стек + мониторинг живы», не liveness-замена).
- **OQ4 — Мониторинг absent до ep6 e12 (prometheus/alertmanager)?** Рекомендация: **absent-tolerant** — watchdog не считает мониторинг сбоем, пока его нет в environment-model (data-driven: нет в модели = не проверяется). Обоснование: ep4 строится до ep6 — мониторинг ещё не в стеке; data-driven решает автоматически (появится в модели → появится в проверках).
- **OQ5 — node_exporter scrape-target: здесь или ep6 e12?** Рекомендация: **здесь** (target 9100 добавляется в prometheus.yml вместе с сервисом — completeness AD-OP-8 «каждый сервис в scrape targets» не ломается на impl). Обоснование: сервис и его target — одна единица; ep6 e12 тогда только prometheus/AM targets.
- **OQ6 — node_exporter в DR-бандл (AD-OP-4)?** Рекомендация: **нет** — monitoring-сервисы (prometheus/AM/node_exporter) не входят в DR-бандл (state = производный, не данные проекта; паттерн ep6 e12: monitoring отдельно от applicationServices). Обоснование: AD-OP-4 scope бандла = данные + тома + S3 + образы; monitoring-state не требуется для restore.
