---
title: 'Backup lock: TTL + auto-release по heartbeat (AD-D3)'
type: 'feature'
ticket: '10'
created: '2026-11-09'
status: ready-for-dev
baseline_revision: '3433b1d147163a82fc023a34f909457830c7f6aa'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context:
  - _bmad-output/initiative-architecture/architecture-data/architecture-data.md
  - _bmad-output/initiative-architecture/tickets/epic-data/epic-data.md
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Файловая бэкап-блокировка (backup-storage.ts:7 `BACKUP_LOCK = '.neurocenter-backup.lock'`, :38-67 `backupLock`) после крэша бэкап-процесса живёт **вечно**: лок-директория остаётся, следующий бэкап получает `BACKUP_BUSY` 409 (backup-storage.ts:46-50), снимается только оператором офлайн (recovery.mjs:354). AD-D3 Rule: «backup lock file — TTL + auto-release по heartbeat (fix; механизм — AD-OP-4 operational spine)».

**Approach:** (1) heartbeat-файл: при успешном acquire `backupLock` пишет `heartbeat` (ISO-timestamp) + интервал обновления (30с, OQ-2) на время владения; release — clearInterval + owner-check + rm (существующий, :61-66); (2) stale-detection при acquire: `mkdir` → EEXIST → прочитать heartbeat: если лок старше TTL (рекомендация 10 мин; **TTL > BACKUP_OPERATION_MS = 20s** — backup-policy.ts:10) И heartbeat не свежий → stale → `rm -rf` лок-директории → повторный acquire (одна попытка); иначе → `BACKUP_BUSY` как сейчас; (3) crash-safe: бэкап = один джоб одновременно, TTL > max backup duration, heartbeat обновляется только владельцем. Механизм-референс — AD-OP-4 operational spine (стык: не дублировать, если AD-OP-4 вводит общий lock-TTL).

## Boundaries & Constraints

**Always:**
- Owner-check при release сохранён (backup-storage.ts:61-64) — чужой лок не удаляется при release.
- Stale-removal только по heartbeat+возрасту (не по owner-файлу) — owner у мёртвого процесса не обновляется.
- TTL > BACKUP_OPERATION_MS (20s, backup-policy.ts:10) — живой бэкап никогда не кажется stale.
- Stale-removal логируется (owner UUID, возраст лока, возраст heartbeat) — наблюдаемость.
- Однократный retry после stale-removal (не loop).

