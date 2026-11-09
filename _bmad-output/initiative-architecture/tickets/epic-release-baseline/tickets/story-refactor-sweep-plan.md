---
title: 'Refactor sweep'
type: 'feature'
ticket: '12'
created: '2026-11-06'
status: in-progress
baseline_revision: '160a4003'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
---

# 1.12 «Refactor sweep» (AD-*)

## SCOPE: устанавливается на старте

По тикету: скоуп = cleanup, который эпик отложил. **Фреймворк ниже: 2 known-находки + 3 скан-процедуры + 2 decision-пункта.** Implementer на старте: (1) подтверждает known-находки по актуальному main, (2) прогоняет сканы, (3) фиксирует финальный список в этом файле (секция «Финальный скоуп»), (4) реализует. Скоуп, вытесненный из другой сторис, — НОВАЯ сторис, не сюда.

### Known-находки (подтвердить по main на старте)

**K1. dev-cli-регрессия AD-10 (4× fail)**
- `scripts/workspace/check-plan.mjs` импортирует `scripts/workspace/isolated-build-source.mjs`, а статический fixture-копи-лист dev-cli не обновлён.
- Проявление: 4× `scripts/test/dev-cli.test.mjs` (найдено в 1.5 root-suite triage; воспроизводится на baseline a946a7b2 и позже).
- Фикс: добавить `isolated-build-source.mjs` в fixture-копи-лист dev-cli (по образцу остальных записей).

**K2. Доки не описывают build-режим (1.1 F3, deferred-work.md)**
- `docs/production-setup.md` и `docs/docker-build-ca.md` не описывают: `setup.mjs build` (чистого-checkout гейт), нормализацию mtime к SOURCE_DATE_EPOCH (`normalizeBuildContext`), манифест `neurocenter-release-v1` и его верификацию (`validateReleaseManifest`).
- Фикс: дополнить оба доки по факту кода (`scripts/production/release-manifest.mjs`, `scripts/production/setup.mjs`).

### Скан-процедуры (на старте, по актуальному main)

**S1. Dead code после shared-сплитов (1.5, 1.6) и supply-align (1.9)**
- Осиротевшие require/import после: (а) 1.5 — `runtime-artifacts.cjs` фасад, TARGETS-вывод из `opencode-cli-install.cjs`; (б) 1.6 — удаление 12 weak-копий bridge-детекций, `limits.cjs`/`archive.cjs`; (в) 1.9 — удаление `provision.mjs` (publish-путь), registry-свита.
- Критерий: модуль/функция/константа, на которую нет ни одного ссылающегося (кроме самих тестов на неё) — кандидат. Фасад `runtime-artifacts.cjs` — НЕ кандидат (осознанная плоская поверхность).

**S2. Осиротевшие комментарии/доки**
- Комментарии-ссылки на удалённые механизмы (provision/publish в 1.9, старые TARGETS-списки, npmjs-registry после свита), stale-«TODO», комментарии-решения, чья сторис закрыта.

**S3. Дубли**
- Дублирующие константы/хелперы, вынесенные в shared в 1.5/1.6/1.7 (остатки локальных копий, не удалённые при switch), дублирующие фикстуры.

### Decision-пункты (решение фиксируется на старте, до реализации)

**D1. lint:root pre-existing ошибки (4)**
- 2 из 4 — в vendor-pinned codex-connector source (source pin неизменяем — фикс ломает pin). Решение по умолчанию: **вне скоупа** (pin-инвариант > линт-чистота); 2 остальные — по факту (если не vendor — в скоуп).

**D2. dev↔prod сверка состава (директива локального режима)**
- Dev-стек (9) vs production (12): `bootstrap-admin`, `database-init` (one-shot), `capacity-collector` отсутствуют в dev — осознанный состав. Действие: НЕ код, а зафиксировать сверку в доке/комментарии compose (один источник), если её нет; production-состав проверяет 1.13 F4/F5.

## Pre-scan оркестратора (2026-11-06, по main 160a4003 — до мержа 1.6/1.7)

Уже подтверждено, implementer на старте только ре-верифицирует:

- **K1 — локация точная**: `scripts/test/dev-cli.test.mjs` fixture-копи-лист (строки ~39–70, список `for (const file of [...])`) содержит `workspace/check-plan.mjs`, но НЕ `workspace/isolated-build-source.mjs`, который `check-plan.mjs:4` импортирует (`import { buildPackages }`). Фикс = одна строка в списке. Безопасность: `isolated-build-source.mjs` импортирует ТОЛЬКО node builtins (fs/promises, fs-constants, path, crypto, child_process) — никаких дополнительных записей в список не требуется.
- **D2 — сверка НЕ задокументирована нигде**: dev (docker-compose.yml) = 9 сервисов {model-runtime, frontend, oauth2-bridge, api-gateway, catalog-service, feature-flags-service, skills-service, postgres, rag-sync-service}; prod (compose.production.yml) = 12 = dev + {capacity-collector, database-init, bootstrap-admin}. В docker-compose.yml и docs/ ни одной пометки об осознанном составе. Действие: зафиксировать (комментарий в docker-compose.yml и/или docs — выбрать на старте).
- **S2 — ЧИСТО** (git grep HEAD): (а) прямых ссылок на `provision.mjs` ноль (1.9 убрал чисто); (б) "publish" в доках — только продуктовые концепции (image.publish/skill.publish permissions, tools:publish), не supply-механизм; (в) `registry.npmjs.org` в lockfile'ах — **BY DESIGN** (1.9: 103 platform-пары — бинарники других ОС/arch + fsevents-darwin; `resolved` осознанно не тронут, на linux-x64 не запрашивается; инвариант держит guard `npm-supply-lockfile.test.mjs` — зелёный в main); (г) docs: backlog-2026-10-22.md и docs/reports/* — датированные истории (вне скоупа), docker-build-ca.md — уже в K2, catalog-mvp.md:85 — легитимная ссылка на pinned-версию public-пакета (не stale). → S2, вероятно, закроется без правок (зафиксировать в финальном скоупе).
- **S1/S3 — после мержа 1.6/1.7** (их switch создаёт/удаляет dead code и дубли; pre-scan смысла нет).

## Verification

- Поведение не изменилось: корневой сьют — без деградации против baseline (числа baseline зафиксировать на старте; load-флейки — реран изолированно, прецедент 1.5/1.6).
- Список cleanup закрыт: финальный скоуп (known + сканы) выполнен, по каждому пункту — коммит-ссылка или решение «вне скоупа» с причиной.
- Гейт локального режима (после мержа): (а) install-путь — npm ci в scratch (кэш), (б) dev-стек 9/9 healthy, (в) корневой сьют.
- Регистрация новых тест-файлов (если появятся) в `check-tooling-tests.json` + `expectedFiles` (union+sort, main = 58 записей).

## Implementation Notes

- Один коммит на пункт финального скоупа (атрибуция) ИЛИ один общий — по размеру; sweep low-risk, без изменения поведения.
- Порядок: K1 (фикс регрессии, 4 теста) → K2 (доки) → S1-S3 (по размеру пунктов) → D-решения.
- НЕ сюда: 1.13 e2e-находки (они в 1.13), новая функциональность (новая сторис).
