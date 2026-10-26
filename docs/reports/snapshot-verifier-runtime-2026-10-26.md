# Минимальный runtime проверщика снимков — 26 октября 2026

На фото Linux зависает `npm ci` вспомогательного snapshot-verifier. Ранее этот образ копировал весь production lock Catalog: 258 записей, включая Nest, esbuild и GitHub asset-contract. Фактический verify-image.cjs требует только LanceDB и встроенные Node-модули; общий контракт снимка требует node:crypto.

В `scripts/snapshots/verifier` выделены private manifest и lock v3 с LanceDB 0.29.0 и его Arrow peer 18.1.0. Все 36 package entries, включая семь optional native binaries и вложенный reflect-metadata 0.2.2, взяты из Catalog без изменения version/resolved/integrity и платформенных ограничений. Производные peer-флаги сняты после продвижения Arrow в прямую production dependency. Lock Catalog не менялся. Проверка целостности npm сохраняется. Docker использует новый lock и печатает эффективное значение diagnostics; dev CLI печатает выбранные network/diagnostics/timeout и только имена явно заданных proxy.

Проверки и исходные квитанции в `.run/verifier-runtime-dependencies-20261026/`:

- `red.log`: оба новых контракта падают до правки — нет отдельного manifest/lock и эффективного лога настроек.
- `contracts.log`: **77 PASS / 2 opt-in Docker SKIP**, четыре связанных файла npm/build/CA/progress. Проверены прежние pins/integrity, отсутствие Catalog manifest в DockerCOPY, лог без proxy credentials и прежние ограничения TLS/registry/lifecycle.
- `docker-build.log`, `docker-build-result.json`: настоящая сборка закреплённого Node24 образа на локальном Docker Desktop, **linux/arm64**, exit0 за **10,42 с**. `npm ci` загрузил архивы с cache miss, включая native LanceDB, и установил **30 пакетов за 4 с**. Отдельный QA-тег `neurocenter-snapshot-verifier:qa-minimal-20261026-7c682d` не заменял образ работающего runner.
- `native-snapshot.log`: **11 PASS / 1 SKIP** в project-snapshot-native.test.ts. Явно задан `NEUROCENTER_SNAPSHOT_TEST_VERIFIER_IMAGE` с новым QA-образом, поэтому Docker-ветка первого теста выполнена: capture → materialize → verifier с network=none/read-only root → чтение восстановленных таблиц. Прочитаны 504 строки трёх таблиц с индексом, extra/nested полями и пустой таблицей. Единственный SKIP требует отдельный managed OpenCodeRAG runtime.
- `startup.log`: **3/3** — прежние сервисы сохраняются при timeout/exit build; настройка host-сети загружается через dotenv настоящим dev CLI на собственном стенде.
- `tooling-profile.log`: **14/14** — контракт фиксированного tooling-профиля; новые проверки добавлены в уже выбранные файлы. Повтор npm после git add (`npm-tracked-locks.log`) дал **6 PASS / 1 SKIP**, включая новый lock в общем обходе источников; эти шесть пересекаются с основными77.

Пользователь отдельно подтвердил `PONG` команды npm ping в Node-контейнере с host-сетью. Прежде plain-контейнер не возвращал DNS-адресов, host-контейнер возвращал. PONG, скачивание ссылки браузером и локальный Docker Desktop не доказывают стабильное скачивание всех архивов или успешный dev.sh up на корпоративном Linux. B26 остаётся открыт до этой приёмки. Глобальные DNS/proxy/daemon, сеть остальных сборок, версии SDK и работающие сервисы не менялись; CI и production не запускались.