**Never:**
- Не убирать лок (конкурентность бэкапов остаётся защищённой) — TTL добавляет, не заменяет.
- Не уменьшать BACKUP_OPERATION_MS / не менять timeout-логику (backup.ts:148-158).
- Не менять API бэкапов (BACKUP_BUSY 409 остаётся для живых лок'ов).
- Не касаться recovery-маркеров (recovery-files.mjs:173-174 — `.neurocenter-backup.lock` исключается из recovery-файлов, как и сейчас).

## I/O & Edge-Case Matrix

| # | Ситуация | Вход | Ожидаемый результат |
|---|----------|------|---------------------|
| 1 | Живой лок (heartbeat свежий) | acquire | BACKUP_BUSY 409 (как сейчас) |
| 2 | Мёртвый владелец (kill -9), heartbeat старше TTL | acquire | stale → rm → acquire успешно; лог с owner/возрастом |
| 3 | Мёртвый владелец, лок младше TTL | acquire | BACKUP_BUSY (TTL не истёк — ждём) |
| 4 | Нормальный бэкап | acquire → работа → release | heartbeat обновляется; release чистит (owner-check) |
| 5 | Бэкап дольше TTL (патология) | acquire другого | stale-removal живого лока! — митигция: TTL >> 20s (OQ-1); heartbeat живого процесса свежий → НЕ stale (heartbeat-условие, не только возраст) |
| 6 | Гонка: 2 acquire на stale-лок | оба видят stale | mkdir-race: один rm+mkdir, второй EEXIST → BACKUP_BUSY (без двойного bэкапа) |
| 7 | Crash во время stale-removal | rm начался, крэш | лок-директория частично удалена/цела → следующий acquire: EEXIST (стale по heartbeat) или свободен — оба исхода корректны |
| 8 | Операторский офлайн-разлок (recovery.mjs:354) | rm вручную | работает как раньше (совместимость) |

## Code Map

- `services/catalog-service/src/backups/backup-storage.ts:7` — BACKUP_LOCK, :38-67 — backupLock (mkdir :43, owner-wx :55, release :61-66), :70-82 — backupUsage (лок-директория исключается из usage :80-82)
- `services/catalog-service/src/backups/backup-policy.ts:10` — BACKUP_OPERATION_MS = 20s (TTL > это значение)
- `services/catalog-service/src/catalog/backup.ts:143` — единственный caller `release = await backupLock(paths.root)`, :148-158 — timeout-таймер (паттерн setInterval/setTimeout в коде)
- `scripts/production/recovery.mjs:354` — операторская проверка/разлок (совместимость)
- `scripts/test/production-backups.fixture.mjs:59-68` — fixture: создание/удаление лок-директории (расширить под heartbeat)
- `scripts/test/project-backups-ui.mjs:23` — lock-path в UI-тесте

## Tasks & Acceptance

### Execution
- [ ] backup-storage.ts: `backupLock` — после acquire: write `heartbeat` (ISO) + `setInterval(updateHeartbeat, 30s).unref()`; release — clearInterval + owner-check + rm (как сейчас)
- [ ] backup-storage.ts: EEXIST-ветка (:44-51) — stale-detection: age(lock dir) > TTL && age(heartbeat) > TTL → rm -rf + один retry mkdir; иначе BACKUP_BUSY; лог stale-removal (owner, возраст)
- [ ] TTL-константа (backup-policy.ts: `BACKUP_LOCK_TTL_MS = 10 * 60_000`, OQ-1) + heartbeat-интервал (30s, OQ-2)
- [ ] Тесты: fixture stale-лок (старый heartbeat) → acquire ок; fresh-лок → BACKUP_BUSY; kill -9 сценарий (fixture: лок без heartbeat-обновлений); гонка 2 acquire
- [ ] production-backups.fixture.mjs: heartbeat в fixture-локе

### Acceptance
- **Given** лок с heartbeat старше TTL **when** acquire **then** stale → rm → acquire успешно, лог записан
- **Given** лок с свежим heartbeat **when** acquire **then** BACKUP_BUSY 409 (без изменения)
- **Given** kill -9 бэкап-процесса **when** следующий бэкап после TTL **then** стартует без офлайн-вмешательства
- **Given** нормальный бэкап **when** acquire→release **then** heartbeat обновлялся, release чист (owner-check)

## Design Notes

- Heartbeat + TTL — стандартный lease-паттерн (AD-D5 pattern 3: lease-токены с recheck): владелец доказывает живость обновлением, мёртвый владелец «истекает» по TTL.
- Двойное условие stale (возраст лока И возраст heartbeat) защищает edge 5: даже если бэкап патологически долгий, живой процесс обновляет heartbeat → не будет снят.
- Crash-safety rm -rf: лок-директория — только owner + heartbeat (нет данных) → rm безопасен даже частично (edge 7).
- AD-OP-4 стык: если operational spine вводит общий lock-TTL-механизм — этот лок подключается к нему (не дублировать); сейчас реализуем self-contained в backup-storage.ts.

## Verification

```bash
export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH
cd services/catalog-service && npm test -- backup
node --test scripts/test/production-backups.fixture.mjs 2>/dev/null || true
```
Ожидаемо: backup-тесты зелёные (stale/fresh/gonka/kill-9); BACKUP_BUSY для живых лок'ов сохранён.

## Open Questions

1. **TTL**: 10 мин (рекомендация; >> BACKUP_OPERATION_MS=20s, << «вечно») — подтвердить. Коррелировать с AD-OP-4 (если вводит общий TTL).
2. **Heartbeat-интервал**: 30с (рекомендация; TTL/20) — подтвердить.
3. **Наблюдаемость stale-removal**: security event (security_events — audit) vs лог — какой канал (рекомендация: security event, т.к. это аномалия).
4. **Совместимость с recovery.mjs:354**: операторский разлок остаётся (ручной override) — да (не убирать, OQ-8 edge 8).
