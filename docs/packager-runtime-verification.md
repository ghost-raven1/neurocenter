# Проверка запуска готового пакета

`verifyBuiltRuntime(asset.json, options)` проверяет закреплённую поставку до её импорта и публикации. Успех относится только к target проверяющего сервера. Прочие платформы остаются в `untestedTargets`; их архивы проходят проверку целостности, но их программы не запускаются.

MCP проходит `initialize`, `notifications/initialized` и `tools/list`. Список должен содержать хотя бы один корректный инструмент. Проверка не вызывает `tools/call`, чтение ресурсов или произвольные методы. Плагин загружается в отдельном процессе, его фабрика получает минимальный OpenCode SDK context и возвращает хотя бы один корректный hook, tool или auth hook. Эти hooks и инструменты при общей проверке не вызываются. Клиент контекста содержит безопасные ответы для чтения fixture config/project/path/session и записи диагностического сообщения без передачи на сервер. Shell API контекста при вызове отклоняет операцию; настоящий OpenCode/Bun, пользовательские модели и provider sessions не запускаются.

Отчёт `schemaVersion: 1` закрепляет identity кандидата, source digest, asset ID/version, SHA-256 полного `asset.json`, проверенный target, границы OS-изоляции, пройденные этапы и фиксированные диагностические коды. Вывод процесса, имена/описания инструментов и provider credentials в отчёт не попадают. Отмена, таймаут, ошибка протокола, пустой список, пустой plugin hooks и отсутствие OS sandbox дают `ok: false`. Перед публикацией нужно повторно сверить SHA-256 манифеста и байты поставки с отчётом.

## Управляемый коннектор Codex

Поставка Codex содержит библиотеку `codex-plugin.mjs` с `createManagedCodexPlugin(options)`. Эту функцию нельзя вызывать как обычную Plugin-фабрику: ей нужны параметры владельца, а не OpenCode SDK context. Рабочую Plugin-фабрику экспортирует wrapper, который создаёт мастер проекта. Проверка воспроизводит эту форму wrapper внутри одноразового OS sandbox; она не выдаёт успех пустому default export библиотеки и не меняет общий перебор экспортов обычных плагинов.

Этот профиль выбирается только после `readyManifest` и проверки целостности всего source envelope/runtime: тип исходника `git`, репозиторий и полный commit из `codex-connector-pin.json`, путь `packages/bridge`, точная декларация из пяти полей `codexConnector` и непустой набор артефактов с entrypoint `codex-plugin.mjs`. Совпадения имени, произвольного `extra` или одной декларации недостаточно. Archive/prepared-source envelope без этой Git provenance не получает профиль автоматически.

Wrapper импортирует настоящую фабрику из распакованного артефакта. Его одноразовые provider ID, UUID сессии, schema digest, project root, Codex HOME и bridge command относятся только к профилю проверки. Фабрика обязана вернуть непустые корректные `config` и `auth` hooks; дополнительно выполняются только регистрация fixture provider через `config` и пассивный `auth.loader` адаптера. Проверяются управляемый не секретный marker, официальный base URL, функция транспорта и сохранность ручного провайдера рядом. Методы `authorize`, OAuth callback, transport fetch, чтение сессии Codex и CLI не вызываются. Сеть и fork на macOS остаются запрещены; нарушение даёт отказ. Успех подтверждает регистрацию wrapper и hooks, но не действительность пользовательского входа и не ответ модели.

## Linux

Catalog image устанавливает `bubblewrap` из Debian вместе с остальными системными зависимостями. Пакет запускается в отдельных user/mount/PID/network/IPC/UTS namespaces: доступны только системные библиотеки для чтения, закреплённая копия пакета и одноразовый записываемый профиль. Сетевой namespace не содержит внешней сети. Дочерние процессы поддерживаются и остаются в принадлежащем проверке PID namespace. Завершение namespace и собственной process group убирает также отсоединившихся потомков. До исполнения пакета доверенный preflight подтверждает изоляцию чтения/записи, отдельные PID/network namespaces и работоспособность дочернего процесса.

Требования хоста:

- Linux с разрешёнными unprivileged user namespaces и положительным `user.max_user_namespaces`; системная политика должна разрешать используемые PID/network/mount namespaces.
- Совместимые Docker Engine/libseccomp для закреплённого профиля. На rootless Docker и хостах с дополнительным LSM нужна отдельная фактическая проверка nested user namespaces.
- Профиль seccomp из `docker/seccomp/catalog-packager.json`. Оба основных Compose файла (`docker-compose.yml` и `compose.production.yml`) применяют его только к `catalog-service`, одновременно убирает все внешние capabilities и сохраняет `no-new-privileges`. Профиль оставляет Docker default и добавляет только необходимые bwrap clone/unshare/mount/pivot_root/setns операции; исходный commit и SHA приведены в `docker/seccomp/README.md`.

