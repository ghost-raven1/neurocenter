---
title: 'Alerting: alertmanager.yml + правила + доставляющий канал (AD-O6/OP-7/OP-8)'
type: 'feature'
ticket: '13'
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
  - docs/implementation-readiness.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** AD-O6: алерты — доставлены (не «есть файл правил»). Readiness P0-RES прямо: «файл Prometheus rules не является доставленным alert» (implementation-readiness.md:95). В main: neurocenter-alerts.yml — 9 правил ( NeurocenterServiceUnavailable/ApiErrors/ApiLatency/CapacityUnavailable/DiskSpaceLow/RagQueueGrowing/ExternalBackupOverdue/BackupRunFailed/BackupStatusUnavailable), НО: (1) alertmanager.yml отсутствует (receiver-канал не определён — правила никуда не доставляются); (2) alertmanager-сервис не поднят (entry 12 — compose); (3) новые правила отсутствуют: stack-down (все сервисы down), error-store (entry 10), cert-expiry (AD-OP-7); (4) known-defect ff:4400 (entry 8) — NeurocenterServiceUnavailable не сработает для ff. Критерий: «вызвать условие → alert доставлен → снят при восстановлении».

**Approach:** (1) alertmanager.yml (НОВЫЙ, deploy/production/monitoring/): route (group_by, group_wait, repeat_interval) + receiver — OQ/HITL: канал в закрытом контуре (webhook/email); рекомендация: local webhook → receiver на хосте (node-скрипт + systemd unit User=neurocenter-operator: алерт → /var/log/neurocenter/alerts.jsonl + journald) — «доставлено» = запись в файл/journal с временем (автоматически проверяемо); (2) правила: 9 neurocenter-alerts.yml — ратификация как базис + новые: NeurocenterStackDown (count(up{job="neurocenter"})==0 → critical), NeurocenterErrorCritical (рост/присутствие critical — метрики entry 10), NeurocenterCertExpiry (AD-OP-7, days-to-expiry edge-сертификата — OQ-1 механизма: host-receiver считает из config-каталога; blackbox-exporter — Deferred); (3) completeness: 6/6 сервисов в targets (fix entry 8) — NeurocenterServiceUnavailable реально срабатывает. HITL: выбор канала + приёмка «вызвать → доставлено → снято» на реальных условиях.

## Boundaries & Constraints

**Always:**
- «Доставлено» = запись в канал (файл/journal с меткой времени), НЕ «alert в alertmanager UI» (readiness-критерий).
- Resolve-события доставляются (снятие алерта при восстановлении — часть приёмки).
- Правило без working-канала = не считается доставленным (критерий зафиксирован в доке).
- Severity-лейблы (critical/warning) — из 9 базовых (ратификация) + новые по той же схеме.

**Never:**
- Не вводить email/external-SMTP (закрытый контур — SMTP-сервер отсутствует; OQ-2: если оператор требует — отдельный канал, не P0).
- Не дублировать правила (9 базовых — ратификация, не переписывать; только +новые).
- Не менять prometheus.yml scrape (entry 8 — targets; здесь — consumer).
- Не вводить blackbox-exporter (Deferred — OQ-1 cert-expiry механизм).
- Не делать UI для алертов (admin UI — расширение; канал = файл/journal).

## I/O & Edge-Case Matrix

| # | Ситуация | Условие | Ожидаемый результат |
|---|----------|---------|---------------------|
| 1 | Disk low | free < 1GiB (NeurocenterDiskSpaceLow) | alert в канал (файл/journal, время) → resolve при восстановлении |
| 2 | Queue growing | rag pending > 8 (5m) | alert (warning) → resolve |
| 3 | Service down | up==0 (1m) | alert (critical) → resolve при up |
| 4 | Stale backup | external_backup_verified==0 | alert (critical) → resolve |
| 5 | Stack down | count(up)==0 (2m) | NeurocenterStackDown (critical) |
| 6 | Error critical | error_events critical > 0 (5m) | NeurocenterErrorCritical |
| 7 | Cert expiry | days-to-expiry < threshold | NeurocenterCertExpiry (OQ-1 механизм) |
| 8 | Канал down | receiver не запущен | alertmanager — alert в UI, НО «не доставлено» (readiness) — OQ-3: detection |
| 9 | Resolve | условие снято | resolve-событие в канал (время) |
| 10 | Grouping | 5 сервисов down одновременно | 1 group (group_by: alertname) — не 5 алертов |

## Code Map

- `deploy/production/monitoring/neurocenter-alerts.yml:1-69` — 9 правил (ратификация; +новые)
- `deploy/production/monitoring/prometheus.yml:7-8` — rule_files (consumer)
- `deploy/production/monitoring/alertmanager.yml` (NEW) — route + receiver
- `compose.production.yml` (entry 12) — alertmanager-сервис (config volume /etc/alertmanager)
- `docs/implementation-readiness.md:57,89-95` — P0-RES-критерий («доставленные уведомления», «файл rules ≠ доставленный alert»)
- AD-OP-7 (architecture-operational) — cert-expiry; AD-OP-8 — stack-watchdog (consumer /ready/dependencies, не алерт)
- Entry 8: 6/6 targets (NeurocenterServiceUnavailable сработает); entry 10: error-метрики (NeurocenterErrorCritical)
- Host-receiver (NEW): scripts/production/alert-receiver.mjs + systemd unit (deploy/production/alert-receiver.service)
- `docs/` — документ канала (как доставлено, как проверить, как снять)

## Tasks & Acceptance

