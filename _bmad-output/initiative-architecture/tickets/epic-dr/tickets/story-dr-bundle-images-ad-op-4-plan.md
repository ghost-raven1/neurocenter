---
title: 'DR-бандл: образы релиза в комплекте (AD-OP-2, AD-OP-4)'
type: 'feature'
ticket: '1'
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
  - '{project-root}/_bmad-output/initiative-architecture/architecture-operational/architecture-operational.md'
  - '{project-root}/_bmad-output/initiative-architecture/tickets/epic-dr/epic-dr.md'
  - '{project-root}/docs/production-recovery.md'
  - '{project-root}/docs/external-backups.md'
  - '{project-root}/docs/implementation-readiness.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** P0-S3 (cross-host DR, R3/C3) не может быть закрыт, пока DR-бандл не является самодостаточным. AD-OP-2 (architecture-operational.md:45) требует: «DR-бандл включает `docker save` всех pinned-образов релиза — бандл достаточен для restore на другом хосте без registry». AD-OP-4 (:57) подтверждает scope бандла = «данные + тома + S3-объекты + **pinned-образы релиза (docker save — AD-OP-2)**». Сегодня это **не так**: `backupOperation` (recovery.mjs:278) пишет в recovery-манифест только `images` (image ID 7 app + postgres, recovery.mjs:469) и `postgresImage`, но сами образы в комплект **не попадают** — `docker save` в codebase отсутствует (grep по scripts/ и deploy/ пуст), а `production-recovery.md:83` прямо фиксирует: «Доставьте **точные образы**… Текущая реализация ещё не публикует их в registry автоматически». Следовательно, restore на другом хосте (restoreProduction, recovery.mjs:626, читает `images` в :644/:652/:672) требует, чтобы образы **уже были на хосте** — нарушается инвариант «бандл достаточен». Это blocker для entry 4 (cross-host restore) и для готовности AD-OP-3/AD-OP-4.

**Approach:** Новый операторский модуль `scripts/production/dr-images.mjs` (или подкоманды `recovery.mjs images-bundle`/`images-load` — решение в OQ1), который закрывает разрыв image-supply: (1) **bundle** — из верифицированного release-манифеста (pinned image ID, 7 app + postgres) выполнить `docker save` каждого образа по точному image ID → tar'ы + опись image-bundle (`image-bundle.json`: `{format:'neurocenter-image-bundle-v1', commit, release, images:{svc→sha256 tar}, postgresImage→sha256 tar}`); (2) **verify** — `docker load` каждого tar во временный контекст и сверка `image ID == manifest` (аналог `assertLive`, update.mjs:160); (3) **передача** — image-bundle как часть DR-набора на S3 через существующий транспорт `external-backup.mjs` (свой SHA описи, retention на стороне хранилища); (4) **restore** — `docker load` всех tar'ов бандла до `restoreProduction`, чтобы assertNewTarget/restore не упали на отсутствующих образах. Bundle **ключится на релиз** (commit+release+image ID из release-манифеста), а не на каждый backup: образы не меняются между бэкапами, повторная сборка бандла для того же релиза — no-op (кэшируется по описи). DR-runbook (production-recovery.md) дополняется секциями «Image-bundle» (сборка/передача) и «Загрузка образов при restore».

## Boundaries & Constraints

**Always:**
- Образы сохраняются **по точному image ID** из верифицированного release-манифеста (`buildReleaseManifest:125`/`verifyReleaseManifest:169`), не по `:tag` (latest-теги запрещены — AD-OP-5, environment-model latestTagViolations:504).
- Опись image-bundle несут SHA256 каждого tar + commit + release; верификация = `docker load` → `docker image inspect` → image ID == опись == release-манифест (триада, как digest-детерминизм 1.13).
- Bundle передаётся на S3 тем же транспортом, что и данные (SigV4, readback, SHA, retry) — единый DR-набор; SHA описи image-bundle сохраняется **отдельно** (вне исходного хоста).
- `docker load` на restore выполняется **до** `restoreProduction` и в том же maintenance-окне (общая daemon-блокировка, compose-client maintenanceLock:182).
- Bundle idempotent: повтор для того же (commit+image ID) не пересобирает существующие tar'ы (сверка описи).
- Не раскрывать приватные значения .env/секретов в описи и артефактах.

