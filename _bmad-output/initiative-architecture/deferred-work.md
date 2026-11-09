# Deferred work

Находки build-review, которые реальны, но не фиксятся в изменении, где найдены.

- source_plan: `/home/region.cbr.ru/69starodubtsevae/projects/neurocenter/_bmad-output/initiative-architecture/tickets/epic-release-baseline/tickets/story-supply-git-checkout-ad-op-2-plan.md`
  summary: `docs/production-setup.md` и `docs/docker-build-ca.md` не описывают новый build-режим `setup.mjs build` (чистого-checkout гейт, нормализация mtime к SOURCE_DATE_EPOCH, манифест `neurocenter-release-v1` и его верификацию).
  status: ЗАКРЫТО 2026-11-09 — entry 1.12 K2 (commit 82a5a3d6, main): `docs/production-setup.md:50` описывает build-режим полностью (fail-closed: чистое git-дерево, SHA HEAD + timestamp commit в манифесте, ровно одна `NEUROCENTER_RELEASE`-метка, TLS strict независимо от флага проекта; `normalizeBuildContext` → mtime к timestamp commit / SOURCE_DATE_EPOCH; манифест `neurocenter-release-v1`: 7 image ID application-сервисов + postgres, опись миграций, supply-опись (bridge-dist SHA-256, 8 installer-шаблонов, vendor-контракт), атомарная запись 0600 + повторная сверка до успешного завершения); `docs/docker-build-ca.md:26` — пометка со ссылкой на production-setup.md.
  evidence: quick-review entry 1.1: production-доки не упоминают новый гейт/манифест; frozen-intent entry не охватывает доки; территория — entry 1.12 (Refactor sweep: скоуп «осиротевшие комментарии/доки», которые эпик отложил).