### Execution
- [ ] alertmanager.yml (deploy/production/monitoring/): route (group_by [alertname, severity], group_wait 30s, group_interval 5m, repeat_interval 4h) + receiver webhook (http://<host-receiver>/alerts)
- [ ] Host-receiver: scripts/production/alert-receiver.mjs (HTTP POST → append /var/log/neurocenter/alerts.jsonl + console → journald; User=neurocenter-operator, 0700 dir) + systemd unit deploy/production/alert-receiver.service
- [ ] Документ: канал (как доставлено, проверка: tail alerts.jsonl/journalctl, снятие: resolve-строка) в docs/production-setup.md
- [ ] Новые правила (neurocenter-alerts.yml): NeurocenterStackDown (count(up{job="neurocenter"})==0 for 2m, critical), NeurocenterErrorCritical (increase(neurocenter_error_events_total{level="critical"}[5m])>0, warning), NeurocenterCertExpiry (OQ-1)
- [ ] Cert-expiry (OQ-1): host-receiver считает days-to-expiry из config-каталога (edge-сертификат) → gauge-метрика (host-receiver отдаёт /metrics? — OQ-1 механизм) OR правило на существующей метрике (Deferred blackbox)
- [ ] Тесты: alertmanager --web.config.file --check (валидность); fixture-алерты (promtool test rules) — stack-down/error/cert срабатывают; resolve-сценарий
- [ ] HITL-ранбук: приёмка «вызвать → доставлено → снято» (пошаговый: как вызвать disk/queue/service/stale условия, как проверить файл/journal, как снять)

### Acceptance
- **Given** alertmanager.yml **when** --check **then** валиден
- **Given** disk < 1GiB (fixture/live) **when** правило **then** alert в канал (файл/journal, время) → resolve при восстановлении
- **Given** service down (fixture) **when** правило **then** NeurocenterServiceUnavailable + (если все down) NeurocenterStackDown в канал
- **Given** error critical (entry 10 fixture) **when** правило **then** NeurocenterErrorCritical в канал
- **Given** канал (HITL) **when** приёмка **then** «вызвать → доставлено → снято» подтверждено оператором; «файл rules без канала = не доставлено» зафиксировано

## Design Notes

- **Канал = local webhook → host-receiver (рекомендация):** закрытый контур (нет SMTP/external). Host-receiver (systemd, User=neurocenter-operator) = «доставлено» = запись в alerts.jsonl + journald (автоматически проверяемо: grep по имени alert). Webhook (alertmanager → receiver) — стандартный механизм (без кастомного протокола).
- **Почему не email/external:** SMTP в контуре отсутствует (AD-OP: закрытый контур). Email = отдельный канал (OQ-2), не P0-RES. Файл/journal = достаточно для «оператор видит» (systemd-журнал + файл).
- **Cert-expiry (OQ-1):** механизм — OQ. Рекомендация: host-receiver считает days-to-expiry edge-сертификата (из config-каталога, путь известен) + отдаёт gauge-метрику (host-receiver /metrics, prometheus scrape) → правило on gauge. Blackbox-exporter — Deferred (тяжёлый, не P0). Альтернатива: правило на cert-метрике (если появится).
- **StackDown vs ServiceUnavailable:** ServiceUnavailable = up==0 (1 сервис, 1m). StackDown = count(up)==0 (ВСЕ, 2m) — эскалация (целый стек мёртв). Не дублируют (разные условия/фор).
- **Grouping:** group_by [alertname, severity] — 5 сервисов down = 1 group ServiceUnavailable (не 5 алертов). Оператор видит «5 сервисов», не 5 строк.
- **Доставлено ≠ в UI:** readiness-критерий (implementation-readiness.md:95) — файл/journal, не alertmanager-UI. UI = диагностика, не канал.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
# Валидность:
docker run --rm -v $PWD/deploy/production/monitoring:/etc/alertmanager prom/alertmanager alertmanager --web.config.file=/etc/alertmanager/alertmanager.yml --check
# Правила (fixture):
promtool test rules deploy/production/monitoring/neurocenter-alerts.yml <fixture-test.yml>
# Live (production-стек, HITL):
# Вызвать disk low / service down / queue → проверить:
tail /var/log/neurocenter/alerts.jsonl
journalctl -u neurocenter-alert-receiver -f
# Снятие: восстановить условие → resolve-строка в файле/journal
```
Ожидаемо: config валиден; правила срабатывают на fixture; live: вызов → доставка (файл/journal) → resolve; HITL-приёмка подтверждена.

## Open Questions (с рекомендациями)

1. **Канал доставки**: local webhook → host-receiver (рекомендация — файл/journal, автоматически проверяемо, закрытый контур) vs email (нет SMTP) vs другой (оператор). Рекомендация: webhook → host-receiver. HITL: оператор подтверждает.
2. **Cert-expiry механизм**: host-receiver считает days-to-expiry (из config-каталога) + gauge-метрика (рекомендация) vs blackbox-exporter (Deferred) vs правило на существующей метрике (нет). Рекомендация: host-receiver gauge (лёгкий, без нового контейнера).
3. **Detection «канал down»**: receiver не запущен → alertmanager держит alert в UI, но «не доставлено». Рекомендация: host-receiver — systemd (restart=always) + отдельный alert на receiver-down (OQ: как детектить — heartbeat-метрика receiver? Рекомендация: host-receiver отдаёт neurocenter_alert_receiver_up gauge, правило на == 0).
4. **Пороги новых правил**: StackDown 2m, ErrorCritical 5m, CertExpiry 14d (рекомендации). HITL: оператор подтверждает пороги на приёмке.
5. **Retention alerts.jsonl**: сколько хранить (logrotate)? Рекомендация: logrotate 30d (алерты = редкие, 30d достаточно для ретроспективы).
