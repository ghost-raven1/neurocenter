---
type: epic
title: "Релиз и supply-базис"
parent: initiative-architecture
covers: [R1]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md, _bmad-output/initiative-architecture/architecture-data/architecture-data.md, _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md, docs/implementation-readiness.md]
after: []
refined: false
risk: high
---

# Релиз и supply-базис

## Description

Когда эпик закрыт, релиз Neurocenter собирается воспроизводимо с чистого git-checkout: supply-манифест (digest'ы образов, опись bridge-dist, commit SHA) и связка source↔version↔digest↔descriptor↔SHA (REL-01); compose сверяется drift-тестом, production не стартует с dev-обходами (AD-OP-1/AD-OP-5); дефект bridge-endpoints 404 (H5, BRIDGE_TEMPLATES_DIR) закрыт; shared-слой разделён с drift- и freshness-гардами (AD-7/AD-8/AD-10); поставка закрыта: локальный registry, запрет отключённого TLS (AD-15); версионирование схемы едино (AD-D1) — базис для всей data-работы.

## Outcome

Для команды: появляется замороженный кандидат релиза (REL-01) — предпосылка всех P0-приёмок (сигнал: PRD C1); все последующие эпики строятся и принимаются от него.

## Done when

1. Релиз собирается с чистого git-checkout: supply-манифест (digest'ы, опись bridge-dist, commit SHA) и связка source↔version↔digest↔descriptor↔SHA проверяются автоматикой (REL-01).
2. Compose сверяется drift-тестом; production не стартует с dev-обходами (AD-OP-1/AD-OP-5).
3. Дефект bridge-endpoints 404 (H5) закрыт.
4. Shared-слой разделён: runtime/{targets,host-target,limits,archive,portable-path}.cjs + фасад, drift- и freshness-гарды (AD-7/AD-8/AD-10).
5. Поставка закрыта: локальный registry, отключённый TLS запрещён (AD-15).
6. Версионирование схемы едино (AD-D1).

## Boundaries

- mcp-host/билеты/gateway-политики — эпик epic-trust-device-catalog.
- Установщики и pairing — эпик epic-devices.
- DR-механика (backup/restore/maintenance-таймер) — эпик epic-dr; этот эпик даёт ей supply-манифест и compose-as-data.
- Лимиты, наблюдаемость, аудит — эпик epic-res-obs.
- Data-модель (write-owner/retention/quota/crash consistency) — эпик epic-data; этот эпик даёт ей AD-D1.

## References

- parent — _bmad-output/initiative-architecture/initiative-architecture.md (Requirements R1)
- architecture — _bmad-output/initiative-architecture/architecture-operational/architecture-operational.md (AD-OP-1, AD-OP-2, AD-OP-5, AD-OP-9)
- architecture — _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md (AD-7, AD-8, AD-10, AD-15, H5)
- architecture — _bmad-output/initiative-architecture/architecture-data/architecture-data.md (AD-D1)
- readiness — docs/implementation-readiness.md (REL-01, P0-матрица)

## Notes

- Decision: (2026-11-05, слайсинг) эпик 1 — platform-baseline и первый в сборке: REL-01 + supply + shared-сплит + AD-D1; всё остальное ждёт его артефактов.
