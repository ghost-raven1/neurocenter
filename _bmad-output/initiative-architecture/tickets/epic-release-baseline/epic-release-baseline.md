---
type: epic
title: "Релиз и supply-базис"
parent: initiative-architecture
covers: [R1]
sources: [_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md]
companions: [_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md, _bmad-output/initiative-architecture/architecture-data/architecture-data.md, _bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md, docs/implementation-readiness.md]
after: []
refined: true
risk: high
---

# Релиз и supply-базис

## Description

Когда эпик закрыт, релиз Neurocenter собирается воспроизводимо с чистого git-checkout: supply-манифест (digest'ы образов, опись bridge-dist, commit SHA) и связка source↔version↔digest↔descriptor↔SHA (REL-01); compose сверяется drift-тестом, production не стартует с dev-обходами (AD-OP-1/AD-OP-5); дефект bridge-endpoints 404 (H5, BRIDGE_TEMPLATES_DIR) закрыт; shared-слой разделён с drift- и freshness-гардами (AD-7/AD-8/AD-10); поставка закрыта: локальный registry, запрет отключённого TLS (AD-15); версионирование схемы едино (AD-D1) — базис для всей data-работы.

## Outcome

Для команды: появляется замороженный кандидат релиза (REL-01) — предпосылка всех P0-приёмок (сигнал: PRD C1); все последующие эпики строятся и принимаются от него.

## Requirements

1. **Воспроизводимый релиз** (R1). С чистого git-checkout собирается релиз `neurocenter-release-v1`: pinned sha256 digest всех 7 app-образов + postgresImage, supply-опись (перечень + SHA всех архивов `bridge-dist/runtime|opencode`, шаблонов installers, версии vendor-контракта), опись миграций; commit SHA в манифесте; локальные незакоммиченные изменения = фэйл сборки. Counter: две сборки с одного commit → разные digest'ы; preflight не верифицирует весь манифест. (AD-OP-2)
2. **Deployment как данные** (R1). Единственная машино-читаемая модель окружения (сервис → образ+digest, сети, mem/cpus/pids, read_only/cap/seccomp, секреты, порты, volumes) живёт в репо как данные; compose (dev/prod/overlay'и) сверяется с моделью drift-тестом в двух направлениях: compose→code (dead-env = фэйл) и code→compose (required env из config schema, не заданный в compose = фэйл). Counter: env в compose, не читаемый кодом, не ловится. (AD-OP-1)
3. **Production без dev-обходов** (R1). `configure` не пишет dev-дефолты обходов в production `.env`; отклонение конфига, содержащего их, — `validateProduction` на старте сервиса + drift-тест (модель запрещает эти ключи в production); `latest`-теги запрещены. Counter: production-старт с `SSO_DISABLE` в production `.env` не отклоняется. (AD-OP-5)
4. **H5 закрыт** (R1). Явный `BRIDGE_TEMPLATES_DIR` в модели; мёртвая переменная `BRIDGE_DIST` устранена; регресс-тест резолва шаблонов из собранного образа. Counter: bridge-endpoints production-стека возвращают 404. (AD-OP-1, H5)
5. **Shared-сплит** (R1). `services/shared/runtime/`: `targets.cjs` (канон TARGETS — единственный список, 8 целей), `host-target.cjs` (единственный `getHostTarget()`), `portable-path.cjs`, `limits.cjs` (ленивый `getLimits()`, `Object.freeze`), `archive.cjs`; фасад `runtime-artifacts.cjs` на плоском пути (identity-реэкспорт, 56 call-site без смены импортов); смена семантики лимитов одним коммитом вместе со switch; канон заменяет все 15+ локаций platform-детекции, включая слабые копии bridge-скриптов; shared не пишет в `process.env` и не валидирует при импорте. Counter: вторая копия TARGETS/`getHostTarget()` или тихая установка musl-артефакта на bionic. (AD-7)
6. **Гарды** (R1). Drift-guard: тест сверяет каждую декларацию `.d.cts` с фактическими экспортами `.cjs` (рассогласование = фэйл), equality TARGETS, явные allowlist'ы; реальный drift зафиксирован и исправлен (`capacity.cjs` 4 имени, `github-release-source.cjs` 1). Freshness-guard: test-plan проверяет актуальность `dist/` против `src/` на старте прогонов, читающих `dist/` (устаревание = явная ошибка «run nest build»). Counter: тихое рассогласование деклараций или «проходит у меня, падает в CI». (AD-8, AD-10)
7. **Поставка закрыта** (R1). Зависимости поставляются только из локальных registry (Artifactory/Nexus `ppod-npm-*`): lockfile аллайнится с существующими локально версиями (249 align), отсутствующие 44 — удалены или вендорятся; lockfile — часть producer-closure (align-срез → re-pin каскадом: `catalog-source/producer.json` → `manifest.json` → `bundled-catalog.lock.json`); npmjs.org — не источник поставки. Глобальное отключение TLS-верификации запрещено (`NODE_TLS_REJECT_UNAUTHORIZED=0`, `strict-ssl=false`, preload); корпоративный CA — через `NODE_EXTRA_CA_CERTS`; «доверять всем адресам» запрещено. Counter: сборка работает только с npmjs.org; TLS-верификация отключена в production-образе. (AD-15, AD-OP-7)
8. **Schema versioning** (R1). Единый протокол ledger `(version, name, checksum sha256)`, monotonic, no-rollback, история неизменяема (ратификация трёх миграционных систем); feature-flags получает собственный advisory-лок `neurocenter:feature-flags:migrations` (не делит с catalog); `security_events` — DDL-owner = catalog (DDL удалён из `feature-flags-schema.ts`, запись строк сохраняется), invariant-тест целостности общей таблицы; ghost-БД `skills` в dev удалён из dev-init. Counter: ff-миграция блокирует catalog; DDL `security_events` создаётся двумя сервисами. (AD-D1)

## Constraints

1. Single-host compose; staging отсутствует (матрица dev/production — решение 2026-11-05). (AD-OP-5)
2. Закрытый контур: внешние registry не источник поставки; `--pull never`. (AD-15, AD-OP-2)
3. Сборка — с чистого git-checkout: локальные незакоммиченные изменения = фэйл сборки. (AD-OP-2)

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
- Decision: (2026-11-05, refine) Tracer bullet = entry 1: supply-манифест + воспроизводимая сборка с чистого git-checkout (AD-OP-2) — самая тонкая линия через все слои эпика (build → supply → compose → deploy → smoke); setup (clean checkout + сборка на хосте) — hitl-шаг.
- Decision: (2026-11-05, refine) Refactor sweep (entry 12) предложен по умолчанию и включён в breakdown; closing e2e = entry 13 (REL-01 приёмка кандидата).
