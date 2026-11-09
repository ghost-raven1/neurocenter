---
title: 'Метрики: канонический набор + auth-failure + machine-metrics + completeness (AD-O3/18)'
type: 'feature'
ticket: '8'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '4097fdc35bd78dbebf44bec1b026b46663a005e2'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-observability/architecture-observability.md
  - _bmad-output/initiative-architecture/tickets/epic-res-obs/epic-res-obs.md
  - deploy/production/monitoring/prometheus.yml
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-O3: канонический набор метрик на каждый из 6 app-сервисов + completeness. Механизм (observability.cjs: ручной renderer, Bearer metrics_token, timingSafeEqual, fail-closed 403 — :32-46) — ратификация. known-defect: prometheus.yml targets 5/6 — feature-flags-service:4400 отсутствует (файл 22 строки, targets :18-22) — NeurocenterServiceUnavailable не может сработать для ff-сервиса. Auth-failure-контр не существует (leading-индикатор: рост отказов auth ДО 5xx). AD-18: machine-metrics (RAM/CPU хоста) в capacity snapshot отсутствуют — collector (capacity-collector.cjs) считает только 6 физических томов. Метки — только фиксированные groups (observability.cjs:18-30 — ратификация: без email/ID/URL в лейблах).

**Approach:** (1) фикс targets: + feature-flags-service:4400 (prometheus.yml); (2) auth-failure counter: расширение createObservability — `recordAuthFailure()` → `neurocenter_auth_failures_total{service}` (фиксированное лейбл-пространство: только service); вызовы: gateway auth-guard (auth check failed, auth-guard.service.ts:112) + oauth2-bridge (code exchange failed, auth.controller.ts:89 + login-failure-точки); (3) AD-18: machine-блок в snapshot — collector читает /proc/meminfo (MemTotal/MemAvailable) + /proc/stat (cpu jiffies, delta между тиками — 15s-тик, :102) → `machine: {ramTotalBytes, ramAvailableBytes, cpuCores, cpuUtilization}`; compat: validateSnapshot (capacity.cjs:29-57) — старые снапшоты (без machine) валидны, выход НОВОГО коллектора обязан machine (тест); renderCapacityMetrics (:160-202) — +gauges machine (только если sample.machine есть); (4) completeness-тест: явный список 6 app-сервисов = scrape targets (парсинг prometheus.yml) + канонический набор в /metrics каждого (через render()); знаменатель НЕ включает capacity-collector (пишет snapshot.json, нет HTTP), frontend/nginx (/metrics = 404, template :26), postgres, prometheus/alertmanager (entry 12).

## Boundaries & Constraints

