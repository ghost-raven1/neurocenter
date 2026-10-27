# Tasks

## 1. Контракт и очередь

- [ ] 1.1 Добавить флаг и server-only origin link со схемой/измеряемыми readiness facts; проверить feature-policy, same-room FK, атомарность enqueue и exact replay на собственном PostgreSQL.
- [ ] 1.2 Проверять origin authority перед исполнением и публиковать safe result отдельно от job ACK; проверить revoke/private-room/withheld, отмену работающего задания и поздний success через причинные тесты.

## 2. Интерфейс

- [ ] 2.1 Открывать существующий selected-agent workflow из source сообщения с отдельным draft scope и сохранением composer; проверить empty/missing target/agent и exact recovery при reload/error/OFF frontend regression.
- [ ] 2.2 Показывать durable linked receipt после read/history, owner cancel и путь продолжения; пройти Chromium desktop с контролируемым API, сверить bodies и сохранность ввода, обновить пользовательскую справку.

## 3. Интеграция и поставка

- [ ] 3.1 Пройти затронутые typecheck и изолированные сборки, независимо проверить сервер/интерфейс/спецификацию; исправить подтверждённые замечания и повторить затронутые проверки.
- [ ] 3.2 Пройти strict OpenSpec verification, обновить отчёт и бэклог по фактам, сохранить feature commits/push/draft PR и очистить собственные QA-ресурсы.

## Workflow follow-up

- Настоящая модель, установленная площадка, CI и production проверяются отдельно. Этот срез не закрывает AP02/SR01/SR02 или все AD/AT/AL направления.
- Изменение не архивируется до фактического завершения требуемых проверок.
