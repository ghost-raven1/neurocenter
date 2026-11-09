---
title: 'Verify билета: claim ≤ ceiling + связка claim↔descriptor + descriptorSha256 (AD-3, AD-2, entry 5)'
type: 'feature'
ticket: '5'
created: '2026-11-09'
status: 'ready-for-dev'
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'high'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - '_bmad-output/initiative-architecture/architecture-runtime-trust/architecture-runtime-trust.md'
  - '_bmad-output/initiative-architecture/prd-neurocenter/prd-neurocenter.md'
  - '_bmad-output/initiative-architecture/tickets/epic-trust-device-catalog/epic-trust-device-catalog.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `verifyHostedMcpTicket` (`ticket.ts:79-148`) проверяет HMAC + exp + форма + `claim ≤ LIMITS` (env-политика, 256 MiB), но: (1) нет `claim ≤ ceiling` против единого источника (entry 2); (2) нет связки `claim.artifactSha256` с верифицированным дескриптором; (3) клиент узнаёт лимиты из env (`NEUROCENTER_RUNTIME_MAX_*`, `runtime-artifact-download.ts:29`, `cache.ts:80`), а не из верифицированного дескриптора (AD-2); (4) `limits` — не обязательное поле дескриптора (AD-2); (5) версия не фиксируется при issuance (head может сместиться → race, recon v2 MED).

**Approach:** `verifyHostedMcpTicket` = HMAC + exp + форма + `claim ≤ CEILING` (entry 2) + связка `claim.artifactSha256`↔дескриптор (через server-issued `descriptorSha256`). Hosted-билет несёт `descriptorSha256` — клиент сверяет descriptor-текст именно с ним (self-referential hash из пакета запрещён). Миграционный коммит: env-лимиты клиента удалены полностью (параллельного env-пути нет даже на переход); клиент применяет `min(descriptor.limits, ceiling)`. `limits` — обязательное поле: отсутствует/некорректно = invalid descriptor, bridge не устанавливает (fail-closed). Версия фиксируется при issuance: head резолвится сервером и фиксируется в дескрипторе и claim; `version=undefined` (head) в прямом каталожном пути запрещён — actionable 404.

## Boundaries & Constraints

**Always:**
- `verifyHostedMcpTicket`: HMAC + exp + форма + `claim ≤ CEILING` (entry 2) + `claim.descriptorSha256` (новое обязательное поле, valid sha) + `claim.artifactSha256` (valid sha). Текущая админ-политика в verify НЕ участвует (AD-3).
- `descriptorSha256` = server-issued sha256 канонического descriptor-текста одобренного пакета; встраивается в claim при issuance. Клиент сверяет descriptor-текст с `descriptorSha256` (self-referential hash из байтов пакета запрещён).
- `limits` — обязательное поле runtime-artifact-дескриптора (entry 1): отсутствует/некорректно = invalid descriptor → bridge не устанавливает (fail-closed; «нет limits → env/ceiling» запрещено).
- Клиент применяет `min(descriptor.limits, ceiling)`: `runtime-artifact-download.ts` (compressedBytes) и `cache.ts` (cacheBytes) используют descriptor.limits (capped ceiling), не env `LIMITS`.
- Миграционный коммит: env-лимиты клиента (`NEUROCENTER_RUNTIME_MAX_*` в bridge-пути) удалены; параллельного env-пути нет.
- Версия фиксируется при issuance: head резолвится сервером (catalog `authorizeHostedMcp`) и фиксируется в дескрипторе + claim (`session.version`); `version=undefined` (head) в прямом каталожном пути запрещён → actionable 404 «перезапроси дескриптор».
- Проверка «версия не retired» (AD-16) — НЕ в stateless verify, а в live re-check `authorize-session` (entry 6/7).