Docker default seccomp блокирует часть namespace/mount операций; одной установки bwrap недостаточно. Это подтверждено [официальной документацией Docker](https://docs.docker.com/engine/security/seccomp/). Параметры изоляции bwrap и принадлежность PID namespace описаны в [документации bubblewrap](https://github.com/containers/bubblewrap/blob/main/README.md).

### Хост с AppArmor

Docker default AppArmor запрещает mount. На хосте с AppArmor 4+ загрузите отдельный профиль контейнера и добавьте подготовленный Compose override:

```sh
sudo apparmor_parser -r -W docker/apparmor/catalog-packager
docker compose -f docker-compose.yml -f compose.packager-apparmor.yml config
docker compose -f compose.production.yml -f compose.packager-apparmor.yml config
```

При следующем согласованном применении стека используйте нужный основной Compose файл вместе с `compose.packager-apparmor.yml`. Команда `config` проверяет конфигурацию; она не меняет работающие сервисы и не подтверждает, что sandbox работает. Профиль привязан к контейнеру, не к общесистемному `/usr/bin/bwrap`, поэтому не подменяет профили bwrap других приложений. Он сохраняет Docker denials для чувствительных `/proc` и `/sys`, добавляя `userns` и mount/pivot_root setup внутри непривилегированного namespace. Внешние capabilities остаются сняты. Сам профиль и механизм его загрузки требуют проверки на целевом ядре; исходная политика — [Moby AppArmor template](https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/apparmor/template.go).

Использование пользовательского профиля описано в [Docker AppArmor docs](https://docs.docker.com/engine/security/apparmor/). Требование явно разрешать user namespaces в AppArmor на Ubuntu подтверждено [документацией Ubuntu](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).

Если политика не пропускает preflight, проверка возвращает `isolation-unavailable` и пакет не публикуется. Автоматического снятия seccomp/AppArmor, выдачи `SYS_ADMIN`, privileged-контейнера, передачи Docker socket или запуска без sandbox нет. Не меняйте глобальную политику хоста ради обхода отказа проверки; настройте ограниченный runner и повторите проверку.

## macOS

Встроенный runner использует `sandbox-exec` с deny-default policy: чтение только собственных staged файлов, runtime и системных библиотек; запись только в одноразовый профиль; сеть и создание дочерних процессов запрещены. Private HOME и cwd сами по себе не являются OS sandbox. Перед пакетом отдельный preflight подтверждает запрещённые чтение/запись/fork/network.

Из-за отсутствия Linux PID namespace этот runner поддерживает один процесс. Плагин, который запускает CLI в фабрике, либо MCP launcher, который запускает Python/JVM/.NET, на этом runner не принимается. Для таких пакетов нужен Linux worker с bwrap и артефактом для его target либо отдельно реализованный VM runner. Запуск macOS-артефакта на Linux не считается проверенным. Windows runner пока не поддержан и также отклоняет публикацию.

## Проверяемые границы

Контракт функции: `{signal?, integrityTimeoutMs?: 1..300000, timeoutMs?: 1..60000, maxOutputBytes?: 1024..1048576, candidateIdentity?}`; по умолчанию до 300 секунд на доверенную проверку целостности/материализацию и по 15 секунд отдельно на OS preflight и запуск программы; лимит общего stdout/stderr — 256 КиБ. Проверка и распаковка больших наборов платформ не отнимают время запуска MCP/плагина. Переход к следующему этапу разрешён только до истечения текущего срока и без отмены; истёкший срок не возобновляется. Профиль и собственные процессы удаляются после успеха и отказа. Перед sandbox запускается небольшой доверенный guardian с очищенным окружением; только после его загрузки package env передаётся по отдельному IPC. Guardian не передаёт этот канал программе пакета и завершает собственную группу при разрыве IPC, включая SIGKILL/OOM основного worker. Результат plugin остаётся на отдельном fd3, owner IPC — на fd4. Доверенная общая `readyManifest` не принимает AbortSignal: отмена может прервать ожидание её чтения архивов; она не запускает программы кандидата. Чтобы ограничить также эти чтения/распаковку, вызывающий worker должен владеть отдельным процессом всей проверки и завершать его по общему дедлайну.

Исходники, unit fixtures, запуск на macOS, Linux bwrap, сборка контейнера и работа на целевом production-хосте — отдельные свидетельства. Наличие Dockerfile/Compose/profile не подтверждает успешную сборку или выполнение на сервере.
