# B26: сеть хоста для сборки verifier — 26 октября 2026

База — main на `dcf5e6d`. Новое фото пользователя следует за проверкой того же Node-образа с `--network=host`: адреса registry.npmjs.org появились, тогда как обычная контейнерная проверка дала пустой вывод. Хостовый getent также ранее был успешен. Это подтверждает работающий DNS-путь host network для пробника; точная настройка resolver/маршрута и успешная загрузка npm на Linux ещё не приняты.

`SNAPSHOT_VERIFIER_BUILD_NETWORK` допускает только строки `default` и `host`. Default/отсутствие не добавляет CLI-флаг; host добавляет ровно `--network=host` к Docker build исполнителя снимков. Валидация выполняется до БД, mkdir секретов и генерации ключей. С готовым SNAPSHOT_VERIFIER_IMAGE настройка не валидируется и не используется. Ключ исключён из Catalog/runner runtime; inspect, прочие сервисы, TLS/прокси/CA, бюджет и отмена сборки сохранены. Произвольное имя сети/аргументы shell не принимаются.

| Проверка | Результат |
| --- | --- |
| RED расширенного snapshot-набора | `.run/snapshot-build-host-network-20261026/red.log`: 34 PASS / 12 FAIL до product-правки |
| Snapshot, progress, CA, npm isolation | `green.log`: **75 PASS / 2 opt-in Docker SKIP**, 0 fail/cancelled/TODO, 4 файла |
| Startup | `startup.log`: **3/3**, 0 skip/cancelled/TODO; прежние timeout/exit37 и новый opt-in из dotenv в реальном dev CLI на собственном Docker/PG fixture |
| Сохранность | Host/default/prebuilt/invalid values, proxy+diagnostics composition, окружение вызывающего кода, signing key/token/processes hashes, отсутствие inspect/старта сервисов после failed build проверены |

Startup проверяет конкретный `--network=host` в аргументах собственного fake Docker и сохранение прежнего processes.json при exit37. Это не запуск Docker daemon или сетевых запросов npm. Связанные native-контролы progress проверяют свой CLI-процесс, не корпоративную Linux-сеть. Исходники и тесты независимо просмотрены; блокирующих замечаний нет. Нового SDK/пакетов/моделей не устанавливалось, работающие сервисы не переключались.

Повтор на целевом Linux после обновления main:

```sh
SNAPSHOT_VERIFIER_BUILD_NETWORK=host SNAPSHOT_VERIFIER_NPM_DIAGNOSTICS=1 ./scripts/dev.sh up --profile=fast
```

Режим host разделяет сеть Docker-хоста во время RUN сборки. Для удалённого daemon/виртуализированного Desktop это не обязательно сеть вызывающего компьютера. BuildKit может потребовать разрешения network.host со стороны builder; CLI не меняет entitlements/daemon и не подменяет ошибку автоматическим fallback. B26 остаётся открыт до воспроизводимого успеха загрузки отсутствующих в кэше пакетов и dev.sh up на нужном Linux. Полная матрица платформ, CI и production не подтверждены.
