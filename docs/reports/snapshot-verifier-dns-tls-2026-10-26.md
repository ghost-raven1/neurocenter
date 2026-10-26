# DNS registry и переключатель проверки сертификатов — 26 октября 2026

После настройки последовательной загрузки пользовательский Linux снова сообщил EAI_AGAIN. Пользователь подтвердил конечное `hostname registry.npmjs.org`, затем попросил включить проверку TLS и вынести её в переменную. HTTPS использовался и раньше; новый переключатель относится к проверке сертификатов.

Реализация ограничена сборкой snapshot-verifier:

- `SNAPSHOT_VERIFIER_TLS_VERIFY` принимает0/1, по умолчанию1. Docker ARG NEUROCENTER_NPM_STRICT_SSL по умолчаниюtrue; NODE_TLS_REJECT_UNAUTHORIZED и NPM_CONFIG_STRICT_SSL в npm RUN согласованы с CLI strict-ssl. Явный0 отключает проверку только для установки, runtime NODE_TLS override отсутствует. Существующий публичный CA передаётся через NEUROCENTER_BUILD_CA_FILE/NODE_EXTRA_CA_CERTS с прежними проверками SHA/прав/состава.
- `SNAPSHOT_VERIFIER_REGISTRY_IPV4` необязателен, принимает один IPv4 из DNS хоста. Добавляется только --add-host registry.npmjs.org:IPv4. Автовыбора IP, публичного DNS, изменения proxy/daemon или обхода настроенного прокси нет. Имя registry/HTTPS/SNI и lock/integrity сохраняются. Если ошибку даёт имя прокси, такое отображение registry не поможет.
- Валидация обеих настроек происходит до БД/ключей; при готовом SNAPSHOT_VERIFIER_IMAGE они не проверяются и не передаются в Catalog/runner. Лог показывает эффективные режимы, без значений proxy.

Свидетельства в `.run/verifier-dns-tls-20261026/`:

- `red.log`:16 новых build-контрактов падают до реализации; затем `contracts-final.log`: **102 PASS / 2 opt-in SKIP** в пяти связанных файлах. Включены IPv4/TLS-валидация, prebuilt/runtime границы, фактический shell RUN в четырёх сочетаниях TLS/диагностики и прежние retry/timeout/CA-контракты. Первый полный прогон `contracts.log` сохранил одно устаревшее ожидание строгого false в CA-контракте; исключение исправлено только для verifier.
- `tls-green.log`, `tls-receipt.json`: настоящий npm на собственном HTTPS-сервере. Без CA strict-режим возвращает DEPTH_ZERO_SELF_SIGNED_CERT до HTTP-handler; с NODE_EXTRA_CA_CERTS установка и выполнение пакета успешны; явный opt-out тоже успешен. Эти4 теста входят в102, не прибавляются отдельно. Начальный TLS-прогон уже был GREEN из-за параллельного изменения Dockerfile; TLS RED не заявляется.
- `dns-build-control.log`, `dns-build-pinned.log`, `dns-build-results.json`: настоящие Docker RUN с network none. Без mapping lookup registry завершается ошибкой, с --add-host/документационным IPv4 разрешается. Это проверяет механизм hosts без доступа к DNS, а не доступность npm по этому тестовому адресу.
- `docker-build.log`, `docker-build-result.json`: полная настоящая локальная Docker Desktop linux/arm64 сборка, свежий IPv4 из DNS Mac передан через --add-host, проверка сертификатов включена по умолчанию. Exit0 за **14,8с**, npm установил30 пакетов за9с, ответы cache miss. QA-тег neurocenter-snapshot-verifier:qa-dns-tls-20261026-8f3c не заменял рабочий образ runner.
- `native-snapshot.log`: **11 PASS / 1 managed-runtime SKIP**; новый QA-образ явно передан, реальный verifier без сети проверяет504 строки/3таблицы с индексом, дополнительными полями и пустой таблицей.
- `startup.log`: **3/3**, в том числе загрузка DNS/TLS/host-настроек из dotenv настоящим dev CLI и сохранение прежних сервисов при неуспешном build.
- `tooling-profile.log`: **14/14**, новый HTTPS-тест включён в фиксированный tooling-профиль.

Локальные fake-DNS/HTTPS и настоящий локальный registry не заменяют приёмку целевого Linux. B26 остаётся открыт до успешного npm ci/dev.sh up с выбранной настройкой. Исходный корпоративный DNS не исправлен, глобальные настройки не менялись. Все images, пользовательские node_modules и работающие сервисы ради этой проверки не удалялись. CI/production не запускались.
