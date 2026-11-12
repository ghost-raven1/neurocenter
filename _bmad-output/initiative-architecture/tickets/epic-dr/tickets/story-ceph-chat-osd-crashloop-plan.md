---
title: 'ceph-chat (dev) — ceph-osd crashloop после DR-репетиции: восстановление dev-стэка + verification gap'
type: 'story'
ticket: '9'
created: '2026-11-12'
status: in-progress
baseline_revision: '56815ff1'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['scripts/workspace/dev-ceph.sh', 'compose.chat-storage.ceph.dev.yml', 'scripts/workspace/check-tooling-tests.json']
---

# ceph-chat (dev): ceph-osd crashloop после DR-репетиции

## Root cause (подтверждён, 2026-11-12)

Dev-стэк chat-хранилища (compose.chat-storage.ceph.dev.yml, ceph:v20.2.4) вошёл в
самоподдерживающийся crash-loop: **падает ceph-osd, не radosgw**.

**Стек падения** (osd.log в volume `neurocenter-ceph-chat-8bbcf06109_ceph-chat-data`,
5.79 GB; **22 465 crash-сборок** «Caught signal»; mon/mgr/rgw.log — ноль падений):

```
OSD::init → BlueStore::_mount → BlueStore::_open_db → RocksDBStore::do_open
→ rocksdb::DBImpl::Open → RecoverLogFiles → WriteLevel0TableForRecovery
→ BlueFS::append_try_flush → BlueFS::_flush_F → __ceph_abort
```

Assert в Ceph v20.2.4: `ceph_assert(h->pos <= h->file->fnode.size)` (BlueFS.cc:4154;
lock-assert 4133 исключён — лок у холдера). Т.е. RocksDB recovery при монтировании
BlueStore пишет SLOG в точку, выходящую за пределы fnode-size — повреждённое/несогласованное
состояние single-file BlueFS (osd/block, 4 GiB) после недоброго SIGKILL.

**Живое воспроизведение** (throwaway-контейнер на том же volume, image
ceph:v20.2.4@sha256:6bb1c8a42fbc0bf87938946990b65174466997bc11c31eb5a323225a779fd8f9):
radosgw на foreground **штатно** (30 с, exit 124 = kill по таймауту); **ceph-osd — abort
(core dumped)** в той же точке recovery.

**Механика цикла**: mon помнит «osd 1 up, 1 in» (persisted state) → `osd_ready()`
(dev-ceph.sh:267, `ceph osd stat` → num_up_osds/num_in_osds) **проходит по памяти мон** →
`radosgw-admin user info` виснет (живого OSD нет) → 20 с → «RGW user-info timed out» →
fail → рестарт контейнера → OSD снова падает в той же точке recovery. «line 318 Aborted»
в docker-логах — bash job-notification, не отдельный crash (проверено эмпирически на
bash 5.1.8 в образе и на хосте).

**Триггер**: 10-11 09:20 — DR-репетиция (stop ceph-контейнера, SIGTERM/SIGKILL в
cleanup-трепе 12 с); mtime `osd/block` = 10-11 09:20.

**Неизвестные детали** (не мешают root cause): 1-строчный сдвиг 318 vs 319 в dev-ceph.sh
(файл не менялся с 10-22, mtime 18:42; `start rgw` на 319). Web-поиск known-issues Ceph
(2 запроса) — пусто.

## Scope

1. **Восстановление dev-стэка — выбор варианта (HITL):**
   - **(а) пересоздать volume** `neurocenter-ceph-chat-8bbcf06109_ceph-chat-data`
     (docker volume rm + старт по compose.chat-storage.ceph.dev.yml): dev-данные
     chat-файлов теряются — **решение за пользователем**; для dev-стэка — рекомендуемый;
   - (б) ручная правка состояния OSD (удаление/откат SLOG-файлов в single-file BlueFS)
     — рискованно, данные могут сохраниться, нет гарантии;
   - (в) апгрейд Ceph (v20.2.4 → актуальный point-release) — не устраняет повреждённое
     состояние, только возможен будущий фикс assert'а.
2. **Verification gap в dev-ceph.sh (основная профилактика):** `osd_ready()`
   (dev-ceph.sh:267-271) проверяет `ceph osd stat` (num_up/num_in) — это **память мон**,
   а не живость OSD. До RGW-verification (dev-ceph.sh:275-317, `radosgw-admin user info`
   с 20-с таймаутом) добавить проверку живого OSD: `ceph daemon osd.0 version`
   (admin socket — недоступен, пока OSD в crash-loop) ИЛИ pgrep ceph-osd в контейнере.
   Целевое поведение: вместо 20-с виснения `radosgw-admin` и общего «timed out» —
   немедленный fail с диагностикой «OSD не жив (crash-loop), osd.log: <путь>,
   last crash: <строка>».

## Вне скоупа

- Production-стек (ceph-chat в production не развёрнут).
- Апгрейд Ceph как самостоятельная работа (вариант (в) — только если (а)/(б) не выбраны).
- Репетиция DR-сценария, которая триггернула инцидент (она сама прошла; этот тикет —
  последствия).

## Операционный факт (2026-11-12)

Контейнер `neurocenter-ceph-chat-8bbcf06109-chat-ceph-1` **остановлен** (docker stop для
диагностики; status: Exited (0)). До решения по варианту восстановления стэк chat-хранилища
dev-окружения недоступен.