**Never:**
- Не сохранять образы по имени:тег и не пуллить внешние registry (`--pull never`, закрытый контур AD-OP-2/AD-15).
- Не включать image-bundle в каждый recovery-комплект данных (раздутие + дублирование); бандл — релизный артефакт, данные ссылаются на него.
- Не менять формат recovery-манифеста (v4) под образы — image-bundle — **отдельный** артефакт со своим format-идентификатором (решение в OQ1).
- Не дублировать логику pg_dump/томов/S3-объектов — это территория backupOperation (recovery.mjs:278), не менять.
- Не выполнять публикацию supply-тарболов в registry (жёсткая директива пользователя 2026-11-06 — только чтение/вендор).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| BUNDLE_FROM_MANIFEST | верифицированный release-манифест (7 app + postgres image ID), docker-демон | 8 tar'ов + `image-bundle.json` (commit, release, svc→sha256, postgres→sha256) | отсутствует образ → фэйл с указанием svc/ID |
| BUNDLE_IDEMPOTENT | тот же (commit+image ID), tar'ы уже есть | no-op (опись сверяется, не пересобирается) | расписание SHA tar ↔ опись → фэйл |
| VERIFY_BUNDLE | tar'ы бандла | docker load → image ID == опись == manifest | любой различающийся ID → фэйл с парой svc/ID |
| UPLOAD_BUNDLE | image-bundle + S3-контракт | передача блоками + readback SHA + manifest последним; SHA описи в квитанции | SHA-mismatch/redirect → фэйл (транспорт, не дублировать) |
| LOAD_FOR_RESTORE | tar'ы бандла, новый проект | docker load всех 8 образов до restoreProduction | несовпадение ID после load → фэйл до мутаций |
| STALE_BUNDLE | бандл другого commit/image ID | верификация несовпадения → отказ restore | actionable: «пересоберите бандл для этого релиза» |
| NO_REGISTRY | хост без доступного registry | restore проходит только с loaded-образами (closed-contour) | обращение к registry → фэйл |

</frozen-after-approval>

## Code Map

**Релиз и образы (что сохраняем):**
- `scripts/production/release-manifest.mjs` — `buildReleaseManifest:125` (состав: `images` 7 app + `postgresImage`, commit, release), `verifyReleaseManifest:169` (пересчёт → список расхождений), `captureReleaseActuals:400` (factual image ID из docker), `buildProductionRelease:436` (полный цикл build). Image-bundle **читает** `manifest.images`/`postgresImage` — единственный источник точных ID.
- `scripts/production/compose-client.mjs` — `applicationServices:11-19` (7 сервисов), `serviceImageIds:235` (image ID через `docker image inspect`), `docker:22` (обёртка docker CLI с timeout), `maintenanceLock:182` (общая daemon-блокировка — под неё грузим образы на restore).

**Recovery (куда встраивается image-supply):**
- `scripts/production/recovery.mjs` — `backupOperation:278` (quiesced copy: `images` в манифесте `:469`, `postgresImage` в метаданных; **не трогать** — image-bundle не меняет данные), `previewRestoreProduction:565`, `restoreProduction:626` (читает `images` в `:644`, держит лок `:652`, `volumeTransfer`/`create` по `images['catalog-service']` `:671-672`; **встроить `docker load` до :654**), `assertNewTarget:536`, `main:790` (CLI: backup/verify/restore — добавить `images-bundle`/`images-load`).
- `scripts/production/recovery-manifest.mjs` — `validateManifest:15`, `writeManifest:128`, `verifyBackup:148` (паттерн описи+SHA, переиспользовать для `image-bundle.json`).
- `scripts/production/recovery-files.mjs` — `digestFile:41` (streaming sha256 tar'ов), `inventory:58`, `copyTree:101` (перенос tar'ов в destination).

**S3-транспорт (передача бандла):**
- `scripts/production/external-backup.mjs` — `createExternalS3Store:200`, `signedS3Request:95` (SigV4), `uploadExternalBackup:304` (blobs 32MiB + readback + manifest последним), `downloadExternalBackup:423` (сборка + SHA + безопасные пути), `retryExternalOperation:156`. Image-bundle идёт **тот же** формат объектов `neurocenter-external-v1/<id>/...`, отдельный backup-id = image-bundle-id.
- `scripts/test/external-backup.test.mjs` (750 строк, local mock) + `external-backup-s3.test.mjs` (138 строк, local minio peer) — паттерн тестов транспорта, переиспользовать.

**Локальная DR-репетиция (проверка restore с loaded-образами):**
- `scripts/test/production-recovery-stack.mjs` — `check:69`, `request:122`, `login:170`, `dataFingerprint:200` (2 независимых стека, restore в новый кластер). Entry 1 **расширяет** его: на target-стороне образы **не предзагружены**, а получены `docker load` из бандла source.
- `docs/production-recovery.md` — «Восстановление на чистой машине» `:81-109` (секция 1 «Доставьте точные образы… ещё не публикует в registry автоматически» `:83`), «Репетиция и допуск» `:140-149`. **Обновить**: image-bundle закрывает «доставить точные образы».
- `deploy/production/environment-model.json` — модель окружения (образы+digest по сервисам) — сверка topologу бандла.