**Never:**
- Self-referential hash: `descriptorSha256` не вычисляется из байтов самого пакета (из descriptor-текста).
- Env-лимиты клиента в security-логике (AD-2): `NEUROCENTER_RUNTIME_MAX_*` не читается bridge для ceiling/limits.
- Текущая админ-политика в stateless verify (AD-3: лимиты = admission при публикации, не runtime-контроль).
- Тихий повтор со старым дескриптором при смещении head (race): version=undefined → actionable 404.
- «Нет limits → env/ceiling» fallback (fail-closed).
- Территория TTL/кэша/re-issue (entry 6), retired-gates (entry 7) — не сюда.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| VERIFY_OK | билет: HMAC + exp + claim ≤ ceiling + descriptorSha256 + artifactSha256 | verify проходит | No error |
| CLAIM_ABOVE_CEILING | claim.compressedBytes > CEILING | invalid | actionable |
| NO_DESCRIPTOR_SHA | claim без `descriptorSha256` | invalid (новое обязательное поле) | actionable |
| BAD_DESCRIPTOR_SHA | `descriptorSha256` не sha256 | invalid | actionable |
| CLIENT_DES_MATCH | клиент: descriptor-текст, sha256 == claim.descriptorSha256 | установка разрешена | No error |
| CLIENT_DES_MISMATCH | клиент: sha256(descriptor-текст) != claim.descriptorSha256 | установка запрещена | actionable «дескриптор не совпадает» |
| SELF_REF_HASH | descriptorSha256 из байтов пакета | запрещён (fail) | actionable |
| NO_LIMITS | дескриптор без `limits` | invalid descriptor, не устанавливает (fail-closed) | actionable «limits обязательны» |
| LIMITS_ABOVE_CEILING | descriptor.limits > ceiling | invalid | actionable |
| CLIENT_MIN | клиент: `min(descriptor.limits, ceiling)` для download/cache | применяет min | No error |
| ENV_GONE | `NEUROCENTER_RUNTIME_MAX_*` задан для bridge | игнорируется (env-путь удалён) | No error |
| HEAD_DRIFT | issuance, head сместился после резолва | версия зафиксирована (не head) | No error (fixed) |
| VERSION_UNDEFINED | прямой каталожный путь, version=undefined | actionable 404 «перезапроси дескриптор» | 404 |

</frozen-after-approval>

## Code Map

- `services/api-gateway/src/features/mcp-host/ticket.ts:5-23` — `IHostedMcpClaim`: + `descriptorSha256: string`
- `services/api-gateway/src/features/mcp-host/ticket.ts:55-77` — `issueHostedMcpTicket`: встроить `descriptorSha256` в payload
- `services/api-gateway/src/features/mcp-host/ticket.ts:79-148` — `verifyHostedMcpTicket`: `claim ≤ CEILING` (entry 2) + `descriptorSha256` (valid sha, обязат.) + `artifactSha256` (valid sha)
- `services/api-gateway/src/features/mcp-host/mcp-host.controller.ts:68-135` — `connect`: получить `descriptorSha256` от catalog (issue), передать в `issueHostedMcpTicket`
- `services/catalog-service/src/devices/mcp-host-access.ts:156-199` — `authorizeHostedMcp`: резолв head → фиксация версии; вернуть `descriptorSha256` (sha256 канонического descriptor-текста пакета); запрет `version=undefined` → actionable
- `services/catalog-service/src/devices/mcp-host-access.ts:201-210` — `authorizeHostedMcpSession` (live re-check) — связка claim↔descriptor (контекст; retired — entry 7)
- `mcp/neurocenter-asset-sync/src/features/mcp-host/connect.ts:20-112` — `requestHostedMcpConnection`: получить билет c `descriptorSha256`; (клиентская сверка descriptor-текста)
- `mcp/neurocenter-asset-sync/src/bridge/runtime-artifact-download.ts:5,29` — `LIMITS.compressedBytes` → `min(descriptor.limits, ceiling)`
- `mcp/neurocenter-asset-sync/src/features/runtime-artifacts/cache.ts:13,80` — `LIMITS.cacheBytes` → `min(descriptor.limits, ceiling)`
- `mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts:15-22` — re-export; ceiling из контракта (entry 2); env-лимиты не используются
- `services/shared/runtime/limits.cjs:9-14` — `LIMIT_ENV` (env-снимок) — client-путь не читает (server bootstrap остаётся, AD-1)
- Тесты: `scripts/test/mcp-host-ticket.test.cjs` (расширить: descriptorSha256, ceiling, fail-closed limits); новый client-verify-тест; регистрация

## Tasks & Acceptance