**Always:**
- Метки — только фиксированные groups (service + existing labels); новые метрики без произвольных значений (AD-O3).
- Auth-failure = счётчик попыток (без причины в лейблах — причина в логе по requestId, entry 6).
- Machine-metrics — только из /proc (не docker stats, не cgroup-файлы — AD-18: /proc/meminfo + /proc/stat не маскируются docker'ом, collector network_mode none + DAC_OVERRIDE, compose :68-71).
- Compat: старый snapshot (6 ресурсов, без machine) проходит validateSnapshot (не ломаем admission при partial-деплой).

**Never:**
- Не вводить Prometheus client-либ (ручной renderer — ратификация; зависимость в закрытый контур = supply-риск AD-OP-2).
- Не рендерить capacity-метрики у gateway/bridge/ff (CAPACITY_REQUIRED=false — осознанно, задокументировать — entry 9).
- Не менять bucket-список/формат http-метрики (существующие правила alerts на них, neurocenter-alerts.yml:11-27).
- Не добавлять machine в знаменатель completeness (collector — не scrape-target).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Scrape всех 6 | prometheus.yml | 6/6 targets (ff:4400 добавлен) |
| 2 | /metrics без токена | GET /metrics | 403 (fail-closed — ратификация) |
| 3 | Auth check failed (gateway) | невалидный token | neurocenter_auth_failures_total{service="api-gateway"} +1; лог (entry 6) без message |
| 4 | Code exchange failed (bridge) | битый code | counter {service="oauth2-bridge"} +1 |
| 5 | Новый снапшот | collector-тик | snapshot.machine {ramTotalBytes, ramAvailableBytes, cpuCores, cpuUtilization} |
| 6 | Первый тик (нет предыдущего /proc/stat) | cpuUtilization | поле отсутствует (не null/0 — «нет данных») |
| 7 | Старый снапшот (без machine) | validateSnapshot | валиден (compat) |
| 8 | /metrics у CAPACITY_REQUIRED=false | gateway | http+process+auth — да; capacity-блоков нет (осознанно) |
| 9 | Completeness: новый сервис без targets | тест | фэйл (явный список) |
| 10 | Completeness: сервис без канона | render() | фэйл по missing family |

## Code Map

- `services/shared/observability.cjs` — createObservability :49-151: services-set :8-15 (6), group() :18-30 (фиксированные), authorized() :32-46, render() :108-149 (http :113-130, process :131-143, capacity :144, maintenance catalog :145-147); расширение: recordAuthFailure + auth-failures в render
- `deploy/production/monitoring/prometheus.yml:16-22` — targets (5/6; :4400 отсутствует)
- `services/shared/capacity.cjs` — validateSnapshot :29-57 (compat-точка), renderCapacityMetrics :160-202 (machine-gauges), resources :4 (6)
- `services/shared/capacity-collector.cjs` — collectCapacity :14-58 (+machine-блок), publishCapacity :59-68, тик 15s :102, --check :70-81
- `services/api-gateway/src/auth/auth-guard.service.ts:112` — точка recordAuthFailure (auth check failed)
- `services/oauth2-bridge/src/auth/auth.controller.ts:89` — точка recordAuthFailure (code exchange failed)
- `compose.production.yml:63-90` — capacity-collector (network_mode none, DAC_OVERRIDE :68-71 — /proc доступен)
- `scripts/test/` — новый metrics-completeness.test.mjs (targets-парсинг + canonical-set)

## Tasks & Acceptance

### Execution
- [ ] prometheus.yml: + feature-flags-service:4400 в targets (6/6)
- [ ] observability.cjs: `recordAuthFailure()` (экспорт из createObservability) + `neurocenter_auth_failures_total{service}` в render (HELP/TYPE + counter)
- [ ] Вызовы: gateway auth-guard (auth check failed → recordAuthFailure + лог entry 6), oauth2-bridge auth.controller (code exchange failed + login-отказ-точки — инвентарь на impl)
- [ ] capacity-collector.cjs: machine-блок — /proc/meminfo (MemTotal/MemAvailable) + /proc/stat (cpu-row, delta к предыдущему тику — модульное состояние; первый тик — cpuUtilization отсутствует) + cpuCores (os.availableParallelism)
- [ ] capacity.cjs: validateSnapshot — machine опционален (compat); renderCapacityMetrics — neurocenter_machine_ram_total_bytes/ram_available_bytes/cpu_utilization/cpu_cores (если sample.machine)
- [ ] Completeness-тест: (а) парсинг prometheus.yml → targets == явный список 6 сервисов (ровно, без лишних); (б) для каждого render() содержит канон: http_requests_total + duration + in_flight + process×4 (+ auth_failures); capacity-семейства только у CAPACITY_REQUIRED (catalog/skills/rag)
- [ ] Документ: capability-аннотация «CAPACITY_REQUIRED=false у gateway/bridge/ff — осознанно» (design-note в docs/capacity-admission.md)

### Acceptance
- **Given** prometheus.yml **when** completeness-тест **then** 6/6 targets, ff:4400 присутствует
- **Given** auth check failed (fixture) **when** /metrics **then** neurocenter_auth_failures_total{service="api-gateway"} > 0
- **Given** collector-тик (один и более) **when** snapshot.json **then** machine-блок с ram-полями; с 2-го тика cpuUtilization ∈ [0,1]
- **Given** старый снапшот без machine **when** validateSnapshot **then** не бросает (compat)
- **Given** новый сервис (fixture в services-set) **when** completeness **then** фэйл «нет в targets/каноне»

## Design Notes

- **Ручной renderer остаётся:** Prometheus client-либ = новая зависимость в supply-цепочку (AD-OP-2/AD-15 — локальный registry); текущий renderer покрывает канон; auth-failure/machine — простые counter/gauge, либ не нужна.
- **Auth-failure без reason-лейбла:** reason-лейбл = кардинальность-риск + раскрывает причину в метрике (AD-O8-принцип); диагностика = лог по requestId (entry 6) + error-store (entry 10).
- **CPU-utilization через delta:** /proc/stat — кумулятивные jiffies; утилизация = Δidle/Δtotal между тиками. Модульное состояние (последний sample) — переживает тики внутри процесса; после restart процесса первый тик без cpuUtilization (допустимо — метрика gauge, prometheus не потеряет смысл).
- **machine в снапшоте, а не отдельный exporter:** AD-18 прямо: «collector читает /proc → поле machine в snapshot». Один канал данных (snapshot.json), один healthcheck (collector --check), один scrape-путь (capacity-метрики уже идут через renderCapacityMetrics у CAPACITY_REQUIRED-сервисов).
- **Знаменатель completeness:** capacity-collector — не HTTP-сервис (snapshot.json — pull по файлу), frontend/nginx — /metrics 404 (template :26), postgres — внешний образ, prometheus/AM — entry 12 (самих себя не скрейпят в каноне). Явный список 6 = защита от «тихо добавили 7-й сервис без метрик».

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
node --test scripts/test/metrics-completeness.test.mjs
node --test scripts/test/capacity*.test.mjs   # compat: старый снапшот валиден
# Live (dev-стек):
curl -s -H "Authorization: Bearer $METRICS_TOKEN" localhost:4400/metrics | grep neurocenter_   # ff-сервис отдаёт канон
# Machine (на хосте/в контейнере коллектора):
node services/shared/capacity-collector.cjs --once | jq .machine
```
Ожидаемо: completeness 6/6; auth-failures растёт; machine-блок в снапшоте; compat зелёный; корневой сьют — без деградации.

## Open Questions (с рекомендациями)

1. **auth-failure точки oauth2-bridge**: только code-exchange (auth.controller.ts:89) vs + login-redirect-отказы (неудачный redirect/missing state)? Рекомендация: code-exchange + missing/invalid state (реальные атаки/сбои); login-redirect без state — тоже (одна точка в controller). Инвентарь фиксируется в PR.
2. **cpuUtilization на первом тике**: omit (рекомендация) vs 0? Рекомендация: omit — 0 ложно («CPU свободен»), omit = «нет данных» (gauge отсутствует до 2-го тика, ~15s).
3. **Machine-метрики у всех CAPACITY_REQUIRED-сервисов или только catalog?** renderCapacityMetrics вызывается у всех 6, но capacity-блок только при CAPACITY_REQUIRED=true (capacity.cjs:163). Machine-метрики идут тем же условием. Рекомендация: да (единое условие) — gateway/bridge/ff не показывают machine (осознанно, entry 9 документ).
4. **Alert на auth-failures?** (entry 13 решает правила; здесь только метрика). Рекомендация: entry 13 добавит правило rate(auth_failures[5m]) > threshold — порог на HITL-приёмке.
