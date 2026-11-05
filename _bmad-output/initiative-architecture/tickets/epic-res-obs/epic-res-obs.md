---
type: epic
title: "Ресурсы и наблюдаемость (P0-RES)"
parent: initiative-architecture
covers: [R1, R7, R9, R10, R11]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-observability/architecture-observability.md, _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md, _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md]
after: [epic-release-baseline, epic-data]
refined: false
risk: high
---

# Ресурсы и наблюдаемость (P0-RES)

## Description

P0-RES закрыт: двухуровневые лимиты (ceiling-константы + policy в DB) исполняются в enforcement-точках, включая enforcement-точки quota-полей projects.quota (AD-D4, квотная модель — из эпика 5; AD-1/9/11/12/18); hardening: non-root, pids_limit, ресурсная таблица (AD-OP-6); единая лог-схема с correlation id и redaction (AD-O1/2/8); канонический набор метрик с completeness-тестом (AD-O3); health /ready (AD-O4); error visibility: PG error_events + admin UI (AD-O5); prometheus/alertmanager — compose-сервисы, базовые алерты и доставляющий канал (AD-O6); транзакционный аудит admin-мутаций (FR-903) и security_events для device/session/gateway-событий (AD-O7) — аудит-часть R9; новые compose-сервисы подхватываются в DR-бандл эпика 4 (AD-OP-4) на финальном restore.

## Outcome

Для команды: каждый заявленный лимит реально работает, ошибки видны главному админу, состояние стека наблюдаемо и алертится (сигнал: PRD C1 P0-RES, NFR-2/5/6).

## Done when

1. Двухуровневые лимиты (ceiling + policy) исполняются в enforcement-точках, включая projects.quota (AD-1/9/11/12/18 + AD-D4).
2. Hardening: non-root, pids_limit, ресурсная таблица (AD-OP-6).
3. Единая лог-схема: correlation id + redaction (AD-O1/2/8); feature-flags-service в scrape.
4. Канонический набор метрик + completeness-тест (AD-O3).
5. Health /ready (AD-O4); error visibility: PG error_events + admin UI (AD-O5).
6. Prometheus/alertmanager — compose-сервисы; базовые алерты + доставляющий канал (AD-O6).
7. Транзакционный аудит admin-мутаций (FR-903) + security_events (AD-O7).

## Boundaries

- Единый источник ceiling/контрактной версии — эпик epic-trust-device-catalog; квотная модель — эпик epic-data.
- DR-бандл подхватывает эти сервисы на финальном restore (эпик 4 → эпик 10).
- Самодиагностика-UI для пользователя — эпик epic-project (admin UI здесь — служебный).

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R1, R7, R9, R10, R11)
- architecture — _bmad-output/initiative-architecture/architecture-observability/architecture-observability.md (AD-O1..AD-O8)
- architecture — _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md (AD-OP-6)
- architecture — _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md (AD-1/9/11/12/18)
- prd — _bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md (FR-903, NFR-2/5/6)

## Notes

- Unknown: L-8 — AD-OP-4: 4 → 5 томов (artifact-cache); gate (совместно с epic-dr).
- Waits on epic-release-baseline because: единое версионирование схемы (AD-D1) и compose-as-data.
- Waits on epic-data because: квотная модель (AD-D4): поля и схема квот.