**Execution:**
- [ ] `ticket.ts` — `IHostedMcpClaim.descriptorSha256`; `issue`/`verify` встраивают и проверяют (valid sha, обязат.)
- [ ] `verifyHostedMcpTicket` — `claim ≤ CEILING` (entry 2) + связка claim↔descriptor (descriptorSha256 + artifactSha256)
- [ ] `mcp-host.controller.ts` connect + `mcp-host-access.ts` `authorizeHostedMcp` — `descriptorSha256` (sha256 descriptor-текста), фиксация версии (head→fixed), запрет `version=undefined` → actionable 404
- [ ] Bridge: клиентская сверка descriptor-текста c `descriptorSha256` (self-referential hash запрещён); `limits` обязательна (fail-closed); `min(descriptor.limits, ceiling)` в `runtime-artifact-download.ts`/`cache.ts`; удаление env-пути клиента
- [ ] Тесты: verify (ceiling/descriptorSha256/claim↔descriptor), client-verify (match/mismatch/self-ref), fail-closed limits, min(descriptor.limits,ceiling), env-gone, version-pinning/404; регистрация

**Acceptance Criteria:**
- Given билет с claim ≤ ceiling + descriptorSha256 + artifactSha256, when verify, then проходит; claim > ceiling → invalid; без descriptorSha256 → invalid.
- Given клиент с descriptor-текстом, when sha256(descriptor) == claim.descriptorSha256, then установка; mismatch → отказ (actionable); self-referential hash (из байтов пакета) → запрещён.
- Given дескриптор без `limits`, when bridge устанавливает, then invalid descriptor, не устанавливает (fail-closed); `limits > ceiling` → invalid.
- Given клиент, when download/cache, then применяет `min(descriptor.limits, ceiling)` (не env); `NEUROCENTER_RUNTIME_MAX_*` для bridge игнорируется.
- Given issuance, when head, then версия зафиксирована (не head); `version=undefined` в прямом каталожном пути → actionable 404 «перезапроси дескриптор».
- Корневой сьют — без деградации против baseline.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

Stateless verify не имеет доступа к descriptor'у — он имеет только claim (зашифрованный HMAC). Поэтому «связка claim↔descriptor» в verify = наличие `descriptorSha256` (server-issued) + `artifactSha256`, оба valid sha; криптографическая связка — HMAC (нельзя подменить один без другого). Реальная проверка «артефакт ∈ дескриптор» выполняется при issuance (catalog `authorizeHostedMcp`) и в live re-check `authorize-session` (entry 6/7) — AD-3 явно: «проверка retired — не в stateless HMAC verify, а в live re-check». `descriptorSha256` вычисляется из канонического descriptor-текста (canonical JSON), НЕ из байтов пакета (self-referential hash запрещён — иначе клиент не мог бы независимо сверить). Клиентская миграция (env → descriptor.limits): AD-2 — «env-лимиты клиента полностью удаляются в миграционном коммите»; `min(descriptor.limits, ceiling)` — клиент применяет политику из дескриптора, ограниченную ceiling (константа, entry 2). Server-side env (bootstrap политики, AD-1) остаётся — это не клиентский security-путь. Version pinning: head резолвится сервером в момент issuance и фиксируется в `session.version` (claim) — устраняет race «head сместился → 404 → тихий повтор со старым дескриптором» (recon v2 MED).

## Open Questions

- **OQ:** `descriptorSha256` — sha256 какого именно канонического текста (весь asset descriptor vs только runtime-artifact-блок)? Рекомендация: весь canonical descriptor (canonicalJson, entry 1) — полный провенанс. Подтвердить при реализации.
- **OQ:** client-сверка descriptor-текста — где именно (в `requestHostedMcpConnection` vs в установке)? Рекомендация: в установке, перед записью конфига. Подтвердить.
- **OQ:** `min(descriptor.limits, ceiling)` — ceiling из контракта (entry 2) или из descriptor? Рекомендация: ceiling = константа контракта (entry 2); descriptor.limits = политика.

## Verification

**Commands:** (node-тесты — только `$NODE`)
- `NODE=~/.nvm/versions/node/v24.22.0/bin/node`
- `cd services/api-gateway && npm run build` → `$NODE scripts/test/mcp-host-ticket.test.cjs` — expected: verify (ceiling/descriptorSha256/claim↔descriptor) 0 fail
- Новый client-verify-тест (bridge: match/mismatch/self-ref/fail-closed/min/env-gone/version-pinning) — expected: 0 fail
- `grep -rn 'NEUROCENTER_RUNTIME_MAX' mcp/neurocenter-asset-sync/src/` — expected: нет (env-путь клиента удалён)
- Корневой сьют (`node scripts/workspace/check.mjs`) — без деградации (287 файлов, 3693 pass / 0 fail / 38 skipped)