**Архитектурный контракт:**
- `_bmad-output/.../architecture-operational/architecture-operational.md:45` (AD-OP-2: «DR-бандл включает docker save всех pinned-образов»), `:57` (AD-OP-4: scope бандла + «образы вне бандла» = предотвращаемый дефект).
- `docs/implementation-readiness.md:53` (P0-S3 «чего недостаёт»: «независимая доставка секретов/образов»).

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/production/dr-images.mjs` (new) — подкоманды: `bundle --manifest <release-manifest.json> --destination <dir>` (docker save 7 app + postgres по image ID → tar'ы + `image-bundle.json` с commit/release/svc→sha256), `verify --source <dir> --manifest <release-manifest.json>` (docker load → сверка image ID == опись == manifest), `load --source <dir>` (docker load всех tar'ов, для restore). Идентификатор `neurocenter-image-bundle-v1`.
- [ ] Опись image-bundle: формат + SHA (streaming `digestFile`), atomic write 0600 (паттерн `writeReleaseManifest:138`), idempotent no-op по совпадению (commit+image ID+sha256 tar).
- [ ] Встроить в `recovery.mjs`: `main:790` — новые режимы `images-bundle`/`images-verify`/`images-load`; `restoreProduction:626` — вызов `load` (docker load всех образов бандла) **до** `:654` (assertNewTarget) под тем же maintenanceLock; бандл **не** входит в recovery-комплект данных.
- [ ] Передача на S3: image-bundle как отдельный backup-id через `uploadExternalBackup`/`downloadExternalBackup` (реестр + SHA описи); retention — на стороне хранилища (документировать в runbook).
- [ ] `scripts/test/dr-images.test.mjs` (new) — unit (mock docker): bundle idempotent, verify-несовпадение ID → фэйл, stale-bundle (другой commit) → отказ, oпись без секретов; регистрация в `scripts/workspace/check-tooling-tests.json` + `expectedFiles` (union+sort при мерже).
- [ ] Расширить `scripts/test/production-recovery-stack.mjs`: target-сторона **без** предзагруженных образов → `docker load` из бандла source → restore проходит (доказательство self-sufficiency).
- [ ] Обновить `docs/production-recovery.md`: секция «Image-bundle» (bundle/verify/upload/load + retention) + поправка `:83` (образы теперь в бандле, не «ручная доставка»).

**Acceptance Criteria:**
- Given верифицированный release-манифест (7 app + postgres image ID), when `dr-images bundle`, then 8 tar'ов + `image-bundle.json` (commit/release/svc→sha256), каждый tar сверен по SHA; отсутствующий образ → фэйл с svc/ID.
- Given тар'ы бандла, when `dr-images verify`, then docker load → image ID == опись == release-манифест; любой различающийся ID → фэйл с парой svc/ID.
- Given бандл того же (commit+image ID), when повторный `bundle`, then no-op (не пересобирает существующие tar'ы).
- Given бандл другого commit/image ID, when verify/restore, then отказ с actionable-сообщением (пересобрать для этого релиза).
- Given новый проект без предзагруженных образов, when `restoreProduction` с `docker load` бандла, then restore проходит (self-sufficiency, closed-contour, `--pull never`).
- Бандл передаётся на S3 с readback-SHA; SHA описи в квитанции; локальная репетиция (production-recovery-stack с loaded-образами) зелёная.
- `check --tooling` зелёный; корневой сьют — без деградации против baseline (backup/verify/restore не ломается).

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

1. **Image-bundle — отдельный релизный артефакт, а не часть recovery-комплектa данных.** Образы не меняются между бэкапами (pinned release), поэтому встраивать 8 tar'ов (~GB) в каждый quiesced backup — раздутие + дублирование. AD-OP-2 формулирует «DR-бандл включает docker save всех pinned-образов **релиза**» — акцент на *релиз*. Решение: отдельный `image-bundle.json` + tar'ы, ключ (commit+release+image ID), recovery-комплект **ссылается** на бандл релиза (manifest уже несёт `images`). DR-набор на S3 = комплект данных + image-bundle (+ секреты/конфиг по runbook, вне бандла). Это минимальное изменение формата (recovery v4 не меняется).

2. **Почему по image ID, а не по name:digest.** Release-манифест хранит **image ID** (`sha256:<64>`) — так же, как deploy-from-manifest в 1.13 (update.mjs:373-386, bare digest). Локально-собранные образы могут не иметь RepoDigests; bare ID резолвится Docker по ID. `docker save <imageID>` + `docker image inspect <loaded>` → ID. Строго = «контейнер работает с именно тем ID, что в манифесте».

3. **Граница с external-backup.mjs.** Не изобретать S3-транспорт: image-bundle идёт **тем же** `uploadExternalBackup` (blobs 32MiB, readback, manifest последним, retry) с отдельным backup-id = image-bundle-id. Это даёт бесплатно: SigV4, SHA readback, повтор после обрыва, retention-семантику. Единственное новое — формат описи `image-bundle.json`.

4. **Idempotency и кэширование.** Bundle на релиз собирается один раз (при build/prepare). Повторный вызов для того же (commit+image ID+sha256) — no-op: сверяем опись, не пересобираем. Это важно для повторных DR-репетиций (эпик 10: финальный restore с сервисами эпика 6) — бандл пересобирается только когда меняется релиз.

5. **Зависимость от REL-01 (1.13 HITL).** Точные image ID приходят из **верифицированного** release-манифеста. Если замороженный кандидат (1.13 F1-F6) ещё не принят оператором, bundle строится по текущему main-кандидату — но финальная P0-S3-репетиция (entry 4) требует замороженного кандидата. См. OQ3.

## Verification

**Commands:** (Node 24 обязателен: `~/.nvm/versions/node/v24.22.0/bin/node`; docker sequential + cooldown load < 8)
- `node scripts/production/dr-images.mjs bundle --manifest <release-manifest.json> --destination <dir>` -- expected: 8 tar'ов + `image-bundle.json` (commit/release/svc→sha256), каждый tar сверен
- `node scripts/production/dr-images.mjs verify --source <dir> --manifest <release-manifest.json>` -- expected: docker load → все image ID == опись == manifest; несовпадение → фэйл с парой svc/ID
- Повторный `bundle` на тот же (commit+ID) -- expected: no-op (tar'ы не пересозданы)
- `node --test scripts/test/dr-images.test.mjs` -- expected: unit (idempotent, verify-несовпадение, stale-bundle, oпись без секретов) зелёные без реального docker
- `node --test scripts/test/external-backup.test.mjs scripts/test/external-backup-s3.test.mjs` -- expected: без регрессии (транспорт не сломан)
- `node --test scripts/test/production-recovery-stack.mjs` (расширенный: target без предзагруженных образов → docker load из бандла) -- expected: restore проходит (self-sufficiency)
- `node --test scripts/test/production-recovery.test.mjs` -- expected: без регрессии (backup/verify/restore не сломан)
- `node scripts/workspace/check.mjs --tooling` -- expected: dr-images + тест в tooling-списке, гейт зелёный
- **HITL-проверка (когда хост/registry доступны):** сборка бандла из верифицированного кандидата → upload на S3 → download на втором хосте → docker load → restore (деталь — entry 4)

## Open Questions (с рекомендациями)

- **OQ1 — Где жить image-bundle: новый `dr-images.mjs` или подкоманды `recovery.mjs`?** Рекомендация: **отдельный `scripts/production/dr-images.mjs`** (чистое разделение: recovery = данные, dr-images = образы), но `restoreProduction` вызывает его `load` (одна точка врезки). Обоснование: разные lifecycle (релиз vs backup), меньшая когнитивная нагрузка на recovery.mjs (38KB). Альтернатива (подкоманды recovery) — только если PO/оркестратор хочет одну CLI.
- **OQ2 — Отдельный артефакт vs расширение recovery-манифеста до v5?** Рекомендация: **отдельный артефакт** (`neurocenter-image-bundle-v1`), recovery v4 не менять. Обоснование: образы — релизный, не бэкапный уровень; v4-совместимость исторических комплектов сохраняется; минимальный blast radius.
- **OQ3 — Бандл строится по какому кандидату до приёмки 1.13?** Рекомендация: по **текущему main-кандидату** для разработки/локальной репетиции (entry 1); **финальная P0-S3-репетиция (entry 4)** — только по **замороженному кандидату REL-01** (1.13 F1-F6 GO). 1.13 HITL — предпосылка entry 4/5/6 (см. риски для волны 2).
- **OQ4 — Размер/транспорт tar'ов (несколько GB)?** Рекомендация: блоки 32MiB (существующий `uploadExternalBackup`), retention на стороне хранилища; при необходимости — split по сервису (8 отдельных tar'ов уже есть). Проверить реальное место на S3 и время передачи на рабочей нагрузке в entry 4.
