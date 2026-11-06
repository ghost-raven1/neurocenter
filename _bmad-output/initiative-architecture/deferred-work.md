# Deferred work

Находки build-review, которые реальны, но не фиксятся в изменении, где найдены.

- source_plan: `/home/region.cbr.ru/69starodubtsevae/projects/neurocenter/_bmad-output/initiative-architecture/tickets/epic-release-baseline/tickets/story-supply-git-checkout-ad-op-2-plan.md`
  summary: `docs/production-setup.md` и `docs/docker-build-ca.md` не описывают новый build-режим `setup.mjs build` (чистого-checkout гейт, нормализация mtime к SOURCE_DATE_EPOCH, манифест `neurocenter-release-v1` и его верификацию).
  evidence: quick-review entry 1.1: production-доки не упоминают новый гейт/манифест; frozen-intent entry не охватывает доки; территория — entry 1.12 (Refactor sweep: скоуп «осиротевшие комментарии/доки», которые эпик отложил).
