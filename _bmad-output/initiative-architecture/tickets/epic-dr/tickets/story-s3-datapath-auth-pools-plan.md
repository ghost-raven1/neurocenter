---
title: 'S3 data path (ceph-chat dev): 403 AccessDenied — подпись SigV4 не аутентифицируется + RGW-пулы данных не создавались'
type: 'story'
ticket: '10'
created: '2026-11-18'
status: ready-for-dev
baseline_revision: 'dfc5a8b6'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
context: ['scripts/workspace/dev-ceph.sh', 'compose.chat-storage.ceph.dev.yml']
---

# ceph-chat (dev): S3 data path — 403 AccessDenied + RGW-пулы не создавались

## Факты (диагностика story 9, 2026-11-18)

Dev-стэк ceph-chat (compose.chat-storage.ceph.dev.yml, ceph:v20.2.4, RGW на
127.0.0.1:19011). Предсуществующая проблема, отдельная от ceph-osd crash-loop
(story 9):

1. **S3 data path (операции bucket/объекта) → 403 AccessDenied.** В RGW
   access-логе пользователь = `-` (anonymous): подпись SigV4 не проходит
   аутентификацию — запрос RGW рассматривает как неавторизованный.
2. **Сторона клиента исключена.** Креденшалы корректны: access/secret совпадают
   с `radosgw-admin user info` и хэшами owner.json; часы корректны; доверенный
   клиент `curl --aws-sigv4` пробован и внутри контейнера, и с хоста через
   127.0.0.1:19011 — одинаковый 403.
3. **RGW-пулы данных никогда не создавались:** `default.rgw.buckets.data/index`
   (+non-ec) отсутствуют. Следствие: объекты через S3 **ни разу** не
   записывались — chat-файлы dev-стека фактически не хранятся.
4. **RGW metadata / admin API работает штатно** (`user info`, список user'ов) —
   mon/OSD-слой и сам RGW живы; сломана только авторизация S3 data path.

## Scope

1. **Причина отказа аутентификации S3 data path** — найти и исправить. Кандидаты
   (проверить по репам RGW и живому RGW, не наугад): часы/часовой пояс
   RGW-контейнера (SigV4-окно 15 мин), алгоритм/region в настройках RGW
   (`rgw_s3_use_sigv4`, default region), host-заголовок в canonical request
   (127.0.0.1:19011 vs ожидание RGW), mismatch user/secret, если RGW
   инициализировался повторно против owner.json (сравнить `user info` hash с
   фактическим секретом до изменения).
2. **RGW-пулы данных** — создаются в сценарии поднятия (`dev-ceph.sh`) до/после
   `radosgw-admin init` в зависимости от найденного порядка инициализации;
   health-гейт (`--health`) проверяет существование `default.rgw.buckets.data/index`.
3. **Верификация полного S3-раундтрипа** — см. Verification.

## Вне скоупа

- ceph-osd crash-loop (story 9, закрыта), DR-репетиции, production-closure,
  замена Ceph-версии, S3-сертификация клиентского кода приложения (использует
  штатные креденшалы, менять не нужно).

## Verification

- S3 PUT/GET объекта через 127.0.0.1:19011 с owner-креденшалами
  (`curl --aws-sigv4`) → 200/200, readback byte-идентичен; в RGW access-логе
  user = access key (не `-`).
- Пулы `default.rgw.buckets.data/index` существуют (`ceph osd pool ls` /
  `rados df`); dev-ceph.sh их создаёт; `--health` зелёный с проверкой пулов.
- RGW admin API без регрессии; штатный старт без регрессии (osd_ready + rgw_ready).

## Progress (2026-11-18, ready-for-dev)

- Тикет создан из диагностического вывода story 9 (коммит d20e2c5d, Progress
  2026-11-18). Реализация не начата; live-стека для разработки нет — старт при
  свободном dev-окне (load-порог как в story 9: docker-сборки sequential,
  cooldown load < 8).
